import { readdirSync, rmSync } from "node:fs"
import path from "node:path"
import type { APIRequestContext, PlaywrightWorkerArgs } from "@playwright/test"
import { expect, test } from "./support/fixtures"
import { alice, registerUser, writeHeaders, type Account } from "./support/accounts"
import { postComment } from "./support/comments"
import { createIssue, removeIssue, setIssueRole } from "./support/issues"
import { createRepo, grantMember, revokeMember, signedIn } from "./support/repos"
import type { Backend } from "./support/backend"

// HTTP contract checks for the notification routes, through the same Vite
// proxy the browser uses. Notifications come from real activity (comments
// posted through Haxy's own forms); every change is read back after a
// restart, and Haxy's own pages agree with the API.

const bob: Account = { name: "bobby", email: "bobby@example.test", password: "battery staple horse" }
const hex = expect.stringMatching(/^[0-9a-f]{32}$/)

type Inbox = {
  items: Array<{ id: string; unread: boolean; title: string; repo: { owner: string; name: string }; thread: { kind: string; id: string }; updated_at: string }>
  page: { has_more: boolean; next_cursor: string | null; count: { kind: string; value?: number } }
  unread_count: number
}
type State = { notified: boolean; notification: { id: string; unread: boolean; revision: string } | null }

/** Sends a JSON write through the hub, with the CSRF token a same-origin page would carry. */
async function send(request: APIRequestContext, hubUrl: string, method: string, path: string, body?: unknown) {
  const headers = { ...(await writeHeaders(request, hubUrl)), "Content-Type": "application/json" }
  return request.fetch(`${hubUrl}${path}`, { method, headers, data: body === undefined ? undefined : JSON.stringify(body) })
}

async function inbox(request: APIRequestContext, hubUrl: string, query = ""): Promise<Inbox> {
  const response = await request.get(`${hubUrl}/api/v1/notifications${query}`)
  expect(response.status(), await response.text()).toBe(200)
  return response.json()
}

async function unread(request: APIRequestContext, hubUrl: string): Promise<number> {
  const response = await request.get(`${hubUrl}/api/v1/notifications/count`)
  expect(response.status(), await response.text()).toBe(200)
  return ((await response.json()) as { unread_count: number }).unread_count
}

async function state(request: APIRequestContext, hubUrl: string, path: string): Promise<State> {
  const response = await request.get(`${hubUrl}${path}`)
  expect(response.status(), await response.text()).toBe(200)
  return response.json()
}

/** alice's repository `name` with one issue of hers, which bob (registered too) comments on; both signed in. */
async function aliceAndBob(playwright: PlaywrightWorkerArgs["playwright"], backend: Backend, hubUrl: string, access: "public" | "private" = "public") {
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const owner = await signedIn(playwright, backend, hubUrl, alice.name, alice.password)
  const other = await signedIn(playwright, backend, hubUrl, bob.name, bob.password)
  await createRepo(owner, backend, { name: "tracker", access })
  if (access === "private") await grantMember(owner, backend, { owner: alice.name, name: "tracker" }, bob.name)
  const issue = await createIssue(owner, backend, "/alice:tracker", { title: "Crash on save" })
  return { owner, other, issue, repo: { owner: alice.name, name: "tracker", access } }
}

