import { expect, test } from "./support/fixtures"
import { alice as aliceAccount, registerUser } from "./support/accounts"
import { addCommits, localGit } from "./support/history"
import { pushRepo } from "./support/push"
import { createRepo, signedIn } from "./support/repos"

// HTTP contract checks for a commit's diff, through the same Vite proxy the
// browser uses, against real Haxy fixtures. Its windows are the TUI's diff
// pane's: these mirror what Haxy's own diff window tests assert.

const latin1Name = Uint8Array.from([...Buffer.from("caf"), 0xe9, ...Buffer.from(".txt")])

/** Files `file-00.txt`… with the same content, one more than a window of 10 holds. */
function elevenFiles(): Record<string, string> {
  return Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`file-${String(index).padStart(2, "0")}.txt`, "added\n"]))
}

test("a commit's diff pages through its files ten entries at a time, and narrows to one path", async ({ request, launch }) => {
  const backend = await launch.local({ files: { "shared.txt": "shared\n" } })
  const hub = await launch.hub(backend.port)
  const git = localGit(backend)
  const root = git(["rev-parse", "HEAD"])
  const [head] = addCommits(git, [{ message: "Add eleven files", files: elevenFiles() }])
  const diff = async (id: string, query = "") => {
    const response = await request.get(`${hub.url}/api/v1/repo/commits/${id}/diff${query}`)
    expect(response.status(), query).toBe(200)
    return response.json()
  }

  const first = await diff(head)
  expect(first.commit).toBe(head)
  // against the first parent
  expect(first.parent).toBe(root)
  expect(first.path).toBeNull()
  expect(first.truncated).toBe(false)
  expect(first.items).toHaveLength(10)
  // an added file shows only its path, as in the TUI
  expect(first.items[0]).toEqual({ path: "file-00.txt", name: "file-00.txt", status: "added", kind: "file", lines: [] })
  expect(first.page).toEqual({ has_more: true, next_cursor: expect.any(String), count: { kind: "unknown" } })

  const last = await diff(head, `?cursor=${first.page.next_cursor}`)
  expect(last.items.map((item: { path: string }) => item.path)).toEqual(["file-10.txt"])
  expect(last.page).toEqual({ has_more: false, next_cursor: null, count: { kind: "unknown" } })

  // the filter narrows the diff to one file, and is echoed
  const filtered = await diff(head, "?path=file-03.txt")
  expect(filtered.path).toBe("file-03.txt")
  expect(filtered.items.map((item: { path: string }) => item.path)).toEqual(["file-03.txt"])
  expect(filtered.page.has_more).toBe(false)
  // a file the commit doesn't change has no changes, not an error
  expect((await diff(head, "?path=shared.txt")).items).toEqual([])

  // a smaller window on request
  const small = await diff(head, "?page_size=4")
  expect(small.items).toHaveLength(4)
  expect((await diff(head, `?page_size=4&cursor=${small.page.next_cursor}`)).items[0].path).toBe("file-04.txt")

  // a root commit adds the files it starts with
  const initial = await diff(root)
  expect(initial.parent).toBeNull()
  expect(initial.items).toEqual([{ path: "shared.txt", name: "shared.txt", status: "added", kind: "file", lines: [] }])
})

