/**
 * Drafts: patches started with a new fork of their repository, read and
 * written through haxy's src/api/patch_drafts.zig. A draft is its author's
 * alone until they publish it; everyone else is told there is none. Who may
 * start, change and publish one, and what publishing needs, are Haxy's
 * rules (src/draft.zig), shared with the TUI's patches tab.
 */
import { ApiError, getJson, requestJson, type ActionAvailability, type Count, type EventId, type ObjectId, type PageInfo, type RequestOptions, type Timestamp } from "@/lib/api"
import type { MarkdownBlock } from "@/lib/markdown"
import type { PatchBranch, PatchDetail } from "@/lib/patches"
import { apiBase as repoApiBase, repoRoute, type RefId, type RepoLocator } from "@/lib/repo"
import { findThread, type ThreadAuthor, type ThreadFields, type WriteViewer } from "@/lib/threads"

/** What was last pushed to a draft's fork; its commits stay in the fork. */
export type DraftRevision = { id: EventId; source_commit: ObjectId; squash_commit: ObjectId; commit_count: number | null }

/** A Git command for a draft's fork, as the TUI offers it: push to it, clone it, or merge it into a local repository. */
export type ForkCommand = { action: "push" | "clone" | "merge"; protocol: "ssh"; url: string; command: string }

export type DraftActions = Record<"edit" | "remove" | "publish", ActionAvailability>

export type DraftSummary = {
  id: EventId
  title: string
  labels: string[]
  created_at: Timestamp
  target: PatchBranch
  revision: DraftRevision | null
  /** The target branch is at the fork's patch branch already. */
  no_changes: boolean
}

export type DraftDetail = DraftSummary & {
  author: ThreadAuthor
  description: MarkdownBlock[]
  description_text: string
  fork: { owner: string; name: string }
  commands: ForkCommand[]
  /** The opaque revision of what an edit replaces (title, labels, description, target), which an edit sends back. */
  edit_revision: string
  actions: DraftActions
}

export type DraftList = { actions: { create: ActionAvailability }; items: DraftSummary[]; page: PageInfo & { count: Count } }

/** A draft's editable fields; `target` is a branch ref id. */
export type DraftFields = { title: string; labels: string; description: string; target: RefId }

type Options = Pick<RequestOptions, "signal">

function draftsApi(repo: RepoLocator): string {
  return `${repoApiBase(repo)}/patches/drafts`
}

function draftApi(repo: RepoLocator, id: EventId): string {
  return `${draftsApi(repo)}/${encodeURIComponent(id)}`
}

export function listDrafts(repo: RepoLocator, query: { cursor?: string; page_size?: number } = {}, options: Options = {}): Promise<DraftList> {
  const params = new URLSearchParams()
  if (query.cursor) params.set("cursor", query.cursor)
  if (query.page_size !== undefined) params.set("page_size", String(query.page_size))
  const text = params.toString()
  return getJson(`${draftsApi(repo)}${text ? `?${text}` : ""}`, options)
}

export function getDraft(repo: RepoLocator, id: EventId, options: Options = {}): Promise<DraftDetail> {
  return getJson(draftApi(repo, id), options)
}

/** The viewer's draft as it is now, or null when they have none under `id`; rejects when Haxy can't say. */
export async function findDraft(repo: RepoLocator, id: EventId): Promise<DraftDetail | null> {
  try {
    return await getDraft(repo, id)
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found") return null
    throw error
  }
}

/**
 * Where a write whose outcome is unknown left draft `id`: published as the
 * repository's patch, still a draft, or gone. A publication may land between
 * the two reads, so a missing draft has the patch looked for again. Rejects
 * when Haxy can't say.
 */
export async function draftState(repo: RepoLocator, id: EventId): Promise<"published" | "draft" | "gone"> {
  if ((await findThread(repo, "patches", id)) !== null) return "published"
  if ((await findDraft(repo, id)) !== null) return "draft"
  return (await findThread(repo, "patches", id)) !== null ? "published" : "gone"
}

