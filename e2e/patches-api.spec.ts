import type { APIRequestContext } from "@playwright/test"
import { expect, test } from "./support/fixtures"
import { alice as aliceAccount, registerUser } from "./support/accounts"
import type { Backend } from "./support/backend"
import { addCommits, localGit } from "./support/history"
import { closePatch, createBranchPatch, divergeBranch, setPatchRole, tuiPatches } from "./support/patches"
import { pushRepo } from "./support/push"
import { createRepo, signedIn } from "./support/repos"

// HTTP contract checks for the patch routes, through the same Vite proxy the
// browser uses, against real Haxy fixtures: branch-backed patches made
// through Haxy's own patch form, and the demo's fork-backed ones. Lists and
// counts are compared with what Haxy's own patches tab shows.

type Count = { kind: "exact" | "at_least"; value: number } | { kind: "unknown" }
type Summary = { id: string; title: string; status: string; labels: Array<{ name: string; search: string }> }
type List = { status: string; items: Summary[]; page: { has_more: boolean; next_cursor: string | null; count: Count }; counts: Record<"open" | "closed" | "merged", Count>; actions: unknown; filters: unknown }

const id = expect.stringMatching(/^[0-9a-f]{32}$/)
const oid = expect.stringMatching(/^[0-9a-f]{40}$/)

async function get(request: APIRequestContext, url: string) {
  const response = await request.get(url)
  expect(response.status(), `${url}: ${await response.text()}`).toBe(200)
  expect(response.headers()["cache-control"]).toBe("no-store")
  return response.json()
}

function paths(diff: { items: Array<{ path: string }> }): string[] {
  return [...new Set(diff.items.map((item) => item.path))]
}

/** A local repository whose `feature` forked off `main` before `main` moved on, and whose `same` is `main` itself. */
async function divergedLocal(launch: { local(): Promise<Backend> }) {
  const backend = await launch.local()
  const git = localGit(backend)
  const commits = divergeBranch(git, "feature", [
    { message: "Add the parser", files: { "src/parser.txt": "parse\n" } },
    { message: "Test the parser", files: { "src/parser_test.txt": "test\n" } },
  ], [
    { message: "Only on main", files: { "main-only.txt": "the target moved on\n" } },
  ])
  git(["branch", "same", "main"])
  return { backend, git, commits }
}

test("a branch-backed patch shows its source, target and revision, whose commits and diff leave out the target's own history", async ({ request, launch }) => {
  const { backend, commits } = await divergedLocal(launch)
  const hub = await launch.hub(backend.port)
  const base = `${hub.url}/api/v1/repo`
  const patch = await createBranchPatch(request, backend, "", { title: "Add a parser", labels: "parser", description: "Parses **things**.", source: "feature", target: "main" })

  const detail = await get(request, `${base}/patches/${patch}`)
  expect(detail).toMatchObject({
    id: patch,
    title: "Add a parser",
    status: "open",
    labels: [{ name: "parser", search: "label:parser" }],
    assignees: [],
    comment_count: 0,
    conflicted: false,
    description_text: "Parses **things**.",
    source: { kind: "branch", name: "feature", id: "branch:feature" },
    target: { name: "main", id: "branch:main" },
    // a git repository's commits aren't counted, as in the TUI
    revision: { id, source_commit: commits.branch[1], squash_commit: oid, base_commit: commits.base, commit_count: null },
    merged: null,
    no_changes: false,
    // local mode merges with git
    mergeability: { available: false, reason: { code: "unsupported", message: expect.any(String) } },
  })
  const revision = detail.revision.id
  expect(detail.review).toEqual({ available: true, revision, diff: revision })

  // the revision's commits run from its source commit back to its base
  const history = await get(request, `${base}/commits?ref=revision:${revision}`)
  expect(history.items.map((commit: { summary: string }) => commit.summary)).toEqual(["Test the parser", "Add the parser"])
  // its files are its source commit's
  const files = await get(request, `${base}/files?ref=revision:${revision}&path=src`)
  expect(files.items.map((item: { name: string }) => item.name)).toEqual(["parser.txt", "parser_test.txt"])
  // its diff is its base against its source commit: the target's own change isn't in it
  const diff = await get(request, `${base}/revisions/${revision}/diff`)
  expect(diff).toMatchObject({ revision, base: commits.base, head: commits.branch[1], path: null, truncated: false })
  expect(paths(diff)).toEqual(["src/parser.txt", "src/parser_test.txt"])
  expect(paths(await get(request, `${base}/revisions/${revision}/diff?path=src/parser_test.txt`))).toEqual(["src/parser_test.txt"])
  const windowed = await get(request, `${base}/revisions/${revision}/diff?page_size=1`)
  expect(paths(windowed)).toEqual(["src/parser.txt"])
  expect(paths(await get(request, `${base}/revisions/${revision}/diff?page_size=1&cursor=${windowed.page.next_cursor}`))).toEqual(["src/parser_test.txt"])

  // a patch whose source is the target's tip changes nothing
  const same = await createBranchPatch(request, backend, "", { title: "Nothing new", source: "same", target: "main" })
  const unchanged = await get(request, `${base}/patches/${same}`)
  expect(unchanged).toMatchObject({ no_changes: true, source: { kind: "branch", name: "same" } })
  expect((await get(request, `${base}/revisions/${unchanged.revision.id}/diff`)).items).toEqual([])
})

