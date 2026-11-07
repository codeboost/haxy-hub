/**
 * Forks: what one is and proposes, its whole diff, a user's forks, and
 * deleting one. Its files, refs and commits are read through the repository
 * readers with a `ForkLocator`. Mirrors haxy's src/api/forks.zig and the
 * forks route of src/api/discovery.zig.
 */
import { ApiError, getJson, requestJson, ViewerChangedError, type ActionAvailability, type EventId, type ObjectId, type Page, type PageQuery, type RequestOptions } from "@/lib/api"
import type { RepoAccess } from "@/lib/discovery"
import { fetchSession } from "@/lib/session"
import type { ForkCommand } from "@/lib/drafts"
import type { DiffEntry } from "@/lib/diff"
import { apiBase, canonicalPath, repoRoute, type EncodedPath, type ForkLocator, type RefId, type RepoLocator } from "@/lib/repo"

export type ForkSummary = {
  id: EventId
  forker: string
  /** The name of the repository it was made from, which its address keeps. */
  name: string
  title: string
  /** Still its forker's draft, not yet published as a patch. */
  draft: boolean
  /** The repository it proposes changes to; null once that (or its owner) was deleted. */
  target: { owner: string; name: string } | null
  target_branch: { name: string; id: RefId }
  /** Where its patch is read: the forker's own draft, or the target's patch; null when neither is there for this viewer. */
  patch: { kind: "draft" | "patch"; id: EventId } | null
  /** The tip of its patch branch. */
  head: ObjectId
  /** What its commits and diff start from. */
  base: ObjectId | null
  commit_count: number | null
  commands: ForkCommand[]
  actions: { delete: ActionAvailability }
}

export type ForkItem = {
  id: EventId
  name: string
  title: string
  /** Its target's, which it shares; null once the target is gone. */
  access: RepoAccess | null
  target_deleted: boolean
}

export type ForkDiff = Page<DiffEntry> & {
  base: ObjectId | null
  head: ObjectId
  path: EncodedPath | null
  truncated: boolean
}

type Options = Pick<RequestOptions, "signal">

export function getFork(fork: ForkLocator, options: Options = {}): Promise<ForkSummary> {
  return getJson<ForkSummary>(apiBase(fork), options)
}

/** A window of everything the fork adds to its base, optionally narrowed to one file. */
export function getForkDiff(fork: ForkLocator, query: { path?: EncodedPath; cursor?: string } = {}, options: Options = {}): Promise<ForkDiff> {
  const path = query.path ? canonicalPath(query.path) : ""
  const cursor = query.cursor ? new URLSearchParams({ cursor: query.cursor }).toString() : ""
  const text = [path ? `path=${path}` : "", cursor].filter((part) => part.length > 0).join("&")
  return getJson<ForkDiff>(`${apiBase(fork)}/diff${text ? `?${text}` : ""}`, options)
}

/**
 * The user's forks the viewer may see, newest first. A page may hold fewer
 * than asked for, so follow `next_cursor`, not the length.
 */
export function listUserForks(name: string, query: PageQuery = {}, options: Options = {}): Promise<Page<ForkItem>> {
  const params = new URLSearchParams()
  if (query.cursor) params.set("cursor", query.cursor)
  if (query.page_size !== undefined) params.set("page_size", String(query.page_size))
  const text = params.toString()
  return getJson<Page<ForkItem>>(`/api/v1/users/${encodeURIComponent(name)}/forks${text ? `?${text}` : ""}`, options)
}

/** Deletes the fork as its forker, `viewer`, with `forker:name` typed and their password. */
export function deleteFork(fork: ForkLocator, viewer: string, fields: { confirm: string; password: string }): Promise<{ forker: string; name: string; id: EventId }> {
  return requestJson(apiBase(fork), { method: "DELETE", viewer, headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields) })
}

async function forkExists(fork: ForkLocator): Promise<boolean> {
  try {
    await getFork(fork)
    return true
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found") return false
    throw error
  }
}

