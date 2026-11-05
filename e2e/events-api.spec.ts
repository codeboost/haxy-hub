import type { APIRequestContext } from "@playwright/test"
import { expect, test } from "./support/fixtures"
import { alice, registerUser, type Account } from "./support/accounts"
import { commentOnIssue, removeIssue, tuiEvents, tuiEventTransactions } from "./support/events"
import { createIssue } from "./support/issues"
import { createRepo, signedIn } from "./support/repos"
import type { Backend } from "./support/backend"

// HTTP contract checks for the event routes, through the same Vite proxy the
// browser uses. Lists, counts and windows are compared with what Haxy's own
// events tab (its server-rendered TUI page) shows for the same fixture.

type Count = { kind: "exact" | "at_least"; value: number } | { kind: "unknown" }
type Target = { kind: "thread"; thread_kind: string; thread: string } | { kind: "comment"; thread_kind: string; thread: string; comment: string }
type Event = { id: string; kind: string; author: unknown; created_at: string | null; target: Target | null }
type List = { view: string; transaction?: string; counts: { active: Count; removed: Count }; items: Event[]; page: { has_more: boolean; next_cursor: string | null; count: Count } }

const instant = expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
const carol: Account = { name: "carol", email: "carol@example.test", password: "another horse battery" }

async function list(request: APIRequestContext, url: string): Promise<List> {
  const response = await request.get(url)
  expect(response.status(), await response.text()).toBe(200)
  expect(response.headers()["cache-control"]).toBe("no-store")
  return response.json()
}

/**
 * A server repository `alice:history` with 23 issues, a comment on the
 * first, and the second and third removed: 22 active events (more than the
 * TUI's window of 20) and 2 removed ones.
 */
async function seedHistory(playwright: Parameters<Parameters<typeof test>[2]>[0]["playwright"], backend: Backend, hubUrl: string) {
  await registerUser(backend, alice)
  const owner = await signedIn(playwright, backend, hubUrl, alice.name, alice.password)
  await createRepo(owner, backend, { name: "history", access: "public" })
  const repoBase = "/alice:history"
  const issues: string[] = []
  for (let index = 0; index < 23; index++) issues.push(await createIssue(owner, backend, repoBase, { title: `Issue ${index}` }))
  const comment = await commentOnIssue(owner, backend, repoBase, issues[0], "First comment")
  await removeIssue(owner, backend, repoBase, issues[1])
  await removeIssue(owner, backend, repoBase, issues[2])
  return { owner, repoBase, issues, comment }
}

test("active and removed events are separate lists, windowed and counted like the TUI's events tab", async ({ playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, repoBase, issues, comment } = await seedHistory(playwright, backend, hub.url)
  const base = `${hub.url}/api/v1/repos/alice/history/events`

  const active = await list(owner, base)
  const tuiActive = await tuiEvents(owner, backend, repoBase, "active")
  expect(active.view).toBe("active")
  expect(active.transaction).toBeUndefined()
  expect(active.counts).toEqual({ active: { kind: "exact", value: 22 }, removed: { kind: "exact", value: 2 } })
  expect(active.counts).toEqual(tuiActive.counts)
  expect(active.items.map((event) => event.id)).toEqual(tuiActive.ids)
  expect(active.items).toHaveLength(20)
  expect(active.page).toMatchObject({ has_more: true, count: { kind: "exact", value: 22 } })

  // the comment is the newest active event; it opens its issue's comment
  expect(active.items[0]).toEqual({ id: comment, kind: "comment", author: { kind: "user", name: "alice" }, created_at: instant, target: { kind: "comment", thread_kind: "issue", thread: issues[0], comment } })
  const issue = active.items.find((event) => event.id === issues[22])
  expect(issue).toEqual({ id: issues[22], kind: "issue", author: { kind: "user", name: "alice" }, created_at: instant, target: { kind: "thread", thread_kind: "issue", thread: issues[22] } })

  // the cursor resumes where the TUI's "next" row does
  const tuiNext = tuiActive.next!.split(":")
  const second = await list(owner, `${base}?cursor=${encodeURIComponent(active.page.next_cursor!)}`)
  expect(second.items.map((event) => event.id)).toEqual((await tuiEvents(owner, backend, repoBase, "active", { start: { kind: tuiNext[0], id: tuiNext[1] } })).ids)
  expect(second.items).toHaveLength(2)
  expect(second.page).toEqual({ has_more: false, next_cursor: null, count: { kind: "exact", value: 22 } })
  expect(new Set([...active.items, ...second.items].map((event) => event.id)).size).toBe(22)

  // removed events are their own list, with no detail links (as in the TUI)
  const removed = await list(owner, `${base}?view=removed`)
  const tuiRemoved = await tuiEvents(owner, backend, repoBase, "removed")
  expect(removed.view).toBe("removed")
  expect(removed.counts).toEqual(tuiRemoved.counts)
  expect(removed.items.map((event) => event.id)).toEqual(tuiRemoved.ids)
  expect(removed.items.map((event) => event.id).sort()).toEqual([issues[1], issues[2]].sort())
  for (const event of removed.items) expect(event).toMatchObject({ kind: "issue", target: null })
  expect(removed.page).toEqual({ has_more: false, next_cursor: null, count: { kind: "exact", value: 2 } })

  // a smaller page chains through the same order; page_size is capped at 100
  const small = await list(owner, `${base}?page_size=5`)
  expect(small.items.map((event) => event.id)).toEqual(active.items.slice(0, 5).map((event) => event.id))
  const smallNext = await list(owner, `${base}?page_size=5&cursor=${encodeURIComponent(small.page.next_cursor!)}`)
  expect(smallNext.items.map((event) => event.id)).toEqual(active.items.slice(5, 10).map((event) => event.id))
  expect((await list(owner, `${base}?page_size=1000`)).items).toHaveLength(22)
  await owner.dispose()
})

