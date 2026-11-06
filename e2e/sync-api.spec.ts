import http from "node:http"
import type { APIRequestContext } from "@playwright/test"
import { expect, test } from "./support/fixtures"
import { writeHeaders } from "./support/accounts"
import { createIssue, editIssue, tuiIssueIds, tuiIssuePage } from "./support/issues"
import { commitOnRemoteEvents, gitRemoteFixture, localGit, serverBase, silentRemote, syncFixture } from "./support/sync"

// HTTP contract checks for local mode's offline edits and its event sync with
// a remote, through the same Vite proxy the browser uses. Results are checked
// on both sides: the local repository after a refresh (and a restart), and
// the remote Haxy server through its own API and pages.

type Detail = { id: string; title: string; status: string; revision: string; description_text: string; conflicted: boolean }
type Count = { kind: "exact" | "at_least"; value: number } | { kind: "unknown" }
type Last = { id: string; outcome: "synced" | "failed"; finished_at: string; failure: { stage: string; message: string; remote_message: string | null } | null }
type SyncStatus = {
  remote: string | null
  state: "no_remote" | "not_fetched" | "in_sync" | "sync_needed"
  running: boolean
  last: Last | null
  conflicts: { issues: { count: Count; items: Detail[] }; patches: { count: Count } }
}

const instant = expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
const none = { issues: { count: { kind: "exact", value: 0 }, items: [] }, patches: { count: { kind: "exact", value: 0 } } }

async function status(request: APIRequestContext, hubUrl: string): Promise<SyncStatus> {
  const response = await request.get(`${hubUrl}/api/v1/repo/sync`)
  expect(response.status(), await response.text()).toBe(200)
  expect(response.headers()["cache-control"]).toBe("no-store")
  return response.json()
}

async function sync(request: APIRequestContext, hubUrl: string): Promise<SyncStatus> {
  const response = await send(request, hubUrl, "POST", "/api/v1/repo/sync")
  expect(response.status(), await response.text()).toBe(200)
  return response.json()
}

/** The ids of the issues a repository's issues API lists for `status`. */
async function issueIds(request: APIRequestContext, url: string): Promise<string[]> {
  const response = await request.get(url)
  expect(response.status(), await response.text()).toBe(200)
  return ((await response.json()) as { items: Detail[] }).items.map((issue) => issue.id)
}

/** Sends a JSON write through the hub, with the CSRF token a same-origin page would carry. */
async function send(request: APIRequestContext, hubUrl: string, method: string, path: string, body?: unknown) {
  const headers = { ...(await writeHeaders(request, hubUrl)), "Content-Type": "application/json" }
  return request.fetch(`${hubUrl}${path}`, { method, headers, data: body === undefined ? undefined : JSON.stringify(body) })
}

test("local issue edits made while the remote is unreachable persist across a restart", async ({ request, launch }) => {
  // a remote nothing listens on
  const remote = `ssh://git@127.0.0.1:${await launch.freePort()}/alice/shared`
  const backend = await launch.local({ config: { "remote.origin.url": remote } })
  const hub = await launch.hub(backend.port)
  const base = "/api/v1/repo/issues"

  const created = await send(request, hub.url, "POST", base, { title: "Written offline", labels: "offline" })
  expect(created.status(), await created.text()).toBe(201)
  const issue: Detail = await created.json()
  const edited = await send(request, hub.url, "PATCH", `${base}/${issue.id}`, { revision: issue.revision, title: "Edited offline", labels: "offline", description: "No network." })
  expect(edited.status(), await edited.text()).toBe(200)
  expect((await send(request, hub.url, "PUT", `${base}/${issue.id}/status`, { status: "closed" })).status()).toBe(200)

  const restarted = await backend.restart!()
  expect(restarted.port).toBe(backend.port)
  const read = await request.get(`${hub.url}${base}/${issue.id}`)
  expect(read.status()).toBe(200)
  expect(await read.json()).toMatchObject({ title: "Edited offline", status: "closed", description_text: "No network." })
  expect(await tuiIssueIds(restarted, "", "closed")).toEqual([issue.id])
  expect(await tuiIssuePage(restarted, "", issue.id)).toContain("Edited offline")
})

