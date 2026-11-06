/**
 * Threads: a repository's issues and discussions (and, in a later slice, its
 * patches), read through the routes in haxy's src/api/thread.zig,
 * src/api/issues.zig and src/api/discussions.zig. Lists, counts, windows and search filters are Haxy's
 * own (the TUI's issues tab): Hub never parses a search or builds a filter.
 */
import { ApiError, getJson, requestJson, type ActionAvailability, type Count, type EventId, type Page, type PageQuery, type RequestOptions, type Timestamp } from "@/lib/api"
import type { MarkdownBlock } from "@/lib/markdown"
import { repoRoute, type RepoLocator } from "@/lib/repo"
import { asThreadDetail, asThreadList, type DiscussionDetail, type DiscussionPage } from "@/lib/discussions"

/** The kinds of thread, as they appear in API and Hub paths. */
export type ThreadKind = "issues" | "discussions" | "patches"

export type IssueStatus = "open" | "closed"

/** Who opened a thread: an account, an email no account holds, or nobody known. */
export type ThreadAuthor = { kind: "user"; name: string } | { kind: "email"; email: string } | { kind: "unknown" }

/**
 * A label or assignee, with the search that lists the threads carrying it:
 * the current search with its filter of that kind replaced (as the TUI's links do).
 */
export type FilterLink = { name: string; search: string }

/**
 * An assignee: by account name when one holds the email, otherwise by email.
 * `id` is the assignment's (opaque) event id, which unassigns them.
 */
export type ThreadAssignee = { id: EventId; name: string | null; email: string | null; search: string }

export type ThreadSummary<Status extends string> = {
  id: EventId
  title: string
  status: Status
  labels: FilterLink[]
  author: ThreadAuthor
  assignees: ThreadAssignee[]
  created_at: Timestamp
  comment_count: number
  /** Concurrent edits left a field conflict to resolve. */
  conflicted: boolean
}

/** What the viewer may do to one thread; Haxy checks again when it is done. */
export type ThreadActions = Record<"edit" | "set_status" | "remove" | "assign", ActionAvailability>

/** What the viewer may do to a kind's list: open a thread. */
export type ThreadListActions = Record<"create", ActionAvailability>

/**
 * The thread with its whole description, parsed by Haxy's Markdown reader;
 * what an edit starts from (the description as written, and the opaque
 * revision an edit is made against); and what the viewer may do to it.
 */
export type ThreadDetail<Status extends string> = ThreadSummary<Status> & {
  description: MarkdownBlock[]
  description_text: string
  revision: string
  actions: ThreadActions
}

/** A search as Haxy's parser split it. */
export type ThreadFilters = {
  labels: string[]
  assignees: string[]
  /** The remaining words, matched against titles, labels and descriptions. */
  words: string
  /** An assignee filter names no account, so nothing is listed. */
  assignee_not_found: boolean
}

/** One status's window of threads. `page.count` counts this status; `counts` counts every status. */
export type ThreadList<Status extends string> = Page<ThreadSummary<Status>> & {
  status: Status
  actions: ThreadListActions
  filters: ThreadFilters
  counts: Record<Status, Count>
}

export type ThreadListQuery<Status extends string> = PageQuery & { status: Status; search?: string }

type Options = Pick<RequestOptions, "signal">

