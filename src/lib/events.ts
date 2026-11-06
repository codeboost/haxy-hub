/**
 * Events: a repository's active and removed events, and the events one
 * transaction wrote, read through the routes in haxy's src/api/events.zig.
 * Lists, counts, windows, detail targets and who may see them are Haxy's own
 * (the TUI's events tab).
 */
import { getJson, type Count, type EventId, type OpaqueId, type Page, type PageQuery, type RequestOptions, type Timestamp } from "@/lib/api"
import { repoRoute, type RepoLocator } from "@/lib/repo"
import { commentRoute, threadRoute, type ThreadAuthor } from "@/lib/threads"

/** What an event records, as Haxy names its event kinds. */
export type EventKind = "user" | "repo" | "fork" | "grant" | "notify" | "discuss" | "issue" | "comment" | "attach" | "assign" | "patchrev" | "patch"

/** The two lists Haxy keeps: events still in effect, and removed ones. */
export type EventView = "active" | "removed"

export const eventViews = ["active", "removed"] as const satisfies readonly EventView[]

/** The event kinds that are threads. */
export type ThreadEventKind = "discuss" | "issue" | "patch"

/** A transaction: its index in the repository's history. Opaque to clients. */
export type TransactionId = OpaqueId<"transaction">

/** What an event's detail opens: a thread, or a comment in one. */
export type EventTarget =
  | { kind: "thread"; thread_kind: ThreadEventKind; thread: EventId }
  | { kind: "comment"; thread_kind: ThreadEventKind; thread: EventId; comment: EventId }

export type RepoEvent = {
  id: EventId
  kind: EventKind
  author: ThreadAuthor
  /** When the event was created; null for kinds whose records don't keep it. */
  created_at: Timestamp | null
  /** Only active events in a thread kind the repository has turned on have one. */
  target: EventTarget | null
}

/** One view's window of events. `page.count` counts this view; `counts` counts both. */
export type EventList = Page<RepoEvent> & {
  view: EventView
  /** Set when the list is one transaction's events. */
  transaction?: TransactionId
  counts: Record<EventView, Count>
}

export type EventListQuery = PageQuery & { view: EventView; transaction?: TransactionId }

type Options = Pick<RequestOptions, "signal">

function apiBase(repo: RepoLocator): string {
  return repo.kind === "local" ? "/api/v1/repo" : `/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
}

function withParams(path: string, entries: Array<[string, string | number | undefined]>): string {
  const params = new URLSearchParams()
  for (const [key, value] of entries) if (value !== undefined && value !== "") params.set(key, String(value))
  const text = params.toString()
  return text ? `${path}?${text}` : path
}

export function listEvents(repo: RepoLocator, query: EventListQuery, options: Options = {}): Promise<EventList> {
  const path = query.transaction === undefined ? `${apiBase(repo)}/events` : `${apiBase(repo)}/transactions/${encodeURIComponent(query.transaction)}/events`
  return getJson(withParams(path, [["view", query.view], ["cursor", query.cursor], ["page_size", query.page_size]]), options)
}

// --- Hub routes ----------------------------------------------------------------

/**
 * The Hub route of an event list: `<repo>/events[/removed]`, or a
 * transaction's, `<repo>/events/transactions/<id>[/removed]`, with `?cursor=`.
 */
export function eventsRoute(repo: RepoLocator, view: EventView, position: { transaction?: TransactionId; cursor?: string } = {}): string {
  let path = `${repoRoute(repo)}/events`
  if (position.transaction !== undefined) path += `/transactions/${encodeURIComponent(position.transaction)}`
  if (view === "removed") path += "/removed"
  return withParams(path, [["cursor", position.cursor]])
}

/** What an events section's URL tail (after `<repo>/events/`) shows. */
export type EventsPage = { kind: "list"; view: EventView; transaction?: TransactionId } | { kind: "unknown" }

export function eventsPage(tail: string): EventsPage {
  const segments = tail.split("/").filter((segment) => segment.length > 0)
  let transaction: TransactionId | undefined
  if (segments[0] === "transactions") {
    if (segments.length < 2) return { kind: "unknown" }
    // ids are digits, so the router's decoding leaves them as written
    transaction = segments[1]
    segments.splice(0, 2)
  }
  if (segments.length === 0) return { kind: "list", view: "active", transaction }
  if (segments.length === 1 && segments[0] === "removed") return { kind: "list", view: "removed", transaction }
  return { kind: "unknown" }
}

/**
 * The Hub page an event's detail opens, or null where Hub has none yet:
 * issues and discussions open their page, and a comment on one opens the
 * comment's page. Patches and comments on them have no Hub page yet, and
 * are shown as unavailable.
 */
export function eventTargetRoute(repo: RepoLocator, target: EventTarget): string | null {
  const kind = target.thread_kind === "issue" ? "issues" : target.thread_kind === "discuss" ? "discussions" : null
  if (kind === null) return null
  return target.kind === "comment" ? commentRoute(repo, kind, target.thread, target.comment) : threadRoute(repo, kind, target.thread)
}

// --- Haxy's own event URLs -----------------------------------------------------

/**
 * The Hub route for a Haxy events page path, or null when `path` isn't one:
 *
 * | Haxy (`<repo>` is `/<owner>:<name>`, empty in local mode) | Haxy Hub |
 * | --- | --- |
 * | `<repo>/events`, `<repo>/events/active` | `<hub repo>/events` |
 * | `<repo>/events/removed` | `<hub repo>/events/removed` |
 * | `<repo>/events[/active\|/removed]/moment:<n>` | `<hub repo>/events/transactions/<n>[/removed]` |
 * | `<repo>/event:<id>/kind:<kind>[/moment:<n>]` | `<hub repo>/events[/transactions/<n>]` |
 *
 * `moment:` may come before or after the view word, as Haxy reads it. An
 * `event:` URL is a window rooted at that event; like `start:` windows it is
 * dropped (Hub pages use cursors only Haxy issues), so it opens the first
 * page of the active list. `local` reads the local forms, which leave the
 * repository out.
 */
export function hubPathForEventsPath(path: string, local = false): string | null {
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
  const moment = (segment: string) => /^moment:(\d+)$/.exec(segment)?.[1]
  if (tab.startsWith("event:")) {
    // the kind comes first, then the moment
    if (!/^event:[0-9a-f]+$/.test(tab) || !/^kind:[a-z]+$/.test(rest[0] ?? "") || rest.length > 2) return null
    const transaction = rest.length === 2 ? moment(rest[1]) : undefined
    if (rest.length === 2 && transaction === undefined) return null
    return eventsRoute(repo, "active", { transaction: transaction === undefined ? undefined : BigInt(transaction).toString() })
  }
  if (tab !== "events") return null
  const words = rest.filter((segment) => !segment.includes(":"))
  const pairs = rest.filter((segment) => segment.includes(":"))
  if (words.length > 1 || pairs.length > 1) return null
  let transaction: TransactionId | undefined
  if (pairs.length === 1) {
    transaction = moment(pairs[0])
    if (transaction === undefined) return null
    // Haxy reads the index as a number; Hub ids are canonical decimal
    transaction = BigInt(transaction).toString()
  }
  const view = words[0] ?? "active"
  if (view !== "active" && view !== "removed") return null
  return eventsRoute(repo, view, { transaction })
}
