/**
 * Undo: a server repository's undo history, and undoing a transaction in it,
 * through the routes in haxy's src/api/undo.zig. Who sees the history (people
 * who may write), who may undo (its owners), what can be undone and what each
 * record says are Haxy's own (the TUI's undo tab). Local mode has no undo.
 */
import { getJson, requestJson, type ActionAvailability, type ObjectId, type OpaqueId, type Page, type PageQuery, type RequestOptions, type Timestamp } from "@/lib/api"
import { commitsRoute } from "@/lib/commits"
import { eventsRoute, type TransactionId } from "@/lib/events"
import { repoRoute, type RefId, type RepoLocator } from "@/lib/repo"

/** What a record's detail opens. */
export type UndoTarget =
  | { kind: "transaction"; transaction: TransactionId }
  | { kind: "events"; transaction: TransactionId }
  | { kind: "user"; name: string }
  | { kind: "commits"; tip: ObjectId; base: ObjectId | null }
  | { kind: "branch" | "tag"; ref: RefId; name: string }

/** What the TUI shows in place of a record's description: a label, a text, and what it opens. */
export type UndoDetail = { label: string; text: string; target: UndoTarget | null }

/** A transaction in the undo history. */
export type UndoRecord = {
  transaction: TransactionId
  action: string
  description: string
  /** Null when the transaction has no undo record. */
  created_at: Timestamp | null
  /** A later undo discarded it. */
  undone: boolean
  details: UndoDetail[]
  /** Whether this viewer may undo it (and every transaction after it). */
  actions: { undo: ActionAvailability }
}

/** The history as one read saw it, opaque: an undo names it, and Haxy refuses the undo once the history has moved on (or was cleared). */
export type UndoRevision = OpaqueId<"undo revision">

/** A window of the history, newest first, with its revision and its newest transaction. */
export type UndoHistory = Page<UndoRecord> & { revision: UndoRevision; newest: TransactionId }

/** An undo's answer: its own record, whose undo reverses it, and the history's revision after it. */
export type UndoResult = { record: UndoRecord; revision: UndoRevision }

export type UndoQuery = PageQuery & { transaction?: TransactionId }

function apiBase(repo: RepoLocator): string {
  return repo.kind === "local" ? "/api/v1/repo" : `/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
}

function withParams(path: string, entries: Array<[string, string | number | undefined]>): string {
  const params = new URLSearchParams()
  for (const [key, value] of entries) if (value !== undefined && value !== "") params.set(key, String(value))
  const text = params.toString()
  return text ? `${path}?${text}` : path
}

/** A window of the history: the newest first, or from `transaction`, or from a previous page's cursor. */
export function listUndo(repo: RepoLocator, query: UndoQuery = {}, options: Pick<RequestOptions, "signal"> = {}): Promise<UndoHistory> {
  const path = query.transaction === undefined ? `${apiBase(repo)}/undo` : `${apiBase(repo)}/undo/${encodeURIComponent(query.transaction)}`
  return getJson(withParams(path, [["cursor", query.cursor], ["page_size", query.page_size]]), options)
}

/**
 * Undoes `transaction` and every transaction after it, as of the history at
 * `revision`. Bound to `viewer`, the owner the page was loaded for.
 */
export function undoTransaction(repo: RepoLocator, viewer: string, transaction: TransactionId, revision: UndoRevision): Promise<UndoResult> {
  return requestJson(`${apiBase(repo)}/undo`, {
    method: "POST",
    viewer,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction, revision }),
  })
}

// --- Hub routes ----------------------------------------------------------------

/** The Hub route of the undo history: `<repo>/undo`, or from one transaction, `<repo>/undo/<id>`, with `?cursor=`. */
export function undoRoute(repo: RepoLocator, position: { transaction?: TransactionId; cursor?: string } = {}): string {
  const path = `${repoRoute(repo)}/undo${position.transaction === undefined ? "" : `/${encodeURIComponent(position.transaction)}`}`
  return withParams(path, [["cursor", position.cursor]])
}

/** What an undo section's URL tail (after `<repo>/undo/`) shows. */
export function undoPage(tail: string): { kind: "history"; transaction?: TransactionId } | { kind: "unknown" } {
  const segments = tail.split("/").filter((segment) => segment.length > 0)
  if (segments.length === 0) return { kind: "history" }
  // ids are digits, so the router's decoding leaves them as written
  if (segments.length === 1 && /^\d+$/.test(segments[0])) return { kind: "history", transaction: segments[0] }
  return { kind: "unknown" }
}

/** The Hub page a record's detail opens. */
export function undoTargetRoute(repo: RepoLocator, target: UndoTarget): string {
  switch (target.kind) {
    case "transaction": return undoRoute(repo, { transaction: target.transaction })
    case "events": return eventsRoute(repo, "active", { transaction: target.transaction })
    case "user": return `/users/${encodeURIComponent(target.name)}`
    // Hub has no base-bounded history: the history from the tip
    case "commits": return commitsRoute(repo, `commit:${target.tip}`)
    case "branch":
    case "tag": return repoRoute(repo, "", target.ref)
  }
}

// --- Haxy's own undo URLs ------------------------------------------------------

/**
 * The Hub route for a Haxy undo page path, or null when `path` isn't one:
 * `<repo>/undo` → `<hub repo>/undo`, `<repo>/undo/<n>` → `<hub repo>/undo/<n>`,
 * where `<repo>` is `/<owner>:<name>` (local mode has no undo pages).
 */
export function hubPathForUndoPath(path: string, local = false): string | null {
  if (local) return null
  const match = /^\/([^/:]+):([^/]+)\/undo(?:\/(\d+))?$/.exec(path)
  if (!match) return null
  try {
    const repo: RepoLocator = { kind: "server", owner: decodeURIComponent(match[1]), name: decodeURIComponent(match[2]) }
    return undoRoute(repo, { transaction: match[3] === undefined ? undefined : BigInt(match[3]).toString() })
  } catch {
    return null
  }
}
