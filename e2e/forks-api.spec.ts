import type { APIRequestContext } from "@playwright/test"
import { expect, test } from "./support/fixtures"
import { alice, writeHeaders } from "./support/accounts"
import { bob, draftsRepo, tuiPage } from "./support/drafts"
import { setPatchRole } from "./support/patches"
import { bobsFork } from "./support/forks"

// HTTP contract checks for browsing and deleting forks, through the same Vite
// proxy the browser uses, against a real Haxy server. Results are checked
// again in Haxy's own server-rendered pages (the TUI's).

type Availability = { available: boolean; reason?: { code: string; message: string } }
type Command = { action: "push" | "clone" | "merge"; protocol: string; url: string; command: string }
type ForkItem = { id: string; name: string; title: string; access: "public" | "private" | null; target_deleted: boolean }
type ForkList = { items: ForkItem[]; page: { has_more: boolean; next_cursor: string | null; count: { kind: string } } }
type Fork = {
  id: string
  forker: string
  name: string
  title: string
  draft: boolean
  target: { owner: string; name: string } | null
  patch: { kind: "draft" | "patch"; id: string } | null
  head: string
  base: string | null
  commit_count: number | null
  commands: Command[]
  actions: { delete: Availability }
}

async function send(request: APIRequestContext, hubUrl: string, method: string, url: string, body?: unknown) {
  const headers = { ...(await writeHeaders(request, hubUrl)), "Content-Type": "application/json" }
  return request.fetch(`${hubUrl}${url}`, { method, headers, data: body === undefined ? undefined : JSON.stringify(body) })
}

async function ok<T = Fork>(response: Awaited<ReturnType<typeof send>>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status)
  return response.json()
}

async function failure(response: Awaited<ReturnType<typeof send>>, status: number) {
  expect(response.status(), await response.text()).toBe(status)
  return (await response.json()).error
}

const drafts = "/api/v1/repos/alice/parser/patches/drafts"