test("a commit's diff shows changed lines, binary and overlong files as placeholders, and byte paths encoded", async ({ request, launch }) => {
  const backend = await launch.local({
    files: { "text.txt": "one\ntwo\nthree\n", "gone.txt": "bye\n", "image.bin": Uint8Array.from([0, 0xff, 1]), "min.js": "x\n" },
    byteNamedFiles: [{ path: latin1Name, content: "latin-1\n" }],
  })
  const hub = await launch.hub(backend.port)
  const git = localGit(backend)
  const root = git(["rev-parse", "HEAD"])
  git(["rm", "--quiet", "--cached", "gone.txt"])
  const [head] = addCommits(git, [{
    message: "Change things",
    files: {
      "text.txt": "one\n2\nthree\n",
      "image.bin": Uint8Array.from([0, 0xfe, 1]),
      // a line past xit's 10,000 bytes makes the file binary to its diff
      "min.js": `${"x".repeat(12_000)}\n`,
    },
  }])
  const diff = await (await request.get(`${hub.url}/api/v1/repo/commits/${head}/diff`)).json()
  const byPath = Object.fromEntries(diff.items.map((item: { path: string }) => [item.path, item]))
  expect(Object.keys(byPath).sort()).toEqual(["gone.txt", "image.bin", "min.js", "text.txt"])
  expect(byPath["text.txt"]).toEqual({
    path: "text.txt", name: "text.txt", status: "changed", kind: "hunk",
    lines: [
      { kind: "context", old_number: 1, new_number: 1, text: "one" },
      { kind: "removed", old_number: 2, new_number: null, text: "two" },
      { kind: "added", old_number: null, new_number: 2, text: "2" },
      { kind: "context", old_number: 3, new_number: 3, text: "three" },
      { kind: "context", old_number: 4, new_number: 4, text: "" },
    ],
  })
  expect(byPath["image.bin"]).toMatchObject({ status: "changed", kind: "binary", lines: [] })
  expect(byPath["min.js"]).toMatchObject({ status: "changed", kind: "binary", lines: [] })
  expect(byPath["gone.txt"]).toMatchObject({ status: "removed", kind: "file", lines: [] })

  // a path that isn't UTF-8 travels percent-encoded, with a U+FFFD name, and filters as sent
  const initial = await (await request.get(`${hub.url}/api/v1/repo/commits/${root}/diff`)).json()
  expect(initial.items).toContainEqual({ path: "caf%E9.txt", name: "caf�.txt", status: "added", kind: "file", lines: [] })
  const narrowed = await (await request.get(`${hub.url}/api/v1/repo/commits/${root}/diff?path=caf%E9.txt`)).json()
  expect(narrowed.path).toBe("caf%E9.txt")
  expect(narrowed.items.map((item: { path: string }) => item.path)).toEqual(["caf%E9.txt"])
})

test("a commit's diff refuses what isn't a commit or a valid window", async ({ request, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  const git = localGit(backend)
  const head = git(["rev-parse", "HEAD"])
  const tree = git(["rev-parse", "HEAD^{tree}"])
  for (const id of ["abc", tree, "0".repeat(40)]) {
    const response = await request.get(`${hub.url}/api/v1/repo/commits/${id}/diff`)
    expect(response.status(), id).toBe(404)
    expect((await response.json()).error.code).toBe("not_found")
  }
  for (const [query, field] of [["path=%zz", "path"], ["cursor=x", "cursor"], ["page_size=0", "page_size"]]) {
    const response = await request.get(`${hub.url}/api/v1/repo/commits/${head}/diff?${query}`)
    expect(response.status(), query).toBe(400)
    expect(Object.keys((await response.json()).error.field_errors), query).toEqual([field])
  }
})

test.describe("on a server", () => {
  test("a pushed commit's diff reads for anyone who can see the repository, and is hidden from others", async ({ playwright, request, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    await registerUser(backend, aliceAccount)
    const context = await signedIn(playwright, backend, hub.url, aliceAccount.name, aliceAccount.password)
    for (const access of ["public", "private"] as const) {
      await createRepo(context, backend, { name: access, access })
      await pushRepo(playwright, backend, hub.url, aliceAccount, { owner: "alice", name: access }, {
        files: { "README.md": "# parser\n" },
        history: (git) => addCommits(git, [{ message: "Add the tokenizer", files: { "src/tokenizer.txt": "one\ntwo\n" } }]),
      })
    }
    for (const access of ["public", "private"] as const) {
      const history = await (await context.get(`${hub.url}/api/v1/repos/alice/${access}/commits`)).json()
      const id = history.items[0].id
      const own = await (await context.get(`${hub.url}/api/v1/repos/alice/${access}/commits/${id}/diff`)).json()
      expect(own.items).toEqual([expect.objectContaining({ path: "src/tokenizer.txt", status: "added", kind: "file" })])
      const anonymous = await request.get(`${hub.url}/api/v1/repos/alice/${access}/commits/${id}/diff`)
      expect(anonymous.status(), access).toBe(access === "public" ? 200 : 404)
    }
    // each host answers the other's routes as unsupported
    expect((await request.get(`${hub.url}/api/v1/repo/commits/${"0".repeat(40)}/diff`)).status()).toBe(405)
    await context.dispose()
  })
})
