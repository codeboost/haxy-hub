import type { APIRequestContext } from "@playwright/test"
import { expect, test } from "./support/fixtures"
import { alice, registerUser, writeHeaders, type Account } from "./support/accounts"
import { assignIssue, createIssue, setIssueRole, tuiIssuePage } from "./support/issues"
import { createRepo, signedIn } from "./support/repos"
import type { Backend } from "./support/backend"

// HTTP contract checks for the assignee routes, through the same Vite proxy
// the browser uses. Every change is checked again in Haxy's own
// server-rendered issue page (the TUI's), and after a restart.

const bob: Account = { name: "bobby", email: "bobby@example.test", password: "battery staple horse" }
const hex = expect.stringMatching(/^[0-9a-f]{32}$/)

type Assignee = { id: string; name: string | null; email: string | null; search: string }
type Detail = { id: string; assignees: Assignee[]; actions: Record<string, { available: boolean; reason?: { code: string; message: string } }> }

/** Sends a JSON write through the hub, with the CSRF token a same-origin page would carry. */
async function send(request: APIRequestContext, hubUrl: string, method: string, path: string, body?: unknown) {
  const headers = { ...(await writeHeaders(request, hubUrl)), "Content-Type": "application/json" }
  return request.fetch(`${hubUrl}${path}`, { method, headers, data: body === undefined ? undefined : JSON.stringify(body) })
}

/** A public repository of alice's with one issue of hers, and bob registered too; both signed in. */
async function aliceAndBob(playwright: Parameters<typeof signedIn>[0], backend: Backend, hubUrl: string) {
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const owner = await signedIn(playwright, backend, hubUrl, alice.name, alice.password)
  const other = await signedIn(playwright, backend, hubUrl, bob.name, bob.password)
  await createRepo(owner, backend, { name: "tracker", access: "public" })
  const issue = await createIssue(owner, backend, "/alice:tracker", { title: "Crash on save" })
  return { owner, other, issue, repo: { owner: alice.name, name: "tracker", access: "public" as const } }
}

test("the owner assigns by account name and by email; Haxy's own page shows both, and they stay after a restart", async ({ playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, other, issue } = await aliceAndBob(playwright, backend, hub.url)
  const base = `/api/v1/repos/alice/tracker/issues/${issue}/assignees`

  const loaded: Detail = await (await owner.get(`${hub.url}/api/v1/repos/alice/tracker/issues/${issue}`)).json()
  expect(loaded.assignees).toEqual([])
  expect(loaded.actions.assign).toEqual({ available: true })

  const byName = await send(owner, hub.url, "POST", base, { assignee: "bobby" })
  expect(byName.status(), await byName.text()).toBe(200)
  expect((await byName.json() as Detail).assignees).toEqual([{ id: hex, name: "bobby", email: null, search: "assignee:bobby" }])

  // an email no account holds is shown, and filtered, by the email itself
  const byEmail = await send(owner, hub.url, "POST", base, { assignee: " outside@example.test " })
  expect(byEmail.status(), await byEmail.text()).toBe(200)
  const both: Detail = await byEmail.json()
  expect(both.assignees).toEqual([
    { id: hex, name: "bobby", email: null, search: "assignee:bobby" },
    { id: hex, name: null, email: "outside@example.test", search: "assignee:outside@example.test" },
  ])
  const page = await tuiIssuePage(backend, "/alice:tracker", issue)
  expect(page).toContain("bobby")
  expect(page).toContain("outside@example.test")

  // each assignee's search lists the issue
  for (const assignee of both.assignees) {
    const list = await (await owner.get(`${hub.url}/api/v1/repos/alice/tracker/issues?search=${encodeURIComponent(assignee.search)}`)).json()
    expect(list.items.map((item: { id: string }) => item.id), assignee.search).toEqual([issue])
  }

  // someone already assigned, by name or by their account's email, is refused beside the field
  for (const assignee of ["bobby", "bobby@example.test", "outside@example.test"]) {
    const again = await send(owner, hub.url, "POST", base, { assignee })
    expect(again.status(), assignee).toBe(409)
    expect((await again.json()).error).toMatchObject({ code: "conflict", field_errors: { assignee: "This person is already assigned." } })
  }
  // as is a name no account holds, or nothing at all
  for (const [assignee, message] of [
    ["nobody-here", "No account has this name. Assign by email to name someone without an account."],
    ["  ", "Enter an account name or an email address."],
    ["two words@example.test", "This isn't an email address Haxy can assign."],
  ]) {
    const refused = await send(owner, hub.url, "POST", base, { assignee })
    expect(refused.status(), assignee).toBe(400)
    expect((await refused.json()).error).toMatchObject({ code: "validation", field_errors: { assignee: message } })
  }
  const notJson = await owner.fetch(`${hub.url}${base}`, { method: "POST", headers: { ...(await writeHeaders(owner, hub.url)), "Content-Type": "application/x-www-form-urlencoded" }, data: "assignee=bobby" })
  expect(notJson.status()).toBe(400)

  const restarted = await backend.restart!()
  const unassigned = await send(owner, hub.url, "DELETE", `${base}/${both.assignees[0].id}`)
  expect(unassigned.status(), await unassigned.text()).toBe(200)
  expect((await unassigned.json() as Detail).assignees).toEqual([both.assignees[1]])
  expect(await tuiIssuePage(restarted, "/alice:tracker", issue)).not.toContain("bobby")
  // unassigning someone no longer assigned changes nothing, and says so
  const again = await send(owner, hub.url, "DELETE", `${base}/${both.assignees[0].id}`)
  expect(again.status()).toBe(404)
  expect(await again.json()).toEqual({ error: { code: "not_found", message: "This person isn't assigned to this issue." } })
  expect((await send(owner, hub.url, "DELETE", `${base}/not-an-id`)).status()).toBe(404)
  const read: Detail = await (await owner.get(`${hub.url}/api/v1/repos/alice/tracker/issues/${issue}`)).json()
  expect(read.assignees).toEqual([both.assignees[1]])

  // someone unassigned can be assigned again
  expect((await send(owner, hub.url, "POST", base, { assignee: "bobby" })).status()).toBe(200)
  expect(await tuiIssuePage(restarted, "/alice:tracker", issue)).toContain("bobby")
  await owner.dispose()
  await other.dispose()
})

