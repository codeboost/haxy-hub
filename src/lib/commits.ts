/**
 * A repository's commit history at a ref, its indexed commit search, and one
 * commit with its whole message. Mirrors haxy's src/api/commits.zig, which
 * reads everything through the TUI's commits tab.
 */
import { getJson, type ObjectId, type Page, type PageQuery, type RequestOptions, type Timestamp } from "@/lib/api"
import { canonicalRef, repoRoute, type ReadRef, type RefId, type RepoLocator } from "@/lib/repo"
import type { ThreadAuthor } from "@/lib/threads"

/** Who wrote or committed a commit: an account, an email no account holds, or nobody known. */
export type CommitPerson = ThreadAuthor

/** What Haxy computes about a commit's change (xit repositories only). */
export type CommitStats = {
  first_parent_depth: number
  lines_added: number
  lines_changed: number
  lines_removed: number
  bytes_added: number
  bytes_removed: number
  files_added: number
  files_changed: number
  files_removed: number
}

export type CommitSummary = {
  id: ObjectId
  /** The first parent, which the commit's diff is against; null for a root commit. */
  parent: ObjectId | null
  /** The message's first line. */
  summary: string
  author: CommitPerson
  /** null when the committer is the author. */
  committer: CommitPerson | null
  committed_at: Timestamp
  merge: boolean
  /** null where Haxy computes no statistics: unavailable, never zero. */
  stats: CommitStats | null
}

export type CommitDetail = CommitSummary & {
  /** The whole message, up to Haxy's limit. */
  message: string
  /** The message is longer than Haxy reads, and `message` is its start. */
  message_truncated: boolean
}

/** Whether the history can be searched, and at which ref (a commit's is searched on the default branch). */
export type CommitSearch =
  | { available: true; ref: RefId; reason: null }
  | { available: false; ref: null; reason: { code: "unsupported"; message: string } }

/**
 * Whether the history's commits are in the repository. A patch revision's are
 * not after its fork was squash-merged: only the squashed commit came in.
 */
export type HistoryAvailability =
  | { available: true; reason: null }
  | { available: false; reason: { code: "unsupported"; message: string } }

export type History = Page<CommitSummary> & {
  /** The ref the history was read at; `id` names it explicitly, also when the request named none. */
  ref: ReadRef
  history: HistoryAvailability
  search: CommitSearch
  /** The search these are the results of; null for the plain history. */
  query: string | null
}

export type HistoryQuery = PageQuery & {
  /** The ref to read at; the default branch when absent. */
  ref?: RefId | null
  search?: string
}

type Options = Pick<RequestOptions, "signal">

