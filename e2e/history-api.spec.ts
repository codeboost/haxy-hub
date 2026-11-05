import { expect, test } from "./support/fixtures"
import { alice as aliceAccount, registerUser } from "./support/accounts"
import type { FixtureRef } from "./support/backend"
import { addCommits, localGit, type FixtureCommit } from "./support/history"
import { pushRepo } from "./support/push"
import { createRepo, signedIn } from "./support/repos"

// HTTP contract checks for commit history, full messages and commit search,
// through the same Vite proxy the browser uses, against real Haxy fixtures.

const oid = expect.stringMatching(/^[0-9a-f]{40}$/)
const bob = { name: "Bob", email: "bob@example.test" }
const carol = { name: "Carol", email: "carol@example.test" }

const latin1 = Uint8Array.from([...Buffer.from("caf"), 0xe9])
const awkwardRefs: FixtureRef[] = [
  { kind: "branch", name: "feature/a b", files: { "which.txt": "feature/a b\n" } },
  { kind: "branch", name: "naïve/ünï", files: { "which.txt": "naïve/ünï\n" } },
  { kind: "branch", name: "x%41y", files: { "which.txt": "x%41y\n" } },
  { kind: "branch", name: "a%2Fb", files: { "which.txt": "a%2Fb\n" } },
  { kind: "branch", name: latin1, files: { "which.txt": "latin-1\n" } },
  { kind: "tag", name: "release/2026 q4", files: { "which.txt": "release\n" }, annotated: true },
]

/** `count` commits "change 1"…, the last one first in the history. */
function changes(count: number): FixtureCommit[] {
  return Array.from({ length: count }, (_, index) => ({ message: `change ${index + 1}\n\nmore about change ${index + 1}` }))
}

test("history pages through the default branch newest first, without loading the whole log", async ({ request, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  const git = localGit(backend)
  const ids = addCommits(git, changes(44))
  const list = async (query = "") => {
    const response = await request.get(`${hub.url}/api/v1/repo/commits${query}`)
    expect(response.status(), query).toBe(200)
    return response.json()
  }

  const first = await list()
  expect(first.ref).toEqual({ kind: "branch", name: "main", id: "branch:main", commit: ids[43] })
  // the TUI's page of 20, keyed by the next page's first commit
  expect(first.items).toHaveLength(20)
  expect(first.items[0]).toEqual({
    id: ids[43], parent: ids[42], summary: "change 44",
    author: { kind: "email", email: "alice@example.test" }, committer: null,
    committed_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/), merge: false,
    // a git repository has no statistics: unavailable, not zero
    stats: null,
  })
  // git repositories aren't counted
  expect(first.page).toEqual({ has_more: true, next_cursor: ids[23], count: { kind: "unknown" } })
  expect(first.search).toEqual({ available: false, ref: null, reason: { code: "unsupported", message: expect.any(String) } })
  expect(first.query).toBeNull()
  expect(first.history).toEqual({ available: true, reason: null })

  const seen: string[] = first.items.map((item: { id: string }) => item.id)
  let page = first.page
  while (page.next_cursor) {
    const next = await list(`?cursor=${page.next_cursor}`)
    seen.push(...next.items.map((item: { id: string }) => item.id))
    page = next.page
  }
  // the initial commit, then every change, each once
  expect(seen).toHaveLength(45)
  expect(seen.slice(0, 44)).toEqual([...ids].reverse())
  expect(seen[44]).toEqual(oid)

  // page_size up to 100
  expect((await list("?page_size=7")).items).toHaveLength(7)
  expect((await list("?page_size=500")).items).toHaveLength(45)
})

