import type { APIRequestContext } from "@playwright/test"
import { expect, test } from "./support/fixtures"
import { alice, registerUser, writeHeaders, type Account } from "./support/accounts"
import { commentOnDiscussion, createDiscussion, editDiscussion, removeDiscussion, setDiscussRole, tuiDiscussionPage, tuiDiscussions } from "./support/discussions"
import { createIssue } from "./support/issues"
import { createRepo, grantMember, signedIn } from "./support/repos"
import type { Backend } from "./support/backend"

// HTTP contract checks for the discussion routes, through the same Vite proxy
// the browser uses. Lists and counts are compared with what Haxy's own
// discussions tab (its server-rendered TUI page) shows, and every write is
// checked again there, after a refresh and a restart.

const bob: Account = { name: "bobby", email: "bobby@example.test", password: "battery staple horse" }
const hexId = expect.stringMatching(/^[0-9a-f]{32}$/)

type Count = { kind: "exact" | "at_least"; value: number } | { kind: "unknown" }
type Availability = { available: boolean; reason?: { code: string; message: string } }
type Summary = { id: string; title: string; labels: Array<{ name: string; search: string }>; author: unknown; created_at: string; comment_count: number }
type List = { items: Summary[]; page: { has_more: boolean; next_cursor: string | null; count: Count }; filters: unknown; actions: Record<"create", Availability> }
type Detail = Summary & { description: unknown[]; description_text: string; revision: string; actions: Record<string, Availability> }

/** Sends a JSON write through the hub, with the CSRF token a same-origin page would carry. */
async function send(request: APIRequestContext, hubUrl: string, method: string, path: string, body?: unknown) {
  const headers = { ...(await writeHeaders(request, hubUrl)), "Content-Type": "application/json" }
  return request.fetch(`${hubUrl}${path}`, { method, headers, data: body === undefined ? undefined : JSON.stringify(body) })
}

async function list(request: APIRequestContext, url: string): Promise<List> {
  const response = await request.get(url)
  expect(response.status(), await response.text()).toBe(200)
  expect(response.headers()["cache-control"]).toBe("no-store")
  return response.json()
}

/** A public repository of alice's, with bob registered too; returns both signed in. */
async function forum(playwright: Parameters<typeof signedIn>[0], backend: Backend, hubUrl: string) {
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const owner = await signedIn(playwright, backend, hubUrl, alice.name, alice.password)
  const other = await signedIn(playwright, backend, hubUrl, bob.name, bob.password)
  await createRepo(owner, backend, { name: "forum", access: "public" })
  return { owner, other, repo: { owner: alice.name, name: "forum", access: "public" as const }, base: "/api/v1/repos/alice/forum/discussions" }
}