/** The API path of a repository's threads of `kind`. */
export function apiBase(repo: RepoLocator, kind: ThreadKind): string {
  const base = repo.kind === "local" ? "/api/v1/repo" : `/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
  return `${base}/${kind}`
}

/** The API path of one thread, which its comment routes extend. */
export function threadApiPath(repo: RepoLocator, kind: ThreadKind, id: EventId): string {
  return `${apiBase(repo, kind)}/${encodeURIComponent(id)}`
}

function withParams(path: string, entries: Array<[string, string | number | undefined]>): string {
  const params = new URLSearchParams()
  for (const [key, value] of entries) if (value !== undefined && value !== "") params.set(key, String(value))
  const text = params.toString()
  return text ? `${path}?${text}` : path
}

// Discussions have one list and no status: their answers are read in the shape
// every kind shares (see `@/lib/discussions`).
function listOf<Status extends string>(kind: ThreadKind, answer: Promise<unknown>): Promise<ThreadList<Status>> {
  return answer.then((value) => (kind === "discussions" ? asThreadList(value as DiscussionPage) : value) as ThreadList<Status>)
}

function detailOf<Status extends string>(kind: ThreadKind, answer: Promise<unknown>): Promise<ThreadDetail<Status>> {
  return answer.then((value) => (kind === "discussions" ? asThreadDetail(value as DiscussionDetail) : value) as ThreadDetail<Status>)
}

export function listThreads<Status extends string>(repo: RepoLocator, kind: ThreadKind, query: ThreadListQuery<Status>, options: Options = {}): Promise<ThreadList<Status>> {
  const status = kind === "discussions" ? undefined : query.status
  return listOf(kind, getJson(withParams(apiBase(repo, kind), [["status", status], ["search", query.search], ["cursor", query.cursor], ["page_size", query.page_size]]), options))
}

export function getThread<Status extends string>(repo: RepoLocator, kind: ThreadKind, id: EventId, options: Options = {}): Promise<ThreadDetail<Status>> {
  return detailOf(kind, getJson(`${apiBase(repo, kind)}/${encodeURIComponent(id)}`, options))
}

/** Every label the repository's threads of `kind` use, by name; each links into the first status's list. */
export function listThreadLabels(repo: RepoLocator, kind: ThreadKind, query: PageQuery & { search?: string } = {}, options: Options = {}): Promise<Page<FilterLink>> {
  return getJson(withParams(`${apiBase(repo, kind)}/labels`, [["search", query.search], ["cursor", query.cursor], ["page_size", query.page_size]]), options)
}

// --- Writes ------------------------------------------------------------------
//
// Every write goes through Haxy's own thread operations (src/thread_write.zig),
// which check the viewer's role when it runs. Each is bound to the viewer its
// form was loaded for (`requestJson` sends X-Haxy-Viewer; null is nobody, as in
// local mode), and none is retried automatically.

/** A thread's editable fields. `labels` is space-separated, as Haxy stores it. */
export type ThreadFields = { title: string; labels: string; description: string }

/** Who a write is for: the signed-in viewer's name, or null for nobody (local mode). */
export type WriteViewer = string | null

/**
 * A fresh id for a new thread. Sent with the creation, it makes the creation
 * idempotent: Haxy refuses a second thread with the same id (`conflict` keyed
 * by `id`), so a form whose outcome is unknown can look the id up, and retry
 * with it, without opening the thread twice.
 */
export function newThreadId(): EventId {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function writeJson<T>(path: string, method: string, viewer: WriteViewer, body?: unknown): Promise<T> {
  return requestJson<T>(path, {
    method,
    viewer,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  })
}

/** Opens a thread under `id` (see `newThreadId`); resolves to it as its own route reads it. */
export function createThread<Status extends string>(repo: RepoLocator, kind: ThreadKind, viewer: WriteViewer, id: EventId, fields: ThreadFields): Promise<ThreadDetail<Status>> {
  return detailOf(kind, writeJson(apiBase(repo, kind), "POST", viewer, { id, ...fields }))
}

/** Replaces a thread's fields as of `revision`; `conflict` keyed by `revision` when it changed since. */
export function editThread<Status extends string>(repo: RepoLocator, kind: ThreadKind, id: EventId, viewer: WriteViewer, revision: string, fields: ThreadFields): Promise<ThreadDetail<Status>> {
  return detailOf(kind, writeJson(`${apiBase(repo, kind)}/${encodeURIComponent(id)}`, "PATCH", viewer, { revision, ...fields }))
}

/** Sets a thread's status; setting the one it has changes nothing, so a retry is safe. */
export function setThreadStatus<Status extends string>(repo: RepoLocator, kind: ThreadKind, id: EventId, viewer: WriteViewer, status: Status): Promise<ThreadDetail<Status>> {
  return writeJson(`${apiBase(repo, kind)}/${encodeURIComponent(id)}/status`, "PUT", viewer, { status })
}

/** Removes a thread; `not_found` once it is gone. */
export function removeThread(repo: RepoLocator, kind: ThreadKind, id: EventId, viewer: WriteViewer): Promise<{ id: EventId }> {
  return writeJson(`${apiBase(repo, kind)}/${encodeURIComponent(id)}`, "DELETE", viewer)
}

/**
 * The thread as it is now, or null when there is none (never opened, or
 * removed), for settling a write whose outcome is unknown. Rejects when Haxy
 * can't say.
 */
export async function findThread<Status extends string>(repo: RepoLocator, kind: ThreadKind, id: EventId): Promise<ThreadDetail<Status> | null> {
  try {
    return await getThread<Status>(repo, kind, id)
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found") return null
    throw error
  }
}

/** Whether `thread` holds exactly `fields` (its labels compared as Haxy splits them). */
export function holdsFields(thread: ThreadDetail<string>, fields: ThreadFields): boolean {
  const labels = fields.labels.split(" ").filter((label) => label.length > 0)
  return thread.title === fields.title && thread.description_text === fields.description.replace(/\r\n/g, "\n")
    && thread.labels.length === labels.length && thread.labels.every((label, index) => label.name === labels[index])
}

// --- Hub routes ----------------------------------------------------------------

/** A list's search and page, as its Hub URL carries them. */
export type ListPosition = { search?: string; cursor?: string }

function query(entries: Array<[string, string | undefined]>): string {
  return withParams("", entries)
}

/**
 * The Hub route of one status's list: `<repo>/<kind>` for the first status,
 * `<repo>/<kind>/<status>` for the others, with `?search=&cursor=`.
 */
export function threadsRoute<Status extends string>(repo: RepoLocator, kind: ThreadKind, statuses: readonly Status[], status: Status, position: ListPosition = {}): string {
  const base = `${repoRoute(repo)}/${kind}`
  const path = status === statuses[0] ? base : `${base}/${encodeURIComponent(status)}`
  return path + query([["search", position.search], ["cursor", position.cursor]])
}

/** The Hub route of one thread's page. */
export function threadRoute(repo: RepoLocator, kind: ThreadKind, id: EventId): string {
  return `${repoRoute(repo)}/${kind}/${encodeURIComponent(id)}`
}

/** The Hub route of a comment's permalink page, at one of its reply windows (`?replies=<cursor>`). */
export function commentRoute(repo: RepoLocator, kind: ThreadKind, thread: EventId, comment: EventId, replies: string | null = null): string {
  const query = replies ? `?${new URLSearchParams({ replies }).toString()}` : ""
  return `${threadRoute(repo, kind, thread)}/comments/${encodeURIComponent(comment)}${query}`
}

/** The Hub route of the form that opens a thread. */
export function newThreadRoute(repo: RepoLocator, kind: ThreadKind): string {
  return `${repoRoute(repo)}/${kind}/new`
}

/** The Hub route of the form that edits a thread. */
export function editThreadRoute(repo: RepoLocator, kind: ThreadKind, id: EventId): string {
  return `${threadRoute(repo, kind, id)}/edit`
}

/** The Hub route of the labels list, carrying the search its links extend. */
export function threadLabelsRoute(repo: RepoLocator, kind: ThreadKind, position: ListPosition = {}): string {
  return `${repoRoute(repo)}/${kind}/labels` + query([["search", position.search], ["cursor", position.cursor]])
}

/** What a thread section's URL tail (after `<repo>/<kind>/`) shows. */
export type ThreadView<Status extends string> =
  | { kind: "list"; status: Status }
  | { kind: "labels" }
  | { kind: "new" }
  | { kind: "thread"; id: EventId }
  | { kind: "edit"; id: EventId }
  | { kind: "comment"; id: EventId; comment: EventId }
  | { kind: "unknown" }

export function threadView<Status extends string>(statuses: readonly Status[], tail: string): ThreadView<Status> {
  const segments = tail.split("/").filter((segment) => segment.length > 0)
  if (segments.length === 0) return { kind: "list", status: statuses[0] }
  const reserved = ["labels", "new", ...statuses]
  if (segments.length === 2 && segments[1] === "edit" && !reserved.includes(segments[0])) return { kind: "edit", id: segments[0] }
  if (segments.length === 3 && segments[1] === "comments" && !reserved.includes(segments[0])) return { kind: "comment", id: segments[0], comment: segments[2] }
  if (segments.length > 1) return { kind: "unknown" }
  const [segment] = segments
  if (segment === "labels") return { kind: "labels" }
  if (segment === "new") return { kind: "new" }
  const status = statuses.find((value, index) => index > 0 && value === segment)
  if (status !== undefined) return { kind: "list", status }
  return { kind: "thread", id: segment }
}

// --- Haxy's own issue URLs -----------------------------------------------------

/** The issue statuses, in the TUI's tab order (the first is the default list). */
export const issueStatuses = ["open", "closed"] as const satisfies readonly IssueStatus[]

/** A Haxy route's `key:value` parameter segments (`search:`, `start:`), percent-decoded; null when one is malformed or not allowed. */
function routeParams(segments: string[], allowed: string[]): Map<string, string> | null {
  const params = new Map<string, string>()
  for (const segment of segments) {
    const colon = segment.indexOf(":")
    const key = segment.slice(0, colon)
    if (colon <= 0 || !allowed.includes(key) || params.has(key)) return null
    try {
      params.set(key, decodeURIComponent(segment.slice(colon + 1)))
    } catch {
      return null
    }
  }
  return params
}

/**
 * The Hub route for a Haxy issue page path (as the TUI and Haxy's web pages
 * write them in Markdown), or null when `path` isn't one Hub has a page for:
 *
 * | Haxy (`<repo>` is `/<owner>:<name>`, empty in local mode) | Haxy Hub                         |
 * | --------------------------------------------------------- | -------------------------------- |
 * | `<repo>/issues`, `<repo>/issues/open[/search:<s>]`         | `<hub repo>/issues?search=<s>`   |
 * | `<repo>/issues/closed[/search:<s>]`                        | `<hub repo>/issues/closed?…`     |
 * | `<repo>/issues/labels[/search:<s>]`                        | `<hub repo>/issues/labels?…`     |
 * | `<repo>/issue:<id>[/search:<s>][/start:<n>]`, `…/description`         | `<hub repo>/issues/<id>`         |
 * | `<repo>/issue:<id>/comment:<c>[/start:<n>]`                 | `<hub repo>/issues/<id>/comments/<c>` |
 * | `<repo>/issues/new`                                        | `<hub repo>/issues/new`          |
 * | `<repo>/issue:<id>/edit`                                   | `<hub repo>/issues/<id>/edit`    |
 *
 * Parameter segments may come in any order before or after the view word, as
 * Haxy reads them. The other forms (`remove`, `resolve`) and the conflicts
 * list have no Hub page yet. `local` reads the local forms, which
 * leave the repository out.
 */
export function hubPathForIssuePath(path: string, local = false): string | null {
  return hubPathForThreadPath(path, local, { kind: "issues", segment: "issue", statuses: issueStatuses })
}

/**
 * What a kind's Haxy paths are named: its tab (`issues`), the segment that
 * names one thread (`issue:<id>`), and its list views in tab order (the first
 * is the tab's own).
 */
export type ThreadPaths = { kind: ThreadKind; segment: string; statuses: readonly string[] }

/** `hubPathForIssuePath` for any kind of thread, its Haxy paths named by `paths`. */
export function hubPathForThreadPath(path: string, local: boolean, paths: ThreadPaths): string | null {
  const { kind, statuses } = paths
  const thread = `${paths.segment}:`
  const segments = path.split("/").slice(1)
  let repo: RepoLocator
  if (local) {
    repo = { kind: "local" }
  } else {
    const pair = segments.shift() ?? ""
    const colon = pair.indexOf(":")
    if (colon <= 0 || colon === pair.length - 1) return null
    try {
      repo = { kind: "server", owner: decodeURIComponent(pair.slice(0, colon)), name: decodeURIComponent(pair.slice(colon + 1)) }
    } catch {
      return null
    }
  }
  const [tab = "", ...rest] = segments
  if (rest.some((segment) => segment.length === 0)) return null
  if (tab.startsWith(thread)) {
    const id = tab.slice(thread.length)
    if (!id) return null
    // a comment permalink opens the comment's own page (its reply window dropped)
    const comment = rest[0]?.startsWith("comment:") ? rest[0].slice("comment:".length) : null
    if (comment === "") return null
    const tail = comment !== null ? rest.slice(1) : rest
    const words = tail.filter((segment) => !segment.includes(":"))
    if (words.length > 1 || (words.length === 1 && (!["description", "edit"].includes(words[0]) || tail !== rest))) return null
    if (routeParams(tail.filter((segment) => segment.includes(":")), ["search", "start"]) === null) return null
    if (comment !== null) return commentRoute(repo, kind, id, comment)
    return words[0] === "edit" ? editThreadRoute(repo, kind, id) : threadRoute(repo, kind, id)
  }
  if (tab !== kind) return null
  const words = rest.filter((segment) => !segment.includes(":"))
  if (words.length === 0) return rest.length === 0 ? threadsRoute(repo, kind, statuses, statuses[0]) : null
  const params = routeParams(rest.filter((segment) => segment.includes(":")), ["search"])
  if (words.length > 1 || params === null) return null
  const search = params.get("search")
  const [word] = words
  if (word === "new") return rest.length === 1 ? newThreadRoute(repo, kind) : null
  if (word === "labels") return threadLabelsRoute(repo, kind, { search })
  const status = statuses.find((value) => value === word)
  return status === undefined ? null : threadsRoute(repo, kind, statuses, status, { search })
}
