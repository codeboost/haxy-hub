import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { expect, test } from "./support/fixtures"
import type { FixtureRef } from "./support/backend"
import { signedIn } from "./support/repos"

// HTTP contract checks for branches, tags and reading files at a ref, through
// the same Vite proxy the browser uses.

const latin1 = Uint8Array.from([...Buffer.from("caf"), 0xe9])
const pad = (index: number) => String(index).padStart(3, "0")

// 120 topic branches (more than two default pages) and refs whose names hold
// a slash, a space, Unicode, a literal percent escape and a byte that isn't UTF-8
const manyRefs: FixtureRef[] = [
  ...Array.from({ length: 120 }, (_, index): FixtureRef => ({ kind: "branch", name: `topic/${pad(index + 1)}` })),
  { kind: "branch", name: "feature/a b", files: { "which.txt": "feature/a b\n" } },
  { kind: "branch", name: "naïve/ünï", files: { "which.txt": "naïve/ünï\n" } },
  { kind: "branch", name: "x%41y", files: { "which.txt": "x%41y\n" } },
  { kind: "branch", name: latin1, files: { "which.txt": "latin-1\n" } },
  { kind: "tag", name: "v1.0", files: { "which.txt": "v1.0\n" } },
  { kind: "tag", name: "v2.0", files: { "which.txt": "v2.0\n" }, annotated: true },
  { kind: "tag", name: "release/2026 q4" },
]

test("branches page in name order with opaque cursors, and search narrows them by prefix", async ({ request, launch }) => {
  const backend = await launch.local({ files: { "which.txt": "main\n" }, refs: manyRefs })
  const hub = await launch.hub(backend.port)
  const list = async (query = "") => {
    const response = await request.get(`${hub.url}/api/v1/repo/branches${query}`)
    expect(response.status(), query).toBe(200)
    return response.json()
  }

  // the refs tab's window of 50 is the default page
  const first = await list()
  expect(first.items.slice(0, 5)).toEqual([
    { name: "caf�", id: "branch:caf%E9" },
    { name: "feature/a b", id: "branch:feature/a%20b" },
    { name: "main", id: "branch:main" },
    { name: "naïve/ünï", id: "branch:na%C3%AFve/%C3%BCn%C3%AF" },
    { name: "topic/001", id: "branch:topic/001" },
  ])
  expect(first.items).toHaveLength(50)
  expect(first.page).toEqual({ has_more: true, next_cursor: expect.any(String), count: { kind: "unknown" } })

  const names: string[] = first.items.map((item: { name: string }) => item.name)
  let page = first.page
  while (page.next_cursor) {
    const next = await list(`?cursor=${encodeURIComponent(page.next_cursor)}`)
    names.push(...next.items.map((item: { name: string }) => item.name))
    page = next.page
  }
  expect(names).toHaveLength(125)
  expect(names.slice(-2)).toEqual(["topic/120", "x%41y"])
  expect(new Set(names).size).toBe(names.length)

  // search is a prefix of the name, and pages within the matches
  const search = await list(`?search=${encodeURIComponent("topic/1")}&page_size=15`)
  expect(search.items.map((item: { name: string }) => item.name)).toEqual(Array.from({ length: 15 }, (_, index) => `topic/${pad(index + 100)}`))
  const rest = await list(`?search=${encodeURIComponent("topic/1")}&page_size=15&cursor=${encodeURIComponent(search.page.next_cursor)}`)
  expect(rest.items.map((item: { name: string }) => item.name)).toEqual(Array.from({ length: 6 }, (_, index) => `topic/${pad(index + 115)}`))
  expect(rest.page).toEqual({ has_more: false, next_cursor: null, count: { kind: "unknown" } })
  expect((await list(`?search=${encodeURIComponent("naï")}`)).items).toEqual([{ name: "naïve/ünï", id: "branch:na%C3%AFve/%C3%BCn%C3%AF" }])
  expect((await list("?search=nothing")).items).toEqual([])

  // page_size is capped at 100; a bad one or a malformed cursor is a validation error
  expect((await list("?page_size=500")).items).toHaveLength(100)
  for (const query of ["?page_size=0", "?page_size=x", "?cursor=%25zz", "?cursor=zz", "?cursor=abc"]) {
    const response = await request.get(`${hub.url}/api/v1/repo/branches${query}`)
    expect(response.status(), query).toBe(400)
    expect(await response.json(), query).toEqual({ error: { code: "validation", message: expect.any(String), field_errors: { [query.includes("cursor") ? "cursor" : "page_size"]: expect.any(String) } } })
  }
})

test("tags list like branches, each with the id that reads files at it", async ({ request, launch }) => {
  const backend = await launch.local({ files: { "which.txt": "main\n" }, refs: manyRefs })
  const hub = await launch.hub(backend.port)

  const tags = await (await request.get(`${hub.url}/api/v1/repo/tags`)).json()
  expect(tags).toEqual({
    items: [
      { name: "release/2026 q4", id: "tag:release/2026%20q4" },
      { name: "v1.0", id: "tag:v1.0" },
      { name: "v2.0", id: "tag:v2.0" },
    ],
    page: { has_more: false, next_cursor: null, count: { kind: "unknown" } },
  })
})

