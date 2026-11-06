/**
 * Patches: a repository's change proposals, read through haxy's
 * src/api/patches.zig. Lists, counts, windows, search filters and labels are
 * the shared thread routes (`@/lib/threads`, kind "patches"); a patch's own
 * route adds what it proposes and where to review it. Every list and patch is
 * the TUI's patches tab's (`ui.Repo.Patches`), so Hub never decides which
 * revision a patch is reviewed at, or what its diff leaves out.
 */
import { getJson, type ActionAvailability, type EventId, type ObjectId, type Page, type RequestOptions, type UnavailableCode } from "@/lib/api"
import type { Attached } from "@/lib/attachments"
import { commitsRoute } from "@/lib/commits"
import { draftsRoute, type ForkCommand } from "@/lib/drafts"
import type { CommitDiff, DiffQuery } from "@/lib/diff"
import type { MarkdownBlock } from "@/lib/markdown"
import { apiBase, canonicalPath, getRepo, listRefs, pathSegments, repoRoute, type EncodedPath, type RefId, type RefItem, type RepoLocator, type RepoOverview } from "@/lib/repo"
import { commentRoute, editThreadRoute, newThreadRoute, threadLabelsRoute, threadRoute, threadsRoute, type ThreadSummary } from "@/lib/threads"

export type PatchStatus = "open" | "closed" | "merged"

/** The patch statuses, in the TUI's tab order (the first is the default list). */
export const patchStatuses = ["open", "closed", "merged"] as const satisfies readonly PatchStatus[]

/** A branch as Haxy names it: for display, and as a ref id for the files and commits views. */
export type PatchBranch = { name: string; id: RefId }

/** Where a patch's commits come from: a branch of the repository, or a fork (null once the fork is gone). */
export type PatchSource = { kind: "branch"; name: string; id: RefId } | { kind: "fork"; fork: { owner: string; name: string } | null }

/** The revision a patch proposes. */
export type PatchRevision = {
  /** The revision's event id; `revision:<id>` is a ref id. */
  id: EventId
  source_commit: ObjectId
  /** The one commit that stands for the revision's changes, which a squash merge lands. */
  squash_commit: ObjectId
  /** The commit it was based on; null where this repository doesn't hold the revision (an open fork-backed patch's). */
  base_commit: ObjectId | null
  /** Its commits from the base, first parents only; null where Haxy doesn't count them. */
  commit_count: number | null
}

export type MergeResult = "clean" | "conflict" | "unknown"

/**
 * Whether Haxy offers merging the patch (as the TUI's merge button does), and
 * how merging its source commits or its squashed commit would go: `unknown`
 * until Haxy has checked it against the target's tip.
 */
export type Mergeability =
  | { available: true; source: MergeResult; squash: MergeResult }
  | { available: false; reason: { code: UnavailableCode; message: string } }

/**
 * Where to review the patch's code: the revision whose files and commits (back
 * to its base) to read, and the revision whose diff to read (for a merged
 * patch, what landed); or why there is none to read here.
 */
export type PatchReview =
  | { available: true; revision: EventId; diff: EventId }
  | { available: false; reason: { code: UnavailableCode; message: string } }

/**
 * One patch: its summary, what it proposes and where to review it, its
 * attachments, and what the viewer may do to it.
 */
export type PatchDetail = ThreadSummary<PatchStatus> & Attached & {
  description: MarkdownBlock[]
  description_text: string
  source: PatchSource
  /** The target branch, with its tip as the read saw it (null without one, or once merged), which a merge sends back. */
  target: PatchBranch & { commit: ObjectId | null }
  revision: PatchRevision | null
  /** How it was merged, and the revision recording what landed. */
  merged: { method: "source" | "squash"; revision: EventId } | null
  /** The target branch already is at the revision's source commit. */
  no_changes: boolean
  mergeability: Mergeability
  review: PatchReview
  /** The opaque revision of what an edit replaces (title, labels, description, target), which an edit sends back. */
  edit_revision: string
  actions: Record<"edit" | "set_status" | "remove" | "attach" | "merge", ActionAvailability>
  /** The Git commands for a fork-backed patch's fork, as the TUI offers them; none for a branch-backed or merged patch. */
  commands: ForkCommand[]
}

/** A window of a patch revision's diff: its base commit's tree against its source commit's. */
export type RevisionDiff = Omit<CommitDiff, "commit" | "parent"> & {
  revision: EventId
  /** The commit the revision was based on; null for one into a branch without commits. */
  base: ObjectId | null
  /** The revision's source commit. */
  head: ObjectId
}

type Options = Pick<RequestOptions, "signal">

