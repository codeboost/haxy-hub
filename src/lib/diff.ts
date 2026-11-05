/**
 * A commit's diff against its first parent, a window at a time, optionally
 * narrowed to one file. Mirrors haxy's src/api/diff.zig, which reads every
 * window through the TUI's diff pane.
 */
import { getJson, type ObjectId, type Page, type RequestOptions } from "@/lib/api"
import { apiBase, canonicalPath, canonicalRef, displaySegment, pathSegments, repoRoute, type EncodedPath, type RefId, type RepoLocator } from "@/lib/repo"

export type DiffLine = {
  kind: "context" | "added" | "removed"
  /** 1-based line numbers, null on the side the line isn't on. */
  old_number: number | null
  new_number: number | null
  text: string
}

/**
 * One entry of a window: a hunk of a changed text file, or a whole file shown
 * only by its path. `file` is an added or removed text file (as the TUI shows
 * them); `binary` a file Haxy reads as binary (not UTF-8, or past its text
 * limits, such as a line over 10,000 bytes); `too_large` a change past Haxy's
 * diff limits.
 */
export type DiffEntry = {
  /** Percent-encoded bytes; see "Repository paths" in docs/api-conventions.md. */
  path: EncodedPath
  /** The last segment, for display. */
  name: string
  status: "added" | "removed" | "changed"
  kind: "hunk" | "file" | "binary" | "too_large"
  /** A hunk's lines; empty for the other kinds. */
  lines: DiffLine[]
}

export type CommitDiff = Page<DiffEntry> & {
  commit: ObjectId
  /** What the diff is against: the first parent, null for a root commit. */
  parent: ObjectId | null
  /** The path the diff is narrowed to, null for every file. */
  path: EncodedPath | null
  /** The diff past these entries is too large for Haxy to read. */
  truncated: boolean
}

export type DiffQuery = { path?: EncodedPath; cursor?: string; page_size?: number }

type Options = Pick<RequestOptions, "signal">

/** A window of commit `id`'s diff. */
export function getCommitDiff(repo: RepoLocator, id: ObjectId, query: DiffQuery = {}, options: Options = {}): Promise<CommitDiff> {
  const params = new URLSearchParams()
  if (query.cursor) params.set("cursor", query.cursor)
  if (query.page_size !== undefined) params.set("page_size", String(query.page_size))
  // already percent-encoded, so it goes in as is and the backend decodes it once
  const path = query.path ? canonicalPath(query.path) : ""
  const text = [path ? `path=${path}` : "", params.toString()].filter((part) => part.length > 0).join("&")
  return getJson<CommitDiff>(`${apiBase(repo)}/commits/${encodeURIComponent(id)}/diff${text ? `?${text}` : ""}`, options)
}

/** An encoded path for display: each segment decoded, ill-formed UTF-8 shown as U+FFFD. */
export function displayPath(path: EncodedPath): string {
  return pathSegments(path).map(displaySegment).join("/")
}

// --- Hub routes ----------------------------------------------------------------

/**
 * The Hub route of commit `id`'s diff, `…/commits/<id>/diff[?ref=<id>][&path=<path>][&cursor=…]`.
 * `ref` is the history the commit was opened from; `path` an encoded path,
 * which goes in exactly as Haxy encoded it.
 */
export function commitDiffRoute(repo: RepoLocator, id: ObjectId, ref: RefId | null = null, query: { path?: EncodedPath; cursor?: string } = {}): string {
  const parts = [
    ref ? `ref=${canonicalRef(ref)}` : "",
    query.path ? `path=${canonicalPath(query.path)}` : "",
    query.cursor ? new URLSearchParams({ cursor: query.cursor }).toString() : "",
  ].filter((part) => part.length > 0)
  return `${repoRoute(repo)}/commits/${encodeURIComponent(id)}/diff${parts.length === 0 ? "" : `?${parts.join("&")}`}`
}

/**
 * The path filter and cursor a diff route names, read from its query string
 * as the browser holds it. `URLSearchParams` would decode the path, and one
 * that isn't UTF-8 would not survive, so the raw text is used.
 */
export function diffParams(search: string): { path: EncodedPath; cursor: string } {
  let path = ""
  let cursor = ""
  for (const pair of search.replace(/^\?/, "").split("&")) {
    if (pair.startsWith("path=") && !path) path = canonicalPath(pair.slice("path=".length))
    if (pair.startsWith("cursor=") && !cursor) {
      try {
        cursor = decodeURIComponent(pair.slice("cursor=".length).replace(/\+/g, " "))
      } catch {
        cursor = pair.slice("cursor=".length)
      }
    }
  }
  return { path: pathSegments(path).join("/"), cursor }
}

/** Where an entry's file opens in the files view: as the commit left it, or as its parent had a removed one. */
export function entryFileRoute(repo: RepoLocator, diff: Pick<CommitDiff, "commit" | "parent">, entry: Pick<DiffEntry, "path" | "status">): string | null {
  const at = entry.status === "removed" ? diff.parent : diff.commit
  return at === null ? null : repoRoute(repo, entry.path, `commit:${at}`)
}
