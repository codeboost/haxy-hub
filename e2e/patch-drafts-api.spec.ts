import { glob, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { APIRequestContext, PlaywrightWorkerArgs } from "@playwright/test"
import { expect, test } from "./support/fixtures"
import { alice, writeHeaders } from "./support/accounts"
import type { Backend } from "./support/backend"
import { draftsRepo, tuiPage } from "./support/drafts"
import { setPatchRole, tuiPatches } from "./support/patches"
import { sshUser } from "./support/ssh"

// HTTP contract checks for fork-backed drafts, through the same Vite proxy
// the browser uses, against a real Haxy server. Every result is checked again
// in Haxy's own server-rendered pages (the TUI's), after a refresh or a restart.

const chosenId = "0123456789abcdef0123456789abcdef"

type Availability = { available: boolean; reason?: { code: string; message: string } }
type Command = { action: "push" | "clone" | "merge"; protocol: string; url: string; command: string }
type Draft = {
  id: string
  title: string
  labels: string[]
  description_text: string
  target: { name: string; id: string }
  fork: { owner: string; name: string }
  revision: { id: string; source_commit: string; commit_count: number | null } | null
  no_changes: boolean
  commands: Command[]
  edit_revision: string
  actions: Record<"edit" | "remove" | "publish", Availability>
}
type DraftList = { actions: { create: Availability }; items: Draft[]; page: { has_more: boolean; next_cursor: string | null; count: { kind: string; value: number } } }

async function send(request: APIRequestContext, hubUrl: string, method: string, path: string, body?: unknown) {
  const headers = { ...(await writeHeaders(request, hubUrl)), "Content-Type": "application/json" }
  return request.fetch(`${hubUrl}${path}`, { method, headers, data: body === undefined ? undefined : JSON.stringify(body) })
}

async function ok<T = Draft>(response: Awaited<ReturnType<typeof send>>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status)
  return response.json()
}

async function failure(response: Awaited<ReturnType<typeof send>>, status: number) {
  expect(response.status(), await response.text()).toBe(status)
  return (await response.json()).error
}

async function pushed(playwright: PlaywrightWorkerArgs["playwright"], backend: Backend, hubUrl: string) {
  return { ...(await draftsRepo(playwright, backend, hubUrl)), drafts: "/api/v1/repos/alice/parser/patches/drafts", patches: "/api/v1/repos/alice/parser/patches" }
}

/**
 * The commands for draft `id`'s fork, as the TUI builds them: from the
 * repository's SSH clone URL and the host's SSH prefix, which its overview's
 * clone command carries.
 */
async function expectedCommands(context: APIRequestContext, hubUrl: string, id: string): Promise<Command[]> {
  const overview = await ok<{ clone: Array<{ protocol: string; url: string; command: string }> }>(await context.get(`${hubUrl}/api/v1/repos/alice/parser`))
  const ssh = overview.clone.find((command) => command.protocol === "ssh")
  if (!ssh) throw new Error("The server offers no SSH URL.")
  const prefix = ssh.command.slice(0, ssh.command.length - `git clone ${ssh.url}`.length)
  const fork = `${ssh.url}+${id}`
  return [
    { action: "push", protocol: "ssh", url: fork, command: `${prefix}git push ${fork} HEAD:patch` },
    { action: "clone", protocol: "ssh", url: fork, command: `${prefix}git clone ${fork}` },
    { action: "merge", protocol: "ssh", url: fork, command: `${prefix}git fetch '${fork}' refs/heads/patch && git merge FETCH_HEAD` },
  ]
}

