import { hubPathForIssuePath } from "@/lib/threads"

/**
 * Haxy's own page URLs (the TUI and its browser renderer, as written in
 * ABOUT.md and other Markdown) mapped to the matching Haxy Hub routes:
 *
 * | Haxy                                        | Haxy Hub                    |
 * | ------------------------------------------- | --------------------------- |
 * | `/`, `/home`                                | `/about`                    |
 * | `/home/users[/search:<s>][/start:<n>]`      | `/users?search=<s>`         |
 * | `/<name>`, `/<name>/repos[/search:<s>]...`  | `/users/<name>?search=<s>`  |
 * | `/<owner>:<name>/issues…`, `…/issue:<id>…`  | see `hubPathForIssuePath`   |
 *
 * `start:` windows are dropped: Hub pages use opaque cursors, which only the
 * backend can issue. Paths with no Hub equivalent yet come back unchanged.
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

/**
 * The Hub route for a Haxy page path, or the path unchanged when there is none.
 * `local`: the path comes from local mode, whose repository routes leave the repository out:
 * its root `/` is the repository (`/repo`), and it has no home, about or user pages, so
 * those paths stay as written.
 */
export function hubPathForHaxyPath(haxyPath: string, local = false): string {
  // Like the TUI, match on the path alone.
  const path = haxyPath.split(/[?#]/, 1)[0]
  const issue = hubPathForIssuePath(path, local); if (issue !== null) return issue
  // local Haxy's root is its repository; it has no home, about or user pages
  if (local) return path === "/" ? "/repo" : haxyPath
  if (path === "/" || path === "/home") return "/about"
  const [first = "", second, ...rest] = path.slice(1).split("/")
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
