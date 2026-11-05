import { expect, test } from "./support/fixtures"
import { alice } from "./support/accounts"
import { indexedServer, manyCount, serveLocally, serverRepoDirs } from "./support/finder"
import { createIssue } from "./support/issues"
import { createRepo, signedIn } from "./support/repos"

// HTTP contract checks for the file finder (`…/find`), through the Vite
// proxy, against repositories Haxy indexed itself: a push to a server indexes
// every branch, as the TUI's finder relies on.

const base = "/api/v1/repos/alice/tricky/find"

test("an indexed branch finds files by the start of their names, in the TUI's order, with byte-exact paths", async ({ playwright, request, launch }) => {
  const { server, hub } = await indexedServer(playwright, launch)
  const find = async (query: string) => {
    const response = await request.get(`${hub.url}${base}?${query}`)
    expect(response.status(), query).toBe(200)
    expect(response.headers()["cache-control"]).toBe("no-store")
    return response.json()
  }

  const read = await find("search=read")
  expect(read).toEqual({
    ref: { kind: "branch", name: "main", id: "branch:main", commit: expect.stringMatching(/^[0-9a-f]{40}$/) },
    kind: "indexed",
    // by name, ignoring ASCII case ("read me.md" sorts before "readme.md"), then path
    items: [
      { name: "Read Me.md", path: "docs/sub%20dir/Read%20Me.md" },
      { name: "README.md", path: "README.md" },
    ],
    page: { has_more: false, next_cursor: null, count: { kind: "exact", value: 2 } },
  })

  // the search is decoded exactly once: "a%" is a literal percent sign, and
  // "a%41" never matches "aA"
  expect((await find("search=a%25")).items).toEqual([
    { name: "a%2Fb.txt", path: "a%252Fb.txt" },
    { name: "a%41.txt", path: "a%2541.txt" },
  ])
  expect((await find("search=a%2541")).items).toEqual([{ name: "a%41.txt", path: "a%2541.txt" }])
  expect((await find("search=aA")).items).toEqual([{ name: "aA.txt", path: "aA.txt" }])

  // Unicode and a byte that isn't UTF-8, in byte order of the lowercased names
  expect((await find(`search=${encodeURIComponent("caf")}`)).items).toEqual([
    { name: "Café.md", path: "src/Caf%C3%A9.md" },
    { name: "café.txt", path: "caf%C3%A9.txt" },
    { name: "caf�.bin", path: "caf%E9.bin" },
  ])
  // only ASCII letters ignore case
  expect((await find(`search=${encodeURIComponent("CAFÉ")}`)).items).toEqual([])

  // a search is never trimmed: a name may start with a space
  expect((await find("search=%20le")).items).toEqual([{ name: " lead.txt", path: "%20lead.txt" }])
  expect((await find("search=le")).items).toEqual([])

  // no match is an indexed, empty answer; so is an empty search, which only
  // says whether the view is indexed
  for (const query of ["search=zzz", "search=", ""]) {
    const answer = await find(query)
    expect(answer.kind, query).toBe("indexed")
    expect(answer.items, query).toEqual([])
    expect(answer.page, query).toEqual({ has_more: false, next_cursor: null, count: { kind: "exact", value: 0 } })
  }

  // Haxy's own finder, which shares the index lookup and the matching, finds the same
  const tui = await (await request.get(`${server.origin}/alice:tricky/files/branch:main/find:read`)).text()
  expect(tui).toContain("Read Me.md")
  expect(tui).toContain("docs/sub dir")
  expect((await request.get(`${server.origin}/alice:tricky/files/tag:v1/find:read`)).status()).toBe(404)

  // each found path reads back as that file
  const file = await request.get(`${hub.url}/api/v1/repos/alice/tricky/files?path=a%252Fb.txt&ref=branch:main`)
  expect((await file.json()).content.lines[0]).toBe("literal percent 2F")
})

test("results stop at the TUI's 1000 with a lower-bound count, and page through opaque cursors", async ({ playwright, request, launch }) => {
  const { hub } = await indexedServer(playwright, launch)
  expect(manyCount).toBeGreaterThan(1000)

  // by default one page holds every listed result, as the TUI's list does
  const all = await (await request.get(`${hub.url}${base}?search=f`)).json()
  expect(all.items).toHaveLength(1000)
  expect(all.items[0]).toEqual({ name: "f0000.txt", path: "many/f0000.txt" })
  expect(all.items[999]).toEqual({ name: "f0999.txt", path: "many/f0999.txt" })
  expect(all.page).toEqual({ has_more: false, next_cursor: null, count: { kind: "at_least", value: 1000 } })

  const paths: string[] = []
  let cursor: string | null = null
  let pages = 0
  do {
    const query: string = cursor === null ? "search=f&page_size=300" : `search=f&page_size=300&cursor=${encodeURIComponent(cursor)}`
    const answer = await (await request.get(`${hub.url}${base}?${query}`)).json()
    expect(answer.page.count).toEqual({ kind: "at_least", value: 1000 })
    expect(answer.page.has_more).toBe(answer.page.next_cursor !== null)
    paths.push(...answer.items.map((item: { path: string }) => item.path))
    cursor = answer.page.next_cursor
    pages++
  } while (cursor !== null)
  // page_size is capped at 100
  expect(pages).toBe(10)
  expect(paths).toEqual(all.items.map((item: { path: string }) => item.path))

  const exact = await (await request.get(`${hub.url}${base}?search=f100`)).json()
  expect(exact.items.map((item: { name: string }) => item.name)).toEqual(["f1000.txt", "f1001.txt", "f1002.txt", "f1003.txt", "f1004.txt"])
  expect(exact.page.count).toEqual({ kind: "exact", value: 5 })
})

