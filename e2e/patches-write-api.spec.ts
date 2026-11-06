import type { APIRequestContext } from "@playwright/test"
import { expect, test } from "./support/fixtures"
import { alice, registerUser, writeHeaders, type Account } from "./support/accounts"
import type { Backend } from "./support/backend"
import { localGit } from "./support/history"
import { divergeBranch, setPatchRole, tuiPatchPage, tuiPatches } from "./support/patches"
import { pushRepo } from "./support/push"
import { createRepo, grantMember, signedIn } from "./support/repos"

// HTTP contract checks for the patch write routes (#18), through the same
// Vite proxy the browser uses, against real Haxy fixtures. Every result is
// checked again in Haxy's own server-rendered patches pages (the TUI's),
// after a refresh and a restart.

const bob: Account = { name: "bobby", email: "bobby@example.test", password: "battery staple horse" }
const id = expect.stringMatching(/^[0-9a-f]{32}$/)

type Availability = { available: boolean; reason?: { code: string; message: string } }
type Detail = {
  id: string
  title: string
  status: string
  edit_revision: string
  description_text: string
  labels: Array<{ name: string }>
  source: { kind: string; name: string; id: string }
  target: { name: string; id: string }
  revision: { id: string; source_commit: string } | null
  actions: Record<string, Availability>
}

/** Sends a JSON write through the hub, with the CSRF token a same-origin page would carry. */
async function send(request: APIRequestContext, hubUrl: string, method: string, path: string, body?: unknown) {
  const headers = { ...(await writeHeaders(request, hubUrl)), "Content-Type": "application/json" }
  return request.fetch(`${hubUrl}${path}`, { method, headers, data: body === undefined ? undefined : JSON.stringify(body) })
}

async function ok<T = Detail>(response: Awaited<ReturnType<typeof send>>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status)
  return response.json()
}

async function failure(response: Awaited<ReturnType<typeof send>>, status: number) {
  expect(response.status(), await response.text()).toBe(status)
  return (await response.json()).error
}

/** A local repository whose `feature` forked off `main`, with `other` at `main` and an `unrelated` branch sharing no history. */
async function branchedLocal(launch: { local(): Promise<Backend> }) {
  const backend = await launch.local()
  const git = localGit(backend)
  const commits = divergeBranch(git, "feature", [{ message: "Add the parser", files: { "src/parser.txt": "parse\n" } }])
  git(["branch", "other", "main"])
  const tree = git(["mktree"], { input: "" })
  const identity = { GIT_AUTHOR_NAME: "Alice", GIT_AUTHOR_EMAIL: "alice@example.test", GIT_COMMITTER_NAME: "Alice", GIT_COMMITTER_EMAIL: "alice@example.test" }
  git(["update-ref", "refs/heads/unrelated", git(["commit-tree", tree, "-m", "Unrelated"], { env: identity })])
  return { backend, git, commits }
}

