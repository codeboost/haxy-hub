import { rm } from "node:fs/promises"
import path from "node:path"
import type { APIRequestContext } from "@playwright/test"
import { expect, test } from "./support/fixtures"
import { alice, registerUser, writeHeaders, type Account } from "./support/accounts"
import { createIssue, editIssue, setIssueRole, tuiIssueIds, tuiIssuePage } from "./support/issues"
import { createRepo, grantMember, revokeMember, signedIn } from "./support/repos"
import type { Backend } from "./support/backend"

// HTTP contract checks for the issue write routes, through the same Vite
// proxy the browser uses. Every result is checked again in Haxy's own
// server-rendered issues pages (the TUI's), after a refresh and a restart.

const bob: Account = { name: "bobby", email: "bobby@example.test", password: "battery staple horse" }
const id = expect.stringMatching(/^[0-9a-f]{32}$/)

type Detail = { id: string; title: string; status: string; revision: string; description_text: string; labels: Array<{ name: string }>; actions: Record<string, { available: boolean; reason?: { code: string } }> }

/** Sends a JSON write through the hub, with the CSRF token a same-origin page would carry. */
async function send(request: APIRequestContext, hubUrl: string, method: string, path: string, body?: unknown) {
  const headers = { ...(await writeHeaders(request, hubUrl)), "Content-Type": "application/json" }
  return request.fetch(`${hubUrl}${path}`, { method, headers, data: body === undefined ? undefined : JSON.stringify(body) })
}

