import { expect, test } from "./support/fixtures"
import { alice, registerUser } from "./support/accounts"
import { branchIds, divergedIssue, divergedPatch, getJson, localApi, localSide, rawSend, sendJson, serverApi, serverSide, sync } from "./support/conflicts"
import { createRepo, signedIn } from "./support/repos"
import { createBranchPatch, divergeBranch, setPatchRole } from "./support/patches"
import { pushRepo } from "./support/push"
import { tuiIssuePage } from "./support/issues"
import { localGit } from "./support/history"

// HTTP contract checks for metadata conflicts through the Vite proxy, with
// conflicts Haxy's own sync merges from divergent edits on two hosts.
// Resolutions are checked by reading the thread again, here and, after the
// next sync, on the other host.

type Author = { kind: "user"; name: string } | { kind: "email"; email: string } | { kind: "unknown" }
type Side = { value: unknown; author: Author }
type Field = { name: string; resolution: "text" | "choice"; ours: Side; theirs: Side }
type Chunk = { kind: "same"; text: string } | { kind: "auto"; side: "ours" | "theirs"; text: string | null } | { kind: "conflict"; ours: string | null; theirs: string | null }
type Conflict = { revision: string; fields: Field[]; description: { ours_author: Author; theirs_author: Author; chunks: Chunk[] } | null }
type Availability = { available: true } | { available: false; reason: { code: string; message: string } }
type Answer = { thread: { id: string; title: string; conflicted: boolean }; conflict: Conflict | null; actions: { resolve: Availability } }
type Count = { kind: string; value: number }
type List = { items: Array<{ id: string; conflicted: boolean }>; page: { has_more: boolean; next_cursor: string | null; count: Count } }
type Detail = { id: string; title: string; description_text: string; conflicted: boolean; target?: { id: string } }

const one = { kind: "exact", value: 1 }
const none = { kind: "exact", value: 0 }

function field(conflict: Conflict, name: string): Field {
  const found = conflict.fields.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`No ${name} conflict in ${JSON.stringify(conflict.fields)}`)
  return found
}

test("divergent issue edits list the issue as conflicted, with both sides and their authors per field and description chunk", async ({ playwright, request, launch }) => {
  const { hub, id } = await divergedIssue(playwright, request, launch)

  const list = await getJson<List>(request, `${hub.url}${localApi}/issues/conflicts`)
  expect(list.items.map((item) => item.id)).toEqual([id])
  expect(list.items[0].conflicted).toBe(true)
  expect(list.page).toEqual({ has_more: false, next_cursor: null, count: one })

  const answer = await getJson<Answer>(request, `${hub.url}${localApi}/issues/${id}/conflict`)
  expect(answer.thread).toMatchObject({ id, title: localSide.title, conflicted: true })
  expect(answer.actions.resolve).toEqual({ available: true })
  const conflict = answer.conflict!
  expect(conflict.revision).toMatch(/^[0-9a-f]{32}$/)
  expect(conflict.fields.map((entry) => entry.name)).toEqual(["title"])
  const title = field(conflict, "title")
  expect(title.resolution).toBe("text")
  expect(title.ours.value).toBe(localSide.title)
  expect(title.theirs).toEqual({ value: serverSide.title, author: { kind: "email", email: alice.email } })
  expect(title.ours.author).not.toEqual(title.theirs.author)
  expect(conflict.description).toEqual({
    ours_author: title.ours.author,
    theirs_author: title.theirs.author,
    chunks: [
      { kind: "same", text: "Intro." },
      { kind: "conflict", ours: "Local words.", theirs: "Server words." },
      { kind: "same", text: "Outro." },
    ],
  })
})