test("local mode opens a branch-backed patch that Haxy's own patches tab lists, edits it, closes, reopens and removes it", async ({ request, launch }) => {
  const { backend, commits } = await branchedLocal(launch)
  const hub = await launch.hub(backend.port)
  const base = "/api/v1/repo/patches"

  // the local owner may open one
  const list = await ok<{ actions: Record<string, Availability> }>(await request.get(`${hub.url}${base}`))
  expect(list.actions).toEqual({ create: { available: true } })

  const chosen = "0123456789abcdef0123456789abcdef"
  const created = await ok(await send(request, hub.url, "POST", base, {
    id: chosen, title: "Add a parser", labels: "parser feature", description: "Parses\r\nthings.", source: "branch:feature", target: "branch:main",
  }), 201)
  expect(created).toMatchObject({
    id: chosen,
    title: "Add a parser",
    status: "open",
    labels: [{ name: "parser" }, { name: "feature" }],
    description_text: "Parses\nthings.",
    source: { kind: "branch", name: "feature", id: "branch:feature" },
    target: { name: "main", id: "branch:main" },
    revision: { id, source_commit: commits.branch[0] },
    edit_revision: id,
  })
  expect(created.actions).toEqual({ edit: { available: true }, set_status: { available: true }, remove: { available: true }, attach: { available: true } })
  expect((await tuiPatches(backend, "", "open")).ids).toEqual([chosen])
  expect(await tuiPatchPage(backend, "", chosen)).toContain("Add a parser")

  // creation is idempotent by id: a retry is refused, and opens nothing
  expect(await failure(await send(request, hub.url, "POST", base, { id: chosen, title: "Again", source: "branch:feature", target: "branch:other" }), 409))
    .toMatchObject({ code: "conflict", field_errors: { id: expect.any(String) } })
  expect((await tuiPatches(backend, "", "open")).ids).toEqual([chosen])

  // an edit replaces the fields as of the revision it names
  const edited = await ok(await send(request, hub.url, "PATCH", `${base}/${chosen}`, {
    revision: created.edit_revision, title: "Add a parser, tested", labels: "parser", description: "Parses things.", target: "branch:main",
  }))
  expect(edited).toMatchObject({ title: "Add a parser, tested", labels: [{ name: "parser" }], target: { name: "main" }, revision: { id: created.revision!.id } })
  expect(edited.edit_revision).not.toBe(created.edit_revision)
  // one made against the revision before is refused, and changes nothing
  expect(await failure(await send(request, hub.url, "PATCH", `${base}/${chosen}`, {
    revision: created.edit_revision, title: "Overwritten", labels: "", description: "", target: "branch:main",
  }), 409)).toMatchObject({ code: "conflict", field_errors: { revision: expect.any(String) } })
  expect(await tuiPatchPage(backend, "", chosen)).toContain("Add a parser, tested")

  // retargeting captures the source again, against the new target
  const retargeted = await ok(await send(request, hub.url, "PATCH", `${base}/${chosen}`, {
    revision: edited.edit_revision, title: "Add a parser, tested", labels: "parser", description: "Parses things.", target: "branch:other",
  }))
  expect(retargeted.target).toEqual({ name: "other", id: "branch:other" })
  expect(retargeted.revision!.id).not.toBe(created.revision!.id)

  // closing and reopening, which a retry repeats harmlessly
  expect(await ok(await send(request, hub.url, "PUT", `${base}/${chosen}/status`, { status: "closed" }))).toMatchObject({ status: "closed", edit_revision: retargeted.edit_revision })
  expect(await ok(await send(request, hub.url, "PUT", `${base}/${chosen}/status`, { status: "closed" }))).toMatchObject({ status: "closed" })
  expect((await tuiPatches(backend, "", "closed")).ids).toEqual([chosen])
  expect(await ok(await send(request, hub.url, "PUT", `${base}/${chosen}/status`, { status: "open" }))).toMatchObject({ status: "open", revision: { id } })
  expect((await tuiPatches(backend, "", "open")).ids).toEqual([chosen])

  // what was written survives Haxy reopening the repository
  const restarted = await backend.restart!()
  expect(await ok(await request.get(`${hub.url}${base}/${chosen}`))).toMatchObject({ title: "Add a parser, tested", status: "open", target: { name: "other" } })

  // removing it takes it out of every list; it is gone after that
  expect(await ok(await send(request, hub.url, "DELETE", `${base}/${chosen}`))).toEqual({ id: chosen })
  expect(await failure(await request.get(`${hub.url}${base}/${chosen}`), 404)).toEqual({ code: "not_found", message: "There is no patch with this id." })
  expect(await failure(await send(request, hub.url, "DELETE", `${base}/${chosen}`), 404)).toMatchObject({ code: "not_found" })
  expect((await tuiPatches(restarted, "", "open")).ids).toEqual([])
  // its branch stays
  expect(await ok(await request.get(`${hub.url}/api/v1/repo/branches?search=feature`))).toMatchObject({ items: [{ name: "feature" }] })
})