test("bad parameters are validation errors; viewers who may not write see no events", async ({ playwright, request, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner } = await seedHistory(playwright, backend, hub.url)
  const base = `${hub.url}/api/v1/repos/alice/history/events`

  const removedCursor = (await list(owner, `${base}?view=removed&page_size=1`)).page.next_cursor!
  for (const [query, field] of [
    ["?view=archived", "view"],
    ["?cursor=nonsense", "cursor"],
    [`?cursor=issue:${"0".repeat(32)}`, "cursor"],
    // a removed event doesn't start a window of the active list
    [`?cursor=${encodeURIComponent(removedCursor)}`, "cursor"],
    ["?page_size=0", "page_size"],
    ["?page_size=ten", "page_size"],
  ]) {
    const response = await owner.get(`${base}${query}`)
    expect(response.status(), query).toBe(400)
    const body = await response.json()
    expect(body.error.code, query).toBe("validation")
    expect(Object.keys(body.error.field_errors), query).toEqual([field])
  }

  // the TUI's events tab needs write access; others get the same answer as for a missing route
  await registerUser(backend, carol)
  const reader = await signedIn(playwright, backend, hub.url, carol.name, carol.password)
  for (const [viewer, context] of [["anonymous", request], ["carol", reader]] as const) {
    const overview = await (await context.get(`${hub.url}/api/v1/repos/alice/history`)).json()
    expect(overview.sections, viewer).not.toContain("events")
    for (const path of ["events", "events?view=removed", "transactions/1/events", "transactions/999999/events"]) {
      const response = await context.get(`${hub.url}/api/v1/repos/alice/history/${path}`)
      expect(response.status(), `${viewer} ${path}`).toBe(404)
      expect(await response.json(), `${viewer} ${path}`).toEqual({ error: { code: "not_found", message: "Only people who may write to this repository see its events." } })
    }
  }
  await reader.dispose()
  await owner.dispose()
})

test("a transaction's events are read as the transaction left them", async ({ playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, repoBase, issues, comment } = await seedHistory(playwright, backend, hub.url)
  const base = `${hub.url}/api/v1/repos/alice/history`

  // newest first: the two removals, then the comment
  const [removal, , commenting] = await tuiEventTransactions(owner, backend, repoBase)
  const removedNow = await list(owner, `${base}/transactions/${removal}/events?view=removed`)
  const tuiRemoved = await tuiEvents(owner, backend, repoBase, "removed", { moment: removal })
  expect(removedNow.transaction).toBe(removal)
  expect(removedNow.view).toBe("removed")
  expect(removedNow.counts).toEqual({ active: { kind: "exact", value: 0 }, removed: { kind: "exact", value: 1 } })
  expect(removedNow.counts).toEqual(tuiRemoved.counts)
  expect(removedNow.items.map((event) => event.id)).toEqual([issues[2]])
  expect(removedNow.items.map((event) => event.id)).toEqual(tuiRemoved.ids)
  expect((await list(owner, `${base}/transactions/${removal}/events`)).items).toEqual([])

  const commented = await list(owner, `${base}/transactions/${commenting}/events`)
  expect(commented.items).toEqual([expect.objectContaining({ id: comment, kind: "comment", target: { kind: "comment", thread_kind: "issue", thread: issues[0], comment } })])
  expect(commented.page).toEqual({ has_more: false, next_cursor: null, count: { kind: "exact", value: 1 } })

  for (const missing of ["999999", "0x1", "-1", "abc"]) {
    const response = await owner.get(`${base}/transactions/${missing}/events`)
    expect(response.status(), missing).toBe(404)
    expect(await response.json(), missing).toEqual({ error: { code: "not_found", message: "There is no transaction with this id whose events can be shown." } })
  }
  await owner.dispose()
})

test("local mode lists the opened repository's events; its git history has no transactions", async ({ request, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  const first = await createIssue(request, backend, "", { title: "Local bug" })
  const second = await createIssue(request, backend, "", { title: "Local idea" })
  await removeIssue(request, backend, "", first)

  const active = await list(request, `${hub.url}/api/v1/repo/events`)
  expect(active.counts).toEqual({ active: { kind: "exact", value: 1 }, removed: { kind: "exact", value: 1 } })
  expect(active.items).toEqual([{ id: second, kind: "issue", author: { kind: "email", email: "e2e@example.test" }, created_at: instant, target: { kind: "thread", thread_kind: "issue", thread: second } }])
  const removed = await list(request, `${hub.url}/api/v1/repo/events?view=removed`)
  expect(removed.items.map((event) => event.id)).toEqual([first])

  const transaction = await request.get(`${hub.url}/api/v1/repo/transactions/0/events`)
  expect(transaction.status()).toBe(404)
  // each host answers the other's routes with unsupported
  expect((await request.get(`${hub.url}/api/v1/repos/someone/thing/events`)).status()).toBe(405)
})
