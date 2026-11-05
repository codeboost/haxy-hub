/**
 * Threads: a repository's issues (and, in later slices, its discussions and
 * patches), read through the routes in haxy's src/api/thread.zig and
 * src/api/issues.zig. Lists, counts, windows and search filters are Haxy's
 * own (the TUI's issues tab): Hub never parses a search or builds a filter.
 */
import { getJson, type Count, type EventId, type Page, type PageQuery, type RequestOptions, type Timestamp } from "@/lib/api"
import type { MarkdownBlock } from "@/lib/markdown"
import { repoRoute, type RepoLocator } from "@/lib/repo"

/** The kinds of thread, as they appear in API and Hub paths. */
export type ThreadKind = "issues"

export type IssueStatus = "open" | "closed"

/** Who opened a thread: an account, an email no account holds, or nobody known. */
export type ThreadAuthor = { kind: "user"; name: string } | { kind: "email"; email: string } | { kind: "unknown" }

/**
 * A label or assignee, with the search that lists the threads carrying it:
 * the current search with its filter of that kind replaced (as the TUI's links do).
 */
export type FilterLink = { name: string; search: string }

/** An assignee: by account name when one holds the email, otherwise by email. */
export type ThreadAssignee = { name: string | null; email: string | null; search: string }

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

/** The thread with its whole description, parsed by Haxy's Markdown reader. */
export type ThreadDetail<Status extends string> = ThreadSummary<Status> & { description: MarkdownBlock[] }

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
  filters: ThreadFilters
  counts: Record<Status, Count>
}

export type ThreadListQuery<Status extends string> = PageQuery & { status: Status; search?: string }

type Options = Pick<RequestOptions, "signal">

function apiBase(repo: RepoLocator, kind: ThreadKind): string {
  const base = repo.kind === "local" ? "/api/v1/repo" : `/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
  return `${base}/${kind}`
}

function withParams(path: string, entries: Array<[string, string | number | undefined]>): string {
  const params = new URLSearchParams()
  for (const [key, value] of entries) if (value !== undefined && value !== "") params.set(key, String(value))
  const text = params.toString()
  return text ? `${path}?${text}` : path
}

export function listThreads<Status extends string>(repo: RepoLocator, kind: ThreadKind, query: ThreadListQuery<Status>, options: Options = {}): Promise<ThreadList<Status>> {
  return getJson(withParams(apiBase(repo, kind), [["status", query.status], ["search", query.search], ["cursor", query.cursor], ["page_size", query.page_size]]), options)
}

export function getThread<Status extends string>(repo: RepoLocator, kind: ThreadKind, id: EventId, options: Options = {}): Promise<ThreadDetail<Status>> {
  return getJson(`${apiBase(repo, kind)}/${encodeURIComponent(id)}`, options)
}

/** Every label the repository's threads of `kind` use, by name; each links into the first status's list. */
export function listThreadLabels(repo: RepoLocator, kind: ThreadKind, query: PageQuery & { search?: string } = {}, options: Options = {}): Promise<Page<FilterLink>> {
  return getJson(withParams(`${apiBase(repo, kind)}/labels`, [["search", query.search], ["cursor", query.cursor], ["page_size", query.page_size]]), options)
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

/** The Hub route of the labels list, carrying the search its links extend. */
export function threadLabelsRoute(repo: RepoLocator, kind: ThreadKind, position: ListPosition = {}): string {
  return `${repoRoute(repo)}/${kind}/labels` + query([["search", position.search], ["cursor", position.cursor]])
}

/** What a thread section's URL tail (after `<repo>/<kind>/`) shows. */
export type ThreadView<Status extends string> = { kind: "list"; status: Status } | { kind: "labels" } | { kind: "thread"; id: EventId } | { kind: "unknown" }

export function threadView<Status extends string>(statuses: readonly Status[], tail: string): ThreadView<Status> {
  const segments = tail.split("/").filter((segment) => segment.length > 0)
  if (segments.length === 0) return { kind: "list", status: statuses[0] }
  if (segments.length > 1) return { kind: "unknown" }
  const [segment] = segments
  if (segment === "labels") return { kind: "labels" }
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
 * | `<repo>/issue:<id>[/search:<s>][/start:<n>]`, `…/description`, `…/comment:<c>[/start:<n>]` | `<hub repo>/issues/<id>` |
 *
 * Parameter segments may come in any order before or after the view word, as
 * Haxy reads them. Forms (`new`, `edit`, `remove`, `resolve`) and the
 * conflicts list have no Hub page yet. `local` reads the local forms, which
 * leave the repository out.
 */
export function hubPathForIssuePath(path: string, local = false): string | null {
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
  if (tab.startsWith("issue:")) {
    const id = tab.slice("issue:".length)
    if (!id) return null
    // a comment permalink opens its issue until Hub has comment pages
    const tail = rest[0]?.startsWith("comment:") ? rest.slice(1) : rest
    const words = tail.filter((segment) => !segment.includes(":"))
    if (words.length > 1 || (words.length === 1 && (words[0] !== "description" || tail !== rest))) return null
    if (routeParams(tail.filter((segment) => segment.includes(":")), ["search", "start"]) === null) return null
    return threadRoute(repo, "issues", id)
  }
  if (tab !== "issues") return null
  const words = rest.filter((segment) => !segment.includes(":"))
  if (words.length === 0) return rest.length === 0 ? threadsRoute(repo, "issues", issueStatuses, "open") : null
  const params = routeParams(rest.filter((segment) => segment.includes(":")), ["search"])
  if (words.length > 1 || params === null) return null
  const search = params.get("search")
  const [word] = words
  if (word === "labels") return threadLabelsRoute(repo, "issues", { search })
  const status = issueStatuses.find((value) => value === word)
  return status === undefined ? null : threadsRoute(repo, "issues", issueStatuses, status, { search })
}