test("a sync pushes local issues to the remote and pulls the remote's, leaving the code HEAD alone", async ({ playwright, request, launch }) => {
  const { server, serverHub, owner, local, hub } = await syncFixture(playwright, launch)
  const headBefore = await localGit(local, "rev-parse", "HEAD")
  const remoteMain = await (await owner.get(`${serverHub.url}/api/v1/repos/alice/shared`)).json()

  const before = await status(request, hub.url)
  expect(before).toEqual({ remote: "origin", state: "not_fetched", running: false, last: null, conflicts: none })

  const mine: Detail = await (await send(request, hub.url, "POST", "/api/v1/repo/issues", { title: "Found offline" })).json()
  const theirs = await createIssue(owner, server, serverBase, { title: "Filed on the server" })

  const synced = await sync(request, hub.url)
  expect(synced).toEqual({ remote: "origin", state: "in_sync", running: false, last: { id: expect.any(String), outcome: "synced", finished_at: instant, failure: null }, conflicts: none })
  // the status reads the same afterwards
  expect(await status(request, hub.url)).toEqual(synced)

  // both sides list both issues: here after a refresh, there through its own API and pages
  expect((await issueIds(request, `${hub.url}/api/v1/repo/issues`)).sort()).toEqual([mine.id, theirs].sort())
  expect((await issueIds(owner, `${serverHub.url}/api/v1/repos/alice/shared/issues`)).sort()).toEqual([mine.id, theirs].sort())
  expect((await tuiIssueIds(server, serverBase, "open")).sort()).toEqual([mine.id, theirs].sort())
  expect(await tuiIssuePage(server, serverBase, mine.id)).toContain("Found offline")
  expect(await tuiIssueIds(local, "", "open")).toContain(theirs)

  // only the events branch moved: HEAD, its branch and the work tree are as they were
  expect(await localGit(local, "symbolic-ref", "HEAD")).toBe("refs/heads/main")
  expect(await localGit(local, "rev-parse", "HEAD")).toBe(headBefore)
  expect(await localGit(local, "status", "--porcelain")).toBe("")
  expect(await (await owner.get(`${serverHub.url}/api/v1/repos/alice/shared`)).json()).toEqual(remoteMain)

  // a local edit since the sync is one the remote lacks
  await send(request, hub.url, "PUT", `/api/v1/repo/issues/${mine.id}/status`, { status: "closed" })
  expect((await status(request, hub.url)).state).toBe("sync_needed")
  const again = await sync(request, hub.url)
  expect(again.state).toBe("in_sync")
  expect(again.last!.id).not.toBe(synced.last!.id)
  expect(await tuiIssueIds(server, serverBase, "closed")).toEqual([mine.id])
})

test("a sync that can't reach the remote says so, keeps the local changes, and a later sync sends them", async ({ playwright, request, launch }) => {
  const { server, local, hub } = await syncFixture(playwright, launch)
  const offline: Detail = await (await send(request, hub.url, "POST", "/api/v1/repo/issues", { title: "Written while the server is down" })).json()
  await server.stop()

  const failed = await sync(request, hub.url)
  expect(failed.last).toEqual({ id: expect.any(String), outcome: "failed", finished_at: instant, failure: { stage: "fetch", message: expect.stringContaining("Couldn't fetch the remote's events"), remote_message: null } })
  expect(failed.last!.failure!.message).toContain("your local changes are kept")
  expect(failed).toMatchObject({ remote: "origin", state: "not_fetched", running: false })
  expect(await status(request, hub.url)).toEqual(failed)
  // the local issue is still there, after a refresh and a restart
  expect(await issueIds(request, `${hub.url}/api/v1/repo/issues`)).toEqual([offline.id])
  const restarted = await local.restart!()
  expect(await tuiIssueIds(restarted, "", "open")).toEqual([offline.id])

  const back = await server.restart!()
  const synced = await sync(request, hub.url)
  expect(synced.last).toMatchObject({ outcome: "synced", failure: null })
  expect(await tuiIssueIds(back, serverBase, "open")).toEqual([offline.id])
})

test("a remote that refuses the push is reported with its own words, after the remote's events were merged here", async ({ playwright, request, launch }) => {
  // bobby may read alice's public repository but not write to it
  const bobby = { name: "bobby", email: "bobby@example.test", password: "battery staple horse" }
  const { server, owner, local, hub } = await syncFixture(playwright, launch, { as: bobby })
  const theirs = await createIssue(owner, server, serverBase, { title: "Filed on the server" })
  const mine: Detail = await (await send(request, hub.url, "POST", "/api/v1/repo/issues", { title: "Not allowed there" })).json()

  const failed = await sync(request, hub.url)
  expect(failed.last).toMatchObject({ outcome: "failed", failure: { stage: "push", message: expect.stringContaining("couldn't push yours"), remote_message: expect.stringMatching(/\S/) } })
  // what Haxy got from the remote is merged; the local issue is kept, and the remote lacks it
  expect((await issueIds(request, `${hub.url}/api/v1/repo/issues`)).sort()).toEqual([mine.id, theirs].sort())
  expect(await tuiIssueIds(server, serverBase, "open")).toEqual([theirs])
  expect(failed.state).toBe("sync_needed")
  expect(local.output()).not.toContain("internal")
})