test("a repository owner creates an issue that Haxy's own pages show, after a restart too", async ({ playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  const owner = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  await createRepo(owner, backend, { name: "tracker", access: "public" })

  const response = await send(owner, hub.url, "POST", "/api/v1/repos/alice/tracker/issues", { title: "Crash on save", labels: "bug ui", description: "Steps:\n\n1. Save" })
  expect(response.status(), await response.text()).toBe(201)
  const created: Detail = await response.json()
  expect(created).toMatchObject({ id, title: "Crash on save", status: "open", labels: [{ name: "bug" }, { name: "ui" }], author: { kind: "user", name: "alice" }, description_text: "Steps:\n\n1. Save", revision: expect.any(String) })
  expect(created.actions).toEqual({ edit: { available: true }, set_status: { available: true }, remove: { available: true } })

  expect(await tuiIssueIds(backend, "/alice:tracker", "open")).toEqual([created.id])
  expect(await tuiIssuePage(backend, "/alice:tracker", created.id)).toContain("Crash on save")

  const restarted = await backend.restart!()
  expect(restarted.port).toBe(backend.port)
  const read = await owner.get(`${hub.url}/api/v1/repos/alice/tracker/issues/${created.id}`)
  expect(await read.json()).toMatchObject({ id: created.id, title: "Crash on save", revision: created.revision })
  expect(await tuiIssueIds(restarted, "/alice:tracker", "open")).toEqual([created.id])
  await owner.dispose()
})

/** A public repository of alice's, with bob registered too; returns both signed in. */
async function aliceAndBob(playwright: Parameters<typeof signedIn>[0], backend: Backend, hubUrl: string, name = "tracker") {
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const owner = await signedIn(playwright, backend, hubUrl, alice.name, alice.password)
  const other = await signedIn(playwright, backend, hubUrl, bob.name, bob.password)
  await createRepo(owner, backend, { name, access: "public" })
  return { owner, other, repo: { owner: alice.name, name, access: "public" as const } }
}

test("an edit made against the issue's current revision replaces its fields; one made against a stale revision is refused", async ({ playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, other } = await aliceAndBob(playwright, backend, hub.url)
  const issueId = await createIssue(owner, backend, "/alice:tracker", { title: "Typo", labels: "docs" })
  const path = `/api/v1/repos/alice/tracker/issues/${issueId}`
  const loaded: Detail = await (await owner.get(`${hub.url}${path}`)).json()

  const edited = await send(owner, hub.url, "PATCH", path, { revision: loaded.revision, title: "Typo in README", labels: "docs good-first-issue", description: "In *Install*.\r\nSecond line." })
  expect(edited.status(), await edited.text()).toBe(200)
  const after: Detail = await edited.json()
  expect(after).toMatchObject({ id: issueId, title: "Typo in README", status: "open", description_text: "In *Install*.\nSecond line.", labels: [{ name: "docs" }, { name: "good-first-issue" }] })
  expect(after.revision).not.toBe(loaded.revision)
  expect(await tuiIssuePage(backend, "/alice:tracker", issueId)).toContain("Typo in README")

  // someone else's edit through Haxy's own form lands meanwhile: an edit
  // based on what was loaded before it doesn't overwrite it
  await editIssue(owner, backend, "/alice:tracker", issueId, { title: "Typo in the README", labels: "docs" })
  const stale = await send(owner, hub.url, "PATCH", path, { revision: after.revision, title: "Mine", labels: "", description: "" })
  expect(stale.status()).toBe(409)
  expect((await stale.json()).error).toMatchObject({ code: "conflict", field_errors: { revision: expect.any(String) } })
  expect(await (await owner.get(`${hub.url}${path}`)).json()).toMatchObject({ title: "Typo in the README" })

  // the shared field rules, beside their fields
  const current: Detail = await (await owner.get(`${hub.url}${path}`)).json()
  for (const [body, field] of [
    [{ revision: current.revision, title: "   ", labels: "", description: "" }, "title"],
    [{ revision: current.revision, title: "Fine", labels: `ok ${"x".repeat(65)}`, description: "" }, "labels"],
    [{ revision: "", title: "Fine", labels: "", description: "" }, "revision"],
    [{ revision: "seven", title: "Fine", labels: "", description: "" }, "revision"],
  ] as const) {
    const refused = await send(owner, hub.url, "PATCH", path, body)
    expect(refused.status(), field).toBe(400)
    expect(Object.keys((await refused.json()).error.field_errors)).toEqual([field])
  }
  const notJson = await owner.fetch(`${hub.url}${path}`, { method: "PATCH", headers: { ...(await writeHeaders(owner, hub.url)), "Content-Type": "application/x-www-form-urlencoded" }, data: "title=x" })
  expect(notJson.status()).toBe(400)

  const missing = await send(owner, hub.url, "PATCH", `/api/v1/repos/alice/tracker/issues/${"0".repeat(32)}`, { revision: "1", title: "x", labels: "", description: "" })
  expect(missing.status()).toBe(404)
  expect(await missing.json()).toEqual({ error: { code: "not_found", message: "There is no issue with this id." } })
  await owner.dispose()
  await other.dispose()
})

test("closing, reopening and removing an issue shows in Haxy's own lists, after a restart too", async ({ playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, other } = await aliceAndBob(playwright, backend, hub.url)
  const keep = await createIssue(owner, backend, "/alice:tracker", { title: "Keep" })
  const drop = await createIssue(owner, backend, "/alice:tracker", { title: "Drop" })
  const base = "/api/v1/repos/alice/tracker/issues"

  const closed = await send(owner, hub.url, "PUT", `${base}/${keep}/status`, { status: "closed" })
  expect(closed.status(), await closed.text()).toBe(200)
  expect(await closed.json()).toMatchObject({ id: keep, status: "closed" })
  expect(await tuiIssueIds(backend, "/alice:tracker", "closed")).toEqual([keep])
  // setting the status it has changes nothing
  expect((await send(owner, hub.url, "PUT", `${base}/${keep}/status`, { status: "closed" })).status()).toBe(200)
  expect((await send(owner, hub.url, "PUT", `${base}/${keep}/status`, { status: "merged" })).status()).toBe(400)

  const removed = await send(owner, hub.url, "DELETE", `${base}/${drop}`)
  expect(removed.status(), await removed.text()).toBe(200)
  expect(await removed.json()).toEqual({ id: drop })
  expect((await owner.get(`${hub.url}${base}/${drop}`)).status()).toBe(404)
  expect((await send(owner, hub.url, "DELETE", `${base}/${drop}`)).status()).toBe(404)
  expect(await tuiIssueIds(backend, "/alice:tracker", "open")).toEqual([])

  const restarted = await backend.restart!()
  expect(await tuiIssueIds(restarted, "/alice:tracker", "closed")).toEqual([keep])
  expect(await tuiIssueIds(restarted, "/alice:tracker", "open")).toEqual([])
  const reopened = await send(owner, hub.url, "PUT", `${base}/${keep}/status`, { status: "open" })
  expect(await reopened.json()).toMatchObject({ status: "open" })
  expect(await tuiIssueIds(restarted, "/alice:tracker", "open")).toEqual([keep])
  await owner.dispose()
  await other.dispose()
})

test("who may write follows Haxy's rules: anonymous viewers and readers below the issues role are refused, and told so", async ({ playwright, request, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, other: reader, repo } = await aliceAndBob(playwright, backend, hub.url)
  const ownersIssue = await createIssue(owner, backend, "/alice:tracker", { title: "Owner's" })
  const base = "/api/v1/repos/alice/tracker/issues"

  // anonymous: nothing offered, and every write refused
  const anonymousList = await (await request.get(`${hub.url}${base}`)).json()
  expect(anonymousList.actions).toEqual({ create: { available: false, reason: { code: "unauthenticated", message: "Log in to open an issue." } } })
  expect((await (await request.get(`${hub.url}${base}/${ownersIssue}`)).json()).actions.edit).toMatchObject({ available: false, reason: { code: "unauthenticated" } })
  for (const [method, path, body] of [
    ["POST", base, { title: "Anonymous" }],
    ["PATCH", `${base}/${ownersIssue}`, { revision: "1", title: "Anonymous", labels: "", description: "" }],
    ["PUT", `${base}/${ownersIssue}/status`, { status: "closed" }],
    ["DELETE", `${base}/${ownersIssue}`, undefined],
  ] as const) {
    const response = await send(request, hub.url, method, path, body)
    expect(response.status(), `${method} ${path}`).toBe(401)
    expect((await response.json()).error.code).toBe("unauthenticated")
  }

  // by default anybody who can read may open issues, and change their own, but not others'
  expect((await (await reader.get(`${hub.url}${base}`)).json()).actions.create).toEqual({ available: true })
  const readersOwn: Detail = await (await send(reader, hub.url, "POST", base, { title: "Reader's own" })).json()
  expect(readersOwn.actions.edit).toEqual({ available: true })
  expect((await send(reader, hub.url, "PUT", `${base}/${readersOwn.id}/status`, { status: "closed" })).status()).toBe(200)
  const others: Detail = await (await reader.get(`${hub.url}${base}/${ownersIssue}`)).json()
  expect(others.actions).toEqual({
    edit: { available: false, reason: { code: "forbidden", message: "Only the issue's author and the repository's writers can change it." } },
    set_status: { available: false, reason: { code: "forbidden", message: "Only the issue's author and the repository's writers can change it." } },
    remove: { available: false, reason: { code: "forbidden", message: "Only the issue's author and the repository's writers can change it." } },
  })
  for (const [method, path, body] of [
    ["PATCH", `${base}/${ownersIssue}`, { revision: others.revision, title: "Taken over", labels: "", description: "" }],
    ["PUT", `${base}/${ownersIssue}/status`, { status: "closed" }],
    ["DELETE", `${base}/${ownersIssue}`, undefined],
  ] as const) {
    const response = await send(reader, hub.url, method, path, body)
    expect(response.status(), `${method} ${path}`).toBe(403)
    expect((await response.json()).error.code).toBe("forbidden")
  }
  expect(await tuiIssueIds(backend, "/alice:tracker", "open")).toEqual([ownersIssue])

  // once only members may write issues, a reader may open none
  await setIssueRole(owner, backend, repo, "members")
  expect((await (await reader.get(`${hub.url}${base}`)).json()).actions.create).toEqual({ available: false, reason: { code: "forbidden", message: "Your role in this repository doesn't allow opening issues." } })
  const refused = await send(reader, hub.url, "POST", base, { title: "Not allowed" })
  expect(refused.status()).toBe(403)
  expect((await refused.json()).error.code).toBe("forbidden")
  // ... nor change the one they opened
  expect((await send(reader, hub.url, "PUT", `${base}/${readersOwn.id}/status`, { status: "open" })).status()).toBe(403)
  expect(await tuiIssueIds(backend, "/alice:tracker", "closed")).toEqual([readersOwn.id])

  // a private repository's issues don't exist to those who can't read it
  await createRepo(owner, backend, { name: "secret", access: "private" })
  const hidden = await send(reader, hub.url, "POST", "/api/v1/repos/alice/secret/issues", { title: "Hidden" })
  expect(hidden.status()).toBe(404)
  expect((await hidden.json()).error.message).toBe("There is no repository with this name.")
  await owner.dispose()
  await reader.dispose()
})

test("a member whose role is revoked after loading the issue is refused, and nothing changes", async ({ playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, other: member, repo } = await aliceAndBob(playwright, backend, hub.url)
  await setIssueRole(owner, backend, repo, "members")
  await grantMember(owner, backend, repo, bob.name)
  const issueId = await createIssue(owner, backend, "/alice:tracker", { title: "Owner issue" })
  const base = "/api/v1/repos/alice/tracker/issues"

  const loaded: Detail = await (await member.get(`${hub.url}${base}/${issueId}`)).json()
  expect(loaded.actions.set_status).toEqual({ available: true })
  expect((await (await member.get(`${hub.url}${base}`)).json()).actions.create).toEqual({ available: true })

  // the owner removes bob through Haxy's own members form
  await revokeMember(owner, backend, repo, bob.name)
  for (const [method, path, body] of [
    ["PUT", `${base}/${issueId}/status`, { status: "closed" }],
    ["PATCH", `${base}/${issueId}`, { revision: loaded.revision, title: "Changed", labels: "", description: "" }],
    ["DELETE", `${base}/${issueId}`, undefined],
    ["POST", base, { title: "New" }],
  ] as const) {
    const response = await send(member, hub.url, method, path, body)
    expect(response.status(), `${method} ${path}`).toBe(403)
    expect((await response.json()).error.code).toBe("forbidden")
  }
  expect(await tuiIssueIds(backend, "/alice:tracker", "open")).toEqual([issueId])
  expect(await tuiIssuePage(backend, "/alice:tracker", issueId)).toContain("Owner issue")
  await owner.dispose()
  await member.dispose()
})

test("a client may choose a new issue's id, so a retry can't open a second issue", async ({ playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, other } = await aliceAndBob(playwright, backend, hub.url)
  const base = "/api/v1/repos/alice/tracker/issues"
  const chosen = "0123456789abcdef0123456789abcdef"

  const first = await send(owner, hub.url, "POST", base, { id: chosen, title: "Once" })
  expect(first.status(), await first.text()).toBe(201)
  expect(await first.json()).toMatchObject({ id: chosen, title: "Once", description_text: "" })
  const retry = await send(owner, hub.url, "POST", base, { id: chosen, title: "Once" })
  expect(retry.status()).toBe(409)
  expect((await retry.json()).error).toMatchObject({ code: "conflict", field_errors: { id: expect.any(String) } })
  expect(await tuiIssueIds(backend, "/alice:tracker", "open")).toEqual([chosen])

  for (const [body, field] of [
    [{ id: "ABCDEF0123456789ABCDEF0123456789", title: "x" }, "id"],
    [{ id: "short", title: "x" }, "id"],
    [{ title: "" }, "title"],
    [{ title: 7 }, null],
  ] as const) {
    const response = await send(owner, hub.url, "POST", base, body)
    expect(response.status(), JSON.stringify(body)).toBe(400)
    const error = (await response.json()).error
    if (field) expect(Object.keys(error.field_errors)).toEqual([field])
    else expect(error.field_errors).toBeUndefined()
  }
  await owner.dispose()
  await other.dispose()
})

test("wrong methods name the ones a route takes", async ({ playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, other } = await aliceAndBob(playwright, backend, hub.url)
  const issueId = await createIssue(owner, backend, "/alice:tracker", { title: "Here" })
  const base = "/api/v1/repos/alice/tracker/issues"
  for (const [method, path, allow] of [
    ["PUT", base, "GET, HEAD, POST"],
    ["POST", `${base}/labels`, "GET, HEAD"],
    ["POST", `${base}/${issueId}`, "GET, HEAD, PATCH, DELETE"],
    ["GET", `${base}/${issueId}/status`, "PUT"],
  ] as const) {
    const response = method === "GET" ? await owner.get(`${hub.url}${path}`) : await send(owner, hub.url, method, path, {})
    expect(response.status(), `${method} ${path}`).toBe(405)
    expect(response.headers().allow, `${method} ${path}`).toBe(allow)
  }
  await owner.dispose()
  await other.dispose()
})

test("local mode writes issues without logging in, as its repository's author", async ({ request, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  const base = "/api/v1/repo/issues"

  const list = await (await request.get(`${hub.url}${base}`)).json()
  expect(list.actions).toEqual({ create: { available: true } })
  const created = await send(request, hub.url, "POST", base, { title: "Offline bug", labels: "local" })
  expect(created.status(), await created.text()).toBe(201)
  const issue: Detail = await created.json()
  expect(issue).toMatchObject({ title: "Offline bug", author: { kind: "email", email: "e2e@example.test" } })
  expect(issue.actions).toEqual({ edit: { available: true }, set_status: { available: true }, remove: { available: true } })

  const edited = await send(request, hub.url, "PATCH", `${base}/${issue.id}`, { revision: issue.revision, title: "Offline crash", labels: "local", description: "Seen offline." })
  expect(edited.status(), await edited.text()).toBe(200)
  const stale = await send(request, hub.url, "PATCH", `${base}/${issue.id}`, { revision: issue.revision, title: "Stale", labels: "", description: "" })
  expect(stale.status()).toBe(409)
  expect((await send(request, hub.url, "PUT", `${base}/${issue.id}/status`, { status: "closed" })).status()).toBe(200)
  expect(await tuiIssueIds(backend, "", "closed")).toEqual([issue.id])
  expect(await tuiIssuePage(backend, "", issue.id)).toContain("Offline crash")

  const other: Detail = await (await send(request, hub.url, "POST", base, { title: "Gone soon" })).json()
  expect((await send(request, hub.url, "DELETE", `${base}/${other.id}`)).status()).toBe(200)
  expect(await tuiIssueIds(backend, "", "open")).toEqual([])
  // the server's routes aren't local mode's
  expect((await send(request, hub.url, "POST", "/api/v1/repos/someone/thing/issues", { title: "x" })).status()).toBe(405)
})

test("in local mode, a write reads the events branch even when nothing has read it into Haxy's event db yet", async ({ request, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  const base = "/api/v1/repo/issues"
  const chosen = "fedcba9876543210fedcba9876543210"
  expect((await send(request, hub.url, "POST", base, { id: chosen, title: "Upstream issue", description: "Kept." })).status()).toBe(201)

  // as in a fresh clone: the events branch holds the issue, the event db doesn't
  const forget = () => rm(path.join(backend.dataDir, ".git", "haxy"), { force: true })
  await forget()
  const replaced = await send(request, hub.url, "POST", base, { id: chosen, title: "Replacement" })
  expect(replaced.status()).toBe(409)
  expect((await replaced.json()).error.field_errors).toEqual({ id: expect.any(String) })
  const kept: Detail = await (await request.get(`${hub.url}${base}/${chosen}`)).json()
  expect(kept).toMatchObject({ title: "Upstream issue", description_text: "Kept." })

  await forget()
  expect((await send(request, hub.url, "PATCH", `${base}/${chosen}`, { revision: kept.revision, title: "Edited", labels: "", description: "Kept." })).status()).toBe(200)
  await forget()
  expect((await send(request, hub.url, "PUT", `${base}/${chosen}/status`, { status: "closed" })).status()).toBe(200)
  expect(await tuiIssueIds(backend, "", "closed")).toEqual([chosen])
})