test.describe("on a server", () => {
  test("starting a fork makes a draft only its author finds, with its fork's commands", async ({ playwright, request, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, other, drafts, patches } = await pushed(playwright, backend, hub.url)

    // only a signed-in viewer has drafts
    expect(await failure(await request.get(`${hub.url}${drafts}`), 401)).toMatchObject({ code: "unauthenticated" })
    expect(await ok<DraftList>(await owner.get(`${hub.url}${drafts}`))).toEqual({ actions: { create: { available: true } }, items: [], page: { has_more: false, next_cursor: null, count: { kind: "exact", value: 0 } } })

    const draft = await ok(await send(owner, hub.url, "POST", drafts, {
      id: chosenId, title: "Speed up parsing", labels: "parser perf", description: "Parses\r\nfaster.", target: "branch:main",
    }), 201)
    expect(draft).toMatchObject({
      id: chosenId,
      title: "Speed up parsing",
      labels: ["parser", "perf"],
      description_text: "Parses\nfaster.",
      target: { name: "main", id: "branch:main" },
      fork: { owner: "alice", name: "parser" },
      revision: null,
      no_changes: true,
      actions: { edit: { available: true }, remove: { available: true }, publish: { available: true } },
    })

    // the fork's commands are the TUI's, built from the server's own SSH URL
    expect(draft.commands).toEqual(await expectedCommands(owner, hub.url, chosenId))

    // the same id can't start a second draft
    expect(await failure(await send(owner, hub.url, "POST", drafts, { id: chosenId, title: "Again", target: "branch:main" }), 409)).toMatchObject({ code: "conflict", field_errors: { id: expect.any(String) } })

    // its author lists it, here and in Haxy's own drafts tab
    expect((await ok<DraftList>(await owner.get(`${hub.url}${drafts}`))).items.map((item) => item.id)).toEqual([chosenId])
    expect(await tuiPage(owner, backend, "/alice:parser/patches/drafts")).toContain("Speed up parsing")

    // nobody else finds it, by any route; nor is it a patch yet
    expect((await ok<DraftList>(await other.get(`${hub.url}${drafts}`))).items).toEqual([])
    for (const context of [request, other]) expect(await failure(await context.get(`${hub.url}${drafts}/${chosenId}`), 404)).toMatchObject({ code: "not_found" })
    expect(await failure(await send(other, hub.url, "PATCH", `${drafts}/${chosenId}`, { revision: draft.edit_revision, title: "Mine", target: "branch:main" }), 404)).toMatchObject({ code: "not_found" })
    expect(await failure(await send(other, hub.url, "DELETE", `${drafts}/${chosenId}`), 404)).toMatchObject({ code: "not_found" })
    expect(await failure(await send(other, hub.url, "POST", `${drafts}/${chosenId}/publish`), 404)).toMatchObject({ code: "not_found" })
    expect(await failure(await owner.get(`${hub.url}${patches}/${chosenId}`), 404)).toMatchObject({ code: "not_found" })
    expect(await tuiPage(other, backend, "/alice:parser/patches/drafts")).not.toContain("Speed up parsing")
    await owner.dispose()
    await other.dispose()
  })

  test("a draft's edits are checked and persist, and removing it takes it away", async ({ playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, drafts } = await pushed(playwright, backend, hub.url)
    const draft = await ok(await send(owner, hub.url, "POST", drafts, { id: chosenId, title: "Speed up parsing", target: "branch:main" }), 201)

    // edits are checked and must name the revision they replace
    const edit = { revision: draft.edit_revision, title: "Parse faster", labels: "perf", description: "Twice as fast.", target: "branch:feature" }
    expect(await failure(await send(owner, hub.url, "PATCH", `${drafts}/${chosenId}`, { ...edit, target: "branch:nope" }), 400)).toMatchObject({ field_errors: { target: expect.any(String) } })
    expect(await failure(await send(owner, hub.url, "PATCH", `${drafts}/${chosenId}`, { ...edit, title: " " }), 400)).toMatchObject({ field_errors: { title: "Enter a title." } })
    const edited = await ok(await send(owner, hub.url, "PATCH", `${drafts}/${chosenId}`, edit))
    expect(edited).toMatchObject({ title: "Parse faster", labels: ["perf"], description_text: "Twice as fast.", target: { name: "feature", id: "branch:feature" } })
    expect(await failure(await send(owner, hub.url, "PATCH", `${drafts}/${chosenId}`, { ...edit, title: "Stale" }), 409)).toMatchObject({ field_errors: { revision: expect.any(String) } })

    // what was written is there after a restart
    const restarted = await backend.restart!()
    expect(await ok(await owner.get(`${hub.url}${drafts}/${chosenId}`))).toMatchObject({ title: "Parse faster", target: { id: "branch:feature" }, edit_revision: edited.edit_revision })
    expect(await tuiPage(owner, restarted, "/alice:parser/patches/drafts")).toContain("Parse faster")

    // removing it takes it, and its fork, away
    expect(await ok(await send(owner, hub.url, "DELETE", `${drafts}/${chosenId}`))).toEqual({ id: chosenId })
    expect(await failure(await owner.get(`${hub.url}${drafts}/${chosenId}`), 404)).toMatchObject({ code: "not_found" })
    expect((await ok<DraftList>(await owner.get(`${hub.url}${drafts}`))).items).toEqual([])
    expect(await tuiPage(owner, restarted, "/alice:parser/patches/drafts")).not.toContain("Parse faster")
    expect(await failure(await send(owner, hub.url, "DELETE", `${drafts}/${chosenId}`), 404)).toMatchObject({ code: "not_found" })
    await owner.dispose()
  })

  test("publishing a draft makes it a repository patch, and an unmet precondition says Haxy's reason", async ({ playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, other, repo, drafts, patches } = await pushed(playwright, backend, hub.url)
    const draft = await ok(await send(other, hub.url, "POST", drafts, { title: "Bob's idea", target: "branch:main" }), 201)

    // a role lost since the draft was started refuses its publication
    await setPatchRole(owner, backend, repo, "members")
    expect((await ok(await other.get(`${hub.url}${drafts}/${draft.id}`))).actions.publish).toEqual({ available: false, reason: { code: "forbidden", message: "Your role in this repository doesn't allow writing patches." } })
    expect(await failure(await send(other, hub.url, "POST", `${drafts}/${draft.id}/publish`), 403)).toEqual({ code: "forbidden", message: "Your role in this repository doesn't allow writing patches." })
    expect(await failure(await other.get(`${hub.url}${patches}/${draft.id}`), 404)).toMatchObject({ code: "not_found" })

    await setPatchRole(owner, backend, repo, "anybody")
    const patch = await ok<{ id: string; title: string; status: string; source: unknown; commands: Command[] }>(await send(other, hub.url, "POST", `${drafts}/${draft.id}/publish`))
    expect(patch).toMatchObject({ id: draft.id, title: "Bob's idea", status: "open", source: { kind: "fork", fork: { owner: "bobby", name: "parser" } } })
    // its fork stays where it was, with the same commands, for anyone reading the patch
    expect((await ok<{ commands: Command[] }>(await owner.get(`${hub.url}${patches}/${draft.id}`))).commands).toEqual(draft.commands)
    // publishing it again changes nothing, so a lost answer can be retried
    expect(await ok(await send(other, hub.url, "POST", `${drafts}/${draft.id}/publish`))).toMatchObject({ id: draft.id, status: "open" })

    // it is a patch everyone reads now, and no draft any more
    expect(await ok(await owner.get(`${hub.url}${patches}/${draft.id}`))).toMatchObject({ title: "Bob's idea" })
    expect(await failure(await other.get(`${hub.url}${drafts}/${draft.id}`), 404)).toMatchObject({ code: "not_found" })
    expect((await ok<DraftList>(await other.get(`${hub.url}${drafts}`))).items).toEqual([])
    expect((await tuiPatches(backend, "/alice:parser", "open")).ids).toEqual([draft.id])
    await owner.dispose()
    await other.dispose()
  })

  test("pushing to a draft's fork over SSH updates the draft, and publishing carries the push", async ({ playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, drafts, patches } = await pushed(playwright, backend, hub.url)
    const draft = await ok(await send(owner, hub.url, "POST", drafts, { title: "Document the parser", target: "branch:main" }), 201)
    const push = draft.commands.find((command) => command.action === "push")
    if (!push) throw new Error("The draft offers no push command.")

    // clone the fork, commit to it and push, as its commands say
    const git = await sshUser(backend, hub.url, owner, alice.name)
    const work = await git.workTree("draft", "main", [])
    await git.git(work, "pull", "--quiet", push.url, "patch")
    await writeFile(path.join(work, "PARSER.md"), "How the parser works.\n")
    await git.git(work, "add", "PARSER.md")
    await git.git(work, "commit", "--quiet", "-m", "Document the parser")
    await git.git(work, "push", "--quiet", push.url, "HEAD:patch")
    const head = (await git.git(work, "rev-parse", "HEAD")).trim()

    const updated = await ok(await owner.get(`${hub.url}${drafts}/${draft.id}`))
    expect(updated).toMatchObject({ revision: { source_commit: head, commit_count: 1 }, no_changes: false })

    const patch = await ok<{ revision: { source_commit: string } }>(await send(owner, hub.url, "POST", `${drafts}/${draft.id}/publish`))
    expect(patch.revision.source_commit).toBe(head)
    expect(await ok(await owner.get(`${hub.url}${patches}/${draft.id}`))).toMatchObject({ revision: { source_commit: head, commit_count: 1 } })
    await owner.dispose()
  })
})