test("a patch's branches and fields are checked, each refusal naming its field", async ({ request, launch }) => {
  const { backend } = await branchedLocal(launch)
  const hub = await launch.hub(backend.port)
  const base = "/api/v1/repo/patches"
  const create = (body: Record<string, string>) => send(request, hub.url, "POST", base, { title: "A patch", source: "branch:feature", target: "branch:main", ...body })
  const fieldOf = async (body: Record<string, string>, field: string) => {
    const error = await failure(await create(body), 400)
    expect(error, JSON.stringify(body)).toMatchObject({ code: "validation", field_errors: { [field]: expect.any(String) } })
    return error.field_errors[field] as string
  }
  // a source or target that is no branch's id, or no branch
  await fieldOf({ source: "feature" }, "source")
  await fieldOf({ source: "tag:v1" }, "source")
  await fieldOf({ source: "" }, "source")
  await fieldOf({ target: "branch:a%2" }, "target")
  expect(await fieldOf({ source: "branch:missing" }, "source")).toMatch(/no such branch/)
  expect(await fieldOf({ target: "branch:missing" }, "target")).toMatch(/no such branch/)
  // the same branch, and one sharing no history with the source
  expect(await fieldOf({ target: "branch:feature" }, "target")).toMatch(/another branch/)
  expect(await fieldOf({ target: "branch:unrelated" }, "target")).toMatch(/no history/)
  // the shared field rules
  await fieldOf({ title: "  " }, "title")
  await fieldOf({ labels: "x".repeat(65) }, "labels")
  await fieldOf({ id: "ABC" }, "id")
  // nothing was opened
  expect((await tuiPatches(backend, "", "open")).ids).toEqual([])

  // a branch with nothing to propose opens a patch that changes nothing, as in Haxy's own form
  const same = await ok(await create({ source: "branch:other" }), 201)
  expect(same).toMatchObject({ no_changes: true })

  // an edit is checked the same way, and needs the revision it replaces
  const edit = (body: Record<string, string>) => send(request, hub.url, "PATCH", `${base}/${same.id}`, { revision: same.edit_revision, title: "A patch", target: "branch:main", ...body })
  expect(await failure(await edit({ revision: "" }), 400)).toMatchObject({ field_errors: { revision: expect.any(String) } })
  expect(await failure(await edit({ target: "branch:missing" }), 400)).toMatchObject({ field_errors: { target: expect.any(String) } })
  expect(await failure(await edit({ target: "branch:other" }), 400)).toMatchObject({ field_errors: { target: expect.stringMatching(/another branch/) } })
  expect(await failure(await edit({ title: "" }), 400)).toMatchObject({ field_errors: { title: expect.any(String) } })
  expect(await failure(await send(request, hub.url, "PUT", `${base}/${same.id}/status`, { status: "merged" }), 400)).toMatchObject({ field_errors: { status: expect.any(String) } })

  // unknown ids, and wrong methods
  const unknown = "fedcba9876543210fedcba9876543210"
  expect(await failure(await send(request, hub.url, "PATCH", `${base}/${unknown}`, { revision: same.edit_revision, title: "x", target: "branch:main" }), 404)).toMatchObject({ code: "not_found" })
  expect(await failure(await send(request, hub.url, "PUT", `${base}/${unknown}/status`, { status: "closed" }), 404)).toMatchObject({ code: "not_found" })
  const wrong = async (method: string, path: string, allow: string) => {
    const response = await send(request, hub.url, method, path, {})
    expect(response.status(), `${method} ${path}`).toBe(405)
    expect(response.headers().allow).toBe(allow)
  }
  await wrong("PUT", base, "GET, HEAD, POST")
  await wrong("POST", `${base}/${same.id}`, "GET, HEAD, PATCH, DELETE")
  await wrong("PATCH", `${base}/${same.id}/status`, "PUT")
  expect((await request.get(`${hub.url}${base}/${same.id}/status`)).status()).toBe(405)
})