test("another user's comment puts the thread in the inbox, unread; only the page's acknowledgement marks it read", async ({ playwright, launch }) => {
  let backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, other, issue } = await aliceAndBob(playwright, backend, hub.url)
  const thread = `/api/v1/repos/alice/tracker/issues/${issue}`

  // nothing yet: alice's own issue notifies nobody
  expect(await inbox(owner, hub.url)).toEqual({ items: [], page: { has_more: false, next_cursor: null, count: { kind: "exact", value: 0 } }, unread_count: 0 })
  expect(await state(owner, hub.url, `${thread}/notifications`)).toEqual({ notified: true, notification: null })

  await postComment(other, backend, "/alice:tracker", issue, "Same here.")
  const listed = await inbox(owner, hub.url)
  expect(listed).toEqual({
    items: [{ id: hex, unread: true, title: "Crash on save", repo: { owner: "alice", name: "tracker" }, thread: { kind: "issues", id: issue }, updated_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/) }],
    page: { has_more: false, next_cursor: null, count: { kind: "exact", value: 1 } },
    unread_count: 1,
  })
  expect(await unread(owner, hub.url)).toBe(1)
  // bob made the comment, so he hears nothing of it
  expect((await inbox(other, hub.url)).items).toEqual([])

  // reading the thread, its comments and its state changes nothing
  const before: State = await state(owner, hub.url, `${thread}/notifications`)
  expect(before).toEqual({ notified: true, notification: { id: listed.items[0].id, unread: true, revision: hex } })
  for (const path of [thread, `${thread}/comments`, `${thread}/notifications`]) expect((await owner.get(`${hub.url}${path}`)).status()).toBe(200)
  expect((await owner.head(`${hub.url}${thread}/notifications`)).status()).toBe(200)
  expect(await unread(owner, hub.url)).toBe(1)

  // an acknowledgement of another bump leaves it unread
  const stale = await send(owner, hub.url, "POST", `${thread}/notifications/read`, { revision: "0".repeat(32) })
  expect(stale.status(), await stale.text()).toBe(200)
  expect(await stale.json()).toEqual(before)

  // the page's acknowledgement of what it showed marks it read
  const read = await send(owner, hub.url, "POST", `${thread}/notifications/read`, { revision: before.notification!.revision })
  expect(read.status(), await read.text()).toBe(200)
  expect(await read.json()).toEqual({ notified: true, notification: { ...before.notification, unread: false } })
  expect(await unread(owner, hub.url)).toBe(0)
  // and again is harmless
  expect((await send(owner, hub.url, "POST", `${thread}/notifications/read`, { revision: before.notification!.revision })).status()).toBe(200)

  backend = await backend.restart!()
  const after = await inbox(owner, hub.url)
  expect(after.items.map((item) => item.unread)).toEqual([false])
  expect(after.unread_count).toBe(0)

  // a new comment bumps it: unread again, at a new revision the old acknowledgement doesn't cover
  await postComment(other, backend, "/alice:tracker", issue, "Still crashing.")
  const bumped = await state(owner, hub.url, `${thread}/notifications`)
  expect(bumped.notification).toMatchObject({ unread: true })
  expect(bumped.notification!.revision).not.toBe(before.notification!.revision)
  await send(owner, hub.url, "POST", `${thread}/notifications/read`, { revision: before.notification!.revision })
  expect(await unread(owner, hub.url)).toBe(1)
})

test("the inbox pages newest first with an opaque cursor, and checks its parameters", async ({ playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, other, issue } = await aliceAndBob(playwright, backend, hub.url)
  const second = await createIssue(owner, backend, "/alice:tracker", { title: "Slow startup" })
  await postComment(other, backend, "/alice:tracker", issue, "First.")
  // Haxy orders notifications by whole seconds, so the second bump comes a second later
  await new Promise((resolve) => setTimeout(resolve, 1100))
  await postComment(other, backend, "/alice:tracker", second, "Second.")

  const first = await inbox(owner, hub.url, "?page_size=1")
  expect(first.items.map((item) => item.title)).toEqual(["Slow startup"])
  expect(first.page).toEqual({ has_more: true, next_cursor: expect.any(String), count: { kind: "exact", value: 2 } })
  const next = await inbox(owner, hub.url, `?page_size=1&cursor=${encodeURIComponent(first.page.next_cursor!)}`)
  expect(next.items.map((item) => item.title)).toEqual(["Crash on save"])
  expect(next.page).toEqual({ has_more: false, next_cursor: null, count: { kind: "exact", value: 2 } })

  for (const query of ["?cursor=nope", "?cursor=", "?page_size=0", "?page_size=x"]) {
    const refused = await owner.get(`${hub.url}/api/v1/notifications${query}`)
    expect(refused.status(), query).toBe(400)
    expect((await refused.json()).error.code).toBe("validation")
  }
})

