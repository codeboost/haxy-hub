import type { APIRequestContext } from "@playwright/test"
import { expect, test } from "./support/fixtures"
import { assignIssue, closeIssue, createIssue, setIssuesEnabled } from "./support/issues"
import { createRepo, signedIn } from "./support/repos"
import type { Backend } from "./support/backend"

// HTTP contract checks for the issue routes, through the same Vite proxy the
// browser uses. Lists and counts are compared with what Haxy's own issues
// tab (its server-rendered TUI page) shows for the same fixture.

type Count = { kind: "exact" | "at_least"; value: number } | { kind: "unknown" }
// an assignment's id: opaque, 32 hex digits
const assignment = expect.stringMatching(/^[0-9a-f]{32}$/)

type Summary = { id: string; title: string; status: string; labels: Array<{ name: string; search: string }>; assignees: Array<{ id: string; name: string | null; email: string | null; search: string }> }
type List = { status: string; items: Summary[]; page: { has_more: boolean; next_cursor: string | null; count: Count }; counts: { open: Count; closed: Count }; filters: unknown }

const id = expect.stringMatching(/^[0-9a-f]{32}$/)

/** What the TUI's issues tab shows: its two tab counts, the window's issue ids in order, and the next window's first issue. */
async function tuiIssues(backend: Backend, repo: string, status: "open" | "closed", search = "") {
  const path = `/${repo}/issues/${status}${search ? `/search:${encodeURIComponent(search)}` : ""}`
  const response = await fetch(`${backend.origin}${path}`)
  expect(response.status, path).toBe(200)
  const html = (await response.text()).replace(/<script[\s\S]*?<\/script>/g, "")
  const count = (tab: string) => {
    const match = new RegExp(`href="/${repo}/issues/${tab}[^"]*"[^>]*>(?:<span[^>]*>[^<]*</span>)?\\s*\\((\\d+)(\\+?)\\)`).exec(html)
    if (!match) throw new Error(`no ${tab} tab count on ${path}`)
    return { kind: match[2] ? "at_least" : "exact", value: Number(match[1]) }
  }
  // each row (and the "next →" row) links to an issue; wrapped rows repeat their link
  const anchors = [...html.matchAll(new RegExp(`<a [^>]*href="/${repo}/issue:([0-9a-f]{32})(?:/search:[^"]*)?"[^>]*>([\\s\\S]*?)</a>`, "g"))]
  const ids: string[] = []
  let next: string | null = null
  for (const [, issue, text] of anchors) {
    if (text.includes("next →")) next = issue
    else if (!ids.includes(issue)) ids.push(issue)
  }
  if (next !== null) ids.splice(ids.indexOf(next), ids.includes(next) ? 1 : 0)
  return { counts: { open: count("open"), closed: count("closed") }, ids, next }
}

async function list(request: APIRequestContext, base: string, query = ""): Promise<List> {
  const response = await request.get(`${base}/issues${query}`)
  expect(response.status(), await response.text()).toBe(200)
  expect(response.headers()["cache-control"]).toBe("no-store")
  return response.json()
}