test("a source branch that moves gives its patch a new revision, as the TUI shows it", async ({ request, launch }) => {
  const { backend, git } = await divergedLocal(launch)
  const hub = await launch.hub(backend.port)
  const patch = await createBranchPatch(request, backend, "", { title: "Add a parser", source: "feature", target: "main" })
  const before = await get(request, `${hub.url}/api/v1/repo/patches/${patch}`)

  git(["symbolic-ref", "HEAD", "refs/heads/feature"])
  git(["read-tree", "feature"])
  const [next] = addCommits(git, [{ message: "Document the parser", files: { "docs/parser.md": "# Parser\n" } }])
  git(["symbolic-ref", "HEAD", "refs/heads/main"])
  git(["read-tree", "main"])

  const after = await get(request, `${hub.url}/api/v1/repo/patches/${patch}`)
  expect(after.revision.source_commit).toBe(next)
  expect(after.revision.id).not.toBe(before.revision.id)
  expect(after.review).toEqual({ available: true, revision: after.revision.id, diff: after.revision.id })
  expect(paths(await get(request, `${hub.url}/api/v1/repo/revisions/${after.revision.id}/diff`))).toEqual(["docs/parser.md", "src/parser.txt", "src/parser_test.txt"])
  // the old revision still reads as it was
  expect(paths(await get(request, `${hub.url}/api/v1/repo/revisions/${before.revision.id}/diff`))).toEqual(["src/parser.txt", "src/parser_test.txt"])
  // and Haxy's own page links the new revision's diff
  const html = await (await request.get(`${backend.origin}/patch:${patch}`)).text()
  expect(html).toContain(`patchrev:${after.revision.id}`)
})

