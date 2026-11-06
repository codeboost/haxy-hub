import { expect, test } from "./support/fixtures"
import { writeHeaders } from "./support/accounts"
import { createRepo, signedIn } from "./support/repos"

// HTTP contract checks for the repository routes, through the same Vite proxy
// the browser uses: exact shapes, hidden repositories and clone commands.

test.describe("with the demo data", () => {
  test.skip(!process.env.HAXY_E2E_DEMO_BIN, "HAXY_BIN was given without HAXY_TRY_BIN")

  test("a public repository's overview names it, its sections and the backend's clone commands", async ({ request, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)

    const response = await request.get(`${hub.url}/api/v1/repos/bobby/linux`)

    expect(response.status()).toBe(200)
    expect(response.headers()["cache-control"]).toBe("no-store")
    const body = await response.json()
    expect(body).toEqual({
      owner: "bobby",
      name: "linux",
      description: "Linux kernel source tree",
      access: "public",
      default_branch: "master",
      default_branch_id: "branch:master",
      empty: false,
      sections: ["files", "commits", "refs", "discussions", "issues", "patches"],
      clone: [
        { protocol: "http", url: `http://localhost:${backend.port}/bobby:linux`, command: `git clone http://localhost:${backend.port}/bobby:linux` },
        // the demo's ssh command carries its key in a GIT_SSH_COMMAND prefix
        { protocol: "ssh", url: expect.stringMatching(/^ssh:\/\/localhost:\d+\/bobby:linux$/), command: expect.stringMatching(/git clone ssh:\/\/localhost:\d+\/bobby:linux$/) },
      ],
      remote: null,
    })
    // the commands name Haxy's own transport, never the hub's port
    expect(JSON.stringify(body.clone)).not.toContain(String(new URL(hub.url).port))
  })

  test("a private repository is not found for anonymous and unrelated viewers, exactly like a missing one", async ({ playwright, request, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)

    const missing = await request.get(`${hub.url}/api/v1/repos/bobby/no-such-repo`)
    expect(missing.status()).toBe(404)
    const missingBody = await missing.json()
    expect(missingBody).toEqual({ error: { code: "not_found", message: expect.any(String) } })

    const alice = await signedIn(playwright, backend, hub.url, "alice", "password")
    for (const [viewer, context] of [["anonymous", request], ["alice", alice]] as const) {
      for (const path of ["repos/bobby/neovim", "repos/bobby/neovim/files", "repos/bobby/neovim/files?path=README.md"]) {
        const response = await context.get(`${hub.url}/api/v1/${path}`)
        expect(response.status(), `${viewer} ${path}`).toBe(404)
        expect(await response.json(), `${viewer} ${path}`).toEqual(missingBody)
      }
    }

    const bobby = await signedIn(playwright, backend, hub.url, "bobby", "password")
    const owned = await bobby.get(`${hub.url}/api/v1/repos/bobby/neovim`)
    expect(owned.status()).toBe(200)
    const body = await owned.json()
    expect(body).toMatchObject({ owner: "bobby", name: "neovim", access: "private", empty: false })
    // the owner also sees the write sections; a private repo isn't cloned over http
    expect(body.sections).toEqual(["files", "commits", "refs", "discussions", "issues", "patches", "events", "undo", "settings"])
    expect(body.clone.map((command: { protocol: string }) => command.protocol)).toEqual(["ssh"])
    await alice.dispose()
    await bobby.dispose()
  })

  test("the files route lists a directory at the default branch, directories first, and names its README", async ({ request, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)

    const root = await (await request.get(`${hub.url}/api/v1/repos/bobby/linux/files`)).json()
    expect(root).toMatchObject({ ref: { kind: "branch", name: "master", commit: expect.stringMatching(/^[0-9a-f]{40}$/) }, path: "", kind: "dir", readme: { name: "README.md", path: "README.md" } })
    expect(root.items.slice(0, 3)).toEqual([{ name: "docs", path: "docs", kind: "dir" }, { name: "src", path: "src", kind: "dir" }, { name: "README.md", path: "README.md", kind: "file" }])
    expect(root.page).toEqual({ has_more: false, next_cursor: null, count: { kind: "exact", value: root.items.length } })

    // directories nest; a directory without a README names none
    const docs = await (await request.get(`${hub.url}/api/v1/repos/bobby/linux/files?path=docs`)).json()
    expect(docs).toMatchObject({ path: "docs", kind: "dir", readme: null, items: [{ name: "dev", path: "docs/dev", kind: "dir" }] })

    // pages follow the conventions' opaque cursors
    const first = await (await request.get(`${hub.url}/api/v1/repos/bobby/linux/files?page_size=2`)).json()
    expect(first.items).toEqual(root.items.slice(0, 2))
    expect(first.page).toEqual({ has_more: true, next_cursor: expect.any(String), count: { kind: "exact", value: root.items.length } })
    const second = await (await request.get(`${hub.url}/api/v1/repos/bobby/linux/files?page_size=2&cursor=${encodeURIComponent(first.page.next_cursor)}`)).json()
    expect(second.items).toEqual(root.items.slice(2, 4))

    const nowhere = await request.get(`${hub.url}/api/v1/repos/bobby/linux/files?path=docs/missing`)
    expect(nowhere.status()).toBe(404)
    expect(await nowhere.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } })
  })

  test("the files route reads a file's numbered lines, and Markdown as Haxy's parsed blocks", async ({ request, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)

    const readme = await (await request.get(`${hub.url}/api/v1/repos/bobby/linux/files?path=README.md`)).json()
    expect(readme).toMatchObject({ path: "README.md", name: "README.md", kind: "file", content: { kind: "text", start_line: 1, has_more: false, next_line: null } })
    expect(readme.content.lines[0]).toBe("# Sample Repo")
    expect(readme.content.total_lines).toBe(readme.content.lines.length)
    expect(readme.markdown[0]).toEqual({ kind: "heading", level: 1, center: false, inlines: [{ text: "Sample Repo", bold: false, italic: false, strike: false, code: false, link: null }] })

    const nested = await (await request.get(`${hub.url}/api/v1/repos/bobby/linux/files?path=${encodeURIComponent("docs/dev/contribute.md")}`)).json()
    expect(nested.content).toEqual({ kind: "text", start_line: 1, lines: ["To contribute, please make a pull request"], total_lines: 1, has_more: false, next_line: null })
  })

  test("a new repository is empty; its owner gets the command that fills it", async ({ playwright, request, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)
    const bobby = await signedIn(playwright, backend, hub.url, "bobby", "password")
    await createRepo(bobby, backend, { name: "fresh", description: "Nothing yet", access: "public" })

    const owner = await (await bobby.get(`${hub.url}/api/v1/repos/bobby/fresh`)).json()
    expect(owner).toMatchObject({ name: "fresh", description: "Nothing yet", default_branch: "master", empty: true })
    expect(owner.remote).toEqual({ protocol: "ssh", url: expect.stringMatching(/^ssh:\/\/localhost:\d+\/bobby:fresh$/), command: expect.stringMatching(/^git remote add origin ssh:\/\/localhost:\d+\/bobby:fresh$/) })

    const anonymous = await (await request.get(`${hub.url}/api/v1/repos/bobby/fresh`)).json()
    expect(anonymous).toMatchObject({ empty: true, remote: null })

    const files = await request.get(`${hub.url}/api/v1/repos/bobby/fresh/files`)
    expect(files.status()).toBe(404)
    expect(await files.json()).toEqual({ error: { code: "not_found", message: "This repository has no commits yet." } })
    await bobby.dispose()
  })
})