test("files read at a branch, tag or commit name the ref they were read at, and ids round-trip", async ({ request, launch }) => {
  const backend = await launch.local({ files: { "which.txt": "main\n" }, refs: manyRefs })
  const hub = await launch.hub(backend.port)
  const files = async (query: string) => {
    const response = await request.get(`${hub.url}/api/v1/repo/files?${query}`)
    expect(response.status(), query).toBe(200)
    return response.json()
  }

  // without a ref, the default branch, named explicitly so a view can pin it
  const main = await files("path=which.txt")
  expect(main.ref).toEqual({ kind: "branch", name: "main", id: "branch:main", commit: expect.stringMatching(/^[0-9a-f]{40}$/) })
  expect(main.content.lines[0]).toBe("main")

  // every branch's id, as listed, reads that branch's own file
  const listed: Array<{ name: string; id: string }> = []
  for (const search of ["caf", "f", "n", "x"]) listed.push(...(await (await request.get(`${hub.url}/api/v1/repo/branches?search=${encodeURIComponent(search)}`)).json()).items)
  const expected: Record<string, string> = { "feature/a b": "feature/a b", "caf�": "latin-1", "naïve/ünï": "naïve/ünï", "x%41y": "x%41y" }
  for (const item of listed) {
    const file = await files(`path=which.txt&ref=${item.id}`)
    expect(file.ref, item.name).toEqual({ kind: "branch", name: item.name, id: item.id, commit: expect.stringMatching(/^[0-9a-f]{40}$/) })
    expect(file.content.lines[0], item.name).toBe(expected[item.name])
    expect(file.ref.commit).not.toBe(main.ref.commit)
  }
  expect(listed).toHaveLength(4)

  // a directory listing carries the ref too
  const root = await files("ref=branch:feature/a%20b")
  expect(root).toMatchObject({ ref: { kind: "branch", name: "feature/a b", id: "branch:feature/a%20b" }, path: "", kind: "dir" })

  // a lightweight and an annotated tag both show their commit
  const v1 = await files("path=which.txt&ref=tag:v1.0")
  expect(v1.ref).toEqual({ kind: "tag", name: "v1.0", id: "tag:v1.0", commit: expect.stringMatching(/^[0-9a-f]{40}$/) })
  expect(v1.content.lines[0]).toBe("v1.0")
  const v2 = await files("path=which.txt&ref=tag:v2.0")
  expect(v2.content.lines[0]).toBe("v2.0")
  const v2Commit = await files(`path=which.txt&ref=commit:${v2.ref.commit}`)
  expect(v2Commit.ref).toEqual({ kind: "commit", name: null, id: `commit:${v2.ref.commit}`, commit: v2.ref.commit })
  expect(v2Commit.content.lines[0]).toBe("v2.0")
  expect((await files("ref=tag:release/2026%20q4")).ref).toMatchObject({ kind: "tag", name: "release/2026 q4", commit: main.ref.commit })

  // a commit id reads that commit
  const atMain = await files(`path=which.txt&ref=commit:${main.ref.commit}`)
  expect(atMain.content.lines[0]).toBe("main")
})

test("an unknown ref or commit is not found, and a malformed ref is a validation error", async ({ request, launch }) => {
  const backend = await launch.local({ files: { "which.txt": "main\n" }, refs: manyRefs })
  const hub = await launch.hub(backend.port)

  const zeros = "0".repeat(40)
  for (const ref of ["branch:nope", "tag:nope", "branch:v1.0", `commit:${zeros}`, "commit:abc", `commit:${"g".repeat(40)}`, "revision:abc", `revision:${"0".repeat(64)}`]) {
    const response = await request.get(`${hub.url}/api/v1/repo/files?ref=${ref}`)
    expect(response.status(), ref).toBe(404)
    expect(await response.json(), ref).toEqual({ error: { code: "not_found", message: expect.any(String) } })
  }
  // a blob's id names no commit
  const blob = createHash("sha1").update("blob 5\0main\n").digest("hex")
  const blobResponse = await request.get(`${hub.url}/api/v1/repo/files?ref=commit:${blob}`)
  expect(blobResponse.status()).toBe(404)
  // nor does an annotated tag's own object id, though `tag:` reads through it
  const tagObject = execFileSync("git", ["rev-parse", "refs/tags/v2.0"], { cwd: backend.dataDir }).toString().trim()
  expect((await request.get(`${hub.url}/api/v1/repo/files?ref=tag:v2.0`)).status()).toBe(200)
  const tagResponse = await request.get(`${hub.url}/api/v1/repo/files?ref=commit:${tagObject}`)
  expect(tagResponse.status()).toBe(404)
  expect(await tagResponse.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } })

  for (const ref of ["main", "branch:", "object:abc", "patchrev:abc", "%zz"]) {
    const response = await request.get(`${hub.url}/api/v1/repo/files?ref=${ref}`)
    expect(response.status(), ref).toBe(400)
    expect(await response.json(), ref).toEqual({ error: { code: "validation", message: expect.any(String), field_errors: { ref: expect.any(String) } } })
  }
})

