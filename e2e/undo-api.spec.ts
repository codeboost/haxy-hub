import { request as playwrightRequest, type APIRequestContext, type APIResponse, type PlaywrightWorkerArgs } from "@playwright/test"
import { alice, registerUser, writeHeaders, type Account } from "./support/accounts"
import { expect, test, type Launch } from "./support/fixtures"
import { createIssue } from "./support/issues"
import { createRepo, grantMember, signedIn } from "./support/repos"
import { sshUser } from "./support/ssh"

// HTTP contract and authorization cases for undo (`/api/v1/repos/{owner}/{name}/undo…`)
// that the browser can't express: the history's pages and records, who
// sees it and who may undo, an undo that names a stale history, an owner demoted between
// loading the history and undoing, and local mode's refusal. They drive a real Haxy
// through Vite's proxy, and check every undo by reading the repository again.

const bob: Account = { name: "bobby", email: "bobby@example.test", password: "bobby's password" }
const carol: Account = { name: "carol", email: "carol@example.test", password: "carol's password" }

type Session = { context: APIRequestContext; headers: Record<string, string>; name: string }
type ErrorBody = { error: { code: string; message: string; field_errors?: Record<string, string> } }
type Action = { available: boolean; reason: { code: string; message: string } | null }
type UndoRecord = {
  transaction: string
  action: string
  description: string
  created_at: string | null
  undone: boolean
  details: Array<{ label: string; text: string; target: Record<string, string | null> | null }>
  actions: { undo: Action }
}
type History = { revision: string; newest: string; items: UndoRecord[]; page: { has_more: boolean; next_cursor: string | null; count: { kind: string; value: number } } }
type UndoResult = { revision: string; record: UndoRecord }

/** A request context logged in as `account` through the session API, with the headers a Hub write sends. */
async function loggedIn(hubUrl: string, account: Account): Promise<Session> {
  const context = await playwrightRequest.newContext()
  const login = await context.post(`${hubUrl}/api/v1/session`, {
    headers: await writeHeaders(context, hubUrl),
    data: { username: account.name, password: account.password },
  })
  expect(login.status()).toBe(200)
  return { context, name: account.name, headers: { ...(await writeHeaders(context, hubUrl)), "Content-Type": "application/json", "X-Haxy-Viewer": account.name } }
}

/** A server with alice, bobby and carol, and alice's public repository `history` with `issues` issues. */
async function setUp(launch: Launch, playwright: PlaywrightWorkerArgs["playwright"], issues: number) {
  const backend = await launch.server()
  for (const account of [alice, bob, carol]) await registerUser(backend, account)
  const hub = await launch.hub(backend.port)
  const owner = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  await createRepo(owner, backend, { name: "history", access: "public" })
  const ids: string[] = []
  for (let index = 0; index < issues; index++) ids.push(await createIssue(owner, backend, "/alice:history", { title: `Issue ${index}` }))
  await grantMember(owner, backend, { owner: alice.name, name: "history" }, bob.name)
  await owner.dispose()
  return { backend, hub, api: `${hub.url}/api/v1/repos/${alice.name}/history`, ids }
}

async function expectError(response: APIResponse, status: number, code: string, field?: string): Promise<ErrorBody["error"]> {
  expect(response.status()).toBe(status)
  const body = (await response.json()) as ErrorBody
  expect(body.error.code).toBe(code)
  if (field) expect(Object.keys(body.error.field_errors ?? {})).toEqual([field])
  else expect(body.error.field_errors).toBeUndefined()
  return body.error
}

async function history(context: APIRequestContext, url: string): Promise<History> {
  const response = await context.get(url)
  expect(response.status()).toBe(200)
  expect(response.headers()["cache-control"]).toBe("no-store")
  return (await response.json()) as History
}

const issueExists = async (context: APIRequestContext, api: string, id: string) => {
  const status = (await context.get(`${api}/issues/${id}`)).status()
  expect([200, 404]).toContain(status)
  return status === 200
}

