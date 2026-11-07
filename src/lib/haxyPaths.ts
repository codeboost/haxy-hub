import { canonicalPath, canonicalRef, refsRoute, repoRoute, type RepoLocator } from "@/lib/repo"
import { hubPathForEventsPath } from "@/lib/events"
import { hubPathForUndoPath } from "@/lib/undo"
import { hubPathForCommitPath } from "@/lib/commits"
import { hubPathForIssuePath, hubPathForThreadPath } from "@/lib/threads"
import { discussionPaths } from "@/lib/discussions"
import { hubPathForFindPath } from "@/lib/finder"
import { hubPathForPatchPath } from "@/lib/patches"
import { hubPathForConflictPath } from "@/lib/conflicts"
import { hubPathForForkPath } from "@/lib/forks"

/**
 * Haxy's own page URLs (the TUI and its browser renderer, as written in
 * ABOUT.md and other Markdown) mapped to the matching Haxy Hub routes. On a
 * server (`<repo>` is `<owner>:<name>`, and `<hub repo>` is `/repos/<owner>/<name>`):
 *
 * | Haxy                                                    | Haxy Hub                                 |
 * | ------------------------------------------------------- | ---------------------------------------- |
 * | `/`, `/home`                                            | `/about`                                 |
 * | `/home/users[/search:<s>][/start:<n>]`                  | `/users?search=<s>`                      |
 * | `/<name>`, `/<name>/repos[/search:<s>]...`              | `/users/<name>?search=<s>`               |
 * | `/<repo>`, `/<repo>/files`                              | `<hub repo>`                             |
 * | `/<repo>/files/<ref>[/line:<n>][/path:<path>]`          | `<hub repo>[/files/<path>]?ref=<id>[&line=<n>]` |
 * | `/<repo>/files/patchrev:<id>[/line:<n>][/path:<path>]`  | `<hub repo>[/files/<path>]?ref=revision:<id>[&line=<n>]` |
 * | `/<repo>/refs[/branch:<from>][/search:<s>]`             | `<hub repo>/branches?search=<s>`         |
 * | `/<repo>/refs/tag:<from>[/search:<s>]`                  | `<hub repo>/tags?search=<s>`             |
 * | `/<repo>/issues…`, `/<repo>/issue:<id>…`              | see `hubPathForIssuePath` (`@/lib/threads`) |
 * | `/<repo>/discussions…`, `/<repo>/discuss:<id>…`       | the same, by `discussionPaths` (`@/lib/discussions`) |
 * | `/<repo>/events…`, `/<repo>/event:<id>…`              | see `hubPathForEventsPath` (`@/lib/events`) |
 * | `/<repo>/files[/<ref>]/find:<s>…`                       | see `hubPathForFindPath` (`@/lib/finder`) |
 * | `/<repo>/commits…`                                      | see `hubPathForCommitPath` (`@/lib/commits`) |
 * | `/<repo>/patches…`, `/<repo>/patch:<id>…`, `/<repo>/diff/patchrev:<id>…` | see `hubPathForPatchPath` (`@/lib/patches`) |
 * | `/<repo>/issues/conflicts`, `/<repo>/issue:<id>/resolve` (and patches') | see `hubPathForConflictPath` (`@/lib/conflicts`) |
 * | `/<forker>:<name>+<id>…`, `/<name>/forks…`             | see `hubPathForForkPath` (`@/lib/forks`) |
 *
 * `<ref>` is `branch:<name>`, `tag:<name>` or `object:<oid>`, which become the
 * ref ids `branch:<name>`, `tag:<name>` and `commit:<oid>` with the name and
 * path re-encoded in Haxy's canonical form (docs/api-conventions.md, "Refs"
 * and "Repository paths"); a file's `line:` is its window's first line, as in
 * Hub. In local mode (`local`) Haxy's repository routes elide `/<repo>`: `/`
 * becomes `/repo` and issue, file-finder and commit routes are translated; local files and refs URLs
 * aren't yet, and home, about and user paths (which local mode lacks) stay as
 * written.
 *
 * `start:` and `from` windows are dropped: Hub pages use opaque cursors, which
 * only the backend can issue. Paths with no Hub equivalent yet (commit-range
 * diffs, patch drafts, …) come back unchanged.
 */

// Haxy's user name rule (event/User.zig validateName)
function isUserName(name: string): boolean {
  return /^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/.test(name) && name.length >= 4 && name.length <= 32 && name.toLowerCase() !== "home"
}

