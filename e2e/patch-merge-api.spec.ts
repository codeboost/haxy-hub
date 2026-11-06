import type { APIRequestContext } from "@playwright/test"
import { expect, test } from "./support/fixtures"
import { writeHeaders } from "./support/accounts"
import { localGit } from "./support/history"
import { divergeBranch, tuiPatchPage, tuiPatches } from "./support/patches"
import { formMerge, mergeRepo, tuiMergePage, type Reviewed } from "./support/patchMerge"
import { grantMember } from "./support/repos"

// HTTP contract checks for merging patches through the same Vite proxy the
// browser uses, against real Haxy fixtures. Every merge is checked again
// after a refresh and in Haxy's own server-rendered patches pages (the TUI's).

type Availability = { available: boolean; reason?: { code: string; message: string } }
type Detail = {
  id: string
  status: string
  revision: { id: string } | null
  target: { name: string; id: string; commit: string | null }
  merged: { method: string; revision: string } | null
  mergeability: { available: boolean; source?: string; squash?: string; reason?: { code: string; message: string } }
  actions: Record<string, Availability>
}

async function merge(request: APIRequestContext, hubUrl: string, path: string, body: unknown) {
  const headers = { ...(await writeHeaders(request, hubUrl)), "Content-Type": "application/json" }
  return request.fetch(`${hubUrl}${path}`, { method: "POST", headers, data: JSON.stringify(body) })
}

async function ok<T = Detail>(response: Awaited<ReturnType<typeof merge>>): Promise<T> {
  expect(response.status(), await response.text()).toBe(200)
  return response.json()
}

async function failure(response: Awaited<ReturnType<typeof merge>>, status: number) {
  expect(response.status(), await response.text()).toBe(status)
  return (await response.json()).error
}

function reviewedOf(patch: Detail): Reviewed {
  return { revision: patch.revision!.id, target_commit: patch.target.commit! }
}