test("committers show only when they aren't the author, merges are marked, and the walk follows first parents", async ({ request, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  const git = localGit(backend)
  const [applied] = addCommits(git, [{ message: "applied by carol", author: bob, committer: carol }])
  git(["checkout", "--quiet", "-b", "side"])
  const [side] = addCommits(git, [{ message: "side work", author: bob }])
  git(["checkout", "--quiet", "main"])
  const [merge] = addCommits(git, [{ message: "Merge side", merge: "side" }])

  const history = await (await request.get(`${hub.url}/api/v1/repo/commits`)).json()
  expect(history.items.map((item: { summary: string }) => item.summary)).toEqual(["Merge side", "applied by carol", "Initial commit"])
  expect(history.items[0]).toMatchObject({ id: merge, merge: true, parent: applied, committer: null })
  expect(history.items[1]).toMatchObject({ id: applied, merge: false, author: { kind: "email", email: bob.email }, committer: { kind: "email", email: carol.email } })
  expect(history.items[2]).toMatchObject({ parent: null, committer: null })
  // the side branch has its own history
  const sideHistory = await (await request.get(`${hub.url}/api/v1/repo/commits?ref=branch:side`)).json()
  expect(sideHistory.items[0]).toMatchObject({ id: side, summary: "side work" })
})

test("a commit opens with its whole message, and a message past Haxy's limit says it was cut", async ({ request, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  const git = localGit(backend)
  const long = ["Long message", "", ...Array.from({ length: 80 }, (_, index) => `line ${index + 1}`)].join("\n")
  const huge = `Huge message\n\n${"x".repeat(110 * 1024)}`
  const [longId, hugeId] = addCommits(git, [{ message: long }, { message: huge }])

  const one = await (await request.get(`${hub.url}/api/v1/repo/commits/${longId}`)).json()
  expect(one).toMatchObject({ id: longId, summary: "Long message", message: long, message_truncated: false, stats: null })
  // the list shows each commit's first line only
  expect((await (await request.get(`${hub.url}/api/v1/repo/commits`)).json()).items[1]).not.toHaveProperty("message")

  const cut = await (await request.get(`${hub.url}/api/v1/repo/commits/${hugeId}`)).json()
  expect(cut.message_truncated).toBe(true)
  expect(cut.message.length).toBe(100 * 1024)
  expect(huge.startsWith(cut.message)).toBe(true)

  for (const id of ["abc", "0".repeat(40), longId.toUpperCase(), `${longId}0`]) {
    const response = await request.get(`${hub.url}/api/v1/repo/commits/${id}`)
    expect(response.status(), id).toBe(404)
    expect(await response.json()).toEqual({ error: { code: "not_found", message: "This repository has no commit with this id." } })
  }
  // a tree is an object, but not a commit
  const tree = git(["rev-parse", `${longId}^{tree}`])
  expect((await request.get(`${hub.url}/api/v1/repo/commits/${tree}`)).status()).toBe(404)
})

test("history follows a branch or tag whose name holds a slash, a space, Unicode, a literal escape or a byte that isn't UTF-8", async ({ request, launch }) => {
  const backend = await launch.local({ files: { "which.txt": "main\n" }, refs: awkwardRefs })
  const hub = await launch.hub(backend.port)

  const listed = [
    ...(await (await request.get(`${hub.url}/api/v1/repo/branches`)).json()).items,
    ...(await (await request.get(`${hub.url}/api/v1/repo/tags`)).json()).items,
  ] as Array<{ name: string; id: string }>
  expect(listed.map((item) => item.id)).toEqual([
    "branch:a%252Fb", "branch:caf%E9", "branch:feature/a%20b", "branch:main", "branch:na%C3%AFve/%C3%BCn%C3%AF", "branch:x%2541y", "tag:release/2026%20q4",
  ])
  for (const item of listed) {
    const response = await request.get(`${hub.url}/api/v1/repo/commits?ref=${item.id}`)
    expect(response.status(), item.name).toBe(200)
    const history = await response.json()
    // the id round-trips, with the name for display
    expect(history.ref, item.name).toEqual({ kind: item.id.startsWith("tag:") ? "tag" : "branch", name: item.name, id: item.id, commit: oid })
    const summaries = history.items.map((entry: { summary: string }) => entry.summary)
    expect(summaries, item.name).toEqual(item.name === "main" ? ["Initial commit"] : [expect.stringMatching(/^Commit for ref \d$/), "Initial commit"])
    // a page names its ref, so the next one stays on it
    const paged = await (await request.get(`${hub.url}/api/v1/repo/commits?ref=${item.id}&page_size=1`)).json()
    if (item.name !== "main") {
      const rest = await (await request.get(`${hub.url}/api/v1/repo/commits?ref=${item.id}&page_size=1&cursor=${paged.page.next_cursor}`)).json()
      expect(rest.items.map((entry: { summary: string }) => entry.summary)).toEqual(["Initial commit"])
      expect(rest.ref.id).toBe(item.id)
    }
  }

  // a commit's own history starts at it
  const main = await (await request.get(`${hub.url}/api/v1/repo/commits`)).json()
  const atCommit = await (await request.get(`${hub.url}/api/v1/repo/commits?ref=commit:${main.ref.commit}`)).json()
  expect(atCommit.ref).toEqual({ kind: "commit", name: null, id: `commit:${main.ref.commit}`, commit: main.ref.commit })
  expect(atCommit.items).toHaveLength(1)
})

test("history requests are validated, and refs that name nothing are not found", async ({ request, launch }) => {
  const backend = await launch.local({ refs: [{ kind: "tag", name: "v1.0" }] })
  const hub = await launch.hub(backend.port)
  const get = (query: string) => request.get(`${hub.url}/api/v1/repo/commits?${query}`)

  for (const [query, fieldName] of [
    ["ref=main", "ref"], ["ref=object:abc", "ref"], ["ref=branch:%zz", "ref"],
    ["page_size=0", "page_size"], ["page_size=x", "page_size"],
    ["cursor=zz", "cursor"], [`cursor=${"0".repeat(40)}`, "cursor"], ["cursor=%zz", "cursor"],
  ] as const) {
    const response = await get(query)
    expect(response.status(), query).toBe(400)
    expect(await response.json(), query).toEqual({ error: { code: "validation", message: expect.any(String), field_errors: { [fieldName]: expect.any(String) } } })
  }
  for (const query of ["ref=branch:nope", "ref=tag:nope", `ref=commit:${"0".repeat(40)}`, "ref=revision:abc"]) {
    const response = await get(query)
    expect(response.status(), query).toBe(404)
    expect(await response.json(), query).toEqual({ error: { code: "not_found", message: "This repository has no such branch, tag, commit or revision." } })
  }
  // local mode offers no commit search: unavailable, not an empty result
  const search = await get("search=initial")
  expect(search.status()).toBe(405)
  expect(await search.json()).toEqual({ error: { code: "unsupported", message: expect.any(String) } })
  // only GET and HEAD
  expect((await request.head(`${hub.url}/api/v1/repo/commits`)).status()).toBe(200)
})

test("a repository without commits has no history yet, while an explicit ref still reads", async ({ request, launch }) => {
  const backend = await launch.local({ refs: [{ kind: "tag", name: "v1.0" }], head: "unborn" })
  const hub = await launch.hub(backend.port)
  const response = await request.get(`${hub.url}/api/v1/repo/commits`)
  expect(response.status()).toBe(404)
  expect(await response.json()).toEqual({ error: { code: "not_found", message: "This repository has no commits yet." } })
  expect((await (await request.get(`${hub.url}/api/v1/repo/commits?ref=tag:v1.0`)).json()).items).toHaveLength(1)
})

test.describe("on a server", () => {
  test("pushed history carries Haxy's statistics and count, and is searchable through its index", async ({ playwright, request, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    await registerUser(backend, aliceAccount)
    const context = await signedIn(playwright, backend, hub.url, aliceAccount.name, aliceAccount.password)
    await createRepo(context, backend, { name: "parser", access: "public" })
    await pushRepo(playwright, backend, hub.url, aliceAccount, { owner: "alice", name: "parser" }, {
      files: { "README.md": "# parser\n" },
      refs: [{ kind: "branch", name: "feature/café", files: { "notes.txt": "a lexer note\n" } }, { kind: "tag", name: "v1.0" }],
      history: (git) => addCommits(git, [
        { message: "Add the tokenizer", files: { "src/tokenizer.txt": "one\ntwo\nthree\n" } },
        { message: "Fix the tokenizer's whitespace", files: { "src/tokenizer.txt": "one\ntwo\nthree four\n" } },
        ...changes(22),
        { message: "Document the tokenizer" },
      ]),
    })
    const base = `${hub.url}/api/v1/repos/alice/parser/commits`
    const list = async (query = "") => {
      const response = await request.get(`${base}${query}`)
      expect(response.status(), query).toBe(200)
      return response.json()
    }

    const first = await list()
    expect(first.ref).toMatchObject({ kind: "branch", name: "main", id: "branch:main" })
    // xit counts the first-parent log
    expect(first.page.count).toEqual({ kind: "exact", value: 26 })
    expect(first.search).toEqual({ available: true, ref: "branch:main", reason: null })
    // and computes each commit's statistics, so zeros are real
    const everything = (await list("?page_size=100")).items as Array<{ summary: string; stats: Record<string, number> | null }>
    const added = everything.find((item) => item.summary === "Add the tokenizer")
    expect(added?.stats).toMatchObject({ lines_added: 3, files_added: 1, lines_removed: 0, files_removed: 0 })
    expect(everything.find((item) => item.summary === "Document the tokenizer")?.stats).toMatchObject({ lines_added: 0, files_added: 0, bytes_added: 0 })

    // words match by prefix, newest first, a page at a time
    const found = await list("?search=tokeniz&page_size=2")
    expect(found.query).toBe("tokeniz")
    expect(found.items.map((item: { summary: string }) => item.summary)).toEqual(["Document the tokenizer", "Fix the tokenizer's whitespace"])
    expect(found.page).toEqual({ has_more: true, next_cursor: oid, count: { kind: "unknown" } })
    const more = await list(`?search=tokeniz&page_size=2&cursor=${found.page.next_cursor}`)
    expect(more.items.map((item: { summary: string }) => item.summary)).toEqual(["Add the tokenizer"])
    expect(more.page.next_cursor).toBeNull()
    // no matches is an empty, available search
    const none = await list("?search=nothing")
    expect(none).toMatchObject({ items: [], query: "nothing", search: { available: true } })

    // every pushed branch and tag is indexed, names and all
    const feature = await list("?ref=branch:feature/caf%C3%A9&search=initial")
    expect(feature.ref).toMatchObject({ name: "feature/café", id: "branch:feature/caf%C3%A9" })
    expect(feature.items.map((item: { summary: string }) => item.summary)).toEqual(["Initial commit"])
    expect((await list("?ref=tag:v1.0")).search).toEqual({ available: true, ref: "tag:v1.0", reason: null })

    // a commit's history is searched on the default branch
    const atCommit = await list(`?ref=commit:${first.items[3].id}`)
    expect(atCommit.search).toEqual({ available: true, ref: "branch:main", reason: null })
    expect(atCommit.page.count).toEqual({ kind: "exact", value: 23 })
    const refused = await request.get(`${base}?ref=commit:${first.items[3].id}&search=tokenizer`)
    expect(refused.status()).toBe(405)
    expect((await refused.json()).error.code).toBe("unsupported")

    // the history survives a backend restart
    await backend.restart?.()
    expect((await list()).items[0].summary).toBe("Document the tokenizer")
    await context.dispose()
  })

  test("a private repository's history is not found for viewers who can't see it", async ({ playwright, request, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)
    const missing = await (await request.get(`${hub.url}/api/v1/repos/bobby/no-such-repo/commits`)).json()
    const alice = await signedIn(playwright, backend, hub.url, "alice", "password")
    const bobby = await signedIn(playwright, backend, hub.url, "bobby", "password")
    const visible = await (await bobby.get(`${hub.url}/api/v1/repos/bobby/neovim/commits`)).json()
    expect(visible.items.length).toBeGreaterThan(0)
    for (const [viewer, context] of [["anonymous", request], ["alice", alice]] as const) {
      for (const path of ["commits", `commits/${visible.items[0].id}`]) {
        const response = await context.get(`${hub.url}/api/v1/repos/bobby/neovim/${path}`)
        expect(response.status(), `${viewer} ${path}`).toBe(404)
        expect(await response.json(), `${viewer} ${path}`).toEqual(missing)
      }
    }
    // each host answers the other's routes as unsupported
    expect((await request.get(`${hub.url}/api/v1/repo/commits`)).status()).toBe(405)
    await alice.dispose()
    await bobby.dispose()
  })

  test("a patch revision's history runs from its source commit back to its base", async ({ request, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)
    // the API has no patches yet, so take a revision id from Haxy's own patches page
    const html = await (await request.get(`${backend.origin}/admin:toolbox/patches/open`)).text()
    const revision = /patchrev:([0-9a-f]{32})/.exec(html)?.[1]
    expect(revision).toBeDefined()
    const files = await (await request.get(`${hub.url}/api/v1/repos/admin/toolbox/files?ref=revision:${revision}`)).json()

    const history = await (await request.get(`${hub.url}/api/v1/repos/admin/toolbox/commits?ref=revision:${revision}`)).json()
    expect(history.ref).toEqual({ kind: "revision", name: null, id: `revision:${revision}`, commit: files.ref.commit })
    expect(history.history).toEqual({ available: true, reason: null })
    expect(history.items[0].id).toBe(files.ref.commit)
    // bounded by the base, so shorter than the source commit's whole log
    const whole = await (await request.get(`${hub.url}/api/v1/repos/admin/toolbox/commits?ref=commit:${files.ref.commit}&page_size=100`)).json()
    expect(history.items.length).toBeLessThan(whole.items.length)
    expect(history.page.count).toEqual({ kind: "exact", value: history.items.length })
  })
})