test("subscribing and muting persist, and decide who hears of a comment", async ({ playwright, launch }) => {
  let backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, other, issue } = await aliceAndBob(playwright, backend, hub.url)
  const path = `/api/v1/repos/alice/tracker/issues/${issue}/notifications`

  expect(await state(other, hub.url, path)).toEqual({ notified: false, notification: null })
  const subscribed = await send(other, hub.url, "PUT", path, { mode: "subscribed" })
  expect(subscribed.status(), await subscribed.text()).toBe(200)
  expect(await subscribed.json()).toEqual({ notified: true, notification: null })

  backend = await backend.restart!()
  expect(await state(other, hub.url, path)).toEqual({ notified: true, notification: null })
  // Haxy's own page offers bob what the API says: to mute it
  expect(await (await other.get(`${backend.origin}/alice:tracker/issue:${issue}`)).text()).toContain("mute")
  await postComment(owner, backend, "/alice:tracker", issue, "Looking into it.")
  expect(await unread(other, hub.url)).toBe(1)

  // muting drops the notification and stops the next one
  const muted = await send(other, hub.url, "PUT", path, { mode: "muted" })
  expect(muted.status(), await muted.text()).toBe(200)
  expect(await muted.json()).toEqual({ notified: false, notification: null })
  backend = await backend.restart!()
  await postComment(owner, backend, "/alice:tracker", issue, "Fixed, I think.")
  expect(await inbox(other, hub.url)).toMatchObject({ items: [], unread_count: 0 })
  expect(await state(other, hub.url, path)).toEqual({ notified: false, notification: null })
  expect(await (await other.get(`${backend.origin}/alice:tracker/issue:${issue}`)).text()).toContain("subscribe to")

  for (const mode of ["involved", "commented", "", "loud"]) {
    const refused = await send(other, hub.url, "PUT", path, { mode })
    expect(refused.status(), mode).toBe(400)
    expect((await refused.json()).error).toMatchObject({ code: "validation", field_errors: { mode: "Send \"subscribed\" or \"muted\"." } })
  }
  const badRevision = await send(owner, hub.url, "POST", `${path}/read`, { revision: "abc" })
  expect(badRevision.status()).toBe(400)
  expect((await badRevision.json()).error).toMatchObject({ code: "validation", field_errors: { revision: "This revision isn't one Haxy gave out." } })
  expect((await send(owner, hub.url, "DELETE", path)).status()).toBe(405)
  expect((await owner.get(`${hub.url}${path}/read`)).status()).toBe(405)
})

test("a thread past its subscriber cap refuses one more with the backend's message", async ({ playwright, launch }) => {
  test.setTimeout(240_000)
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { other, issue } = await aliceAndBob(playwright, backend, hub.url)
  const path = `/api/v1/repos/alice/tracker/issues/${issue}/notifications`

  // a hundred subscribers, each signed in by Haxy's own sign-up form
  for (let i = 0; i < 100; i++) {
    const context = await playwright.request.newContext()
    const signUp = await context.post(`${backend.origin}/user/new`, {
      form: { name: `sub${i}`, email: `sub${i}@example.test`, password: "subscriber pass", password_again: "subscriber pass" },
      maxRedirects: 0,
    })
    expect(signUp.status()).toBe(303)
    const subscribed = await send(context, hub.url, "PUT", path, { mode: "subscribed" })
    expect(subscribed.status(), await subscribed.text()).toBe(200)
    await context.dispose()
  }

  const refused = await send(other, hub.url, "PUT", path, { mode: "subscribed" })
  expect(refused.status()).toBe(409)
  expect((await refused.json()).error).toEqual({ code: "conflict", message: "This issue already has 100 subscribers, the most Haxy allows." })
  expect(await state(other, hub.url, path)).toEqual({ notified: false, notification: null })
})