test.describe("with the demo data", () => {
  test.skip(!process.env.HAXY_E2E_DEMO_BIN, "HAXY_BIN was given without HAXY_TRY_BIN")

  test("open and closed lists, their counts and their windows match the TUI's issues tab", async ({ request, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)
    const base = `${hub.url}/api/v1/repos/bobby/linux`

    const open = await list(request, base)
    const tuiOpen = await tuiIssues(backend, "bobby:linux", "open")
    expect(open.status).toBe("open")
    expect(open.counts).toEqual({ open: { kind: "exact", value: 22 }, closed: { kind: "exact", value: 3 } })
    expect(open.counts).toEqual(tuiOpen.counts)
    expect(open.page).toEqual({ has_more: true, next_cursor: tuiOpen.next, count: { kind: "exact", value: 22 } })
    expect(open.items.map((issue) => issue.id)).toEqual(tuiOpen.ids)
    expect(open.items).toHaveLength(20)
    // newest first, each with its labels linking to the list they filter
    expect(open.items[0]).toEqual({
      id,
      title: "Deprecate the legacy plugin format",
      status: "open",
      labels: [{ name: "maintenance", search: "label:maintenance" }, { name: "plugins", search: "label:plugins" }],
      author: { kind: "user", name: expect.any(String) },
      assignees: [{ id: assignment, name: "alice", email: null, search: "assignee:alice" }, { id: assignment, name: "bobby", email: null, search: "assignee:bobby" }],
      created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
      comment_count: expect.any(Number),
      conflicted: false,
    })

    // the cursor resumes where the TUI's "next" link does
    const second = await list(request, base, `?cursor=${open.page.next_cursor}`)
    expect(second.items.map((issue) => issue.id)).toEqual((await tuiIssuesAt(backend, "bobby:linux", open.page.next_cursor!)).ids)
    expect(second.items).toHaveLength(2)
    expect(second.page).toEqual({ has_more: false, next_cursor: null, count: { kind: "exact", value: 22 } })
    expect(new Set([...open.items, ...second.items].map((issue) => issue.id)).size).toBe(22)

    const closed = await list(request, base, "?status=closed")
    const tuiClosed = await tuiIssues(backend, "bobby:linux", "closed")
    expect(closed.items.map((issue) => issue.title)).toEqual(["Log rotation deletes the newest file instead of the oldest", "Progress bar overshoots 100% during resumed downloads", "Memory leak when reconnecting after network failure"])
    expect(closed.items.map((issue) => issue.id)).toEqual(tuiClosed.ids)
    expect(closed.page).toEqual({ has_more: false, next_cursor: null, count: { kind: "exact", value: 3 } })

    // a smaller page chains through the same order; page_size is capped at 100
    const small = await list(request, base, "?page_size=5")
    expect(small.items.map((issue) => issue.id)).toEqual(open.items.slice(0, 5).map((issue) => issue.id))
    const smallNext = await list(request, base, `?page_size=5&cursor=${small.page.next_cursor}`)
    expect(smallNext.items.map((issue) => issue.id)).toEqual(open.items.slice(5, 10).map((issue) => issue.id))
    const all = await list(request, base, "?page_size=1000")
    expect(all.items).toHaveLength(22)
    expect(all.page.has_more).toBe(false)
  })

  test("text, label and assignee filters are Haxy's own search, with the TUI's counts", async ({ request, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)
    const base = `${hub.url}/api/v1/repos/bobby/linux`

    for (const search of ["label:bug", "label:bug label:ui", "assignee:alice", "crash", "label:bug crash"]) {
      for (const status of ["open", "closed"] as const) {
        const body = await list(request, base, `?status=${status}&search=${encodeURIComponent(search)}`)
        const tui = await tuiIssues(backend, "bobby:linux", status, search)
        expect(body.counts, search).toEqual(tui.counts)
        expect(body.items.map((issue) => issue.id), `${status} ${search}`).toEqual(tui.ids)
      }
    }

    const bugs = await list(request, base, `?search=${encodeURIComponent("label:bug  crash")}`)
    expect(bugs.filters).toEqual({ labels: ["bug"], assignees: [], words: "crash", assignee_not_found: false })
    for (const issue of bugs.items) expect(issue.labels.map((label) => label.name)).toContain("bug")
    // a label link replaces the search's label filter and keeps its words
    expect(bugs.items[0].labels.find((label) => label.name === "crash")?.search).toBe("label:crash crash")

    const alice = await list(request, base, "?search=assignee:alice")
    expect(alice.items.map((issue) => issue.title)).toEqual(["Deprecate the legacy plugin format", "Timestamps display in UTC instead of local time"])

    const words = await list(request, base, "?search=zlib")
    expect(words.items.map((issue) => issue.title)).toEqual(["Upgrade bundled zlib to the latest release"])

    // an assignee no account holds lists nothing, and says so
    const nobody = await list(request, base, "?search=assignee:nobody-here")
    expect(nobody.filters).toEqual({ labels: [], assignees: ["nobody-here"], words: "", assignee_not_found: true })
    expect(nobody.items).toEqual([])
    expect(nobody.counts).toEqual({ open: { kind: "exact", value: 0 }, closed: { kind: "exact", value: 0 } })
  })

  test("the label listing names every label once, each linking into a filtered list", async ({ request, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)

    const response = await request.get(`${hub.url}/api/v1/repos/bobby/linux/issues/labels`)
    expect(response.status()).toBe(200)
    const labels = await response.json()
    const names: string[] = labels.items.map((label: { name: string }) => label.name)
    expect(names).toEqual([...names].sort())
    expect(new Set(names).size).toBe(names.length)
    for (const name of ["bug", "documentation", "enhancement", "logging", "maintenance", "priority-high"]) expect(names).toContain(name)
    expect(labels.items).toContainEqual({ name: "bug", search: "label:bug" })
    expect(labels.page).toEqual({ has_more: false, next_cursor: null, count: { kind: "exact", value: names.length } })

    // the links extend the search they were listed for
    const narrowed = await (await request.get(`${hub.url}/api/v1/repos/bobby/linux/issues/labels?search=${encodeURIComponent("label:ui crash")}`)).json()
    expect(narrowed.items).toContainEqual({ name: "bug", search: "label:bug crash" })

    const paged = await (await request.get(`${hub.url}/api/v1/repos/bobby/linux/issues/labels?page_size=2`)).json()
    expect(paged.items.map((label: { name: string }) => label.name)).toEqual(names.slice(0, 2))
    expect(paged.page.has_more).toBe(true)
  })

  test("an issue's own route has its whole description, independently of any list", async ({ request, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)
    const base = `${hub.url}/api/v1/repos/bobby/linux`

    const open = await list(request, base, `?search=${encodeURIComponent("expired credentials")}`)
    const summary = open.items[0]
    expect(summary.title).toBe("Improve error message for expired credentials")

    const response = await request.get(`${base}/issues/${summary.id}`)
    expect(response.status()).toBe(200)
    const issue = await response.json()
    // the same issue as listed, its links extending no list's search
    expect(issue).toMatchObject({ id: summary.id, title: summary.title, status: "open", labels: summary.labels.map((label) => ({ name: label.name, search: `label:${label.name}` })) })
    expect(issue.assignees).toEqual([{ id: assignment, name: "admin", email: null, search: "assignee:admin" }])
    expect(issue.comment_count).toBeGreaterThan(0)
    // the demo makes this description longer than the TUI's detail preview
    expect(issue.description.length).toBeGreaterThan(3)
    expect(issue.description.map((block: { kind: string }) => block.kind)).toContain("paragraph")

    // closed issues have their page too
    const closed = (await list(request, base, "?status=closed")).items[0]
    expect(await (await request.get(`${base}/issues/${closed.id}`)).json()).toMatchObject({ id: closed.id, status: "closed" })

    for (const missing of ["0".repeat(32), "not-an-id", "labelsx"]) {
      const notFound = await request.get(`${base}/issues/${missing}`)
      expect(notFound.status(), missing).toBe(404)
      expect(await notFound.json()).toEqual({ error: { code: "not_found", message: "There is no issue with this id." } })
    }
  })

  test("bad paging and status parameters are validation errors; a private repository's issues are hidden", async ({ playwright, request, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)
    const base = `${hub.url}/api/v1/repos/bobby/linux`

    const closedId = (await list(request, base, "?status=closed")).items[0].id
    for (const [query, field] of [
      ["?cursor=nonsense", "cursor"],
      ["?cursor=" + "0".repeat(32), "cursor"],
      // a closed issue doesn't start a window of the open list
      [`?cursor=${closedId}`, "cursor"],
      ["?page_size=0", "page_size"],
      ["?page_size=ten", "page_size"],
      ["?status=merged", "status"],
    ]) {
      const response = await request.get(`${base}/issues${query}`)
      expect(response.status(), query).toBe(400)
      const body = await response.json()
      expect(body.error.code, query).toBe("validation")
      expect(Object.keys(body.error.field_errors), query).toEqual([field])
    }

    const write = await request.post(`${base}/issues`, { headers: { "X-Haxy-CSRF": "x" } })
    expect(write.status()).toBe(403)

    const missing = await (await request.get(`${hub.url}/api/v1/repos/bobby/no-such-repo/issues`)).json()
    const alice = await signedIn(playwright, backend, hub.url, "alice", "password")
    for (const [viewer, context] of [["anonymous", request], ["alice", alice]] as const) {
      for (const path of ["issues", "issues?status=closed", "issues/labels", `issues/${"0".repeat(32)}`]) {
        const response = await context.get(`${hub.url}/api/v1/repos/bobby/neovim/${path}`)
        expect(response.status(), `${viewer} ${path}`).toBe(404)
        expect(await response.json(), `${viewer} ${path}`).toEqual(missing)
      }
    }
    const bobby = await signedIn(playwright, backend, hub.url, "bobby", "password")
    expect((await bobby.get(`${hub.url}/api/v1/repos/bobby/neovim/issues`)).status()).toBe(200)
    await alice.dispose()
    await bobby.dispose()
  })
})