test.describe("on a server", () => {
  test("a writer merges one patch with its commits and squash-merges another; a target that moved after the read is refused first", async ({ playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, feature, docs, base } = await mergeRepo(playwright, backend, hub.url)
    const read = async (id: string) => ok(await owner.get(`${hub.url}${base}/${id}`))

    // both are offered, and both read the same target tip
    const loaded = await read(feature)
    const docsLoaded = await read(docs)
    expect(loaded.actions.merge).toEqual({ available: true })
    expect(loaded.mergeability).toEqual({ available: true, source: "clean", squash: "clean" })
    expect(loaded.target).toEqual({ name: "main", id: "branch:main", commit: expect.stringMatching(/^[0-9a-f]{40}$/) })
    expect(docsLoaded.target.commit).toBe(loaded.target.commit)

    // the docs land with their commits; the target moves
    const merged = await ok(await merge(owner, hub.url, `${base}/${docs}/merge`, { method: "source", ...reviewedOf(docsLoaded) }))
    expect(merged).toMatchObject({ id: docs, status: "merged", merged: { method: "source" }, target: { commit: null } })
    expect(merged.actions.merge).toMatchObject({ available: false, reason: { code: "unsupported" } })

    // the parser's merge was reviewed against the old tip: refused, nothing changes
    const moved = await failure(await merge(owner, hub.url, `${base}/${feature}/merge`, { method: "squash", ...reviewedOf(loaded) }), 409)
    expect(moved).toMatchObject({ code: "conflict", field_errors: { target_commit: expect.any(String) } })
    const reread = await read(feature)
    expect(reread.status).toBe("open")
    expect(reread.target.commit).not.toBe(loaded.target.commit)

    // reviewed again, it squash-merges into the new tip
    const squashed = await ok(await merge(owner, hub.url, `${base}/${feature}/merge`, { method: "squash", ...reviewedOf(reread) }))
    expect(squashed).toMatchObject({ status: "merged", merged: { method: "squash" } })
    // a second merge of it (a retry, say) is refused, not done twice
    expect(await failure(await merge(owner, hub.url, `${base}/${feature}/merge`, { method: "squash", ...reviewedOf(reread) }), 405)).toMatchObject({ code: "unsupported" })

    // after a refresh, after a restart and in Haxy's own pages, both are merged
    expect((await read(feature)).merged).toEqual(squashed.merged)
    const restarted = await backend.restart!()
    expect((await tuiPatches(restarted, "/alice:parser", "merged")).ids.sort()).toEqual([docs, feature].sort())
    expect(await tuiPatchPage(restarted, "/alice:parser", feature)).toContain("merged")
    await owner.dispose()
  })

  test("only the repository's writers merge, a stale revision or a bad request is refused, and only POST is a merge", async ({ playwright, request, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, other, repo, feature, base } = await mergeRepo(playwright, backend, hub.url)
    const loaded = await ok(await owner.get(`${hub.url}${base}/${feature}`))
    const body = { method: "source", ...reviewedOf(loaded) }
    const path = `${base}/${feature}/merge`

    // anonymous viewers and readers who may write patches may not merge them
    expect((await ok(await request.get(`${hub.url}${base}/${feature}`))).actions.merge).toMatchObject({ available: false, reason: { code: "unauthenticated" } })
    expect(await failure(await merge(request, hub.url, path, body), 401)).toMatchObject({ code: "unauthenticated" })
    expect((await ok(await other.get(`${hub.url}${base}/${feature}`))).actions.merge).toMatchObject({ available: false, reason: { code: "forbidden" } })
    expect(await failure(await merge(other, hub.url, path, body), 403)).toEqual({ code: "forbidden", message: "Only the repository's writers can merge its patches." })

    // what the client sends is checked; a revision the patch no longer proposes is stale
    expect(await failure(await merge(owner, hub.url, path, { ...body, method: "rebase" }), 400)).toMatchObject({ code: "validation", field_errors: { method: expect.any(String) } })
    expect(await failure(await merge(owner, hub.url, path, { ...body, target_commit: "main" }), 400)).toMatchObject({ code: "validation", field_errors: { target_commit: expect.any(String) } })
    expect(await failure(await merge(owner, hub.url, path, { ...body, revision: "0123456789abcdef0123456789abcdef" }), 409)).toMatchObject({ code: "conflict", field_errors: { revision: expect.any(String) } })
    expect(await failure(await merge(owner, hub.url, `${base}/0123456789abcdef0123456789abcdef/merge`, body), 404)).toMatchObject({ code: "not_found" })
    const get = await owner.get(`${hub.url}${path}`)
    expect(get.status()).toBe(405)
    expect(get.headers().allow).toBe("POST")
    expect((await ok(await owner.get(`${hub.url}${base}/${feature}`))).status).toBe("open")

    // a member writes, so merges
    await grantMember(owner, backend, repo, "bobby")
    expect((await ok(await other.get(`${hub.url}${base}/${feature}`))).actions.merge).toEqual({ available: true })
    expect(await ok(await merge(other, hub.url, path, body))).toMatchObject({ status: "merged" })
    await owner.dispose()
    await other.dispose()
  })

  test("Haxy's merge form says why it didn't merge rather than redirecting as if it had, and merges what its page showed", async ({ playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, feature, docs, base } = await mergeRepo(playwright, backend, hub.url)
    const read = async (id: string) => ok(await owner.get(`${hub.url}${base}/${id}`))
    const loaded = await read(feature)
    expect(await tuiMergePage(owner, backend, feature)).toContain(`?revision=${loaded.revision!.id}&amp;target=${loaded.target.commit}`)

    // the target moves after the merge page loaded: its squash button is refused, on that page
    await ok(await merge(owner, hub.url, `${base}/${docs}/merge`, { method: "source", ...reviewedOf(await read(docs)) }))
    expect(await formMerge(owner, backend, feature, "squash", reviewedOf(loaded))).toBe(`/alice:parser/patch:${feature}/merge`)
    expect(await tuiMergePage(owner, backend, feature)).toContain("not merged: the target branch moved since this page loaded")
    // a form that names nothing it showed merges nothing
    expect(await formMerge(owner, backend, feature, "squash", null)).toBe(`/alice:parser/patch:${feature}/merge`)
    expect((await read(feature)).status).toBe("open")

    // reviewed again, the squash lands and the form goes to the patch
    const current = await read(feature)
    expect(await formMerge(owner, backend, feature, "squash", reviewedOf(current))).toBe(`/alice:parser/patch:${feature}`)
    expect(await read(feature)).toMatchObject({ status: "merged", merged: { method: "squash" } })
    await owner.dispose()
  })
})

test("local mode doesn't merge patches: the action says why, and a merge is refused", async ({ request, launch }) => {
  const backend = await launch.local()
  const git = localGit(backend)
  divergeBranch(git, "feature", [{ message: "Add the parser", files: { "src/parser.txt": "parse\n" } }])
  const hub = await launch.hub(backend.port)
  const base = "/api/v1/repo/patches"
  const headers = { ...(await writeHeaders(request, hub.url)), "Content-Type": "application/json" }
  const response = await request.fetch(`${hub.url}${base}`, { method: "POST", headers, data: JSON.stringify({ title: "Add a parser", source: "branch:feature", target: "branch:main" }) })
  expect(response.status(), await response.text()).toBe(201)
  const created: Detail = await response.json()
  const reason = { code: "unsupported", message: "Local mode doesn't merge patches; merge the branches with Git." }
  expect(created.actions.merge).toEqual({ available: false, reason })
  expect(await failure(await merge(request, hub.url, `${base}/${created.id}/merge`, { method: "source", ...reviewedOf(created) }), 405)).toEqual(reason)
  expect((await ok(await request.get(`${hub.url}${base}/${created.id}`))).status).toBe("open")
})