test("the recent list, its search, its labels and its pages match Haxy's own discussions tab", async ({ playwright, request, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, other, base } = await forum(playwright, backend, hub.url)
  const roadmap = await createDiscussion(owner, backend, "/alice:forum", { title: "Roadmap for 2027", labels: "planning", description: "What comes *next*." })
  const plugins = await createDiscussion(other, backend, "/alice:forum", { title: "Plugin ideas", labels: "ideas plugins" })
  const config = await createDiscussion(owner, backend, "/alice:forum", { title: "Configuration format", labels: "ideas", description: "TOML or YAML?" })
  // a comment makes the roadmap the most recently active, as the TUI orders them
  await commentOnDiscussion(other, backend, "/alice:forum", roadmap, "Count me in.")

  const recent = await list(request, `${hub.url}${base}`)
  const tui = await tuiDiscussions(backend, "/alice:forum")
  expect(recent.items.map((discussion) => discussion.id)).toEqual([roadmap, config, plugins])
  expect(recent.items.map((discussion) => discussion.id)).toEqual(tui.ids)
  expect(recent.page).toEqual({ has_more: false, next_cursor: null, count: { kind: "exact", value: 3 } })
  expect(tui.count).toEqual(recent.page.count)
  // a discussion has no status, assignees or conflicts: only what the TUI shows of it
  expect(recent.items[0]).toEqual({
    id: roadmap,
    title: "Roadmap for 2027",
    labels: [{ name: "planning", search: "label:planning" }],
    author: { kind: "user", name: "alice" },
    created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
    comment_count: 1,
  })
  expect(recent.filters).toEqual({ labels: [], assignees: [], words: "", assignee_not_found: false })
  // anonymous readers may not open one
  expect(recent.actions).toEqual({ create: { available: false, reason: { code: "unauthenticated", message: expect.any(String) } } })

  // a smaller page chains through the same order
  const first = await list(request, `${hub.url}${base}?page_size=2`)
  expect(first.items.map((discussion) => discussion.id)).toEqual([roadmap, config])
  expect(first.page).toMatchObject({ has_more: true, next_cursor: expect.any(String), count: { kind: "exact", value: 3 } })
  const second = await list(request, `${hub.url}${base}?page_size=2&cursor=${encodeURIComponent(first.page.next_cursor!)}`)
  expect(second.items.map((discussion) => discussion.id)).toEqual([plugins])
  expect(second.page).toEqual({ has_more: false, next_cursor: null, count: { kind: "exact", value: 3 } })
  const unknown = await request.get(`${hub.url}${base}?cursor=${"0".repeat(32)}`)
  expect(unknown.status()).toBe(400)
  expect((await unknown.json()).error).toMatchObject({ code: "validation", field_errors: { cursor: expect.any(String) } })

  // Haxy's own search: labels and words, with the TUI's results
  for (const search of ["label:ideas", "label:ideas label:plugins", "toml", "label:planning toml", "assignee:alice"]) {
    const found = await list(request, `${hub.url}${base}?search=${encodeURIComponent(search)}`)
    const tuiFound = await tuiDiscussions(backend, "/alice:forum", search)
    expect(found.items.map((discussion) => discussion.id), search).toEqual(tuiFound.ids)
  }
  const ideas = await list(request, `${hub.url}${base}?search=${encodeURIComponent("label:ideas  toml")}`)
  expect(ideas.items.map((discussion) => discussion.id)).toEqual([config])
  expect(ideas.filters).toEqual({ labels: ["ideas"], assignees: [], words: "toml", assignee_not_found: false })
  // a label link replaces the search's label filter and keeps its words
  expect(ideas.items[0].labels).toEqual([{ name: "ideas", search: "label:ideas toml" }])

  const labels = await list(request, `${hub.url}${base}/labels`)
  expect(labels.items).toEqual([{ name: "ideas", search: "label:ideas" }, { name: "planning", search: "label:planning" }, { name: "plugins", search: "label:plugins" }])
  expect(labels.page).toEqual({ has_more: false, next_cursor: null, count: { kind: "exact", value: 3 } })

  // one discussion, its whole description parsed by Haxy
  const detail: Detail = await (await request.get(`${hub.url}${base}/${config}`)).json()
  expect(detail).toMatchObject({ id: config, title: "Configuration format", description_text: "TOML or YAML?", revision: expect.stringMatching(/^[0-9a-f]{32}$/), comment_count: 0 })
  expect(detail.description).toEqual([{ kind: "paragraph", center: false, pre: false, inlines: [{ text: "TOML or YAML?", bold: false, italic: false, strike: false, code: false, link: null }] }])
  expect(detail.actions).toEqual({
    edit: { available: false, reason: { code: "unauthenticated", message: expect.any(String) } },
    remove: { available: false, reason: { code: "unauthenticated", message: expect.any(String) } },
    attach: { available: false, reason: { code: "unauthenticated", message: expect.any(String) } },
  })
  expect((await request.get(`${hub.url}${base}/${"0".repeat(32)}`)).status()).toBe(404)
  expect((await (await request.get(`${hub.url}${base}/nonsense`)).json()).error).toEqual({ code: "not_found", message: "There is no discussion with this id." })
  // an issue is no discussion
  const issue = await createIssue(owner, backend, "/alice:forum", { title: "A bug" })
  expect((await request.get(`${hub.url}${base}/${issue}`)).status()).toBe(404)
  expect((await request.get(`${hub.url}/api/v1/repos/alice/forum/issues/${config}`)).status()).toBe(404)

  // wrong methods name the ones the route takes
  const wrong = await send(owner, hub.url, "PUT", base, {})
  expect(wrong.status()).toBe(405)
  expect(wrong.headers().allow).toBe("GET, HEAD, POST")
  expect((await send(owner, hub.url, "PUT", `${base}/${config}/status`, { status: "closed" })).status()).toBe(404)
  await owner.dispose()
  await other.dispose()
})