test("assignees assigned in Haxy's own pages show in the API, by name only while an account holds their email", async ({ playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, other, issue } = await aliceAndBob(playwright, backend, hub.url)
  await assignIssue(owner, backend, "/alice:tracker", issue, "bobby@example.test")
  const read: Detail = await (await other.get(`${hub.url}/api/v1/repos/alice/tracker/issues/${issue}`)).json()
  expect(read.assignees).toEqual([{ id: hex, name: "bobby", email: null, search: "assignee:bobby" }])

  // bob changes his email: the assignment keeps the old one, which no account holds now
  const changed = await send(other, hub.url, "PUT", "/api/v1/account/email", { email: "bobby@elsewhere.test" })
  expect(changed.status(), await changed.text()).toBe(200)
  const after: Detail = await (await other.get(`${hub.url}/api/v1/repos/alice/tracker/issues/${issue}`)).json()
  expect(after.assignees).toEqual([{ id: read.assignees[0].id, name: null, email: "bobby@example.test", search: "assignee:bobby@example.test" }])
  await owner.dispose()
  await other.dispose()
})

test("people who may not change an issue can't assign or unassign through the API, and nothing changes", async ({ playwright, request, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, other: reader, issue, repo } = await aliceAndBob(playwright, backend, hub.url)
  const base = `/api/v1/repos/alice/tracker/issues/${issue}/assignees`
  const assigned: Detail = await (await send(owner, hub.url, "POST", base, { assignee: "alice" })).json()
  const assignment = assigned.assignees[0].id

  // anonymous: nothing offered, every write refused
  const anonymous: Detail = await (await request.get(`${hub.url}/api/v1/repos/alice/tracker/issues/${issue}`)).json()
  expect(anonymous.actions.assign).toEqual({ available: false, reason: { code: "unauthenticated", message: "Log in to change this issue." } })
  for (const [method, path, body] of [["POST", base, { assignee: "bobby" }], ["DELETE", `${base}/${assignment}`, undefined]] as const) {
    const response = await send(request, hub.url, method, path, body)
    expect(response.status(), `${method} ${path}`).toBe(401)
    expect((await response.json()).error.code).toBe("unauthenticated")
  }

  // a reader who didn't open the issue may not change who is assigned to it
  const readers: Detail = await (await reader.get(`${hub.url}/api/v1/repos/alice/tracker/issues/${issue}`)).json()
  expect(readers.actions.assign).toEqual({ available: false, reason: { code: "forbidden", message: "Only the issue's author and the repository's writers can assign people to it." } })
  for (const [method, path, body] of [["POST", base, { assignee: "bobby" }], ["DELETE", `${base}/${assignment}`, undefined]] as const) {
    const response = await send(reader, hub.url, method, path, body)
    expect(response.status(), `${method} ${path}`).toBe(403)
    expect(await response.json()).toEqual({ error: { code: "forbidden", message: "Only the issue's author and the repository's writers can change it." } })
  }
  const unchanged: Detail = await (await owner.get(`${hub.url}/api/v1/repos/alice/tracker/issues/${issue}`)).json()
  expect(unchanged.assignees).toEqual(assigned.assignees)
  expect(await tuiIssuePage(backend, "/alice:tracker", issue)).not.toContain("bobby")

  // ... but may on an issue of their own, until only members may write issues
  const own = await createIssue(reader, backend, "/alice:tracker", { title: "Reader's" })
  expect((await send(reader, hub.url, "POST", `/api/v1/repos/alice/tracker/issues/${own}/assignees`, { assignee: "bobby" })).status()).toBe(200)
  await setIssueRole(owner, backend, repo, "members")
  const refused = await send(reader, hub.url, "POST", `/api/v1/repos/alice/tracker/issues/${own}/assignees`, { assignee: "alice" })
  expect(refused.status()).toBe(403)
  expect((await refused.json()).error.message).toBe("Your role in this repository doesn't allow writing issues.")

  // an issue that isn't one, and a repository the viewer can't read, aren't found
  const missing = await send(owner, hub.url, "POST", `/api/v1/repos/alice/tracker/issues/${"0".repeat(32)}/assignees`, { assignee: "bobby" })
  expect(await missing.json()).toEqual({ error: { code: "not_found", message: "There is no issue with this id." } })
  await createRepo(owner, backend, { name: "secret", access: "private" })
  const secret = await createIssue(owner, backend, "/alice:secret", { title: "Hidden" })
  const hidden = await send(reader, hub.url, "POST", `/api/v1/repos/alice/secret/issues/${secret}/assignees`, { assignee: "bobby" })
  expect(hidden.status()).toBe(404)
  expect((await hidden.json()).error.message).toBe("There is no repository with this name.")
  await owner.dispose()
  await reader.dispose()
})

