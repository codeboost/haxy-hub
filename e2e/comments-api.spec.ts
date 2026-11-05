import type { APIRequestContext } from "@playwright/test"
import { expect, test } from "./support/fixtures"
import { alice, registerUser, writeHeaders, type Account } from "./support/accounts"
import { postComment, tuiCommentIds, tuiCommentPage, tuiThreadPage } from "./support/comments"
import { createIssue, removeIssue, setIssueRole } from "./support/issues"
import { createRepo, signedIn } from "./support/repos"
import type { Backend } from "./support/backend"

// HTTP contract checks for the comment routes every thread kind shares,
// through the same Vite proxy the browser uses. Every write is checked again
// in Haxy's own server-rendered thread pages (the TUI's).

const bob: Account = { name: "bobby", email: "bobby@example.test", password: "battery staple horse" }
const carol: Account = { name: "carol", email: "carol@example.test", password: "correct horse battery" }
const hexId = expect.stringMatching(/^[0-9a-f]{32}$/)

type Availability = { available: boolean; reason?: { code: string; message: string } }
type Comment = {
  id: string
  parent_id: string | null
  author: { kind: string; name?: string; email?: string }
  parent_author: { kind: string; name?: string } | null
  created_at: string
  removed: boolean
  body: unknown[]
  body_text: string
  revision: string
  actions: Record<"reply" | "edit" | "remove", Availability>
}
type Window = { items: Comment[]; page: { has_more: boolean; next_cursor: string | null; count: { kind: string; value: number } }; previous_cursor: string | null }
type Permalink = { comment: Comment; thread_cursor: string | null; replies: Window }

async function send(request: APIRequestContext, hubUrl: string, method: string, path: string, body?: unknown) {
  const headers = { ...(await writeHeaders(request, hubUrl)), "Content-Type": "application/json" }
  return request.fetch(`${hubUrl}${path}`, { method, headers, data: body === undefined ? undefined : JSON.stringify(body) })
}

/** A public repository of alice's with one issue, and bob registered too; returns both signed in. */
async function tracker(playwright: Parameters<typeof signedIn>[0], backend: Backend, hubUrl: string) {
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const owner = await signedIn(playwright, backend, hubUrl, alice.name, alice.password)
  const reader = await signedIn(playwright, backend, hubUrl, bob.name, bob.password)
  await createRepo(owner, backend, { name: "tracker", access: "public" })
  const issue = await createIssue(owner, backend, "/alice:tracker", { title: "Crash on save" })
  return { owner, reader, issue, repo: { owner: alice.name, name: "tracker", access: "public" as const }, base: `/api/v1/repos/alice/tracker/issues/${issue}/comments` }
}