test("a view without an index says why: a tag or commit is unsupported, an unindexed branch has no index", async ({ playwright, request, launch }) => {
  const { server, hub } = await indexedServer(playwright, launch)
  const find = async (query: string) => {
    const response = await request.get(`${hub.url}${base}?${query}`)
    expect(response.status(), query).toBe(200)
    return response.json()
  }

  // every pushed branch is indexed
  expect((await find("ref=branch:feature&search=feature")).items).toEqual([{ name: "feature only.txt", path: "feature%20only.txt" }])
  expect((await find("search=feature")).items).toEqual([])

  const tag = await find("ref=tag:v1&search=read")
  expect(tag).toEqual({ ref: { kind: "tag", name: "v1", id: "tag:v1", commit: expect.any(String) }, kind: "unsupported", reason: "ref" })
  const commit = await find(`ref=commit:${tag.ref.commit}&search=read`)
  expect(commit).toEqual({ ref: { kind: "commit", name: null, id: `commit:${tag.ref.commit}`, commit: tag.ref.commit }, kind: "unsupported", reason: "ref" })

  // an issue starts the events branch, which no push indexes
  const context = await signedIn(playwright, server, hub.url, alice.name, alice.password)
  await createIssue(context, server, "/alice:tricky", { title: "Start the events branch" })
  expect(await find("ref=branch:haxy/events&search=read")).toEqual({
    ref: { kind: "branch", name: "haxy/events", id: "branch:haxy/events", commit: expect.any(String) },
    kind: "no_index",
    reason: null,
  })
  // and that left main's index alone
  expect((await find("search=read")).items).toHaveLength(2)
})

test("bad finder requests are refused as for the files view, and hidden repositories are not found", async ({ playwright, request, launch }) => {
  const { server, hub } = await indexedServer(playwright, launch)
  const answer = async (query: string, path = base) => {
    const response = await request.get(`${hub.url}${path}?${query}`)
    return { status: response.status(), body: await response.json() }
  }

  expect(await answer("ref=branch:nope&search=a")).toEqual({ status: 404, body: { error: { code: "not_found", message: "This repository has no such branch, tag, commit or revision." } } })
  expect((await answer("ref=main")).body.error.field_errors).toEqual({ ref: expect.any(String) })
  expect((await answer("search=%zz")).body.error).toEqual({ code: "validation", message: "Check the search.", field_errors: { search: "The search isn't validly encoded." } })
  expect((await answer("search=a&page_size=0")).body.error.field_errors).toEqual({ page_size: expect.any(String) })
  expect((await answer("search=a&cursor=nope")).body.error.field_errors).toEqual({ cursor: expect.any(String) })
  const post = await request.post(`${hub.url}${base}`)
  expect(post.status()).toBe(403)

  const context = await signedIn(playwright, server, hub.url, alice.name, alice.password)
  await createRepo(context, server, { name: "secret", access: "private" })
  const missing = await answer("search=a", "/api/v1/repos/alice/no-such-repo/find")
  const hidden = await answer("search=a", "/api/v1/repos/alice/secret/find")
  expect(missing.status).toBe(404)
  expect(hidden).toEqual(missing)
  // a repository without commits has nothing to search
  const empty = await context.get(`${hub.url}/api/v1/repos/alice/secret/find?search=a`)
  expect(await empty.json()).toEqual({ error: { code: "not_found", message: "This repository has no commits yet." } })
})

test("local mode finds files in an indexed xit repository, and says a git repository has no index", async ({ playwright, request, launch }) => {
  const git = await launch.local({ files: { "README.md": "# Local\n" } })
  const gitHub = await launch.hub(git.port)
  expect(await (await request.get(`${gitHub.url}/api/v1/repo/find?search=read`)).json()).toEqual({
    ref: { kind: "branch", name: "main", id: "branch:main", commit: expect.any(String) },
    kind: "unsupported",
    reason: "repository",
  })
  // a server's route isn't local mode's
  expect((await request.get(`${gitHub.url}${base}?search=read`)).status()).toBe(405)

  // the repository a server push indexed, opened in local mode
  const { server } = await indexedServer(playwright, launch)
  const [dir] = serverRepoDirs(server)
  await server.stop()
  const local = await serveLocally(dir)
  const hub = await launch.hub(local.port)
  const read = await (await request.get(`${hub.url}/api/v1/repo/find?search=read`)).json()
  expect(read.kind).toBe("indexed")
  expect(read.items).toEqual([
    { name: "Read Me.md", path: "docs/sub%20dir/Read%20Me.md" },
    { name: "README.md", path: "README.md" },
  ])
  expect((await (await request.get(`${hub.url}/api/v1/repo/find?ref=tag:v1&search=read`)).json()).reason).toBe("ref")
})