test("a resolution is one event: the conflict is gone after a refresh, and the next sync carries it to the other host", async ({ playwright, request, launch }) => {
  const fixture = await divergedIssue(playwright, request, launch)
  const { hub, id } = fixture
  const before = await getJson<Answer>(request, `${hub.url}${localApi}/issues/${id}/conflict`)

  const resolved = (await sendJson(request, hub.url, "POST", `${localApi}/issues/${id}/conflict`, {
    revision: before.conflict!.revision,
    title: "Merged title",
    description: ["Merged words.\r\nAnd more."],
  })) as Detail
  expect(resolved).toMatchObject({ id, title: "Merged title", description_text: "Intro.\nMerged words.\nAnd more.\nOutro.", conflicted: false })

  const after = await getJson<Answer>(request, `${hub.url}${localApi}/issues/${id}/conflict`)
  expect(after.conflict).toBeNull()
  expect(after.actions.resolve).toEqual({ available: false, reason: { code: "conflict", message: "This issue has no conflict to resolve." } })
  expect((await getJson<List>(request, `${hub.url}${localApi}/issues/conflicts`)).page.count).toEqual(none)
  expect(await getJson<Detail>(request, `${hub.url}${localApi}/issues/${id}`)).toMatchObject({ title: "Merged title", conflicted: false })
  expect(await tuiIssuePage(fixture.local, "", id)).not.toContain("conflicts")

  await sync(request, fixture)
  const there = await getJson<Detail>(fixture.owner, `${fixture.serverHub.url}${serverApi}/issues/${id}`)
  expect(there).toMatchObject({ title: "Merged title", description_text: "Intro.\nMerged words.\nAnd more.\nOutro.", conflicted: false })
  expect((await getJson<List>(fixture.owner, `${fixture.serverHub.url}${serverApi}/issues/conflicts`)).page.count).toEqual(none)
})

test("a resolution based on a conflict that changed since, or settling what doesn't conflict, is refused and changes nothing", async ({ playwright, request, launch }) => {
  const { hub, id } = await divergedIssue(playwright, request, launch)
  const answer = await getJson<Answer>(request, `${hub.url}${localApi}/issues/${id}/conflict`)
  const revision = answer.conflict!.revision
  const path = `${localApi}/issues/${id}/conflict`

  const refused = async (body: unknown, status: number) => {
    const response = await rawSend(request, hub.url, "POST", path, body)
    expect(response.status(), await response.text()).toBe(status)
    return (await response.json()).error
  }
  expect(await refused({ title: "No revision" }, 400)).toMatchObject({ code: "validation", field_errors: { revision: expect.any(String) } })
  expect(await refused({ revision: "0".repeat(32), title: "Guessed" }, 409)).toMatchObject({ code: "conflict", field_errors: { revision: expect.any(String) } })
  expect(await refused({ revision, labels: "bug" }, 400)).toMatchObject({ code: "validation", field_errors: { labels: "This field has no conflict to resolve." } })
  expect(await refused({ revision, description: ["one", "two"] }, 400)).toMatchObject({ code: "validation", field_errors: { description: expect.any(String) } })
  expect(await refused({ revision, theirs: ["status"] }, 400)).toMatchObject({ code: "validation", field_errors: { theirs: expect.any(String) } })
  expect(await refused({ revision, title: " " }, 400)).toMatchObject({ code: "validation", field_errors: { title: expect.any(String) } })
  expect((await getJson<Answer>(request, `${hub.url}${path}`)).conflict?.revision).toBe(revision)

  // an edit settles the conflict meanwhile: the resolution made from it is refused
  const issue = await getJson<Detail & { revision: string }>(request, `${hub.url}${localApi}/issues/${id}`)
  await sendJson(request, hub.url, "PATCH", `${localApi}/issues/${id}`, { revision: issue.revision, title: "Edited", labels: "", description: "Edited." })
  expect(await refused({ revision, title: "Late" }, 409)).toMatchObject({ code: "conflict", field_errors: { revision: expect.any(String) } })
  expect(await getJson<Detail>(request, `${hub.url}${localApi}/issues/${id}`)).toMatchObject({ title: "Edited", conflicted: false })

  const wrongMethod = await rawSend(request, hub.url, "PUT", path, {})
  expect(wrongMethod.status()).toBe(405)
  expect(wrongMethod.headers().allow).toBe("GET, HEAD, POST")
  expect((await rawSend(request, hub.url, "POST", `${localApi}/issues/conflicts`, {})).headers().allow).toBe("GET, HEAD")
})