test("notifications of a repository the viewer can no longer read are hidden everywhere", async ({ playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, other, issue, repo } = await aliceAndBob(playwright, backend, hub.url, "private")
  const path = `/api/v1/repos/alice/tracker/issues/${issue}/notifications`
  await postComment(other, backend, "/alice:tracker", issue, "Me too.")
  await postComment(owner, backend, "/alice:tracker", issue, "Thanks.")
  const before = await state(other, hub.url, path)
  expect(before.notification).toMatchObject({ unread: true })
  expect(await (await other.get(`${backend.origin}/bobby/user`)).text()).toContain("Crash on save")

  await revokeMember(owner, backend, repo, bob.name)
  expect(await inbox(other, hub.url)).toEqual({ items: [], page: { has_more: false, next_cursor: null, count: { kind: "exact", value: 0 } }, unread_count: 0 })
  expect(await unread(other, hub.url)).toBe(0)
  for (const response of [
    await other.get(`${hub.url}${path}`),
    await send(other, hub.url, "POST", `${path}/read`, { revision: before.notification!.revision }),
    await send(other, hub.url, "PUT", path, { mode: "subscribed" }),
  ]) {
    expect(response.status()).toBe(404)
    expect((await response.json()).error).toEqual({ code: "not_found", message: "There is no repository with this name." })
  }
  // Haxy's own inbox hides it too
  expect(await (await other.get(`${backend.origin}/bobby/user`)).text()).not.toContain("Crash on save")

  // it was hidden, not lost: access again shows it, still unread
  await grantMember(owner, backend, repo, bob.name)
  expect((await inbox(other, hub.url)).items).toMatchObject([{ title: "Crash on save", unread: true }])

  // a repository whose issues are turned off hides its issues' notifications
  await setIssueRole(owner, backend, repo, "nobody")
  expect(await unread(other, hub.url)).toBe(0)
  expect((await inbox(other, hub.url)).items).toEqual([])
  expect((await other.get(`${hub.url}${path}`)).status()).toBe(404)
})

test("notifications need a signed-in viewer on a server, and local mode has none", async ({ playwright, launch, request }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { issue } = await aliceAndBob(playwright, backend, hub.url)
  for (const path of ["/api/v1/notifications", "/api/v1/notifications/count", `/api/v1/repos/alice/tracker/issues/${issue}/notifications`]) {
    const response = await request.get(`${hub.url}${path}`)
    expect(response.status(), path).toBe(401)
    expect((await response.json()).error.code).toBe("unauthenticated")
  }
  expect((await send(request, hub.url, "PUT", `/api/v1/repos/alice/tracker/issues/${issue}/notifications`, { mode: "subscribed" })).status()).toBe(401)

  const local = await launch.local()
  const localHub = await launch.hub(local.port)
  for (const path of ["/api/v1/notifications", "/api/v1/notifications/count", `/api/v1/repo/issues/${"0".repeat(32)}/notifications`]) {
    const response = await request.get(`${localHub.url}${path}`)
    expect(response.status(), path).toBe(405)
    expect((await response.json()).error).toEqual({ code: "unsupported", message: "Local mode has no accounts, so it has no notifications." })
  }
})