test("a cursor naming a discussion the search no longer lists is refused, never a short or skipping page", async ({ playwright, request, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, other, base } = await forum(playwright, backend, hub.url)
  for (const title of ["Plugin loading", "Plugin API", "Plugin registry"]) await createDiscussion(owner, backend, "/alice:forum", { title })
  const search = `search=${encodeURIComponent("plugin")}`

  const first = await list(request, `${hub.url}${base}?${search}&page_size=1`)
  expect(first.items.map((discussion) => discussion.title)).toEqual(["Plugin registry"])
  const cursor = encodeURIComponent(first.page.next_cursor!)

  // the same cursor with another search names a discussion that search doesn't list
  const elsewhere = await request.get(`${hub.url}${base}?search=${encodeURIComponent("loading")}&page_size=1&cursor=${cursor}`)
  expect(elsewhere.status(), await elsewhere.text()).toBe(400)
  expect((await elsewhere.json()).error).toMatchObject({ code: "validation", field_errors: { cursor: expect.any(String) } })

  // the discussion the cursor names is retitled between pages, so the words no longer match it
  const named = (await list(request, `${hub.url}${base}?${search}&page_size=1&cursor=${cursor}`)).items[0]
  await editDiscussion(owner, backend, "/alice:forum", named.id, { title: "Extension API" })
  const stale = await request.get(`${hub.url}${base}?${search}&page_size=1&cursor=${cursor}`)
  expect(stale.status(), await stale.text()).toBe(400)
  expect((await stale.json()).error).toMatchObject({ code: "validation", field_errors: { cursor: expect.any(String) } })
  await owner.dispose()
  await other.dispose()
})

test("a contributor opens, edits and removes a discussion; Haxy's own pages show each change, after a restart too", async ({ playwright, launch }) => {
  let backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, other, base } = await forum(playwright, backend, hub.url)

  // anybody who can read the repository may open one
  const listed = await list(other, `${hub.url}${base}`)
  expect(listed.actions).toEqual({ create: { available: true } })
  const chosen = "0123456789abcdef0123456789abcdef"
  const created = await send(other, hub.url, "POST", base, { id: chosen, title: "Plugin ideas", labels: "ideas plugins", description: "Share yours.\r\nAll welcome." })
  expect(created.status(), await created.text()).toBe(201)
  const opened: Detail = await created.json()
  expect(opened).toMatchObject({ id: chosen, title: "Plugin ideas", labels: [{ name: "ideas" }, { name: "plugins" }], author: { kind: "user", name: "bobby" }, description_text: "Share yours.\nAll welcome." })
  expect(opened.actions).toEqual({ edit: { available: true }, remove: { available: true }, attach: { available: true } })
  expect((await tuiDiscussions(backend, "/alice:forum")).ids).toEqual([chosen])
  expect(await tuiDiscussionPage(backend, "/alice:forum", chosen)).toContain("Plugin ideas")

  // a retried creation under the same id opens nothing more
  const again = await send(other, hub.url, "POST", base, { id: chosen, title: "Plugin ideas" })
  expect(again.status()).toBe(409)
  expect((await again.json()).error.field_errors).toEqual({ id: expect.any(String) })
  // fields are checked by the shared rules
  const untitled = await send(other, hub.url, "POST", base, { title: " ", labels: "", description: "" })
  expect(untitled.status()).toBe(400)
  expect((await untitled.json()).error.field_errors).toEqual({ title: "Enter a title." })
  expect((await send(other, hub.url, "POST", base, { title: "Long label", labels: "x".repeat(65) })).status()).toBe(400)

  // an edit against the current revision replaces the fields
  const path = `${base}/${chosen}`
  const edited = await send(other, hub.url, "PATCH", path, { revision: opened.revision, title: "Plugin ideas for 2027", labels: "ideas", description: "Share yours." })
  expect(edited.status(), await edited.text()).toBe(200)
  const after: Detail = await edited.json()
  expect(after).toMatchObject({ title: "Plugin ideas for 2027", labels: [{ name: "ideas" }], description_text: "Share yours." })
  expect(after.revision).not.toBe(opened.revision)
  expect(await tuiDiscussionPage(backend, "/alice:forum", chosen)).toContain("Plugin ideas for 2027")

  // someone else's edit through Haxy's own form lands meanwhile: an edit
  // based on what was loaded before it doesn't overwrite it
  await editDiscussion(owner, backend, "/alice:forum", chosen, { title: "Plugin ideas (moderated)", labels: "ideas" })
  const stale = await send(other, hub.url, "PATCH", path, { revision: after.revision, title: "Mine", labels: "", description: "" })
  expect(stale.status()).toBe(409)
  expect((await stale.json()).error).toMatchObject({ code: "conflict", field_errors: { revision: expect.any(String) } })
  expect(await (await other.get(`${hub.url}${path}`)).json()).toMatchObject({ title: "Plugin ideas (moderated)" })
  expect((await send(other, hub.url, "PATCH", path, { title: "No revision", labels: "", description: "" })).status()).toBe(400)

  // only its author and the repository's writers may change it
  const carol: Account = { name: "carol", email: "carol@example.test", password: "carol's password" }
  await registerUser(backend, carol)
  const third = await signedIn(playwright, backend, hub.url, carol.name, carol.password)
  const theirs: Detail = await (await third.get(`${hub.url}${path}`)).json()
  expect(theirs.actions.edit).toEqual({ available: false, reason: { code: "forbidden", message: "Only the discussion's author and the repository's writers can change it." } })
  const refused = await send(third, hub.url, "PATCH", path, { revision: theirs.revision, title: "Carol's now", labels: "", description: "" })
  expect(refused.status()).toBe(403)
  expect((await send(third, hub.url, "DELETE", path)).status()).toBe(403)

  for (const step of ["refresh", "restart"] as const) {
    if (step === "restart") backend = await backend.restart!()
    expect(await (await other.get(`${hub.url}${path}`)).json(), step).toMatchObject({ title: "Plugin ideas (moderated)" })
    expect((await tuiDiscussions(backend, "/alice:forum")).ids, step).toEqual([chosen])
  }

  // the owner removes it; a second removal finds nothing
  const removed = await send(owner, hub.url, "DELETE", path)
  expect(removed.status(), await removed.text()).toBe(200)
  expect(await removed.json()).toEqual({ id: chosen })
  expect((await other.get(`${hub.url}${path}`)).status()).toBe(404)
  expect((await send(owner, hub.url, "DELETE", path)).status()).toBe(404)
  expect((await tuiDiscussions(backend, "/alice:forum")).ids).toEqual([])
  expect((await list(other, `${hub.url}${base}`)).page.count).toEqual({ kind: "exact", value: 0 })

  // one removed through Haxy's own form is gone here too
  const other2 = await createDiscussion(owner, backend, "/alice:forum", { title: "Short-lived" })
  await removeDiscussion(owner, backend, "/alice:forum", other2)
  expect((await owner.get(`${hub.url}${base}/${other2}`)).status()).toBe(404)
  await owner.dispose()
  await other.dispose()
  await third.dispose()
})