test("on a server, the pushed merge shows the conflict too; anyone who can read sees it, only a writer resolves it", async ({ playwright, request, launch }) => {
  const fixture = await divergedIssue(playwright, request, launch)
  const { server, serverHub, owner, id } = fixture
  const url = `${serverHub.url}${serverApi}/issues/${id}/conflict`

  const anonymous = await getJson<Answer>(request, url)
  expect(anonymous.thread.conflicted).toBe(true)
  expect(anonymous.actions.resolve).toEqual({ available: false, reason: { code: "unauthenticated", message: "Log in to resolve conflicts." } })
  expect((await getJson<List>(request, `${serverHub.url}${serverApi}/issues/conflicts`)).items.map((item) => item.id)).toEqual([id])

  const bob = { name: "bobby", email: "bobby@example.test", password: "battery staple horse" }
  await registerUser(server, bob)
  const reader = await signedIn(playwright, server, serverHub.url, bob.name, bob.password)
  const read = await getJson<Answer>(reader, url)
  expect(read.actions.resolve).toEqual({ available: false, reason: { code: "forbidden", message: "Only the repository's writers can resolve conflicts." } })
  const revision = read.conflict!.revision
  expect((await rawSend(reader, serverHub.url, "POST", `${serverApi}/issues/${id}/conflict`, { revision, title: "Bob's" })).status()).toBe(403)

  const loaded = await getJson<Answer>(owner, url)
  expect(loaded.actions.resolve).toEqual({ available: true })
  const title = field(loaded.conflict!, "title")
  expect(title.theirs.value).not.toBe(title.ours.value)
  // their side, word for word
  await sendJson(owner, serverHub.url, "POST", `${serverApi}/issues/${id}/conflict`, { revision, title: title.theirs.value, description: ["Server words."] })
  expect(await getJson<Detail>(owner, `${serverHub.url}${serverApi}/issues/${id}`)).toMatchObject({ title: title.theirs.value, description_text: serverSide.description, conflicted: false })

  await sync(request, fixture)
  expect(await getJson<Detail>(request, `${fixture.hub.url}${localApi}/issues/${id}`)).toMatchObject({ title: title.theirs.value, conflicted: false })
  expect(server.output()).not.toContain("internal")
  await reader.dispose()
})

test("a patch's divergent edits conflict field by field; a resolution takes their target whole and gives the rest as text", async ({ playwright, request, launch }) => {
  const fixture = await divergedPatch(playwright, request, launch)
  const { hub, id } = fixture

  expect((await getJson<List>(request, `${hub.url}${localApi}/patches/conflicts`)).items.map((item) => item.id)).toEqual([id])
  const answer = await getJson<Answer>(request, `${hub.url}${localApi}/patches/${id}/conflict`)
  const conflict = answer.conflict!
  expect(conflict.fields.map((entry) => [entry.name, entry.resolution])).toEqual([["title", "text"], ["revision", "choice"], ["target", "choice"]])
  expect(field(conflict, "target").ours.value).toEqual({ name: "release-a", id: branchIds.local })
  expect(field(conflict, "target").theirs.value).toEqual({ name: "release-b", id: branchIds.server })
  expect(field(conflict, "revision").ours.value).toEqual({ source_commit: expect.stringMatching(/^[0-9a-f]{40}$/), squash_commit: expect.stringMatching(/^[0-9a-f]{40}$/) })
  expect(conflict.description?.chunks).toContainEqual({ kind: "conflict", ours: "Local words.", theirs: "Server words." })

  // a patch's metadata conflict blocks merging it, but is no code conflict
  const patch = await getJson<{ mergeability: unknown }>(request, `${hub.url}${localApi}/patches/${id}`)
  expect(patch.mergeability).toMatchObject({ available: false })

  const resolved = (await sendJson(request, hub.url, "POST", `${localApi}/patches/${id}/conflict`, {
    revision: conflict.revision,
    title: "Merged patch",
    description: ["Local words."],
    theirs: ["target"],
  })) as Detail
  expect(resolved).toMatchObject({ id, title: "Merged patch", description_text: localSide.description, conflicted: false, target: { id: branchIds.server } })
  expect((await getJson<Answer>(request, `${hub.url}${localApi}/patches/${id}/conflict`)).conflict).toBeNull()

  await sync(request, fixture)
  expect(await getJson<Detail>(fixture.owner, `${fixture.serverHub.url}${serverApi}/patches/${id}`)).toMatchObject({ title: "Merged patch", conflicted: false, target: { id: branchIds.server } })
})