test("the assignee routes name the methods they take", async ({ playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, other, issue } = await aliceAndBob(playwright, backend, hub.url)
  const base = `/api/v1/repos/alice/tracker/issues/${issue}/assignees`
  for (const [method, path, allow] of [
    ["GET", base, "POST"],
    ["PUT", base, "POST"],
    ["POST", `${base}/${"0".repeat(32)}`, "DELETE"],
  ] as const) {
    const response = method === "GET" ? await owner.get(`${hub.url}${path}`) : await send(owner, hub.url, method, path, {})
    expect(response.status(), `${method} ${path}`).toBe(405)
    expect(response.headers().allow, `${method} ${path}`).toBe(allow)
  }
  await owner.dispose()
  await other.dispose()
})

test("local mode assigns by email without logging in; Haxy's own page shows it", async ({ request, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  const issue = await createIssue(request, backend, "", { title: "Offline" })
  const base = `/api/v1/repo/issues/${issue}/assignees`

  const assigned = await send(request, hub.url, "POST", base, { assignee: "ada@example.test" })
  expect(assigned.status(), await assigned.text()).toBe(200)
  const detail: Detail = await assigned.json()
  expect(detail.assignees).toEqual([{ id: hex, name: null, email: "ada@example.test", search: "assignee:ada@example.test" }])
  expect(detail.actions.assign).toEqual({ available: true })
  expect(await tuiIssuePage(backend, "", issue)).toContain("ada@example.test")

  // there are no accounts to name
  const byName = await send(request, hub.url, "POST", base, { assignee: "ada" })
  expect(byName.status()).toBe(400)
  expect((await byName.json()).error.field_errors).toEqual({ assignee: "Enter an email address. Local mode has no accounts to name." })

  // one assigned in Haxy's own page shows by email too
  await assignIssue(request, backend, "", issue, "bo@example.test")
  const both: Detail = await (await request.get(`${hub.url}/api/v1/repo/issues/${issue}`)).json()
  expect(both.assignees.map((assignee) => assignee.email)).toEqual(["ada@example.test", "bo@example.test"])
  const list = await (await request.get(`${hub.url}/api/v1/repo/issues?search=${encodeURIComponent("assignee:bo@example.test")}`)).json()
  expect(list.items.map((item: { id: string }) => item.id)).toEqual([issue])

  const unassigned = await send(request, hub.url, "DELETE", `${base}/${both.assignees[0].id}`)
  expect(unassigned.status(), await unassigned.text()).toBe(200)
  expect(await tuiIssuePage(backend, "", issue)).not.toContain("ada@example.test")
  expect((await send(request, hub.url, "DELETE", `${base}/${both.assignees[0].id}`)).status()).toBe(404)
  // the server's routes aren't local mode's
  expect((await send(request, hub.url, "POST", `/api/v1/repos/someone/thing/issues/${issue}/assignees`, { assignee: "x@y.z" })).status()).toBe(405)
})
