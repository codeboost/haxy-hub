import type { APIRequestContext, APIResponse, PlaywrightWorkerArgs } from "@playwright/test"
import { expect, test } from "./support/fixtures"
import { alice, registerUser, writeHeaders, type Account } from "./support/accounts"
import type { Backend } from "./support/backend"
import { commentOnDiscussion, createDiscussion, setDiscussRole, tuiDiscussionPage } from "./support/discussions"
import { commentOnPatch, pushedPatch, setPatchRole, tuiPatchPage } from "./support/patches"
import { createRepo, signedIn } from "./support/repos"

// Discussions and patches take attachments and notify as issues do, through
// the same shared routes (attachments.zig and notifications.zig, each hooked
// in with the kind). The shared rules are covered on issues
// (attachments-api.spec.ts, notifications-api.spec.ts); these prove each
// kind's wiring: an upload, its download and removal (Haxy's own page shows
// them), who may attach, a private repository's file refused, a comment by
// someone else notifying the author, the acknowledgement, and mute and
// subscribe.

const bob: Account = { name: "bobby", email: "bobby@example.test", password: "battery staple horse" }
const hex = expect.stringMatching(/^[0-9a-f]{32}$/)

type Availability = { available: boolean; reason?: { code: string; message: string } }
type Attachment = { id: string; name: string; content_type: string; inline: boolean; actions: { remove: Availability } }
type Detail = { id: string; attachments: Attachment[]; attachment_limits: { max_bytes: number; max_name_bytes: number }; actions: Record<string, Availability> }
type State = { notified: boolean; notification: { id: string; unread: boolean; revision: string } | null }
type Inbox = { items: Array<{ unread: boolean; title: string; thread: { kind: string; id: string } }>; unread_count: number }

/** One of alice's threads of a kind, in a repository bob (registered, signed in) may read and comment in. */
type Seeded = {
  owner: APIRequestContext
  other: APIRequestContext
  /** The thread's API path. */
  thread: string
  /** The repository, for its settings form. */
  repo: { owner: string; name: string; access: "public" | "private" }
  /** Posts a comment on the thread as `by`, through Haxy's own form. */
  comment(by: APIRequestContext, body: string): Promise<string>
  /** Haxy's own page of the thread (the TUI's). */
  tuiPage(): Promise<string>
  /** Makes the repository private (members only). */
  makePrivate(): Promise<void>
}

type Kind = {
  name: string
  noun: string
  plural: string
  /** Whether its fixture pushes commits (a patch needs a branch). */
  ssh: boolean
  seed(playwright: PlaywrightWorkerArgs["playwright"], backend: Backend, hubUrl: string): Promise<Seeded>
}

async function people(playwright: PlaywrightWorkerArgs["playwright"], backend: Backend, hubUrl: string) {
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const owner = await signedIn(playwright, backend, hubUrl, alice.name, alice.password)
  const other = await signedIn(playwright, backend, hubUrl, bob.name, bob.password)
  return { owner, other }
}

const kinds: Kind[] = [
  {
    name: "discussions",
    noun: "discussion",
    plural: "discussions",
    ssh: false,
    async seed(playwright, backend, hubUrl) {
      const { owner, other } = await people(playwright, backend, hubUrl)
      await createRepo(owner, backend, { name: "forum", access: "public" })
      const repo = { owner: alice.name, name: "forum", access: "public" as const }
      const id = await createDiscussion(owner, backend, "/alice:forum", { title: "Roadmap for 2027" })
      return {
        owner,
        other,
        thread: `/api/v1/repos/alice/forum/discussions/${id}`,
        repo,
        comment: (by, body) => commentOnDiscussion(by, backend, "/alice:forum", id, body),
        tuiPage: () => tuiDiscussionPage(backend, "/alice:forum", id),
        makePrivate: () => setDiscussRole(owner, backend, { ...repo, access: "private" }, "anybody"),
      }
    },
  },
  {
    name: "patches",
    noun: "patch",
    plural: "patches",
    ssh: true,
    async seed(playwright, backend, hubUrl) {
      const { owner, other } = await people(playwright, backend, hubUrl)
      await createRepo(owner, backend, { name: "parser", access: "public" })
      const repo = { owner: alice.name, name: "parser", access: "public" as const }
      const id = await pushedPatch(playwright, backend, hubUrl, alice, owner, "parser", "Roadmap for 2027")
      return {
        owner,
        other,
        thread: `/api/v1/repos/alice/parser/patches/${id}`,
        repo,
        comment: (by, body) => commentOnPatch(by, backend, "/alice:parser", id, body),
        tuiPage: () => tuiPatchPage(backend, "/alice:parser", id),
        makePrivate: () => setPatchRole(owner, backend, { ...repo, access: "private" }, "anybody"),
      }
    },
  },
]