/** One patch, with what it proposes. */
export function getPatch(repo: RepoLocator, id: EventId, options: Options = {}): Promise<PatchDetail> {
  return getJson(`${apiBase(repo)}/patches/${encodeURIComponent(id)}`, options)
}

/** A page of the repository's branches whose names start with `search`, in name order, from `cursor`. */
export type BranchSearch = (query: { search: string; cursor?: string }, options?: Options) => Promise<Page<RefItem>>

/** The branches a patch's form chooses among, and the target it starts at. */
export type BranchChoices = {
  /** Finds any of the repository's branches by the start of its name, a page at a time. */
  search: BranchSearch
  /** The repository's default branch by its exact id, a new patch's target unless chosen otherwise; null when it has no commits or HEAD names no branch. */
  defaultTarget: RefId | null
}

/** How many branches a picker lists at a time. */
export const branchPageSize = 50

/** Searches the repository's branches, and names its default branch. */
export async function getBranchChoices(repo: RepoLocator, options: Options = {}): Promise<BranchChoices> {
  const overview = await getRepo(repo, options)
  return { search: branchSearch(repo), defaultTarget: defaultTargetOf(overview) }
}

function branchSearch(repo: RepoLocator): BranchSearch {
  return (query, options = {}) => listRefs(repo, "branch", { ...query, page_size: branchPageSize }, options)
}

/** The default branch, by the id Haxy gives it; none when it has no commit, so it isn't a branch yet. */
function defaultTargetOf(overview: RepoOverview): RefId | null {
  return overview.empty ? null : overview.default_branch_id
}

/** A window of revision `id`'s diff. */
export function getRevisionDiff(repo: RepoLocator, id: EventId, query: DiffQuery = {}, options: Options = {}): Promise<RevisionDiff> {
  const params = new URLSearchParams()
  if (query.cursor) params.set("cursor", query.cursor)
  if (query.page_size !== undefined) params.set("page_size", String(query.page_size))
  // already percent-encoded, so it goes in as is and the backend decodes it once
  const path = query.path ? canonicalPath(query.path) : ""
  const text = [path ? `path=${path}` : "", params.toString()].filter((part) => part.length > 0).join("&")
  return getJson(`${apiBase(repo)}/revisions/${encodeURIComponent(id)}/diff${text ? `?${text}` : ""}`, options)
}

/** Whether `ref` names a patch revision, and which. */
export function revisionOfRef(ref: RefId | null): EventId | null {
  const match = /^revision:([0-9a-f]{32})$/.exec(ref ?? "")
  return match ? match[1] : null
}

// --- Hub routes ----------------------------------------------------------------

/** A revision as a ref id, for the files and commits views. */
export function revisionRef(revision: EventId): RefId {
  return `revision:${revision}`
}

/** The files view at a revision: its source commit's tree. */
export function revisionFilesRoute(repo: RepoLocator, revision: EventId): string {
  return repoRoute(repo, "", revisionRef(revision))
}

/** The commits view at a revision: its source commit back to its base, first parents only. */
export function revisionCommitsRoute(repo: RepoLocator, revision: EventId): string {
  return commitsRoute(repo, revisionRef(revision))
}

/**
 * The Hub route of a revision's diff, `<hub repo>/patches/revisions/<id>/diff[?patch=<id>][&path=…][&cursor=…]`.
 * `patch` is the patch it was opened from, which its way back returns to;
 * `path` an encoded path, which goes in exactly as Haxy encoded it.
 */
export function revisionDiffRoute(repo: RepoLocator, revision: EventId, query: { patch?: EventId | null; path?: EncodedPath; cursor?: string } = {}): string {
  const parts = [
    query.patch ? new URLSearchParams({ patch: query.patch }).toString() : "",
    query.path ? `path=${canonicalPath(query.path)}` : "",
    query.cursor ? new URLSearchParams({ cursor: query.cursor }).toString() : "",
  ].filter((part) => part.length > 0)
  return `${repoRoute(repo)}/patches/revisions/${encodeURIComponent(revision)}/diff${parts.length === 0 ? "" : `?${parts.join("&")}`}`
}

/** The patch a revision diff route came from (`?patch=<id>`), or null. */
export function diffPatchParam(search: string): EventId | null {
  for (const pair of search.replace(/^\?/, "").split("&")) {
    if (pair.startsWith("patch=") && /^[0-9a-f]{32}$/.test(pair.slice("patch=".length))) return pair.slice("patch=".length)
  }
  return null
}

/** What a patches section's URL tail after `revisions/` names: a revision's diff, or nothing Hub has. */
export function revisionView(tail: string): { kind: "diff"; revision: EventId } | null {
  const segments = tail.split("/").filter((segment) => segment.length > 0)
  if (segments[0] !== "revisions") return null
  if (segments.length === 3 && segments[2] === "diff" && /^[0-9a-f]{32}$/.test(segments[1])) return { kind: "diff", revision: segments[1] }
  return null
}

