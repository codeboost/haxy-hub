/**
 * Local mode's event sync with its remote, through `/api/v1/repo/sync` (haxy's
 * src/api/sync.zig). Haxy runs the TUI's own sync: it fetches the remote's
 * events, merges them by Haxy's merge rules, pushes the result and fetches
 * again, moving only the events branch. A POST answers once the sync has
 * finished, with its outcome.
 */
import { getJson, requestJson, type Count, type RequestOptions, type Timestamp } from "@/lib/api"
import type { IssueStatus, ThreadSummary } from "@/lib/threads"

/** How the events branch compares with the remote's, as last fetched. */
export type SyncState = "no_remote" | "not_fetched" | "in_sync" | "sync_needed"

/** The step a failed sync stopped at, which says what it left behind. */
export type SyncStage = "remote" | "fetch" | "merge" | "push" | "confirm"

/** A finished sync. `id` is opaque: a different one is a different sync. */
export type SyncRecord = {
  id: string
  outcome: "synced" | "failed"
  finished_at: Timestamp
  failure: { stage: SyncStage; message: string; remote_message: string | null } | null
}

export type SyncStatus = {
  remote: string | null
  state: SyncState
  /** Whether a sync is running in Haxy now. */
  running: boolean
  /** The last sync this Haxy process finished; null since it started. */
  last: SyncRecord | null
  /**
   * Unresolved metadata conflicts: the first conflicted issues and the counts.
   * Null when Haxy couldn't read them (events that can't be read; `last` says why).
   */
  conflicts: { issues: { count: Count; items: ThreadSummary<IssueStatus>[] }; patches: { count: Count } } | null
}

const path = "/api/v1/repo/sync"

export function readSync(options: Pick<RequestOptions, "signal"> = {}): Promise<SyncStatus> {
  return getJson<SyncStatus>(path, options)
}

/** Runs a sync and answers once it finished; no client timeout (writes have none). */
export function runSync(): Promise<SyncStatus> {
  return requestJson<SyncStatus>(path, { method: "POST" })
}