const numbered = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n") + "\n"
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xff, 0xfe])

test("local mode serves the repository it opened, with distinct empty, binary and windowed files", async ({ request, launch }) => {
  const backend = await launch.local({
    files: { "README.md": "# Fixture\n", "empty.txt": "", "logo.png": png, "big.txt": numbered(6000), "src/main.zig": "pub fn main() void {}\n" },
  })
  const hub = await launch.hub(backend.port)

  expect(await (await request.get(`${hub.url}/api/v1/repo`)).json()).toEqual({
    owner: null,
    name: "repo",
    description: "",
    access: null,
    default_branch: "main",
    default_branch_id: "branch:main",
    empty: false,
    sections: ["files", "commits", "refs", "discussions", "issues", "patches", "events"],
    clone: [],
    remote: null,
  })

  const root = await (await request.get(`${hub.url}/api/v1/repo/files`)).json()
  expect(root.items).toEqual([
    { name: "src", path: "src", kind: "dir" },
    { name: "README.md", path: "README.md", kind: "file" },
    { name: "big.txt", path: "big.txt", kind: "file" },
    { name: "empty.txt", path: "empty.txt", kind: "file" },
    { name: "logo.png", path: "logo.png", kind: "file" },
  ])

  const file = async (query: string) => (await request.get(`${hub.url}/api/v1/repo/files?${query}`)).json()
  expect((await file("path=empty.txt")).content).toEqual({ kind: "empty" })
  expect((await file("path=logo.png")).content).toEqual({ kind: "binary" })
  expect((await file("path=src%2Fmain.zig")).content.lines).toEqual(["pub fn main() void {}", ""])

  // a large file arrives a window at a time, each saying where the next starts
  const first = (await file("path=big.txt")).content
  expect(first).toMatchObject({ kind: "text", start_line: 1, has_more: true, next_line: 5001, total_lines: 6001 })
  expect(first.lines).toHaveLength(5000)
  expect(first.lines[4999]).toBe("line 5000")
  const next = (await file(`path=big.txt&line=${first.next_line}`)).content
  expect(next).toMatchObject({ kind: "text", start_line: 5001, has_more: false, next_line: null })
  expect(next.lines[0]).toBe("line 5001")

  for (const line of ["0", "x", "9999"]) {
    const response = await request.get(`${hub.url}/api/v1/repo/files?path=big.txt&line=${line}`)
    expect(response.status(), line).toBe(400)
    expect(await response.json()).toEqual({ error: { code: "validation", message: expect.any(String), field_errors: { line: expect.any(String) } } })
  }
})