test.describe("on a server", () => {
  /** alice's public repository with `feature` one commit ahead of `main`, bob registered too; both signed in. */
  async function pushed(playwright: Parameters<typeof signedIn>[0], backend: Backend, hubUrl: string) {
    await registerUser(backend, alice)
    await registerUser(backend, bob)
    const owner = await signedIn(playwright, backend, hubUrl, alice.name, alice.password)
    const other = await signedIn(playwright, backend, hubUrl, bob.name, bob.password)
    await createRepo(owner, backend, { name: "parser", access: "public" })
    await pushRepo(playwright, backend, hubUrl, alice, { owner: "alice", name: "parser" }, {
      files: { "README.md": "# parser\n" },
      history: (git) => {
        divergeBranch(git, "feature", [{ message: "Add the parser", files: { "src/parser.txt": "parse\n" } }])
        git(["branch", "other", "main"])
      },
    })
    const repo = { owner: "alice", name: "parser", access: "public" } as const
    return { owner, other, repo, base: "/api/v1/repos/alice/parser/patches" }
  }

  test("who may open, change and remove a patch is Haxy's rule: the patches tab's role, then its author or a writer", async ({ playwright, request, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, other, repo, base } = await pushed(playwright, backend, hub.url)
    await setPatchRole(owner, backend, repo, "members")
    const body = { title: "Add a parser", source: "branch:feature", target: "branch:main" }

    // anonymous viewers, and readers below the patches tab's role, may not open one
    expect(await failure(await send(request, hub.url, "POST", base, body), 401)).toMatchObject({ code: "unauthenticated" })
    expect((await ok<{ actions: unknown }>(await request.get(`${hub.url}${base}`))).actions).toEqual({ create: { available: false, reason: { code: "unauthenticated", message: expect.any(String) } } })
    expect(await failure(await send(other, hub.url, "POST", base, body), 403)).toEqual({ code: "forbidden", message: "Your role in this repository doesn't allow writing patches." })
    expect((await ok<{ actions: unknown }>(await other.get(`${hub.url}${base}`))).actions).toEqual({ create: { available: false, reason: { code: "forbidden", message: expect.any(String) } } })

    // the owner opens one; Haxy's own pages show it, after a restart too
    const mine = await ok(await send(owner, hub.url, "POST", base, body), 201)
    expect(mine).toMatchObject({ author: { kind: "user", name: "alice" }, revision: { id } })
    expect((await tuiPatches(backend, "/alice:parser", "open")).ids).toEqual([mine.id])
    const restarted = await backend.restart!()
    expect((await tuiPatches(restarted, "/alice:parser", "open")).ids).toEqual([mine.id])

    // once anybody who can read may write patches, bob opens his own
    await setPatchRole(owner, restarted, repo, "anybody")
    const his = await ok(await send(other, hub.url, "POST", base, { ...body, title: "Bob's take", target: "branch:other" }), 201)
    // he may change his own, not alice's
    expect((await ok(await other.get(`${hub.url}${base}/${mine.id}`))).actions.edit).toEqual({ available: false, reason: { code: "forbidden", message: expect.any(String) } })
    expect(await failure(await send(other, hub.url, "PATCH", `${base}/${mine.id}`, { revision: mine.edit_revision, title: "Mine now", target: "branch:main" }), 403)).toMatchObject({ code: "forbidden" })
    expect(await failure(await send(other, hub.url, "PUT", `${base}/${mine.id}/status`, { status: "closed" }), 403)).toMatchObject({ code: "forbidden" })
    expect(await failure(await send(other, hub.url, "DELETE", `${base}/${mine.id}`), 403)).toMatchObject({ code: "forbidden" })
    expect(await ok(await send(other, hub.url, "PUT", `${base}/${his.id}/status`, { status: "closed" }))).toMatchObject({ status: "closed" })
    // the owner, a writer, may change anyone's
    expect(await ok(await send(owner, hub.url, "PATCH", `${base}/${his.id}`, { revision: his.edit_revision, title: "Bob's take, reviewed", target: "branch:other" }))).toMatchObject({ title: "Bob's take, reviewed", status: "closed" })

    // a role revoked after the page loaded is refused, not a false success
    await setPatchRole(owner, restarted, repo, "members")
    expect(await failure(await send(other, hub.url, "PUT", `${base}/${his.id}/status`, { status: "open" }), 403)).toMatchObject({ code: "forbidden" })
    // a member writes again
    await grantMember(owner, restarted, repo, bob.name)
    expect(await ok(await send(other, hub.url, "DELETE", `${base}/${mine.id}`))).toEqual({ id: mine.id })
    expect((await tuiPatches(restarted, "/alice:parser", "open")).ids).toEqual([])
    await owner.dispose()
    await other.dispose()
  })

  test.describe("with the demo data", () => {
    test.skip(!process.env.HAXY_E2E_DEMO_BIN, "HAXY_BIN was given without HAXY_TRY_BIN")

    test("a merged patch stays merged: its status and target can't change, its title can", async ({ playwright, launch }) => {
      const backend = await launch.demo()
      const hub = await launch.hub(backend.port)
      const admin = await signedIn(playwright, backend, hub.url, "admin", "password")
      const base = "/api/v1/repos/admin/toolbox/patches"
      const [merged] = (await ok<{ items: Detail[] }>(await admin.get(`${hub.url}${base}?status=merged`))).items
      const detail = await ok(await admin.get(`${hub.url}${base}/${merged.id}`))
      expect(detail.actions).toMatchObject({ edit: { available: true }, set_status: { available: false, reason: { code: "unsupported" } }, remove: { available: true } })
      expect(await failure(await send(admin, hub.url, "PUT", `${base}/${merged.id}/status`, { status: "closed" }), 409)).toMatchObject({ code: "conflict" })
      // what it landed in stays where it landed
      const branches = await ok<{ items: Array<{ id: string }> }>(await admin.get(`${hub.url}/api/v1/repos/admin/toolbox/branches`))
      const elsewhere = branches.items.find((branch) => branch.id !== detail.target.id)
      if (elsewhere) {
        expect(await failure(await send(admin, hub.url, "PATCH", `${base}/${merged.id}`, { revision: detail.edit_revision, title: detail.title, target: elsewhere.id }), 409)).toMatchObject({ code: "conflict" })
      }
      expect(await ok(await send(admin, hub.url, "PATCH", `${base}/${merged.id}`, { revision: detail.edit_revision, title: "Retire the legacy loader", target: detail.target.id }))).toMatchObject({ title: "Retire the legacy loader", status: "merged" })
      expect(await tuiPatchPage(backend, "/admin:toolbox", merged.id)).toContain("Retire the legacy loader")
      await admin.dispose()
    })
  })
})