test("a patch whose code conflicts with its target has no metadata conflict to list", async ({ playwright, request, launch }) => {
  const server = await launch.server({ ssh: true })
  const hub = await launch.hub(server.port)
  await registerUser(server, alice)
  const owner = await signedIn(playwright, server, hub.url, alice.name, alice.password)
  await createRepo(owner, server, { name: "clash", access: "public" })
  await pushRepo(playwright, server, hub.url, alice, { owner: alice.name, name: "clash" }, {
    files: { "README.md": "# clash\n", "shared.txt": "base\n" },
    history: (git) => { divergeBranch(git, "feature", [{ message: "Ours", files: { "shared.txt": "feature\n" } }], [{ message: "Theirs", files: { "shared.txt": "main\n" } }]) },
  })
  await setPatchRole(owner, server, { owner: alice.name, name: "clash", access: "public" }, "anybody")
  const id = await createBranchPatch(owner, server, `/${alice.name}:clash`, { title: "Clashes", source: "feature", target: "main" })
  const api = `/api/v1/repos/${alice.name}/clash/patches`

  const patch = await getJson<{ conflicted: boolean; mergeability: { available: boolean; source?: string } }>(request, `${hub.url}${api}/${id}`)
  expect(patch.conflicted).toBe(false)
  expect(patch.mergeability).toMatchObject({ available: true, source: "conflict" })
  expect(await getJson<List>(request, `${hub.url}${api}/conflicts`)).toEqual({ items: [], page: { has_more: false, next_cursor: null, count: none } })
  const answer = await getJson<Answer>(request, `${hub.url}${api}/${id}/conflict`)
  expect(answer).toMatchObject({ conflict: null, actions: { resolve: { available: false, reason: { code: "conflict" } } } })
})

test("unknown threads, discussions and a kind that is off have no conflict routes", async ({ request, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  expect((await request.get(`${hub.url}${localApi}/issues/${"a".repeat(32)}/conflict`)).status()).toBe(404)
  expect((await request.get(`${hub.url}${localApi}/issues/not-an-id/conflict`)).status()).toBe(404)
  expect((await request.get(`${hub.url}${localApi}/discussions/conflicts`)).status()).toBe(404)
  expect((await request.get(`${hub.url}${localApi}/issues/conflicts?cursor=${"b".repeat(32)}`)).status()).toBe(400)
  expect(await getJson<List>(request, `${hub.url}${localApi}/issues/conflicts`)).toEqual({ items: [], page: { has_more: false, next_cursor: null, count: none } })
})

test("taking their target of a patch whose source branch is gone is refused beside the source, and changes nothing", async ({ playwright, request, launch }) => {
  const { hub, local, id } = await divergedPatch(playwright, request, launch)
  const answer = await getJson<Answer>(request, `${hub.url}${localApi}/patches/${id}/conflict`)
  localGit(local)(["branch", "-D", "feature"])

  const response = await rawSend(request, hub.url, "POST", `${localApi}/patches/${id}/conflict`, { revision: answer.conflict!.revision, theirs: ["target"] })
  expect(response.status(), await response.text()).toBe(400)
  expect((await response.json()).error).toMatchObject({ code: "validation", field_errors: { source: expect.stringContaining("There is no such branch") } })
  expect(await getJson<Detail>(request, `${hub.url}${localApi}/patches/${id}`)).toMatchObject({ conflicted: true, target: { id: branchIds.local } })
})