test.describe("with the demo data", () => {
  test.skip(!process.env.HAXY_E2E_DEMO_BIN, "HAXY_BIN was given without HAXY_TRY_BIN")

  test("a server repository's branches and tags page, and its files read at a tag", async ({ request, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)

    const branches = await (await request.get(`${hub.url}/api/v1/repos/bobby/linux/branches`)).json()
    expect(branches.items.map((item: { name: string }) => item.name)).toEqual(expect.arrayContaining(["extra", "feature", "master"]))

    const tags: Array<{ name: string; id: string }> = []
    let cursor: string | null = ""
    while (cursor !== null) {
      const page = await (await request.get(`${hub.url}/api/v1/repos/bobby/linux/tags?page_size=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).json()
      expect(page.items.length).toBeLessThanOrEqual(7)
      tags.push(...page.items)
      cursor = page.page.next_cursor
    }
    expect(tags.length).toBeGreaterThan(7)
    expect(tags.map((tag) => tag.name)).toEqual([...tags.map((tag) => tag.name)].sort())

    const files = await (await request.get(`${hub.url}/api/v1/repos/bobby/linux/files?ref=${tags[0].id}`)).json()
    expect(files).toMatchObject({ ref: { kind: "tag", name: tags[0].name, id: tags[0].id }, kind: "dir" })
  })

  test("a patch revision's files read at its source commit", async ({ request, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)
    // the API has no patches yet, so take a revision id from Haxy's own patches page
    const html = await (await request.get(`${backend.origin}/admin:toolbox/patches/open`)).text()
    const revision = /patchrev:([0-9a-f]{32})/.exec(html)?.[1]
    expect(revision).toBeDefined()

    const files = await (await request.get(`${hub.url}/api/v1/repos/admin/toolbox/files?ref=revision:${revision}`)).json()
    expect(files).toMatchObject({ ref: { kind: "revision", name: null, id: `revision:${revision}`, commit: expect.stringMatching(/^[0-9a-f]{40}$/) }, path: "", kind: "dir" })
    const readme = await (await request.get(`${hub.url}/api/v1/repos/admin/toolbox/files?path=README.md&ref=revision:${revision}`)).json()
    expect(readme).toMatchObject({ ref: { id: `revision:${revision}` }, kind: "file" })
  })

  test("a private repository's refs are not found for viewers who can't see it", async ({ playwright, request, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)
    const missing = await (await request.get(`${hub.url}/api/v1/repos/bobby/no-such-repo/branches`)).json()

    const alice = await signedIn(playwright, backend, hub.url, "alice", "password")
    for (const [viewer, context] of [["anonymous", request], ["alice", alice]] as const) {
      for (const path of ["branches", "tags", "files?ref=branch:master"]) {
        const response = await context.get(`${hub.url}/api/v1/repos/bobby/neovim/${path}`)
        expect(response.status(), `${viewer} ${path}`).toBe(404)
        expect(await response.json(), `${viewer} ${path}`).toEqual(missing)
      }
    }
    const bobby = await signedIn(playwright, backend, hub.url, "bobby", "password")
    expect((await bobby.get(`${hub.url}/api/v1/repos/bobby/neovim/branches`)).status()).toBe(200)
    await alice.dispose()
    await bobby.dispose()
  })
})

test("when HEAD names a branch without commits, explicit refs and the ref lists still read", async ({ request, launch }) => {
  const backend = await launch.local({
    files: { "which.txt": "main\n" },
    refs: [{ kind: "tag", name: "v1.0", files: { "which.txt": "v1.0\n" } }],
    head: "unborn",
  })
  const hub = await launch.hub(backend.port)

  // the overview and the default view describe HEAD's branch
  expect(await (await request.get(`${hub.url}/api/v1/repo`)).json()).toMatchObject({ default_branch: "unborn", empty: true })
  const files = await request.get(`${hub.url}/api/v1/repo/files`)
  expect(files.status()).toBe(404)
  expect(await files.json()).toEqual({ error: { code: "not_found", message: "This repository has no commits yet." } })

  expect((await (await request.get(`${hub.url}/api/v1/repo/files?path=which.txt&ref=branch:main`)).json()).content.lines[0]).toBe("main")
  expect((await (await request.get(`${hub.url}/api/v1/repo/files?path=which.txt&ref=tag:v1.0`)).json()).content.lines[0]).toBe("v1.0")
  expect((await (await request.get(`${hub.url}/api/v1/repo/branches`)).json()).items).toEqual([{ name: "main", id: "branch:main" }])
  expect((await (await request.get(`${hub.url}/api/v1/repo/tags`)).json()).items).toEqual([{ name: "v1.0", id: "tag:v1.0" }])
})