/** The TUI's window rooted at `id` (its "next →" link). */
async function tuiIssuesAt(backend: Backend, repo: string, id: string) {
  const response = await fetch(`${backend.origin}/${repo}/issue:${id}`)
  const html = (await response.text()).replace(/<script[\s\S]*?<\/script>/g, "")
  const ids: string[] = []
  for (const [, issue, text] of html.matchAll(new RegExp(`<a [^>]*href="/${repo}/issue:([0-9a-f]{32})"[^>]*>([\\s\\S]*?)</a>`, "g"))) {
    if (!text.includes("← previous") && !ids.includes(issue)) ids.push(issue)
  }
  return { ids }
}

test("a repository whose issues are turned off has no issue routes; turning them back on restores them", async ({ playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { registerUser, alice: account } = await import("./support/accounts")
  await registerUser(backend, account)
  const owner = await signedIn(playwright, backend, hub.url, account.name, account.password)
  const repo = { owner: account.name, name: "quiet", access: "public" as const }
  await createRepo(owner, backend, repo)
  await createIssue(owner, backend, `/${repo.owner}:${repo.name}`, { title: "Visible while issues are on" })
  await setIssuesEnabled(owner, backend, repo, false)

  const overview = await (await owner.get(`${hub.url}/api/v1/repos/alice/quiet`)).json()
  expect(overview.sections).not.toContain("issues")
  for (const path of ["issues", "issues/labels"]) {
    const response = await owner.get(`${hub.url}/api/v1/repos/alice/quiet/${path}`)
    expect(response.status(), path).toBe(404)
    expect(await response.json()).toEqual({ error: { code: "not_found", message: "This repository doesn't use issues." } })
  }

  await setIssuesEnabled(owner, backend, repo, true)
  const body = await (await owner.get(`${hub.url}/api/v1/repos/alice/quiet/issues`)).json()
  expect(body.items.map((issue: Summary) => issue.title)).toEqual(["Visible while issues are on"])
  await owner.dispose()
})

test("local mode lists the opened repository's issues, with labels, assignees and closed issues", async ({ request, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  const first = await createIssue(request, backend, "", { title: "Local bug", labels: "bug local", description: "Found **offline**." })
  const second = await createIssue(request, backend, "", { title: "Local idea", labels: "idea" })
  await assignIssue(request, backend, "", second, "dev@example.test")
  await closeIssue(request, backend, "", first)

  const open = await list(request, `${hub.url}/api/v1/repo`)
  expect(open.items).toEqual([expect.objectContaining({ id: second, title: "Local idea", labels: [{ name: "idea", search: "label:idea" }], assignees: [{ id: assignment, name: null, email: "dev@example.test", search: "assignee:dev@example.test" }] })])
  expect(open.counts).toEqual({ open: { kind: "exact", value: 1 }, closed: { kind: "exact", value: 1 } })
  expect((await list(request, `${hub.url}/api/v1/repo`, "?search=assignee:dev@example.test")).items.map((issue) => issue.id)).toEqual([second])

  const detail = await (await request.get(`${hub.url}/api/v1/repo/issues/${first}`)).json()
  expect(detail).toMatchObject({ id: first, title: "Local bug", status: "closed", author: { kind: "email", email: "e2e@example.test" } })
  expect(detail.description).toEqual([{ kind: "paragraph", center: false, pre: false, inlines: [
    { text: "Found ", bold: false, italic: false, strike: false, code: false, link: null },
    { text: "offline", bold: true, italic: false, strike: false, code: false, link: null },
    { text: ".", bold: false, italic: false, strike: false, code: false, link: null },
  ] }])
  const labels = await (await request.get(`${hub.url}/api/v1/repo/issues/labels`)).json()
  expect(labels.items.map((label: { name: string }) => label.name)).toEqual(["bug", "idea", "local"])

  // each host answers the other's routes with unsupported
  expect((await request.get(`${hub.url}/api/v1/repos/someone/thing/issues`)).status()).toBe(405)
})