test("open, closed and merged lists, their counts, search and labels match the TUI's patches tab", async ({ request, launch }) => {
  const { backend } = await divergedLocal(launch)
  const hub = await launch.hub(backend.port)
  const base = `${hub.url}/api/v1/repo/patches`
  const parser = await createBranchPatch(request, backend, "", { title: "Add a parser", labels: "parser feature", source: "feature", target: "main" })
  const same = await createBranchPatch(request, backend, "", { title: "Nothing new", labels: "noop", source: "same", target: "main" })
  const closed = await createBranchPatch(request, backend, "", { title: "Abandoned", labels: "feature", source: "same", target: "main" })
  await closePatch(request, backend, "", closed)

  const open: List = await get(request, base)
  const tui = await tuiPatches(backend, "", "open")
  expect(open.counts).toEqual({ open: { kind: "exact", value: 2 }, closed: { kind: "exact", value: 1 }, merged: { kind: "exact", value: 0 } })
  expect(open.counts).toEqual(tui.counts)
  expect(open.items.map((patch) => patch.id)).toEqual(tui.ids)
  expect(open.items.map((patch) => patch.id)).toEqual([same, parser])
  expect(open.items[1]).toEqual({
    id: parser,
    title: "Add a parser",
    status: "open",
    labels: [{ name: "parser", search: "label:parser" }, { name: "feature", search: "label:feature" }],
    author: { kind: "email", email: expect.any(String) },
    assignees: [],
    created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
    comment_count: 0,
    conflicted: false,
  })
  expect(open.page).toEqual({ has_more: false, next_cursor: null, count: { kind: "exact", value: 2 } })
  // opening patches from Hub comes later
  expect(open.actions).toEqual({ create: { available: false, reason: { code: "unsupported", message: expect.any(String) } } })

  const closedList: List = await get(request, `${base}?status=closed`)
  expect(closedList.items.map((patch) => patch.id)).toEqual([closed])
  expect(closedList.items.map((patch) => patch.id)).toEqual((await tuiPatches(backend, "", "closed")).ids)
  expect((await get(request, `${base}?status=merged`)).items).toEqual([])

  // search is Haxy's: a label filter, words, each in every status
  const filtered: List = await get(request, `${base}?search=${encodeURIComponent("label:feature")}`)
  expect(filtered.items.map((patch) => patch.id)).toEqual([parser])
  expect(filtered.counts).toEqual({ open: { kind: "exact", value: 1 }, closed: { kind: "exact", value: 1 }, merged: { kind: "exact", value: 0 } })
  expect(filtered.filters).toEqual({ labels: ["feature"], assignees: [], words: "", assignee_not_found: false })
  expect((await get(request, `${base}?search=Nothing`)).items.map((patch: Summary) => patch.id)).toEqual([same])
  // patches have no assignees, so an assignee filter lists nothing
  expect((await get(request, `${base}?search=${encodeURIComponent("assignee:someone")}`)).items).toEqual([])

  // a window of one, and the cursor to the next
  const first: List = await get(request, `${base}?page_size=1`)
  expect(first.items.map((patch) => patch.id)).toEqual([same])
  expect(first.page).toEqual({ has_more: true, next_cursor: parser, count: { kind: "exact", value: 2 } })
  expect((await get(request, `${base}?page_size=1&cursor=${first.page.next_cursor}`)).items.map((patch: Summary) => patch.id)).toEqual([parser])

  const labels = await get(request, `${base}/labels?search=${encodeURIComponent("label:noop")}`)
  expect(labels.items).toEqual([
    { name: "feature", search: "label:feature" },
    { name: "noop", search: "label:noop" },
    { name: "parser", search: "label:parser" },
  ])
  expect(labels.page.count).toEqual({ kind: "exact", value: 3 })
})

test("patch requests are validated, and what doesn't exist is not found", async ({ request, launch }) => {
  const { backend } = await divergedLocal(launch)
  const hub = await launch.hub(backend.port)
  const base = `${hub.url}/api/v1/repo`
  const patch = await createBranchPatch(request, backend, "", { title: "Add a parser", source: "feature", target: "main" })
  const closed = await createBranchPatch(request, backend, "", { title: "Abandoned", source: "same", target: "main" })
  await closePatch(request, backend, "", closed)

  const failure = async (url: string, status: number) => {
    const response = await request.get(url)
    expect(response.status(), url).toBe(status)
    return (await response.json()).error
  }
  expect(await failure(`${base}/patches?status=draft`, 400)).toMatchObject({ code: "validation", field_errors: { status: expect.any(String) } })
  // a cursor naming a patch of another status
  expect(await failure(`${base}/patches?cursor=${closed}`, 400)).toMatchObject({ code: "validation", field_errors: { cursor: expect.any(String) } })
  expect(await failure(`${base}/patches?page_size=0`, 400)).toMatchObject({ code: "validation" })
  expect(await failure(`${base}/patches/0123456789abcdef0123456789abcdef`, 404)).toEqual({ code: "not_found", message: "There is no patch with this id." })
  expect(await failure(`${base}/revisions/0123456789abcdef0123456789abcdef/diff`, 404)).toMatchObject({ code: "not_found" })
  // the patch's id is no revision
  expect(await failure(`${base}/revisions/${patch}/diff`, 404)).toMatchObject({ code: "not_found" })
  // each host answers the other's routes with unsupported
  expect((await request.get(`${hub.url}/api/v1/repos/someone/thing/patches`)).status()).toBe(405)
})