// --- Haxy's own patch URLs -------------------------------------------------------

/** A Haxy route's `key:value` parameter segments, percent-decoded; null when one is malformed or not allowed. */
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
 * The Hub route for a Haxy patch page path (as the TUI and Haxy's web pages
 * write them in Markdown), or null when `path` isn't one Hub has a page for:
 *
 * | Haxy (`<repo>` is `/<owner>:<name>`, empty in local mode) | Haxy Hub                                  |
 * | --------------------------------------------------------- | ----------------------------------------- |
 * | `<repo>/patches`, `<repo>/patches/open[/search:<s>]`      | `<hub repo>/patches?search=<s>`           |
 * | `<repo>/patches/closed\|merged[/search:<s>]`             | `<hub repo>/patches/closed\|merged?…`     |
 * | `<repo>/patches/labels[/search:<s>]`                      | `<hub repo>/patches/labels?…`             |
 * | `<repo>/patch:<id>[/search:<s>][/start:<n>]`, `…/description` | `<hub repo>/patches/<id>`             |
 * | `<repo>/patch:<id>/comment:<c>[/start:<n>]`               | `<hub repo>/patches/<id>/comments/<c>`    |
 * | `<repo>/diff/patchrev:<id>[/start:<n>][/path:<path>]`     | `<hub repo>/patches/revisions/<id>/diff[?path=<path>]` |
 * | `<repo>/patches/new`                                      | `<hub repo>/patches/new` (#18, branch-backed patches) |
 * | `<repo>/patch:<id>/edit`                                  | `<hub repo>/patches/<id>/edit` (#18)      |
 * | `<repo>/patches/drafts`                                   | `<hub repo>/patches/drafts`               |
 *
 * Parameter segments may come in any order before or after the view word, as
 * Haxy reads them; `start:` windows are dropped. Conflicts and the other
 * forms (`merge`, `publish`, `remove`, …) have no Hub page yet.
 */
export function hubPathForPatchPath(path: string, local = false): string | null {
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
  if (tab === "diff") {
    const [revision = "", ...tail] = rest
    const id = revision.startsWith("patchrev:") ? revision.slice("patchrev:".length) : ""
    if (!/^[0-9a-f]{32}$/.test(id)) return null
    // the path is the rest of the URL, slashes and all
    const pathAt = tail.findIndex((segment) => segment.startsWith("path:"))
    const params = pathAt === -1 ? tail : tail.slice(0, pathAt)
    if (params.some((segment) => !/^start:\d+$/.test(segment))) return null
    const filter = pathAt === -1 ? "" : tail.slice(pathAt).join("/").slice("path:".length)
    if (pathAt !== -1 && filter.length === 0) return null
    return revisionDiffRoute(repo, id, { path: pathSegments(canonicalPath(filter)).join("/") })
  }
  if (rest.some((segment) => segment.length === 0)) return null
  if (tab.startsWith("patch:")) {
    const id = tab.slice("patch:".length)
    if (!id) return null
    // a comment permalink opens the comment's own page (its reply window dropped)
    const comment = rest[0]?.startsWith("comment:") ? rest[0].slice("comment:".length) : null
    if (comment === "") return null
    const tail = comment !== null ? rest.slice(1) : rest
    const words = tail.filter((segment) => !segment.includes(":"))
    if (words.length > 1 || (words.length === 1 && (!["description", "edit"].includes(words[0]) || comment !== null))) return null
    if (routeParams(tail.filter((segment) => segment.includes(":")), ["search", "start"]) === null) return null
    if (comment !== null) return commentRoute(repo, "patches", id, comment)
    return words[0] === "edit" ? editThreadRoute(repo, "patches", id) : threadRoute(repo, "patches", id)
  }
  if (tab !== "patches") return null
  const words = rest.filter((segment) => !segment.includes(":"))
  if (words.length === 0) return rest.length === 0 ? threadsRoute(repo, "patches", patchStatuses, "open") : null
  const params = routeParams(rest.filter((segment) => segment.includes(":")), ["search"])
  if (words.length > 1 || params === null) return null
  const search = params.get("search")
  const [word] = words
  if (word === "labels") return threadLabelsRoute(repo, "patches", { search })
  if (word === "new") return rest.length === 1 ? newThreadRoute(repo, "patches") : null
  if (word === "drafts") return rest.length === 1 ? draftsRoute(repo) : null
  const status = patchStatuses.find((value) => value === word)
  return status === undefined ? null : threadsRoute(repo, "patches", patchStatuses, status, { search })
}