function writeJson<T>(path: string, method: string, viewer: WriteViewer, body?: unknown): Promise<T> {
  return requestJson<T>(path, {
    method,
    viewer,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  })
}

/** Starts a draft with a new fork under `id` (see `newThreadId`), so a retry can't start a second one. */
export function startDraft(repo: RepoLocator, viewer: WriteViewer, id: EventId, fields: DraftFields): Promise<DraftDetail> {
  return writeJson(draftsApi(repo), "POST", viewer, { id, ...fields })
}

/** Replaces a draft's fields as of `revision`; `conflict` keyed by `revision` when it changed since. */
export function editDraft(repo: RepoLocator, id: EventId, viewer: WriteViewer, revision: string, fields: DraftFields): Promise<DraftDetail> {
  return writeJson(draftApi(repo, id), "PATCH", viewer, { revision, ...fields })
}

/** Removes a draft and its fork; `not_found` once it is gone. */
export function removeDraft(repo: RepoLocator, id: EventId, viewer: WriteViewer): Promise<{ id: EventId }> {
  return writeJson(draftApi(repo, id), "DELETE", viewer)
}

/** Publishes a draft as the repository's patch under the same id; publishing it again changes nothing. */
export function publishDraft(repo: RepoLocator, id: EventId, viewer: WriteViewer): Promise<PatchDetail> {
  return writeJson(`${draftApi(repo, id)}/publish`, "POST", viewer)
}

/** A thread form's fields as a draft's: its target branch picker is all a draft chooses. */
export function draftFieldsOf(fields: ThreadFields): DraftFields {
  return { title: fields.title, labels: fields.labels, description: fields.description, target: fields.target ?? "" }
}

/** Whether `draft` holds exactly `fields` (labels compared as Haxy splits them). */
export function draftHolds(draft: DraftDetail, fields: DraftFields): boolean {
  const labels = fields.labels.split(" ").filter((label) => label.length > 0)
  return draft.title === fields.title && draft.description_text === fields.description.replace(/\r\n/g, "\n")
    && draft.target.id === fields.target && draft.labels.length === labels.length && draft.labels.every((label, index) => label === labels[index])
}

// --- Hub routes ----------------------------------------------------------------

/** The Hub route of the viewer's drafts, `<hub repo>/patches/drafts[?cursor=…]`. */
export function draftsRoute(repo: RepoLocator, cursor = ""): string {
  return `${repoRoute(repo)}/patches/drafts${cursor ? `?${new URLSearchParams({ cursor }).toString()}` : ""}`
}

/** The Hub route of the form that starts a draft with a new fork. */
export function newDraftRoute(repo: RepoLocator): string {
  return `${repoRoute(repo)}/patches/drafts/new`
}

export function draftRoute(repo: RepoLocator, id: EventId): string {
  return `${repoRoute(repo)}/patches/drafts/${encodeURIComponent(id)}`
}

export function editDraftRoute(repo: RepoLocator, id: EventId): string {
  return `${draftRoute(repo, id)}/edit`
}

export type DraftView = { kind: "list" } | { kind: "new" } | { kind: "draft"; id: EventId } | { kind: "edit"; id: EventId } | { kind: "unknown" }

/** What a patches section's URL tail names under `drafts`, or null when it isn't a drafts page. */
export function draftView(tail: string): DraftView | null {
  const segments = tail.split("/").filter((segment) => segment.length > 0)
  if (segments[0] !== "drafts") return null
  const [, id, action] = segments
  if (segments.length === 1) return { kind: "list" }
  if (segments.length === 2) return id === "new" ? { kind: "new" } : { kind: "draft", id }
  if (segments.length === 3 && action === "edit" && id !== "new") return { kind: "edit", id }
  return { kind: "unknown" }
}