test.describe("on a server", () => {
  test("a pushed branch's patch counts its commits and says how merging it would go", async ({ playwright, request, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    await registerUser(backend, aliceAccount)
    const context = await signedIn(playwright, backend, hub.url, aliceAccount.name, aliceAccount.password)
    await createRepo(context, backend, { name: "parser", access: "public" })
    await pushRepo(playwright, backend, hub.url, aliceAccount, { owner: "alice", name: "parser" }, {
      files: { "README.md": "# parser\n" },
      history: (git) => {
        divergeBranch(git, "feature", [
          { message: "Add the parser", files: { "src/parser.txt": "parse\n" } },
          { message: "Test the parser", files: { "src/parser_test.txt": "test\n" } },
        ], [{ message: "Only on main", files: { "main-only.txt": "moved on\n" } }])
      },
    })
    const repo = { owner: "alice", name: "parser", access: "public" } as const
    // a new repository has patches off; while they are, the patch routes say so
    const off = await request.get(`${hub.url}/api/v1/repos/alice/parser/patches`)
    expect(off.status()).toBe(404)
    expect(await off.json()).toEqual({ error: { code: "not_found", message: "This repository doesn't use patches." } })
    await setPatchRole(context, backend, repo, "anybody")
    const patch = await createBranchPatch(context, backend, "/alice:parser", { title: "Add a parser", source: "feature", target: "main" })

    // anyone who can read the repository reads its patches
    const detail = await get(request, `${hub.url}/api/v1/repos/alice/parser/patches/${patch}`)
    expect(detail).toMatchObject({
      source: { kind: "branch", name: "feature" },
      target: { name: "main" },
      revision: { commit_count: 2 },
      no_changes: false,
      mergeability: { available: true, source: "clean", squash: "clean" },
      review: { available: true },
    })
    const history = await get(request, `${hub.url}/api/v1/repos/alice/parser/commits?ref=revision:${detail.revision.id}`)
    expect(history.items.map((commit: { summary: string }) => commit.summary)).toEqual(["Test the parser", "Add the parser"])
    expect(history.page.count).toEqual({ kind: "exact", value: 2 })
    await context.dispose()
  })

  test.describe("with the demo data", () => {
    test.skip(!process.env.HAXY_E2E_DEMO_BIN, "HAXY_BIN was given without HAXY_TRY_BIN")

    test("fork-backed patches list as the TUI lists them; a merged one is reviewed at what landed", async ({ request, launch }) => {
      const backend = await launch.demo()
      const hub = await launch.hub(backend.port)
      const base = `${hub.url}/api/v1/repos/admin/toolbox/patches`

      for (const status of ["open", "closed", "merged"] as const) {
        const list: List = await get(request, `${base}?status=${status}`)
        const tui = await tuiPatches(backend, "/admin:toolbox", status)
        expect(list.counts, status).toEqual(tui.counts)
        expect(list.items.map((patch) => patch.id), status).toEqual(tui.ids)
      }
      const merged: List = await get(request, `${base}?status=merged`)
      // the demo edits its title on two sides, so either may stand
      expect(merged.items.map((patch) => patch.title)).toEqual([expect.stringMatching(/legacy configuration loader$/)])

      const detail = await get(request, `${base}/${merged.items[0].id}`)
      expect(detail).toMatchObject({
        status: "merged",
        source: { kind: "fork" },
        target: { name: "master", id: "branch:master" },
        merged: { method: "source", revision: id },
        mergeability: { available: false, reason: { code: "unsupported" } },
      })
      // its files and commits are the revision it proposed; its diff is what landed
      expect(detail.review).toEqual({ available: true, revision: detail.revision.id, diff: detail.merged.revision })
      const landed = await get(request, `${hub.url}/api/v1/repos/admin/toolbox/revisions/${detail.merged.revision}/diff`)
      expect(paths(landed)).toContain("patch.txt")
      const proposed = await get(request, `${hub.url}/api/v1/repos/admin/toolbox/revisions/${detail.revision.id}/diff`)
      expect(paths(proposed)).toEqual(["patch.txt"])

      // an open fork-backed patch's commits are in its fork
      const open: List = await get(request, `${base}?status=open`)
      const forked = await get(request, `${base}/${open.items[open.items.length - 1].id}`)
      expect(forked).toMatchObject({ source: { kind: "fork", fork: { owner: "admin", name: "toolbox" } }, review: { available: false, reason: { code: "unsupported" } } })

      // one patch carries the demo's comments, read through the shared comment routes
      const commented = open.items.find((patch) => (patch as Summary & { comment_count: number }).comment_count > 0)
      expect(commented).toMatchObject({ comment_count: 5 })
      const comments = await get(request, `${base}/${commented!.id}/comments`)
      expect(comments.page.count).toEqual({ kind: "exact", value: 5 })
    })
  })
})