test("concurrent edits to one issue on both sides are merged into a conflict the sync reports", async ({ playwright, request, launch }) => {
  const { server, owner, hub } = await syncFixture(playwright, launch)
  const issue: Detail = await (await send(request, hub.url, "POST", "/api/v1/repo/issues", { title: "Shared", labels: "", description: "Base" })).json()
  expect((await sync(request, hub.url)).last!.outcome).toBe("synced")

  const edited = await send(request, hub.url, "PATCH", `/api/v1/repo/issues/${issue.id}`, { revision: issue.revision, title: "Local title", labels: "", description: "Base" })
  expect(edited.status(), await edited.text()).toBe(200)
  await editIssue(owner, server, serverBase, issue.id, { title: "Server title", description: "Base" })

  const synced = await sync(request, hub.url)
  expect(synced.last).toMatchObject({ outcome: "synced", failure: null })
  expect(synced.conflicts.issues.count).toEqual({ kind: "exact", value: 1 })
  expect(synced.conflicts.issues.items).toEqual([expect.objectContaining({ id: issue.id, title: "Local title", conflicted: true })])
  expect(synced.conflicts.patches.count).toEqual({ kind: "exact", value: 0 })
  // the issue itself says so after a refresh, keeping this side's value
  const read: Detail = await (await request.get(`${hub.url}/api/v1/repo/issues/${issue.id}`)).json()
  expect(read).toMatchObject({ title: "Local title", conflicted: true })
  expect(await status(request, hub.url)).toEqual(synced)
})

test("one sync runs at a time: a second is refused while the first waits on the remote, and the status says one is running", async ({ request, launch }) => {
  const remote = await silentRemote()
  try {
    const backend = await launch.local({ config: { "remote.origin.url": remote.url } })
    const hub = await launch.hub(backend.port)
    await send(request, hub.url, "POST", "/api/v1/repo/issues", { title: "Waiting to be sent" })

    const first = send(request, hub.url, "POST", "/api/v1/repo/sync")
    await expect.poll(async () => (await status(request, hub.url)).running, { timeout: 15_000 }).toBe(true)
    const second = await send(request, hub.url, "POST", "/api/v1/repo/sync")
    expect(second.status()).toBe(409)
    expect((await second.json()).error).toEqual({ code: "conflict", message: expect.stringContaining("already running") })

    // the remote hangs up: the first sync finishes, failed at its fetch
    await remote.hangUp()
    const answered = await first
    expect(answered.status()).toBe(200)
    const body: SyncStatus = await answered.json()
    expect(body).toMatchObject({ running: false, last: { outcome: "failed", failure: { stage: "fetch" } } })
    expect((await status(request, hub.url)).running).toBe(false)
  } finally {
    await remote.close()
  }
})

test("the sync route is local mode's, and takes GET, HEAD and POST only", async ({ request, launch }) => {
  const local = await launch.local()
  const hub = await launch.hub(local.port)
  // no remote configured
  expect(await status(request, hub.url)).toEqual({ remote: null, state: "no_remote", running: false, last: null, conflicts: none })
  const synced = await sync(request, hub.url)
  expect(synced.last).toMatchObject({ outcome: "failed", failure: { stage: "remote", message: expect.stringContaining("no remote"), remote_message: null } })
  for (const method of ["PUT", "PATCH", "DELETE"]) {
    const response = await send(request, hub.url, method, "/api/v1/repo/sync")
    expect(response.status(), method).toBe(405)
    expect(response.headers().allow).toBe("GET, HEAD, POST")
  }
  // a write without the CSRF token never runs
  expect((await request.post(`${hub.url}/api/v1/repo/sync`, { headers: { Origin: hub.url } })).status()).toBe(403)

  const server = await launch.server()
  const serverHub = await launch.hub(server.port)
  for (const method of ["GET", "POST"]) {
    const response = await send(request, serverHub.url, method, "/api/v1/repo/sync")
    expect(response.status(), method).toBe(405)
    expect((await response.json()).error.code).toBe("unsupported")
  }
})