test("a removed thread's notification leaves the inbox and both counts, here and in Haxy's own inbox", async ({ playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, other, issue } = await aliceAndBob(playwright, backend, hub.url)
  const kept = await createIssue(owner, backend, "/alice:tracker", { title: "Slow startup" })
  await postComment(other, backend, "/alice:tracker", issue, "Same here.")
  await postComment(other, backend, "/alice:tracker", kept, "Me too.")
  expect(await unread(owner, hub.url)).toBe(2)
  expect(await (await owner.get(`${backend.origin}/alice/user`)).text()).toContain("Crash on save")

  await removeIssue(owner, backend, "/alice:tracker", issue)
  expect(await inbox(owner, hub.url)).toMatchObject({ items: [{ title: "Slow startup", unread: true }], page: { count: { kind: "exact", value: 1 } }, unread_count: 1 })
  expect(await unread(owner, hub.url)).toBe(1)
  const tui = await (await owner.get(`${backend.origin}/alice/user`)).text()
  expect(tui).not.toContain("Crash on save")
  expect(tui).toContain("Slow startup")
})

test("a thread route of a repository without any events yet is the missing thread, not a failure", async ({ playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  const owner = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  await createRepo(owner, backend, { name: "fresh", access: "public" })
  const path = `/api/v1/repos/alice/fresh/issues/${"0123456789abcdef".repeat(2)}/notifications`
  for (const response of [
    await owner.get(`${hub.url}${path}`),
    await send(owner, hub.url, "PUT", path, { mode: "subscribed" }),
    await send(owner, hub.url, "POST", `${path}/read`, { revision: "0".repeat(32) }),
  ]) {
    expect(response.status(), await response.text()).toBe(404)
    expect((await response.json()).error).toEqual({ code: "not_found", message: "There is no issue with this id." })
  }
})

test("a repository whose directory is gone mid-deletion hides its notifications instead of failing the inbox", async ({ playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, other, issue } = await aliceAndBob(playwright, backend, hub.url)
  await postComment(other, backend, "/alice:tracker", issue, "Same here.")
  expect(await unread(owner, hub.url)).toBe(1)

  // the state a concurrent deletion leaves for a moment: the owner's record of
  // the repository is still there, its directory already isn't
  const users = path.join(backend.dataDir, "users")
  const repos = readdirSync(users).flatMap((user) => {
    try { return readdirSync(path.join(users, user, "repos")).map((repo) => path.join(users, user, "repos", repo)) } catch { return [] }
  })
  expect(repos).toHaveLength(1)
  rmSync(repos[0], { recursive: true, force: true })

  expect(await inbox(owner, hub.url)).toEqual({ items: [], page: { has_more: false, next_cursor: null, count: { kind: "exact", value: 0 } }, unread_count: 0 })
  expect(await unread(owner, hub.url)).toBe(0)
  const tui = await owner.get(`${backend.origin}/alice/user`)
  expect(tui.status()).toBe(200)
  expect(await tui.text()).not.toContain("Crash on save")
})

test("a repository caught mid-deletion with its database gone hides its notifications instead of failing the inbox", async ({ playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, other, issue } = await aliceAndBob(playwright, backend, hub.url)
  await postComment(other, backend, "/alice:tracker", issue, "Same here.")
  expect(await unread(owner, hub.url)).toBe(1)

  const users = path.join(backend.dataDir, "users")
  const repos = readdirSync(users).flatMap((user) => {
    try { return readdirSync(path.join(users, user, "repos")).map((repo) => path.join(users, user, "repos", repo)) } catch { return [] }
  })
  expect(repos).toHaveLength(1)
  const empty = { items: [], page: { has_more: false, next_cursor: null, count: { kind: "exact", value: 0 } }, unread_count: 0 }

  // a deletion that has removed the repository's database but not yet its directories
  rmSync(path.join(repos[0], ".xit", "db"), { force: true })
  expect(await inbox(owner, hub.url)).toEqual(empty)
  expect((await owner.get(`${backend.origin}/alice/user`)).status()).toBe(200)

  // and one further along, with no repository metadata left: never another repository found above it
  rmSync(path.join(repos[0], ".xit"), { recursive: true, force: true })
  expect(await inbox(owner, hub.url)).toEqual(empty)
  expect(await unread(owner, hub.url)).toBe(0)
})