function apiBase(repo: RepoLocator): string {
  return repo.kind === "local" ? "/api/v1/repo" : `/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
}

/** A page of the history at `ref`, or of the commits matching `search`. */
export function listCommits(repo: RepoLocator, query: HistoryQuery = {}, options: Options = {}): Promise<History> {
  const params = new URLSearchParams()
  if (query.search) params.set("search", query.search)
  if (query.cursor) params.set("cursor", query.cursor)
  if (query.page_size !== undefined) params.set("page_size", String(query.page_size))
  // already percent-encoded, so it goes in as is and the backend decodes it once
  const text = [query.ref ? `ref=${canonicalRef(query.ref)}` : "", params.toString()].filter((part) => part.length > 0).join("&")
  return getJson<History>(`${apiBase(repo)}/commits${text ? `?${text}` : ""}`, options)
}

/** One commit, with its whole message up to Haxy's limit. */
export function getCommit(repo: RepoLocator, id: ObjectId, options: Options = {}): Promise<CommitDetail> {
  return getJson<CommitDetail>(`${apiBase(repo)}/commits/${encodeURIComponent(id)}`, options)
}

// --- Hub routes ----------------------------------------------------------------

function routeQuery(ref: RefId | null, query: Record<string, string>): string {
  const plain = new URLSearchParams(Object.entries(query).filter(([, value]) => value.length > 0)).toString()
  // the ref is already safe in a query string; the rest is plain text
  const parts = [ref ? `ref=${canonicalRef(ref)}` : "", plain].filter((part) => part.length > 0)
  return parts.length === 0 ? "" : `?${parts.join("&")}`
}

/**
 * The Hub route of `repo`'s history at `ref` (the default branch when null):
 * `/repos/<owner>/<name>/commits[?ref=<id>][&search=…][&cursor=…]`, or
 * `/repo/commits…` in local mode.
 */
export function commitsRoute(repo: RepoLocator, ref: RefId | null = null, query: { search?: string; cursor?: string } = {}): string {
  return `${repoRoute(repo)}/commits${routeQuery(ref, { search: query.search ?? "", cursor: query.cursor ?? "" })}`
}

/**
 * The Hub route of one commit, `…/commits/<id>`. `ref` is the history it was
 * opened from, which its way back returns to. (A commit's diff, #08, hangs
 * off this route.)
 */
export function commitRoute(repo: RepoLocator, id: ObjectId, ref: RefId | null = null): string {
  return `${repoRoute(repo)}/commits/${encodeURIComponent(id)}${routeQuery(ref, {})}`
}

/** What a commits route's tail (the raw pathname after `…/commits`) names. */
export function commitsView(tail: string): { kind: "history" } | { kind: "commit"; id: ObjectId } | { kind: "unknown" } {
  const segments = tail.split("/").filter((segment) => segment.length > 0)
  if (segments.length === 0) return { kind: "history" }
  if (segments.length === 1 && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(segments[0])) return { kind: "commit", id: segments[0] }
  return { kind: "unknown" }
}

// --- Haxy's own URLs -------------------------------------------------------------

const refKinds: Record<string, string> = { branch: "branch", tag: "tag" }

/**
 * Haxy's commits page URLs as Hub routes (`hubPathForHaxyPath`, `@/lib/haxyPaths`).
 * `<repo>` is `/<owner>:<name>` on a server and empty in local mode:
 *
 * | Haxy                                                         | Haxy Hub                                |
 * | ------------------------------------------------------------ | --------------------------------------- |
 * | `<repo>/commits`                                             | `<hub repo>/commits`                    |
 * | `<repo>/commits/branch:<n>\|tag:<n>[/search:<s>][/from:<c>]` | `<hub repo>/commits?ref=<id>[&search=<s>]` |
 * | `<repo>/commits/object:<oid>[/message]`                      | `<hub repo>/commits/<oid>`              |
 *
 * `from:` windows are dropped, as Hub pages use opaque cursors. Base-bounded
 * lists (`base:`) and a merge's commits (`merge:`) have no Hub page, so those
 * paths come back null and stay as written.
 */
export function hubPathForCommitPath(path: string, local = false): string | null {
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
  const [tab, ...rest] = segments
  if (tab !== "commits") return null
  let ref: RefId | null = null
  let object: string | null = null
  let search = ""
  let message = false
  for (const [index, segment] of rest.entries()) {
    const colon = segment.indexOf(":")
    const key = segment.slice(0, colon)
    const value = segment.slice(colon + 1)
    if (segment === "message" && index === rest.length - 1) {
      message = true
    } else if (colon <= 0 || value.length === 0) {
      return null
    } else if (key in refKinds || key === "object") {
      if (ref !== null || object !== null) return null
      if (key === "object") object = value
      else ref = canonicalRef(`${refKinds[key]}:${value}`)
    } else if (key === "search") {
      try {
        search = decodeURIComponent(value)
      } catch {
        return null
      }
    } else if (key !== "from") {
      return null
    }
  }
  if (object !== null) {
    if (search || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(object)) return null
    return commitRoute(repo, object)
  }
  if (message || (ref === null && search)) return null
  return commitsRoute(repo, ref, { search })
}