test("the hub's proxy waits for a long sync instead of cutting it off as unreachable", async ({ launch, request }) => {
  // A sync waits on the remote, which can outlast the proxy's 10s bound for
  // reads. A stand-in backend answers this one route slowly.
  const port = await launch.freePort()
  const slow = http.createServer((incoming, response) => {
    const answer = (code: number, body: unknown) => {
      response.writeHead(code, { "content-type": "application/json; charset=utf-8" })
      response.end(JSON.stringify(body))
    }
    if (incoming.url === "/api/v1/status") return answer(200, { service: "haxy", api_version: 1, mode: "local" })
    if (incoming.method === "POST" && incoming.url === "/api/v1/repo/sync") {
      incoming.resume()
      setTimeout(() => answer(200, { remote: "origin", state: "in_sync", running: false, last: { id: "1", outcome: "synced", finished_at: "2026-11-05T00:00:00Z", failure: null }, conflicts: none }), 11_000)
      return
    }
    answer(404, { error: { code: "not_found", message: "No API route matches this path." } })
  })
  await new Promise<void>((resolve) => slow.listen(port, "127.0.0.1", resolve))
  try {
    const hub = await launch.hub(port)
    const started = Date.now()
    const synced = await request.post(`${hub.url}/api/v1/repo/sync`, { headers: { Origin: hub.url }, timeout: 30_000 })
    expect(synced.status()).toBe(200)
    expect(Date.now() - started).toBeGreaterThan(10_000)
  } finally {
    slow.closeAllConnections()
    await new Promise<void>((resolve) => slow.close(() => resolve()))
  }
})

test("a sync's id is never reused, even by a restarted Haxy", async ({ request, launch }) => {
  const local = await launch.local()
  const hub = await launch.hub(local.port)
  const first = (await sync(request, hub.url)).last!
  await local.restart!()
  expect((await status(request, hub.url)).last).toBeNull()
  const second = (await sync(request, hub.url)).last!
  expect(second.id).not.toBe(first.id)
})

test("a sync from a remote whose events Haxy can't read fails at the merge, moves nothing here and pushes nothing", async ({ request, launch }) => {
  const fixture = await gitRemoteFixture(launch)
  const { local, hub } = fixture
  const synced: Detail = await (await send(request, hub.url, "POST", "/api/v1/repo/issues", { title: "Synced before" })).json()
  expect((await sync(request, hub.url)).last).toMatchObject({ outcome: "synced", failure: null })

  // something other than Haxy commits to the remote's events: not an event
  const unreadable = await commitOnRemoteEvents(fixture, "{\"id\": \"not an event")
  const mine: Detail = await (await send(request, hub.url, "POST", "/api/v1/repo/issues", { title: "Written since" })).json()
  const branch = await localGit(local, "rev-parse", "refs/heads/haxy/events")
  const events = await (await request.get(`${hub.url}/api/v1/repo/events`)).json()
  const before = await status(request, hub.url)

  const failed = await sync(request, hub.url)
  expect(failed.last).toEqual({ id: expect.any(String), outcome: "failed", finished_at: instant, failure: { stage: "merge", message: expect.stringContaining("couldn't merge them"), remote_message: null } })
  expect(failed.last!.failure!.message).toContain("Nothing changed here and nothing was pushed; your local changes are kept.")
  expect(failed.last!.failure!.message).toContain("haxy/events branch")
  // where the events stand is as before the sync: the remote's ref is back
  // where the last good sync left it, and the conflicts still read
  expect(failed).toMatchObject({ remote: "origin", state: before.state, running: false, conflicts: none })
  expect(failed.state).toBe("sync_needed")
  expect(await status(request, hub.url)).toEqual(failed)

  // the events branch didn't move, and every read of it still works
  expect(await localGit(local, "rev-parse", "refs/heads/haxy/events")).toBe(branch)
  expect((await issueIds(request, `${hub.url}/api/v1/repo/issues`)).sort()).toEqual([synced.id, mine.id].sort())
  const issue = await request.get(`${hub.url}/api/v1/repo/issues/${mine.id}`)
  expect(issue.status(), await issue.text()).toBe(200)
  expect(await (await request.get(`${hub.url}/api/v1/repo/events`)).json()).toEqual(events)
  expect(await tuiIssueIds(local, "", "open")).toEqual(expect.arrayContaining([synced.id, mine.id]))
  // nothing was pushed: the remote's events end at the unreadable commit
  expect(await fixture.remoteGit("rev-parse", "refs/heads/haxy/events")).toBe(unreadable)

  // a later sync fails the same way, and so does one after a restart
  expect((await sync(request, hub.url)).last!.failure!.stage).toBe("merge")
  const restarted = await local.restart!()
  expect(await tuiIssueIds(restarted, "", "open")).toEqual(expect.arrayContaining([synced.id, mine.id]))
  expect((await sync(request, hub.url)).last!.failure!.stage).toBe("merge")
  expect(await localGit(local, "rev-parse", "refs/heads/haxy/events")).toBe(branch)
  expect(await fixture.remoteGit("rev-parse", "refs/heads/haxy/events")).toBe(unreadable)
  expect(local.output()).not.toContain("internal")
})