test("a comment and a reply posted through the API show in Haxy's own pages, after a restart too", async ({ playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, reader, issue, base } = await tracker(playwright, backend, hub.url)

  const empty: Window & { actions: Record<string, Availability> } = await (await reader.get(`${hub.url}${base}`)).json()
  expect(empty).toEqual({ items: [], page: { has_more: false, next_cursor: null, count: { kind: "exact", value: 0 } }, previous_cursor: null, actions: { create: { available: true } } })

  const chosen = "0123456789abcdef0123456789abcdef"
  const posted = await send(reader, hub.url, "POST", base, { id: chosen, body: "Seen it on **Linux** too.\r\nEvery time." })
  expect(posted.status(), await posted.text()).toBe(201)
  const comment: Permalink = await posted.json()
  expect(comment).toMatchObject({
    comment: {
      id: chosen, parent_id: null, author: { kind: "user", name: "bobby" }, parent_author: null, removed: false,
      body_text: "Seen it on **Linux** too.\nEvery time.", revision: hexId,
      actions: { reply: { available: true }, edit: { available: true }, remove: { available: true } },
    },
    thread_cursor: null,
    replies: { items: [], page: { has_more: false, next_cursor: null, count: { kind: "exact", value: 0 } }, previous_cursor: null },
  })
  expect(comment.comment.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
  expect(comment.comment.body.length).toBeGreaterThan(0)

  // a retried post under the same id is refused rather than posted twice
  const retry = await send(reader, hub.url, "POST", base, { id: chosen, body: "Seen it on **Linux** too.\r\nEvery time." })
  expect(retry.status()).toBe(409)
  expect((await retry.json()).error).toMatchObject({ code: "conflict", field_errors: { id: expect.any(String) } })

  const replied = await send(owner, hub.url, "POST", base, { parent_id: chosen, body: "Which version?" })
  expect(replied.status(), await replied.text()).toBe(201)
  const reply: Permalink = await replied.json()
  expect(reply.comment).toMatchObject({ id: hexId, parent_id: chosen, author: { kind: "user", name: "alice" }, parent_author: { kind: "user", name: "bobby" } })

  const list: Window = await (await reader.get(`${hub.url}${base}`)).json()
  expect(list.items.map((item) => item.id)).toEqual([chosen, reply.comment.id])
  expect(list.page.count).toEqual({ kind: "exact", value: 2 })
  // bob may change his own comment, not alice's
  expect(list.items[1].actions.edit).toEqual({ available: false, reason: { code: "forbidden", message: "Only the comment's author and the repository's writers can change it." } })
  const permalink: Permalink = await (await reader.get(`${hub.url}${base}/${chosen}`)).json()
  expect(permalink.replies.items.map((item) => item.id)).toEqual([reply.comment.id])
  expect((await (await reader.get(`${hub.url}/api/v1/repos/alice/tracker/issues/${issue}`)).json()).comment_count).toBe(2)

  // Haxy's own pages show both: the issue's comments, and the comment's reply
  const thread = await tuiThreadPage(backend, "/alice:tracker", issue)
  expect(thread).toContain("Which version?")
  expect(tuiCommentIds(thread, "/alice:tracker", issue)).toEqual([chosen, reply.comment.id])
  expect(await tuiCommentPage(backend, "/alice:tracker", issue, chosen)).toContain("Which version?")

  const restarted = await backend.restart!()
  expect(await (await reader.get(`${hub.url}${base}`)).json()).toMatchObject({ items: [{ id: chosen }, { id: reply.comment.id }] })
  expect(tuiCommentIds(await tuiThreadPage(restarted, "/alice:tracker", issue), "/alice:tracker", issue)).toEqual([chosen, reply.comment.id])
  await owner.dispose()
  await reader.dispose()
})

test("comments come oldest first in the TUI's windows of ten; a permalink names the window holding its comment", async ({ playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, reader, issue, base } = await tracker(playwright, backend, hub.url)
  const ids: string[] = []
  for (let n = 1; n <= 12; n++) ids.push(await postComment(owner, backend, "/alice:tracker", issue, `Comment ${n}`))

  const first: Window = await (await reader.get(`${hub.url}${base}`)).json()
  expect(first.items.map((item) => item.body_text)).toEqual(ids.slice(0, 10).map((_, index) => `Comment ${index + 1}`))
  expect(first.page).toMatchObject({ has_more: true, count: { kind: "exact", value: 12 } })
  expect(first.previous_cursor).toBeNull()
  const second: Window = await (await reader.get(`${hub.url}${base}?cursor=${encodeURIComponent(first.page.next_cursor!)}`)).json()
  expect(second.items.map((item) => item.id)).toEqual(ids.slice(10))
  expect(second.page).toMatchObject({ has_more: false, next_cursor: null })
  expect(second.previous_cursor).not.toBeNull()
  const back: Window = await (await reader.get(`${hub.url}${base}?cursor=${encodeURIComponent(second.previous_cursor!)}`)).json()
  expect(back.items.map((item) => item.id)).toEqual(ids.slice(0, 10))
  // the same windows as the TUI's own pages
  expect(tuiCommentIds(await tuiThreadPage(backend, "/alice:tracker", issue, 10), "/alice:tracker", issue)).toEqual(ids.slice(10))

  const small: Window = await (await reader.get(`${hub.url}${base}?page_size=5`)).json()
  expect(small.items).toHaveLength(5)
  expect((await (await reader.get(`${hub.url}${base}?page_size=500`)).json()).items).toHaveLength(12)
  for (const query of ["page_size=0", "page_size=x", "cursor=nope"]) {
    const refused = await reader.get(`${hub.url}${base}?${query}`)
    expect(refused.status(), query).toBe(400)
    expect((await refused.json()).error.code).toBe("validation")
  }

  // the twelfth comment's permalink names the second window, which shows it
  const last: Permalink = await (await reader.get(`${hub.url}${base}/${ids[11]}`)).json()
  expect(last.comment.id).toBe(ids[11])
  expect(last.thread_cursor).not.toBeNull()
  const holding: Window = await (await reader.get(`${hub.url}${base}?cursor=${encodeURIComponent(last.thread_cursor!)}`)).json()
  expect(holding.items.map((item) => item.id)).toContain(ids[11])
  expect(((await (await reader.get(`${hub.url}${base}/${ids[3]}`)).json()) as Permalink).thread_cursor).toBeNull()

  // a comment's replies come in windows of their own
  const replies: string[] = []
  for (let n = 1; n <= 11; n++) replies.push(await postComment(owner, backend, "/alice:tracker", issue, `Reply ${n}`, ids[0]))
  const withReplies: Permalink = await (await reader.get(`${hub.url}${base}/${ids[0]}`)).json()
  expect(withReplies.replies.items.map((item) => item.id)).toEqual(replies.slice(0, 10))
  expect(withReplies.replies.page).toMatchObject({ has_more: true, count: { kind: "exact", value: 11 } })
  const moreReplies: Permalink = await (await reader.get(`${hub.url}${base}/${ids[0]}?cursor=${encodeURIComponent(withReplies.replies.page.next_cursor!)}`)).json()
  expect(moreReplies.replies.items.map((item) => item.id)).toEqual(replies.slice(10))
  expect(await tuiCommentPage(backend, "/alice:tracker", issue, ids[0])).toContain("Reply 10")
  await owner.dispose()
  await reader.dispose()
})

test("only a comment's author and the repository's writers may edit or remove it; edits name the revision they replace", async ({ playwright, request, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, reader, issue, base } = await tracker(playwright, backend, hub.url)
  await registerUser(backend, carol)
  const stranger = await signedIn(playwright, backend, hub.url, carol.name, carol.password)
  const bobs = await postComment(reader, backend, "/alice:tracker", issue, "Frist")
  const loaded: Permalink = await (await reader.get(`${hub.url}${base}/${bobs}`)).json()

  // another reader is offered nothing, and refused by Haxy
  const seen: Permalink = await (await stranger.get(`${hub.url}${base}/${bobs}`)).json()
  expect(seen.comment.actions).toEqual({
    reply: { available: true },
    edit: { available: false, reason: { code: "forbidden", message: "Only the comment's author and the repository's writers can change it." } },
    remove: { available: false, reason: { code: "forbidden", message: "Only the comment's author and the repository's writers can change it." } },
  })
  for (const [method, body] of [["PATCH", { revision: loaded.comment.revision, body: "Taken over" }], ["DELETE", undefined]] as const) {
    const refused = await send(stranger, hub.url, method, `${base}/${bobs}`, body)
    expect(refused.status(), method).toBe(403)
    expect((await refused.json()).error.code).toBe("forbidden")
  }
  // anonymous viewers are told to log in, and refused
  const anonymous: Permalink = await (await request.get(`${hub.url}${base}/${bobs}`)).json()
  expect(anonymous.comment.actions.reply).toEqual({ available: false, reason: { code: "unauthenticated", message: "Log in to comment on this issue." } })
  expect(anonymous.comment.actions.edit).toMatchObject({ available: false, reason: { code: "unauthenticated" } })
  for (const [method, path, body] of [["POST", base, { body: "Anonymous" }], ["PATCH", `${base}/${bobs}`, { revision: loaded.comment.revision, body: "x" }], ["DELETE", `${base}/${bobs}`, undefined]] as const) {
    const refused = await send(request, hub.url, method, path, body)
    expect(refused.status(), `${method} ${path}`).toBe(401)
    expect((await refused.json()).error.code).toBe("unauthenticated")
  }
  expect(await tuiCommentPage(backend, "/alice:tracker", issue, bobs)).toContain("Frist")

  // the author fixes it; an edit based on what was loaded before is refused
  const fixed = await send(reader, hub.url, "PATCH", `${base}/${bobs}`, { revision: loaded.comment.revision, body: "First!" })
  expect(fixed.status(), await fixed.text()).toBe(200)
  const after: Permalink = await fixed.json()
  expect(after.comment).toMatchObject({ id: bobs, body_text: "First!" })
  expect(after.comment.revision).not.toBe(loaded.comment.revision)
  const stale = await send(owner, hub.url, "PATCH", `${base}/${bobs}`, { revision: loaded.comment.revision, body: "Overwritten" })
  expect(stale.status()).toBe(409)
  expect((await stale.json()).error).toMatchObject({ code: "conflict", field_errors: { revision: expect.any(String) } })
  for (const [body, field] of [[{ revision: after.comment.revision, body: "" }, "body"], [{ revision: "", body: "x" }, "revision"]] as const) {
    const refused = await send(reader, hub.url, "PATCH", `${base}/${bobs}`, body)
    expect(refused.status(), field).toBe(400)
    expect(Object.keys((await refused.json()).error.field_errors)).toEqual([field])
  }
  expect(await tuiCommentPage(backend, "/alice:tracker", issue, bobs)).toContain("First!")

  // the repository's owner moderates it: edits, then removes it
  const moderated = await send(owner, hub.url, "PATCH", `${base}/${bobs}`, { revision: after.comment.revision, body: "First! (edited by a moderator)" })
  expect(moderated.status(), await moderated.text()).toBe(200)
  const removed = await send(owner, hub.url, "DELETE", `${base}/${bobs}`)
  expect(removed.status(), await removed.text()).toBe(200)
  const gone: Permalink = await removed.json()
  expect(gone.comment).toMatchObject({ id: bobs, removed: true, body: [], body_text: "", author: { kind: "user", name: "bobby" } })
  expect(gone.comment.actions.edit).toEqual({ available: false, reason: { code: "conflict", message: "This comment has been removed." } })
  // it stays in the thread, so its replies stay connected; removing it again changes nothing
  expect(((await (await reader.get(`${hub.url}${base}`)).json()) as Window).items).toMatchObject([{ id: bobs, removed: true }])
  expect((await send(owner, hub.url, "DELETE", `${base}/${bobs}`)).status()).toBe(200)
  const late = await send(reader, hub.url, "PATCH", `${base}/${bobs}`, { revision: gone.comment.revision, body: "Back" })
  expect(late.status()).toBe(409)
  expect((await late.json()).error).toEqual({ code: "conflict", message: "This comment has been removed." })
  const tui = await tuiThreadPage(backend, "/alice:tracker", issue)
  expect(tui).toContain("(removed)")
  expect(tui).not.toContain("edited by a moderator")
  await owner.dispose()
  await reader.dispose()
  await stranger.dispose()
})

test("comments are written only in threads that hold them, by those the issues tab lets write", async ({ playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, reader, repo, base } = await tracker(playwright, backend, hub.url)
  const other = await createIssue(owner, backend, "/alice:tracker", { title: "Other" })
  const elsewhere = await postComment(owner, backend, "/alice:tracker", other, "On the other issue")
  const otherBase = `/api/v1/repos/alice/tracker/issues/${other}/comments`

  // a comment answers only under its own thread, and a reply's parent must be in it
  expect((await reader.get(`${hub.url}${base}/${elsewhere}`)).status()).toBe(404)
  const strayReply = await send(owner, hub.url, "POST", base, { parent_id: elsewhere, body: "Here?" })
  expect(strayReply.status()).toBe(404)
  for (const [body, field] of [[{ body: "" }, "body"], [{ body: "x", parent_id: "nope" }, "parent_id"], [{ body: "x", id: "ABC" }, "id"]] as const) {
    const refused = await send(owner, hub.url, "POST", base, body)
    expect(refused.status(), field).toBe(400)
    expect(Object.keys((await refused.json()).error.field_errors)).toEqual([field])
  }
  expect((await send(owner, hub.url, "PATCH", `${base}/${elsewhere}`, { revision: "0".repeat(32), body: "x" })).status()).toBe(404)
  expect((await send(owner, hub.url, "DELETE", `${base}/${elsewhere}`)).status()).toBe(404)
  expect((await reader.get(`${hub.url}${base}/${"0".repeat(32)}`)).status()).toBe(404)
  expect((await reader.get(`${hub.url}/api/v1/repos/alice/tracker/issues/${"0".repeat(32)}/comments`)).status()).toBe(404)

  // wrong methods name the ones a route takes
  for (const [method, path, allow] of [["PUT", base, "GET, HEAD, POST"], ["POST", `${base}/${elsewhere}`, "GET, HEAD, PATCH, DELETE"]] as const) {
    const response = await send(owner, hub.url, method, path, {})
    expect(response.status(), `${method} ${path}`).toBe(405)
    expect(response.headers().allow).toBe(allow)
  }

  // once only members may write issues, a reader may not comment
  await setIssueRole(owner, backend, repo, "members")
  expect(((await (await reader.get(`${hub.url}${base}`)).json()) as { actions: Record<string, Availability> }).actions.create).toEqual({ available: false, reason: { code: "forbidden", message: "Your role in this repository doesn't allow commenting on issues." } })
  const refused = await send(reader, hub.url, "POST", base, { body: "Not allowed" })
  expect(refused.status()).toBe(403)
  expect((await refused.json()).error.code).toBe("forbidden")

  // a removed issue's comments are gone with it
  await removeIssue(owner, backend, "/alice:tracker", other)
  const removedThread = await reader.get(`${hub.url}${otherBase}`)
  expect(removedThread.status()).toBe(404)
  expect(await removedThread.json()).toEqual({ error: { code: "not_found", message: "There is no issue with this id." } })
  expect((await send(owner, hub.url, "POST", otherBase, { body: "Too late" })).status()).toBe(404)
  await owner.dispose()
  await reader.dispose()
})

test("local mode comments without logging in, as its repository's author", async ({ request, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  const issue = await createIssue(request, backend, "", { title: "Offline bug" })
  const base = `/api/v1/repo/issues/${issue}/comments`

  const posted = await send(request, hub.url, "POST", base, { body: "Offline note" })
  expect(posted.status(), await posted.text()).toBe(201)
  const comment: Permalink = await posted.json()
  expect(comment.comment).toMatchObject({ author: { kind: "email", email: "e2e@example.test" }, actions: { reply: { available: true }, edit: { available: true }, remove: { available: true } } })
  const reply: Permalink = await (await send(request, hub.url, "POST", base, { parent_id: comment.comment.id, body: "Offline reply" })).json()
  const edited = await send(request, hub.url, "PATCH", `${base}/${reply.comment.id}`, { revision: reply.comment.revision, body: "Offline reply, edited" })
  expect(edited.status(), await edited.text()).toBe(200)
  expect(await tuiCommentPage(backend, "", issue, comment.comment.id)).toContain("Offline reply, edited")
  expect((await send(request, hub.url, "DELETE", `${base}/${comment.comment.id}`)).status()).toBe(200)
  expect(await tuiThreadPage(backend, "", issue)).toContain("(removed)")
})