/**
 * Whether `viewer` can read the fork now, to settle a deletion whose outcome
 * is unknown. Hidden and missing look the same, so the answer counts only
 * while `viewer` is still the one signed in; otherwise it rejects with
 * ViewerChangedError.
 */
export async function forkExistsFor(fork: ForkLocator, viewer: string): Promise<boolean> {
  const exists = await forkExists(fork)
  const now = await fetchSession()
  if (now.viewer?.name !== viewer) throw new ViewerChangedError(viewer, now.viewer)
  return exists
}

/** The text a fork's deletion is confirmed with, as Haxy's own delete form asks for it. */
export function forkConfirmText(fork: ForkLocator): string {
  return `${fork.forker}:${fork.name}`
}

// --- Hub routes ----------------------------------------------------------------

export type ForkSection = "patch" | "files" | "commits" | "diff" | "delete"

/** The Hub route of one of the fork's sections: `/forks/<forker>/<name>/<id>[/files|/commits|/diff|/delete]`. */
export function forkRoute(fork: ForkLocator, section: ForkSection = "patch"): string {
  const base = repoRoute(fork)
  return section === "patch" ? base : `${base}/${section}`
}

/** The Hub route of the fork's diff, narrowed to `path` and paged by `cursor`. */
export function forkDiffRoute(fork: ForkLocator, query: { path?: EncodedPath; cursor?: string } = {}): string {
  const parts = [query.path ? `path=${canonicalPath(query.path)}` : "", query.cursor ? new URLSearchParams({ cursor: query.cursor }).toString() : ""].filter((part) => part.length > 0)
  return `${forkRoute(fork, "diff")}${parts.length === 0 ? "" : `?${parts.join("&")}`}`
}

/** The fork behind a fork-backed patch or draft of `repo`. */
export function forkOf(owner: { owner: string; name: string }, id: EventId): ForkLocator {
  return { kind: "fork", forker: owner.owner, name: owner.name, id }
}

/** The page of the fork's patch: the draft page or the patch page in its target. */
export function forkPatchRoute(fork: ForkSummary): string | null {
  if (!fork.target || !fork.patch) return null
  const target: RepoLocator = { kind: "server", owner: fork.target.owner, name: fork.target.name }
  const id = encodeURIComponent(fork.patch.id)
  return fork.patch.kind === "draft" ? `${repoRoute(target)}/patches/drafts/${id}` : `${repoRoute(target)}/patches/${id}`
}

// --- Haxy's own URLs -------------------------------------------------------------

const forkTabs: Record<string, ForkSection> = { "": "patch", files: "files", commits: "commits", diff: "diff", delete: "delete" }

/**
 * Haxy's fork page URLs as Hub routes (`hubPathForHaxyPath`, `@/lib/haxyPaths`):
 * `/<forker>:<name>+<id>[/files|/commits|/diff|/delete]` opens the fork's
 * section, and `/<user>/forks[/start:<n>]` the user's page with their forks.
 * A fork view naming a commit or a path has no Hub equivalent yet and stays
 * as written, never mistaken for a repository's; anything else gives null.
 */
export function hubPathForForkPath(path: string, local: boolean): string | null {
  if (local) return null
  const [first = "", ...rest] = path.slice(1).split("/")
  const forks = /^([A-Za-z0-9-]+)$/.exec(first)
  if (forks && rest[0] === "forks" && rest.slice(1).every((segment) => /^start:\d+$/.test(segment))) return `/users/${encodeURIComponent(first)}`
  const match = /^([A-Za-z0-9-]+):([A-Za-z0-9._-]+)\+([0-9a-f]{32})$/.exec(first)
  if (!match) return null
  const section = rest.length > 1 ? undefined : forkTabs[rest[0] ?? ""]
  if (section === undefined) return path
  return forkRoute({ kind: "fork", forker: match[1], name: match[2], id: match[3] }, section)
}
