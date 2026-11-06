/**
 * Metadata conflicts on issues and patches: what Haxy's merge of two hosts'
 * events left for a person to settle field by field, read and resolved
 * through haxy's src/api/conflicts.zig. These are never a patch's code
 * conflicts (its `mergeability`), and a resolution only ever chooses or
 * writes a thread's title, labels, description chunks, or one side of a
 * patch's status, revision or target.
 */
import { ApiError, getJson, requestJson, type ActionAvailability, type EventId, type Page, type PageQuery } from "@/lib/api"
import { repoRoute, type RefId, type RepoLocator } from "@/lib/repo"
import { apiBase, detailOf, threadRoute, type ThreadAuthor, type ThreadDetail, type ThreadSummary, type WriteViewer } from "@/lib/threads"

/** The thread kinds that can have metadata conflicts. */
export type ConflictKind = "issues" | "patches"

/** One side's value of a conflicted field. */
export type ConflictValue =
  | string
  | { source_commit: string; squash_commit: string }
  | { name: string; id: RefId }
  | null

export type ConflictSide = { value: ConflictValue; author: ThreadAuthor }

/** A conflicted field: `text` takes any text as its resolution, `choice` one side whole. */
export type ConflictField = { name: string; resolution: "text" | "choice"; ours: ConflictSide; theirs: ConflictSide }

export type ConflictChunk =
  | { kind: "same"; text: string }
  | { kind: "auto"; side: "ours" | "theirs"; text: string | null }
  | { kind: "conflict"; ours: string | null; theirs: string | null }

export type MetadataConflict = {
  revision: string
  fields: ConflictField[]
  description: { ours_author: ThreadAuthor; theirs_author: ThreadAuthor; chunks: ConflictChunk[] } | null
}

export type ConflictAnswer = {
  thread: ThreadSummary<string>
  conflict: MetadataConflict | null
  actions: { resolve: ActionAvailability }
}

/** What a resolution sends: texts for conflicted title and labels, one per conflicting description chunk, and the choice fields taken from their side. */
export type Resolution = {
  title?: string
  labels?: string
  description?: string[]
  theirs: string[]
}

type Options = { signal?: AbortSignal }

function conflictPath(repo: RepoLocator, kind: ConflictKind, id: EventId): string {
  return `${apiBase(repo, kind)}/${encodeURIComponent(id)}/conflict`
}

/** One window of a kind's conflicted threads, newest first, as the TUI's conflicts tab lists them. */
export function listConflicts(repo: RepoLocator, kind: ConflictKind, query: PageQuery = {}, options: Options = {}): Promise<Page<ThreadSummary<string>>> {
  const params = new URLSearchParams()
  if (query.cursor) params.set("cursor", query.cursor)
  const text = params.toString()
  return getJson(`${apiBase(repo, kind)}/conflicts${text ? `?${text}` : ""}`, options)
}

/** A thread with its unresolved conflict, if any. */
export function getConflict(repo: RepoLocator, kind: ConflictKind, id: EventId, options: Options = {}): Promise<ConflictAnswer> {
  return getJson(conflictPath(repo, kind, id), options)
}

/** Resolves the conflict loaded at `revision`; `conflict` keyed by `revision` when it changed or was resolved since. */
export function resolveConflict(repo: RepoLocator, kind: ConflictKind, id: EventId, viewer: WriteViewer, revision: string, resolution: Resolution): Promise<ThreadDetail<string>> {
  return detailOf(kind, requestJson(conflictPath(repo, kind, id), {
    method: "POST",
    viewer,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision, ...resolution }),
  }))
}

/** Whether a refusal says the conflict changed (or was resolved) since it was loaded. */
export function conflictChanged(error: unknown): boolean {
  return error instanceof ApiError && error.code === "conflict" && error.fieldError("revision") !== undefined
}

// --- routes ----------------------------------------------------------------------

/** The Hub route of a kind's conflicted threads. */
export function conflictsRoute(repo: RepoLocator, kind: ConflictKind, cursor = ""): string {
  const base = `${repoRoute(repo)}/${kind}/conflicts`
  return cursor ? `${base}?${new URLSearchParams({ cursor })}` : base
}

/** The Hub route of one thread's conflict and its resolution form. */
export function conflictRoute(repo: RepoLocator, kind: ConflictKind, id: EventId): string {
  return `${threadRoute(repo, kind, id)}/conflict`
}