/** The directory of fork `id` in the server's data dir (its forker's), found by its name. */
async function forkDir(backend: Backend, id: string): Promise<string> {
  for await (const entry of glob(path.join("users", "*", "forks", id), { cwd: backend.dataDir })) return path.join(backend.dataDir, entry)
  throw new Error(`No fork ${id} in ${backend.dataDir}`)
}

test.describe("on a server, paging", () => {
  test("a draft whose fork can't be read is left out, and the pages go on past it", async ({ playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, drafts } = await pushed(playwright, backend, hub.url)
    const started: string[] = []
    for (const title of ["First", "Second", "Third"]) started.push((await ok(await send(owner, hub.url, "POST", drafts, { title, target: "branch:main" }), 201)).id)
    await rm(await forkDir(backend, started[1]), { recursive: true, force: true })

    // newest first, one a page: the third, then (the second unreadable) the first
    const seen: string[] = []
    let cursor = ""
    for (let pages = 0; pages < started.length; pages++) {
      const page = await ok<DraftList>(await owner.get(`${hub.url}${drafts}?page_size=1${cursor ? `&cursor=${cursor}` : ""}`))
      seen.push(...page.items.map((item) => item.id))
      if (!page.page.next_cursor) break
      cursor = page.page.next_cursor
    }
    expect(seen).toEqual([started[2], started[0]])
    await owner.dispose()
  })
})

test("local mode has no drafts", async ({ request, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  expect(await failure(await request.get(`${hub.url}/api/v1/repo/patches/drafts`), 405)).toMatchObject({ code: "unsupported" })
  expect(await failure(await send(request, hub.url, "POST", "/api/v1/repo/patches/drafts", { title: "A fork", target: "branch:main" }), 405)).toMatchObject({ code: "unsupported" })
})