test.describe("on a server", () => {
  test("a fork's owner browses its files, commits and diff, with its draft", async ({ playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, forker, id, base, head, fork } = await bobsFork(playwright, backend, hub.url)

    const summary = await ok(await forker.get(`${hub.url}${fork}`))
    expect(summary).toMatchObject({
      id,
      forker: "bobby",
      name: "parser",
      title: "Document the parser",
      draft: true,
      target: { owner: "alice", name: "parser" },
      patch: { kind: "draft", id },
      head,
      base,
      commit_count: 1,
      actions: { delete: { available: true } },
    })
    expect(summary.commands.map((command) => command.action)).toEqual(["push", "clone", "merge"])

    // its files are its patch branch's
    const root = await ok<{ ref: { id: string; commit: string }; items: Array<{ path: string }> }>(await forker.get(`${hub.url}${fork}/files`))
    expect(root.ref).toMatchObject({ id: "branch:patch", commit: head })
    expect(root.items.map((item) => item.path)).toEqual(expect.arrayContaining(["PARSER.md", "README.md"]))
    expect(await ok(await forker.get(`${hub.url}${fork}/files?path=PARSER.md`))).toMatchObject({ kind: "file", content: { kind: "text", lines: ["How the parser works.", ""] } })

    // its commits are what it adds to its base, as the TUI's fork commits tab lists them
    const history = await ok<{ items: Array<{ id: string }> }>(await forker.get(`${hub.url}${fork}/commits`))
    expect(history.items.map((item) => item.id)).toEqual([head])
    expect(await ok(await forker.get(`${hub.url}${fork}/commits/${head}`))).toMatchObject({ id: head, parent: base, summary: "Document the parser" })
    expect((await ok<{ items: Array<{ path: string }> }>(await forker.get(`${hub.url}${fork}/commits/${head}/diff`))).items.map((item) => item.path)).toEqual(["PARSER.md"])

    // its diff is everything it adds to its base
    const diff = await ok<{ base: string; head: string; items: Array<{ path: string; status: string }> }>(await forker.get(`${hub.url}${fork}/diff`))
    expect(diff).toMatchObject({ base, head, items: [{ path: "PARSER.md", status: "added" }] })

    // as in Haxy's own fork page
    expect(await tuiPage(forker, backend, `/bobby:parser+${id}`)).toContain("Document the parser")
    await owner.dispose()
    await forker.dispose()
  })

  test("a fork is as visible as its target, and only its owner reaches its draft", async ({ playwright, request, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, forker, repo, id, head, fork } = await bobsFork(playwright, backend, hub.url)
    const forks = "/api/v1/users/bobby/forks"

    // readers of a public target read the fork, but not its draft, and may not delete it
    for (const [context, code] of [[request, "unauthenticated"], [owner, "forbidden"]] as const) {
      expect(await ok(await context.get(`${hub.url}${fork}`))).toMatchObject({ id, head, draft: true, patch: null, actions: { delete: { available: false, reason: { code } } } })
      expect(await ok(await context.get(`${hub.url}${fork}/files?path=PARSER.md`))).toMatchObject({ kind: "file" })
      expect(await ok<ForkList>(await context.get(`${hub.url}${forks}`))).toEqual({
        items: [{ id, name: "parser", title: "Document the parser", access: "public", target_deleted: false }],
        page: { has_more: false, next_cursor: null, count: { kind: "unknown" } },
      })
    }

    // a private target hides it from everyone it hides the target from, its forker too
    await setPatchRole(owner, backend, { ...repo, access: "private" }, "anybody")
    for (const context of [request, forker]) {
      expect(await failure(await context.get(`${hub.url}${fork}`), 404)).toMatchObject({ code: "not_found" })
      expect(await failure(await context.get(`${hub.url}${fork}/commits`), 404)).toMatchObject({ code: "not_found" })
      expect((await ok<ForkList>(await context.get(`${hub.url}${forks}`))).items).toEqual([])
    }
    expect((await ok<ForkList>(await owner.get(`${hub.url}${forks}`))).items).toMatchObject([{ id, access: "private" }])
    expect(await tuiPage(request, backend, "/bobby/forks")).not.toContain("Document the parser")
    await owner.dispose()
    await forker.dispose()
  })

  test("a user's forks come a page at a time, newest first", async ({ playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, other } = await draftsRepo(playwright, backend, hub.url)
    const started: string[] = []
    for (const title of ["First", "Second", "Third"]) started.push((await ok<{ id: string }>(await send(other, hub.url, "POST", drafts, { title, target: "branch:main" }), 201)).id)

    const first = await ok<ForkList>(await owner.get(`${hub.url}/api/v1/users/bobby/forks?page_size=2`))
    expect(first.items.map((item) => item.title)).toEqual(["Third", "Second"])
    expect(first.page.has_more).toBe(true)
    const second = await ok<ForkList>(await owner.get(`${hub.url}/api/v1/users/bobby/forks?page_size=2&cursor=${first.page.next_cursor}`))
    expect(second.items.map((item) => item.title)).toEqual(["First"])
    expect(second.page).toMatchObject({ has_more: false, next_cursor: null })
    expect(await failure(await owner.get(`${hub.url}/api/v1/users/nobody/forks`), 404)).toMatchObject({ code: "not_found" })
    await owner.dispose()
    await other.dispose()
  })

  test("a fork whose target was deleted stays its owner's to read, fetch and delete", async ({ playwright, request, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, forker, id, head, fork } = await bobsFork(playwright, backend, hub.url)
    expect(await ok(await send(owner, hub.url, "DELETE", "/api/v1/repos/alice/parser", { confirm: "alice:parser", password: alice.password }))).toEqual({ owner: "alice", name: "parser" })

    const summary = await ok(await forker.get(`${hub.url}${fork}`))
    expect(summary).toMatchObject({ id, head, title: "Document the parser", target: null, patch: null, actions: { delete: { available: true } } })
    // it can't be pushed to any more, only cloned and fetched
    expect(summary.commands.map((command) => command.action)).toEqual(["clone", "merge"])
    expect(await ok(await forker.get(`${hub.url}${fork}/files?path=PARSER.md`))).toMatchObject({ kind: "file" })
    expect((await ok<{ items: Array<{ id: string }> }>(await forker.get(`${hub.url}${fork}/commits`))).items.map((item) => item.id)).toEqual([head])
    expect((await ok<ForkList>(await forker.get(`${hub.url}/api/v1/users/bobby/forks`))).items).toEqual([
      { id, name: "parser", title: "Document the parser", access: null, target_deleted: true },
    ])

    // nobody else finds it
    for (const context of [request, owner]) {
      expect(await failure(await context.get(`${hub.url}${fork}`), 404)).toMatchObject({ code: "not_found" })
      expect((await ok<ForkList>(await context.get(`${hub.url}/api/v1/users/bobby/forks`))).items).toEqual([])
    }
    expect(await tuiPage(forker, backend, `/bobby:parser+${id}`)).toContain("Document the parser")
    await owner.dispose()
    await forker.dispose()
  })

  test("only a fork's owner deletes it, with the typed name and their password", async ({ playwright, request, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, forker, id, fork } = await bobsFork(playwright, backend, hub.url)
    const fields = { confirm: "bobby:parser", password: bob.password }

    expect(await failure(await send(request, hub.url, "DELETE", fork, fields), 401)).toMatchObject({ code: "unauthenticated" })
    expect(await failure(await send(owner, hub.url, "DELETE", fork, { ...fields, password: alice.password }), 403)).toMatchObject({ code: "forbidden" })
    expect(await failure(await send(forker, hub.url, "DELETE", fork, { ...fields, confirm: "bobby:parse" }), 400)).toMatchObject({ code: "validation", field_errors: { confirm: "Type bobby:parser exactly to confirm." } })
    expect(await failure(await send(forker, hub.url, "DELETE", fork, { ...fields, password: "wrong" }), 400)).toMatchObject({ code: "validation", field_errors: { password: "Incorrect password." } })
    expect(await failure(await send(forker, hub.url, "PUT", fork, fields), 405)).toMatchObject({ code: "unsupported" })
    expect(await ok(await forker.get(`${hub.url}${fork}`))).toMatchObject({ id })

    expect(await ok(await send(forker, hub.url, "DELETE", fork, fields))).toEqual({ forker: "bobby", name: "parser", id })

    // gone after a restart: the fork, its draft and its list entry
    const restarted = await backend.restart!()
    expect(await failure(await forker.get(`${hub.url}${fork}`), 404)).toMatchObject({ code: "not_found" })
    expect(await failure(await forker.get(`${hub.url}${drafts}/${id}`), 404)).toMatchObject({ code: "not_found" })
    expect((await ok<ForkList>(await forker.get(`${hub.url}/api/v1/users/bobby/forks`))).items).toEqual([])
    expect(await failure(await send(forker, hub.url, "DELETE", fork, fields), 404)).toMatchObject({ code: "not_found" })
    expect(await tuiPage(forker, restarted, "/bobby/forks")).not.toContain("Document the parser")
    await owner.dispose()
    await forker.dispose()
  })

  test("a published patch's fork leads to the patch", async ({ playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, forker, id, fork } = await bobsFork(playwright, backend, hub.url)
    await ok(await send(forker, hub.url, "POST", `${drafts}/${id}/publish`))
    for (const context of [owner, forker]) expect(await ok(await context.get(`${hub.url}${fork}`))).toMatchObject({ draft: false, patch: { kind: "patch", id } })
    await owner.dispose()
    await forker.dispose()
  })
})

test("local mode has no forks", async ({ request, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  expect(await failure(await request.get(`${hub.url}/api/v1/forks/alice/parser/0123456789abcdef0123456789abcdef`), 405)).toMatchObject({ code: "unsupported" })
  expect(await failure(await request.get(`${hub.url}/api/v1/users/alice/forks`), 405)).toMatchObject({ code: "unsupported" })
})
