/**
 * The indexed file finder: a repository's files whose names start with a
 * search, at a ref, from the file index Haxy keeps for a xit repository's
 * branches. Mirrors haxy's src/api/find.zig.
 */
import { getJson, type PageInfo, type PageQuery, type RequestOptions } from "@/lib/api"
import { apiBase, canonicalPath, canonicalRef, repoRoute, type NamedPath, type ReadRef, type RefId, type RepoLocator } from "@/lib/repo"

/** A found file: its name for display, and its whole encoded path. */
export type FoundFile = NamedPath

/**
 * What a find answers. Only a xit repository's branches are indexed: a tag,
 * commit or patch revision, or a git repository, is `unsupported` (`reason`
 * says which), and a branch whose latest commit no index covers is
 * `no_index`. Neither is an empty result.
 */
export type FindAnswer = { ref: ReadRef } & (
  | { kind: "indexed"; items: FoundFile[]; page: PageInfo }
  | { kind: "no_index"; reason: null }
  | { kind: "unsupported"; reason: "ref" | "repository" }
)

export type FindQuery = PageQuery & {
  /** The ref to search at; the default branch when absent. */
  ref?: RefId | null
  /** The start of the file names, matched exactly as typed (ASCII letters in either case). Empty matches nothing. */
  search?: string
}

type Options = Pick<RequestOptions, "signal">

export function findFiles(repo: RepoLocator, query: FindQuery = {}, options: Options = {}): Promise<FindAnswer> {
  const params = new URLSearchParams()
  if (query.search) params.set("search", query.search)
  if (query.cursor) params.set("cursor", query.cursor)
  if (query.page_size !== undefined) params.set("page_size", String(query.page_size))
  // the ref is already safe in a query string, and its bytes must survive as they are
  const text = [query.ref ? `ref=${canonicalRef(query.ref)}` : "", params.toString()].filter((part) => part.length > 0).join("&")
  return getJson<FindAnswer>(`${apiBase(repo)}/find${text ? `?${text}` : ""}`, options)
}

/**
 * The Hub route finding files in `repo` at `ref` (the default branch when
 * null): `/repos/<owner>/<name>/find[?ref=<id>][&search=…]`, `/repo/find…`
 * in local mode. `query` adds the list's `search` and `cursor`.
 */
export function findRoute(repo: RepoLocator, ref: RefId | null = null, query: Record<string, string> = {}): string {
  const parts = [ref ? `ref=${canonicalRef(ref)}` : "", new URLSearchParams(query).toString()].filter((part) => part.length > 0)
  return `${repoRoute(repo)}/find${parts.length === 0 ? "" : `?${parts.join("&")}`}`
}

const refKinds: Record<string, string> = { branch: "branch", tag: "tag", object: "commit" }

/**
 * Haxy's file-finder URLs as Hub routes, or null for any other path. `<repo>`
 * is `/<owner>:<name>` on a server and empty in local mode; the parameter
 * segments come in any order before `path:`:
 *
 * | Haxy | Haxy Hub |
 * | --- | --- |
 * | `<repo>/files[/<ref>]/find:<s>[/line:<n>]` | `<hub repo>/find?[ref=<id>&]search=<s>` |
 * | `<repo>/files[/<ref>]/find:<s>[/line:<n>]/path:<path>` | `<hub repo>/files/<path>[?ref=<id>][&line=<n>]`, the chosen result |
 *
 * `<ref>` is `branch:`, `tag:` or `object:`, as in `hubPathForHaxyPath`. A
 * search that isn't UTF-8 has no Hub form, so its URL stays as written.
 */
export function hubPathForFindPath(path: string, local = false): string | null {
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
  if (segments.shift() !== "files") return null
  const params = new Map<string, string>()
  let index = 0
  for (; index < segments.length && !segments[index].startsWith("path:"); index++) {
    const segment = segments[index]
    const colon = segment.indexOf(":")
    const key = segment.slice(0, colon)
    if (colon <= 0 || colon === segment.length - 1 || params.has(key)) return null
    params.set(key, segment.slice(colon + 1))
  }
  const find = params.get("find")
  if (find === undefined) return null
  const refs = [...params.keys()].filter((key) => key in refKinds)
  if (refs.length > 1 || [...params.keys()].some((key) => !(key in refKinds) && key !== "find" && key !== "line")) return null
  const line = params.get("line") ?? "0"
  if (!/^\d+$/.test(line)) return null
  const ref = refs.length === 0 ? null : canonicalRef(`${refKinds[refs[0]]}:${params.get(refs[0])}`)
  // the path is the rest of the URL, slashes and all
  const selected = segments.slice(index).join("/").slice("path:".length)
  if (selected.length > 0) return repoRoute(repo, canonicalPath(selected), ref, Number(line) > 1 ? { line: String(Number(line)) } : {})
  if (index < segments.length) return null
  let search: string
  try {
    search = decodeURIComponent(find)
  } catch {
    return null
  }
  return findRoute(repo, ref, { search })
}