test("discussions turned off, and a members-only creation threshold, are enforced by every route", async ({ playwright, request, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, other, repo, base } = await forum(playwright, backend, hub.url)
  const existing = await createDiscussion(owner, backend, "/alice:forum", { title: "Welcome" })
  const path = `${base}/${existing}`

  // members only: a reader may read, but not open, comment or change
  await setDiscussRole(owner, backend, repo, "members")
  const asReader = await list(other, `${hub.url}${base}`)
  expect(asReader.items.map((discussion) => discussion.id)).toEqual([existing])
  expect(asReader.actions).toEqual({ create: { available: false, reason: { code: "forbidden", message: "Your role in this repository doesn't allow opening discussions." } } })
  const refused = await send(other, hub.url, "POST", base, { title: "Not allowed" })
  expect(refused.status()).toBe(403)
  expect((await refused.json()).error).toEqual({ code: "forbidden", message: "Your role in this repository doesn't allow writing discussions." })
  const comments = await (await other.get(`${hub.url}${path}/comments`)).json()
  expect(comments.actions.create).toMatchObject({ available: false, reason: { code: "forbidden" } })
  expect((await send(other, hub.url, "POST", `${path}/comments`, { body: "Hi" })).status()).toBe(403)
  // anonymous writes are asked to log in
  const anonymous = await send(request, hub.url, "POST", base, { title: "Anonymous" })
  expect(anonymous.status()).toBe(401)
  // a member may
  await grantMember(owner, backend, { owner: "alice", name: "forum" }, bob.name)
  expect((await list(other, `${hub.url}${base}`)).actions).toEqual({ create: { available: true } })
  expect((await send(other, hub.url, "POST", base, { title: "Now allowed" })).status()).toBe(201)

  // off: no route serves them, as the TUI has no discussions tab
  await setDiscussRole(owner, backend, repo, "nobody")
  const off = { code: "not_found", message: "This repository doesn't use discussions." }
  for (const url of [base, `${base}/labels`, path, `${path}/comments`]) {
    const response = await owner.get(`${hub.url}${url}`)
    expect(response.status(), url).toBe(404)
    expect((await response.json()).error, url).toEqual(off)
  }
  for (const [method, url, body] of [["POST", base, { title: "Off" }], ["PATCH", path, { revision: "0".repeat(32), title: "Off", labels: "", description: "" }], ["DELETE", path, undefined], ["POST", `${path}/comments`, { body: "Off" }]] as const) {
    const response = await send(owner, hub.url, method, url, body)
    expect(response.status(), `${method} ${url}`).toBe(404)
    expect((await response.json()).error, `${method} ${url}`).toEqual(off)
  }
  expect((await (await owner.get(`${hub.url}/api/v1/repos/alice/forum`)).json()).sections).not.toContain("discussions")

  // on again, nothing was lost
  await setDiscussRole(owner, backend, repo, "anybody")
  expect((await list(owner, `${hub.url}${base}`)).page.count).toEqual({ kind: "exact", value: 2 })
  await owner.dispose()
  await other.dispose()
})