export type ConflictView = { kind: "list" } | { kind: "conflict"; id: EventId }

/** What a thread section's URL tail names among the conflict pages, or null when it names none. */
export function conflictView(tail: string): ConflictView | null {
  const segments = tail.split("/").filter((segment) => segment.length > 0)
  if (segments.length === 1 && segments[0] === "conflicts") return { kind: "list" }
  if (segments.length === 2 && segments[1] === "conflict" && segments[0] !== "conflicts") return { kind: "conflict", id: segments[0] }
  return null
}

const haxySegments: Record<ConflictKind, string> = { issues: "issue", patches: "patch" }

/** The repository a Haxy path names (`/<owner>:<name>/…`, or nothing in local mode) and the segments after it. */
function haxyRepo(path: string, local: boolean): { repo: RepoLocator; segments: string[] } | null {
  const segments = path.split("/").slice(1)
  if (local) return { repo: { kind: "local" }, segments }
  const pair = segments.shift() ?? ""
  const colon = pair.indexOf(":")
  if (colon <= 0 || colon === pair.length - 1) return null
  try {
    return { repo: { kind: "server", owner: decodeURIComponent(pair.slice(0, colon)), name: decodeURIComponent(pair.slice(colon + 1)) }, segments }
  } catch {
    return null
  }
}

/**
 * The Hub route for a Haxy conflicts path, or null when `path` isn't one:
 * `<repo>/issues[/start:<id>]/conflicts` is `<hub repo>/issues/conflicts`,
 * and `<repo>/issue:<id>[/theirs:<fields>]/resolve` is
 * `<hub repo>/issues/<id>/conflict`; patches alike.
 */
export function hubPathForConflictPath(path: string, local = false): string | null {
  const found = haxyRepo(path, local)
  if (found === null) return null
  const [tab = "", ...rest] = found.segments
  const words = rest.filter((segment) => !segment.includes(":"))
  const params = rest.filter((segment) => segment.includes(":")).map((segment) => segment.slice(0, segment.indexOf(":")))
  for (const kind of ["issues", "patches"] as const) {
    if (tab === kind && words.length === 1 && words[0] === "conflicts" && params.every((key) => key === "start")) return conflictsRoute(found.repo, kind)
    const prefix = `${haxySegments[kind]}:`
    const id = tab.startsWith(prefix) ? tab.slice(prefix.length) : ""
    if (id && words.length === 1 && words[0] === "resolve" && params.every((key) => key === "theirs")) return conflictRoute(found.repo, kind, id)
  }
  return null
}

// --- a resolution being chosen ------------------------------------------------------

/** What the resolution form holds: each text field's resolved text, each choice field's side, and each conflicting description chunk's text. */
export type Choices = {
  texts: Record<string, string>
  sides: Record<string, "ours" | "theirs">
  hunks: string[]
}

/** The conflicting description chunks, in order. */
export function conflictingChunks(conflict: MetadataConflict): Array<Extract<ConflictChunk, { kind: "conflict" }>> {
  return (conflict.description?.chunks ?? []).filter((chunk): chunk is Extract<ConflictChunk, { kind: "conflict" }> => chunk.kind === "conflict")
}

/** The form's starting point, as the TUI's resolve form prefills it: this side's value everywhere. */
export function initialChoices(conflict: MetadataConflict): Choices {
  const texts: Record<string, string> = {}
  const sides: Record<string, "ours" | "theirs"> = {}
  for (const field of conflict.fields) {
    if (field.resolution === "text") texts[field.name] = typeof field.ours.value === "string" ? field.ours.value : ""
    else sides[field.name] = "ours"
  }
  return { texts, sides, hunks: conflictingChunks(conflict).map((chunk) => chunk.ours ?? "") }
}

/** The resolution the form's choices make. */
export function resolutionOf(conflict: MetadataConflict, choices: Choices): Resolution {
  const theirs = Object.entries(choices.sides).filter(([, side]) => side === "theirs").map(([name]) => name)
  return {
    ...("title" in choices.texts ? { title: choices.texts.title } : {}),
    ...("labels" in choices.texts ? { labels: choices.texts.labels } : {}),
    ...(conflict.description && conflictingChunks(conflict).length > 0 ? { description: choices.hunks } : {}),
    theirs,
  }
}