test("the history pages as the TUI's undo tab lists it, for people who may write; others see none", async ({ launch, playwright, request }) => {
  const { hub, api } = await setUp(launch, playwright, 22)
  const owner = await loggedIn(hub.url, alice)
  const member = await loggedIn(hub.url, bob)
  const reader = await loggedIn(hub.url, carol)
  try {
    const first = await history(owner.context, `${api}/undo`)
    expect(first.items).toHaveLength(20)
    expect(first.newest).toBe(first.items[0].transaction)
    // the history's revision is opaque: it names the history as this read saw it
    expect(first.revision).toMatch(/^[0-9a-f]{32}$/)
    expect(first.page.has_more).toBe(true)
    // newest first, every transaction down to the initial state
    expect(first.page.count).toEqual({ kind: "exact", value: Number(first.newest) + 1 })
    // the initial state (the repository's creation), then one transaction per issue
    expect(first.items.map((item) => item.transaction)).toEqual(Array.from({ length: 20 }, (_, index) => String(22 - index)))

    // each issue's creation is a transaction that wrote its event
    const issueRow = first.items[0]
    expect(issueRow.action).toBe("events (1)")
    expect(issueRow.description).toBe("updated the event database")
    expect(issueRow.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
    expect(issueRow.undone).toBe(false)
    expect(issueRow.details).toEqual([{ label: "events", text: "view events (1)", target: { kind: "events", transaction: issueRow.transaction } }])
    expect(issueRow.actions.undo).toEqual({ available: true, reason: null })

    const second = await history(owner.context, `${api}/undo?cursor=${first.page.next_cursor}`)
    expect(second.revision).toBe(first.revision)
    expect(second.items[0].transaction).toBe(String(Number(first.items[19].transaction) - 1))
    expect(second.page.has_more).toBe(false)
    expect(second.page.next_cursor).toBeNull()
    expect(second.items.map((item) => item.transaction)).toEqual(["2", "1", "0"])
    // the initial state ends the history and can't be undone
    const initial = second.items[second.items.length - 1]
    expect(initial.transaction).toBe("0")
    expect(initial.actions.undo).toEqual({ available: false, reason: { code: "unsupported", message: "The initial state can't be undone." } })

    // a window from one transaction, and a page size
    const window = await history(owner.context, `${api}/undo/5?page_size=3`)
    expect(window.items.map((item) => item.transaction)).toEqual(["5", "4", "3"])
    expect(window.page.next_cursor).not.toBeNull()
    await expectError(await owner.context.get(`${api}/undo?page_size=0`), 400, "validation", "page_size")
    await expectError(await owner.context.get(`${api}/undo?cursor=nonsense`), 400, "validation", "cursor")
    await expectError(await owner.context.get(`${api}/undo?cursor=999`), 400, "validation", "cursor")
    for (const id of ["999", "05", "x"]) {
      const refused = await expectError(await owner.context.get(`${api}/undo/${id}`), 404, "not_found")
      expect(refused.message).toBe("There is no transaction with this id in the undo history.")
    }

    // a member sees the history, but only owners may undo
    const seen = await history(member.context, `${api}/undo`)
    expect(seen.items.map((item) => item.transaction)).toEqual(first.items.map((item) => item.transaction))
    expect(seen.items[1].actions.undo).toEqual({ available: false, reason: { code: "forbidden", message: "Only the repository's owners can undo." } })
    const forbidden = await expectError(await member.context.post(`${api}/undo`, { headers: member.headers, data: { transaction: first.newest, revision: first.revision } }), 403, "forbidden")
    expect(forbidden.message).toBe("Only the repository's owners can undo.")

    // readers and anonymous visitors get one answer, whatever the request names
    for (const context of [reader.context, request]) {
      for (const path of ["undo", "undo/1", "undo/999", "undo?cursor=nonsense"]) {
        const hidden = await expectError(await context.get(`${api}/${path}`), 404, "not_found")
        expect(hidden.message).toBe("Only people who may write to this repository see its undo history.")
      }
    }
    await expectError(await reader.context.post(`${api}/undo`, { headers: reader.headers, data: { transaction: first.newest, revision: first.revision } }), 404, "not_found")
    // a repository nobody can see is not found as a missing one
    await expectError(await owner.context.get(`${hub.url}/api/v1/repos/alice/missing/undo`), 404, "not_found")
    expect((await history(owner.context, `${api}/undo`)).revision).toBe(first.revision)
  } finally {
    for (const session of [owner, member, reader]) await session.context.dispose()
  }
})

test("an owner undoes a transaction, gets the undo's own record, and reverses it with that record's undo", async ({ launch, playwright }) => {
  const { hub, api, ids } = await setUp(launch, playwright, 2)
  const owner = await loggedIn(hub.url, alice)
  try {
    const before = await history(owner.context, `${api}/undo`)
    // the second issue's creation
    const target = before.items[0]
    expect(target.action).toBe("events (1)")

    const undone = await owner.context.post(`${api}/undo`, { headers: owner.headers, data: { transaction: target.transaction, revision: before.revision } })
    expect(undone.status()).toBe(201)
    const result = (await undone.json()) as UndoResult
    const next = String(Number(before.newest) + 1)
    expect(result.revision).toMatch(/^[0-9a-f]{32}$/)
    expect(result.revision).not.toBe(before.revision)
    expect(result.record).toMatchObject({
      transaction: next,
      action: "undo",
      description: "events (1)",
      undone: false,
      details: [{ label: "what was undone", text: "events (1)", target: { kind: "transaction", transaction: target.transaction } }],
      actions: { undo: { available: true, reason: null } },
    })
    expect(result.record.created_at).toMatch(/Z$/)
    // read again: the second issue is gone, the first stays
    expect(await issueExists(owner.context, api, ids[1])).toBe(false)
    expect(await issueExists(owner.context, api, ids[0])).toBe(true)
    const after = await history(owner.context, `${api}/undo`)
    expect(after.newest).toBe(next)
    expect(after.revision).toBe(result.revision)
    expect(after.items[0]).toEqual(result.record)
    expect(after.items.slice(1, 3).map((item) => [item.transaction, item.undone])).toEqual([[target.transaction, true], [before.items[1].transaction, false]])

    // the same request again (as after a lost answer) names a history that moved on
    await expectError(await owner.context.post(`${api}/undo`, { headers: owner.headers, data: { transaction: target.transaction, revision: before.revision } }), 409, "conflict", "revision")
    expect((await history(owner.context, `${api}/undo`)).revision).toBe(result.revision)

    // undoing the undo restores what it undid
    const reversed = await owner.context.post(`${api}/undo`, { headers: owner.headers, data: { transaction: result.record.transaction, revision: result.revision } })
    expect(reversed.status()).toBe(201)
    const restoration = (await reversed.json()) as UndoResult
    expect(restoration.record.details).toEqual([{ label: "what was redone", text: "events (1)", target: { kind: "transaction", transaction: target.transaction } }])
    expect(await issueExists(owner.context, api, ids[1])).toBe(true)

    // what can't be undone, and malformed requests
    const now = restoration.revision
    await expectError(await owner.context.post(`${api}/undo`, { headers: owner.headers, data: { transaction: "0", revision: now } }), 404, "not_found")
    await expectError(await owner.context.post(`${api}/undo`, { headers: owner.headers, data: { transaction: "999", revision: now } }), 404, "not_found")
    await expectError(await owner.context.post(`${api}/undo`, { headers: owner.headers, data: { transaction: "x", revision: now } }), 400, "validation", "transaction")
    await expectError(await owner.context.post(`${api}/undo`, { headers: owner.headers, data: { transaction: "1" } }), 400, "validation", "revision")
    await expectError(await owner.context.post(`${api}/undo/1`, { headers: owner.headers, data: { transaction: "1", revision: now } }), 405, "unsupported")
    const put = await owner.context.put(`${api}/undo`, { headers: owner.headers, data: {} })
    await expectError(put, 405, "unsupported")
    expect(put.headers().allow).toBe("GET, HEAD, POST")
    expect((await history(owner.context, `${api}/undo`)).revision).toBe(now)
  } finally {
    await owner.context.dispose()
  }
})

test("ownership is read again when the undo runs: an owner demoted after loading the history undoes nothing", async ({ launch, playwright }) => {
  const { hub, api, ids } = await setUp(launch, playwright, 1)
  const owner = await loggedIn(hub.url, alice)
  const granted = await loggedIn(hub.url, bob)
  try {
    expect((await owner.context.put(`${api}/settings/members/${bob.name}`, { headers: owner.headers, data: { role: "owner" } })).status()).toBe(200)
    // bobby loads the history as an owner
    const loaded = await history(granted.context, `${api}/undo`)
    const issueRow = loaded.items.find((item) => item.action === "events (1)" && item.details[0]?.target?.kind === "events")!
    expect(issueRow.actions.undo.available).toBe(true)

    // alice demotes him in her own session meanwhile
    expect((await owner.context.put(`${api}/settings/members/${bob.name}`, { headers: owner.headers, data: { role: "member" } })).status()).toBe(200)
    const refused = await expectError(await granted.context.post(`${api}/undo`, { headers: granted.headers, data: { transaction: issueRow.transaction, revision: loaded.revision } }), 403, "forbidden")
    expect(refused.message).toBe("Only the repository's owners can undo.")
    expect(await issueExists(owner.context, api, ids[0])).toBe(true)

    // removed from the repository: he can't see its history any more
    expect((await owner.context.delete(`${api}/settings/members/${bob.name}`, { headers: owner.headers })).status()).toBe(200)
    await expectError(await granted.context.post(`${api}/undo`, { headers: granted.headers, data: { transaction: issueRow.transaction, revision: loaded.revision } }), 404, "not_found")

    // an owner again, but the history he loaded has moved on (alice added an issue): refused, not applied over it
    expect((await owner.context.post(`${api}/settings/members`, { headers: owner.headers, data: { name: bob.name } })).status()).toBe(201)
    expect((await owner.context.put(`${api}/settings/members/${bob.name}`, { headers: owner.headers, data: { role: "owner" } })).status()).toBe(200)
    const later = await owner.context.post(`${api}/issues`, { headers: owner.headers, data: { title: "Later", labels: "", description: "" } })
    expect(later.status()).toBe(201)
    await expectError(await granted.context.post(`${api}/undo`, { headers: granted.headers, data: { transaction: issueRow.transaction, revision: loaded.revision } }), 409, "conflict", "revision")
    expect(await issueExists(owner.context, api, ids[0])).toBe(true)
  } finally {
    await owner.context.dispose()
    await granted.context.dispose()
  }
})

test("a push's record names who pushed and what it did to each ref, as structured targets", async ({ launch, playwright }) => {
  const backend = await launch.server({ ssh: true })
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  const forms = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  await createRepo(forms, backend, { name: "pushed", access: "private" })
  await forms.dispose()
  const owner = await loggedIn(hub.url, alice)
  const api = `${hub.url}/api/v1/repos/${alice.name}/pushed`
  try {
    const pusher = await sshUser(backend, hub.url, owner.context, alice.name)
    const remote = await pusher.remote(alice.name, "pushed")
    const work = await pusher.workTree("pushed", "main", [{ "README.md": "# One\n" }])
    await pusher.git(work, "push", "--quiet", remote, "main")
    const first = (await pusher.git(work, "rev-parse", "HEAD")).trim()
    await pusher.git(work, "commit", "--quiet", "--allow-empty", "-m", "Two")
    await pusher.git(work, "tag", "v1")
    await pusher.git(work, "push", "--quiet", remote, "main", "v1")
    const second = (await pusher.git(work, "rev-parse", "HEAD")).trim()

    const read = await history(owner.context, `${api}/undo`)
    const [later, earlier] = read.items.filter((item) => item.action === "push")
    expect(earlier.description).toBe("received a push")
    expect(earlier.details).toContainEqual({ label: "user", text: alice.name, target: { kind: "user", name: alice.name } })
    expect(earlier.details).toContainEqual({ label: "created branch", text: "main", target: { kind: "branch", ref: "branch:main", name: "main" } })
    expect(later.details).toContainEqual({ label: "added to branch", text: "main", target: { kind: "commits", tip: second, base: first } })
    expect(later.details).toContainEqual({ label: "created tag", text: "v1", target: { kind: "tag", ref: "tag:v1", name: "v1" } })
  } finally {
    await owner.context.dispose()
  }
})

test("ids past any history are refused, never added to", async ({ launch, playwright }) => {
  const { hub, api, ids } = await setUp(launch, playwright, 1)
  const owner = await loggedIn(hub.url, alice)
  try {
    const max = "18446744073709551615"
    const read = await history(owner.context, `${api}/undo`)
    await expectError(await owner.context.post(`${api}/undo`, { headers: owner.headers, data: { transaction: read.items[0].transaction, revision: max } }), 400, "validation", "revision")
    await expectError(await owner.context.post(`${api}/undo`, { headers: owner.headers, data: { transaction: max, revision: read.revision } }), 404, "not_found")
    await expectError(await owner.context.get(`${api}/undo?cursor=${max}`), 400, "validation", "cursor")
    await expectError(await owner.context.get(`${api}/undo/${max}`), 404, "not_found")
    // the server is still there, and nothing was undone
    expect((await history(owner.context, `${api}/undo`)).revision).toBe(read.revision)
    expect(await issueExists(owner.context, api, ids[0])).toBe(true)
  } finally {
    await owner.context.dispose()
  }
})

test("an undo chosen before the history was cleared is refused, though new transactions reuse its ids", async ({ launch, playwright }) => {
  const backend = await launch.server({ ssh: true })
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  const forms = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  await createRepo(forms, backend, { name: "history", access: "private" })
  const ids: string[] = []
  for (let index = 0; index < 2; index++) ids.push(await createIssue(forms, backend, "/alice:history", { title: `Issue ${index}` }))
  const owner = await loggedIn(hub.url, alice)
  const api = `${hub.url}/api/v1/repos/${alice.name}/history`
  try {
    const loaded = await history(owner.context, `${api}/undo`)
    const shown = loaded.items[0]

    // the owner clears the history with Haxy's own push, then two issues take its ids again
    const pusher = await sshUser(backend, hub.url, owner.context, alice.name)
    const work = await pusher.workTree("clear", "main", [{ "README.md": "# Clear\n" }])
    await pusher.git(work, "push", "--quiet", await pusher.remote(alice.name, "history"), ":refs/haxy/undo")
    expect((await history(owner.context, `${api}/undo`)).page.count).toEqual({ kind: "exact", value: 1 })
    for (let index = 2; index < 4; index++) ids.push(await createIssue(forms, backend, "/alice:history", { title: `Issue ${index}` }))
    const now = await history(owner.context, `${api}/undo`)
    expect(now.items[0].transaction).toBe(shown.transaction)

    await expectError(await owner.context.post(`${api}/undo`, { headers: owner.headers, data: { transaction: shown.transaction, revision: loaded.revision } }), 409, "conflict", "revision")
    for (const id of ids) expect(await issueExists(owner.context, api, id)).toBe(true)
  } finally {
    await owner.context.dispose()
    await forms.dispose()
  }
})

test("local mode has no undo: every undo route is unsupported", async ({ launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  const context = await playwrightRequest.newContext()
  try {
    for (const path of ["undo", "undo/1"]) {
      const refused = await expectError(await context.get(`${hub.url}/api/v1/repo/${path}`), 405, "unsupported")
      expect(refused.message).toBe("Undo is not available in local mode.")
    }
    const headers = { ...(await writeHeaders(context, hub.url)), "Content-Type": "application/json" }
    const posted = await expectError(await context.post(`${hub.url}/api/v1/repo/undo`, { headers, data: { transaction: "1", revision: "1" } }), 405, "unsupported")
    expect(posted.message).toBe("Undo is not available in local mode.")
    // the overview offers no undo section
    const overview = (await (await context.get(`${hub.url}/api/v1/repo`)).json()) as { sections: string[] }
    expect(overview.sections).not.toContain("undo")
  } finally {
    await context.dispose()
  }
})

test("a server answers the local undo routes as unsupported", async ({ launch, request }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await expectError(await request.get(`${hub.url}/api/v1/repo/undo`), 405, "unsupported")
})