function newId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function upload(request: APIRequestContext, hubUrl: string, thread: string, bytes: Buffer, params: { name: string; id?: string }): Promise<APIResponse> {
  const query = new URLSearchParams({ name: params.name, ...(params.id ? { id: params.id } : {}) })
  const headers = { ...(await writeHeaders(request, hubUrl)), "Content-Type": "application/octet-stream" }
  return request.fetch(`${hubUrl}${thread}/attachments?${query.toString().replace(/\+/g, "%20")}`, { method: "POST", headers, data: bytes })
}

async function send(request: APIRequestContext, hubUrl: string, method: string, path: string, body?: unknown): Promise<APIResponse> {
  const headers = { ...(await writeHeaders(request, hubUrl)), "Content-Type": "application/json" }
  return request.fetch(`${hubUrl}${path}`, { method, headers, data: body === undefined ? undefined : JSON.stringify(body) })
}

async function json<T>(response: Promise<APIResponse>, status = 200): Promise<T> {
  const answer = await response
  expect(answer.status(), await answer.text()).toBe(status)
  return answer.json()
}

for (const kind of kinds) {
  test(`${kind.plural}: the author attaches, everyone downloads, only the author or a writer removes, and a private repository's file is refused`, async ({ playwright, launch }) => {
    const backend = await launch.server({ ssh: kind.ssh })
    const hubUrl = (await launch.hub(backend.port)).url
    const seeded = await kind.seed(playwright, backend, hubUrl)
    const { owner, other, thread } = seeded

    const loaded = await json<Detail>(owner.get(`${hubUrl}${thread}`))
    expect(loaded).toMatchObject({ attachments: [], attachment_limits: { max_bytes: 10 * 1024 * 1024, max_name_bytes: 255 }, actions: { attach: { available: true } } })
    const forbidden = `Only the ${kind.noun}'s author and the repository's writers can attach files to it.`
    expect((await json<Detail>(other.get(`${hubUrl}${thread}`))).actions.attach).toEqual({ available: false, reason: { code: "forbidden", message: forbidden } })
    const refused = await upload(other, hubUrl, thread, Buffer.from("x"), { name: "x.txt" })
    expect(refused.status()).toBe(403)
    expect(await refused.json()).toEqual({ error: { code: "forbidden", message: forbidden } })

    const id = newId()
    const bytes = Buffer.from("the plan, in prose\n")
    const uploaded = await json<Detail>(upload(owner, hubUrl, thread, bytes, { name: "the plan.txt", id }), 201)
    expect(uploaded.attachments).toEqual([{ id, name: "the plan.txt", content_type: "text/plain; charset=utf-8", inline: false, actions: { remove: { available: true } } }])
    expect(await seeded.tuiPage()).toContain("the plan.txt")

    const anonymous = await playwright.request.newContext()
    for (const reader of [owner, other, anonymous]) {
      const download = await reader.get(`${hubUrl}${thread}/attachments/${id}`)
      expect(download.status()).toBe(200)
      expect(await download.body()).toEqual(bytes)
      expect(download.headers()["content-disposition"]).toBe("attachment; filename=\"the plan.txt\"; filename*=UTF-8''the%20plan.txt")
    }
    expect((await json<Detail>(other.get(`${hubUrl}${thread}`))).attachments[0].actions.remove).toEqual({ available: false, reason: { code: "forbidden", message: "Only the attachment's author and the repository's writers can remove it." } })
    expect((await send(other, hubUrl, "DELETE", `${thread}/attachments/${id}`)).status()).toBe(403)

    const restarted = await backend.restart!()
    expect((await json<Detail>(send(owner, hubUrl, "DELETE", `${thread}/attachments/${id}`))).attachments).toEqual([])
    expect(await seeded.tuiPage()).not.toContain("the plan.txt")
    const gone = await owner.get(`${hubUrl}${thread}/attachments/${id}`)
    expect(gone.status()).toBe(404)
    expect(await gone.json()).toEqual({ error: { code: "not_found", message: `There is no attachment with this id on this ${kind.noun}.` } })

    // once the repository is private, a file of it is not found to anyone who can't read it
    const secret = newId()
    await json<Detail>(upload(owner, hubUrl, thread, Buffer.from("secret"), { name: "secret.txt", id: secret }), 201)
    await seeded.makePrivate()
    expect((await owner.get(`${hubUrl}${thread}/attachments/${secret}`)).status()).toBe(200)
    for (const reader of [other, anonymous]) {
      const download = await reader.get(`${hubUrl}${thread}/attachments/${secret}`)
      expect(download.status()).toBe(404)
      expect(await download.json()).toEqual({ error: { code: "not_found", message: "There is no repository with this name." } })
    }
    expect((await fetch(`${restarted.origin}/${seeded.repo.owner}:${seeded.repo.name}/attachment:${secret}`)).status).toBe(404)
    await anonymous.dispose()
    await owner.dispose()
    await other.dispose()
  })

  test(`${kind.plural}: another user's comment notifies the author until acknowledged, and mute and subscribe decide who hears of the next`, async ({ playwright, launch }) => {
    const backend = await launch.server({ ssh: kind.ssh })
    const hubUrl = (await launch.hub(backend.port)).url
    const seeded = await kind.seed(playwright, backend, hubUrl)
    const { owner, other, thread } = seeded
    const notifications = `${thread}/notifications`
    const inbox = (who: APIRequestContext) => json<Inbox>(who.get(`${hubUrl}/api/v1/notifications`))

    expect(await json<State>(owner.get(`${hubUrl}${notifications}`))).toEqual({ notified: true, notification: null })
    expect(await json<State>(other.get(`${hubUrl}${notifications}`))).toEqual({ notified: false, notification: null })

    await seeded.comment(other, "Count me in.")
    const listed = await inbox(owner)
    expect(listed.items).toEqual([expect.objectContaining({ unread: true, title: "Roadmap for 2027", thread: { kind: kind.name, id: thread.split("/").pop() } })])
    expect(listed.unread_count).toBe(1)
    const before = await json<State>(owner.get(`${hubUrl}${notifications}`))
    expect(before).toEqual({ notified: true, notification: { id: hex, unread: true, revision: hex } })
    const read = await json<State>(send(owner, hubUrl, "POST", `${notifications}/read`, { revision: before.notification!.revision }))
    expect(read).toEqual({ notified: true, notification: { ...before.notification, unread: false } })
    expect((await inbox(owner)).unread_count).toBe(0)

    // bob, notified as a commenter, mutes: alice's next comment doesn't reach him
    expect(await json<State>(other.get(`${hubUrl}${notifications}`))).toMatchObject({ notified: true })
    expect(await json<State>(send(other, hubUrl, "PUT", notifications, { mode: "muted" }))).toEqual({ notified: false, notification: null })
    await seeded.comment(owner, "Thanks.")
    expect((await inbox(other)).items).toEqual([])
    // subscribed again, the one after does
    expect(await json<State>(send(other, hubUrl, "PUT", notifications, { mode: "subscribed" }))).toMatchObject({ notified: true })
    await seeded.comment(owner, "Next week, then.")
    expect((await inbox(other)).items).toEqual([expect.objectContaining({ unread: true, thread: { kind: kind.name, id: thread.split("/").pop() } })])
    await owner.dispose()
    await other.dispose()
  })
}