/** The `search:` value of a list URL's tail, or null when the tail holds anything else. */
function listSearch(segments: string[]): string | null {
  let search = ""
  for (const segment of segments) {
    if (/^start:\d+$/.test(segment)) continue
    if (!segment.startsWith("search:")) return null
    try {
      search = decodeURIComponent(segment.slice("search:".length))
    } catch {
      return null
    }
  }
  return search
}

function withSearch(path: string, search: string): string {
  return search ? `${path}?${new URLSearchParams({ search })}` : path
}

// Haxy's repository name rule (event/Repo.zig validateName)
function isRepoName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== "." && name !== ".."
}

const refKinds: Record<string, string> = { branch: "branch", tag: "tag", object: "commit", patchrev: "revision" }

/** A repository files route's `key:value` segments and trailing `path:`, as a Hub route; null when it has no equivalent. */
function filesRoute(repo: RepoLocator, segments: string[]): string | null {
  let ref: string | null = null
  let line = 0
  let index = 0
  for (; index < segments.length && !segments[index].startsWith("path:"); index++) {
    const segment = segments[index]
    const colon = segment.indexOf(":")
    const key = segment.slice(0, colon)
    const value = segment.slice(colon + 1)
    if (colon <= 0 || value.length === 0) return null
    if (key in refKinds) {
      if (ref !== null) return null
      ref = `${refKinds[key]}:${value}`
    } else if (key === "line" && /^\d+$/.test(value)) {
      line = Number(value)
    } else {
      return null
    }
  }
  // the path is the rest of the URL, slashes and all
  const rest = segments.slice(index).join("/")
  const path = rest.slice("path:".length)
  if (rest.length > 0 && path.length === 0) return null
  return repoRoute(repo, canonicalPath(path), ref === null ? null : canonicalRef(ref), line > 1 ? { line: String(line) } : {})
}

/** A repository route's tail after its identity, as a Hub route; null when it has no equivalent. */
function repoTailRoute(repo: RepoLocator, segments: string[]): string | null {
  const [tab, ...rest] = segments
  if (tab === undefined || tab === "") return rest.length === 0 ? repoRoute(repo) : null
  if (tab === "files") return filesRoute(repo, rest)
  if (tab === "refs") {
    const kind = rest.some((segment) => segment.startsWith("tag:")) ? "tag" : "branch"
    const search = listSearch(rest.filter((segment) => !/^(branch|tag):./.test(segment)))
    return search === null ? null : withSearch(refsRoute(repo, kind), search)
  }
  return null
}

/**
 * The Hub route for a Haxy page path, or the path unchanged when there is none.
 * `local`: the path comes from local mode, whose repository routes leave the repository out:
 * its root `/` is the repository (`/repo`), and it has no home, about or user pages, so
 * those paths stay as written.
 */
export function hubPathForHaxyPath(haxyPath: string, local = false): string {
  // Like the TUI, match on the path alone.
  const path = haxyPath.split(/[?#]/, 1)[0]
  // before the repository routes, whose `<owner>:<name>` a fork's `<forker>:<name>+<id>` resembles
  const fork = hubPathForForkPath(path, local); if (fork !== null) return fork
  const conflict = hubPathForConflictPath(path, local); if (conflict !== null) return conflict
  const issue = hubPathForIssuePath(path, local); if (issue !== null) return issue
  const discussion = hubPathForThreadPath(path, local, discussionPaths); if (discussion !== null) return discussion
  const events = hubPathForEventsPath(path, local); if (events !== null) return events
  const undo = hubPathForUndoPath(path, local); if (undo !== null) return undo
  const find = hubPathForFindPath(path, local); if (find !== null) return find
  const commit = hubPathForCommitPath(path, local); if (commit !== null) return commit
  const patch = hubPathForPatchPath(path, local); if (patch !== null) return patch
  // local Haxy's root is its repository; it has no home, about or user pages
  if (local) return path === "/" ? "/repo" : haxyPath
  if (path === "/" || path === "/home") return "/about"
  const [first = "", second, ...rest] = path.slice(1).split("/")
  const owner = first.slice(0, first.indexOf(":"))
  const name = first.slice(first.indexOf(":") + 1)
  if (first.includes(":") && isUserName(owner) && isRepoName(name)) {
    return repoTailRoute({ kind: "server", owner, name }, second === undefined ? [] : [second, ...rest]) ?? haxyPath
  }
  if (first === "home" && second === "users") {
    const search = listSearch(rest)
    return search === null ? haxyPath : withSearch("/users", search)
  }
  if (!isUserName(first)) return haxyPath
  const user = `/users/${encodeURIComponent(first)}`
  if (second === undefined) return user
  if (second === "repos") {
    const search = listSearch(rest)
    return search === null ? haxyPath : withSearch(user, search)
  }
  return haxyPath
}