test("local mode with no commits yet reports an empty repository", async ({ request, launch }) => {
  const backend = await launch.local({ files: null })
  const hub = await launch.hub(backend.port)

  expect(await (await request.get(`${hub.url}/api/v1/repo`)).json()).toMatchObject({ default_branch: "main", empty: true, remote: null })
  expect((await request.get(`${hub.url}/api/v1/repo/files`)).status()).toBe(404)
})

test("each host serves only its own kind of repository route, read-only", async ({ request, launch }) => {
  const local = await launch.local()
  const localHub = await launch.hub(local.port)
  const server = await launch.server()
  const serverHub = await launch.hub(server.port)

  for (const [hub, path] of [[localHub, "repos/alice/thing"], [serverHub, "repo"], [serverHub, "repo/files"]] as const) {
    const response = await request.get(`${hub.url}/api/v1/${path}`)
    expect(response.status(), path).toBe(405)
    expect(await response.json()).toEqual({ error: { code: "unsupported", message: expect.any(String) } })
  }
  const unknown = await request.get(`${serverHub.url}/api/v1/repos/alice/thing/elsewhere`)
  expect(unknown.status()).toBe(404)

  const response = await request.post(`${localHub.url}/api/v1/repo`, { data: {}, headers: await writeHeaders(request, localHub.url) })
  expect(response.status()).toBe(405)
  expect(response.headers()["allow"]).toBe("GET, HEAD")
})

test("paths that aren't UTF-8 or hold URL syntax travel as percent-encoded bytes and come back to the same file", async ({ request, launch }) => {
  const backend = await launch.local({
    files: { "a%2Fb.txt": "literal percent\n" },
    byteNamedFiles: [{ path: Uint8Array.from([...Buffer.from("caf"), 0xe9, ...Buffer.from(".txt")]), content: "latin-1 name\n" }],
  })
  const hub = await launch.hub(backend.port)

  const root = await (await request.get(`${hub.url}/api/v1/repo/files`)).json()
  expect(root.items).toEqual([
    { name: "a%2Fb.txt", path: "a%252Fb.txt", kind: "file" },
    { name: "caf�.txt", path: "caf%E9.txt", kind: "file" },
  ])

  // the path goes back exactly as given, and names the same bytes
  const latin = await request.get(`${hub.url}/api/v1/repo/files?path=caf%E9.txt`)
  expect(latin.status()).toBe(200)
  expect(await latin.json()).toMatchObject({ path: "caf%E9.txt", name: "caf�.txt", kind: "file", content: { lines: ["latin-1 name", ""] } })
  const literal = await (await request.get(`${hub.url}/api/v1/repo/files?path=a%252Fb.txt`)).json()
  expect(literal).toMatchObject({ path: "a%252Fb.txt", name: "a%2Fb.txt", content: { lines: ["literal percent", ""] } })
})