test("comments on a discussion are posted, replied to, edited and removed through the shared comment routes", async ({ playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, other, base } = await forum(playwright, backend, hub.url)
  const discussion = await createDiscussion(owner, backend, "/alice:forum", { title: "Roadmap" })
  const comments = `${base}/${discussion}/comments`

  const posted = await send(other, hub.url, "POST", comments, { body: "Count me in." })
  expect(posted.status(), await posted.text()).toBe(201)
  const comment = (await posted.json()).comment
  expect(comment).toMatchObject({ id: hexId, parent_id: null, author: { kind: "user", name: "bobby" }, body_text: "Count me in." })
  const replied = await send(owner, hub.url, "POST", comments, { parent_id: comment.id, body: "Welcome!" })
  expect(replied.status()).toBe(201)
  const reply = (await replied.json()).comment
  expect(reply).toMatchObject({ parent_id: comment.id, parent_author: { kind: "user", name: "bobby" } })

  const thread = await (await other.get(`${hub.url}${comments}`)).json()
  expect(thread.items.map((item: { id: string }) => item.id)).toEqual([comment.id, reply.id])
  const permalink = await (await other.get(`${hub.url}${comments}/${comment.id}`)).json()
  expect(permalink.replies.items.map((item: { id: string }) => item.id)).toEqual([reply.id])
  expect((await (await other.get(`${hub.url}${base}/${discussion}`)).json()).comment_count).toBe(2)
  expect(await tuiDiscussionPage(backend, "/alice:forum", discussion)).toContain("Welcome!")

  const edited = await send(other, hub.url, "PATCH", `${comments}/${comment.id}`, { revision: comment.revision, body: "Count me in twice." })
  expect(edited.status(), await edited.text()).toBe(200)
  expect(await tuiDiscussionPage(backend, "/alice:forum", discussion)).toContain("Count me in twice.")
  const removed = await send(owner, hub.url, "DELETE", `${comments}/${reply.id}`)
  expect((await removed.json()).comment).toMatchObject({ id: reply.id, removed: true, body_text: "" })

  // a discussion's comment route serves only its own comments; an issue's id names no discussion
  const issue = await createIssue(owner, backend, "/alice:forum", { title: "A bug" })
  const wrongKind = await other.get(`${hub.url}${base}/${issue}/comments`)
  expect(wrongKind.status()).toBe(404)
  expect((await wrongKind.json()).error).toEqual({ code: "not_found", message: "There is no discussion with this id." })
  await owner.dispose()
  await other.dispose()
})

test("local mode opens, edits and removes discussions without logging in", async ({ request, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  const base = "/api/v1/repo/discussions"

  expect((await list(request, `${hub.url}${base}`)).actions).toEqual({ create: { available: true } })
  const created = await send(request, hub.url, "POST", base, { title: "Offline notes", labels: "local" })
  expect(created.status(), await created.text()).toBe(201)
  const discussion: Detail = await created.json()
  expect(discussion).toMatchObject({ title: "Offline notes", author: { kind: "email", email: "e2e@example.test" } })
  expect((await tuiDiscussions(backend, "")).ids).toEqual([discussion.id])

  const edited = await send(request, hub.url, "PATCH", `${base}/${discussion.id}`, { revision: discussion.revision, title: "Offline notes, edited", labels: "local", description: "" })
  expect(edited.status(), await edited.text()).toBe(200)
  expect(await tuiDiscussionPage(backend, "", discussion.id)).toContain("Offline notes, edited")
  expect((await send(request, hub.url, "POST", `${base}/${discussion.id}/comments`, { body: "Noted." })).status()).toBe(201)

  expect((await send(request, hub.url, "DELETE", `${base}/${discussion.id}`)).status()).toBe(200)
  expect((await tuiDiscussions(backend, "")).ids).toEqual([])
  // a server's routes aren't local mode's
  expect((await request.get(`${hub.url}/api/v1/repos/alice/forum/discussions`)).status()).toBe(405)
})
