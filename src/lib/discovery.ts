/**
 * Discovery: the forge's about page, the user directory and an owner's
 * repositories. Server mode only; local mode answers `unsupported`.
 * Mirrors haxy's src/api/discovery.zig.
 */
import { getJson, type Page, type PageQuery, type RequestOptions } from "@/lib/api"
import type { MarkdownBlock } from "@/lib/markdown"

export type About = {
  /** The about page's leading level-1 heading, shown as its title; null when it has none. */
  title: string | null
  /** The rest of ABOUT.md, parsed by Haxy's Markdown reader. */
  blocks: MarkdownBlock[]
}

export type UserSummary = { name: string }

export type User = { name: string }

export type RepoAccess = "public" | "private"

export type RepoSummary = {
  name: string
  description: string
  access: RepoAccess
}

/** A name-prefix search plus the page to show. Empty values mean "none". */
export type ListQuery = PageQuery & { search?: string }

type Options = Pick<RequestOptions, "signal">

function withQuery(path: string, query: ListQuery): string {
  const params = new URLSearchParams()
  if (query.search) params.set("search", query.search)
  if (query.cursor) params.set("cursor", query.cursor)
  if (query.page_size !== undefined) params.set("page_size", String(query.page_size))
  const text = params.toString()
  return text ? `${path}?${text}` : path
}

export function getAbout(options: Options = {}): Promise<About> {
  return getJson<About>("/api/v1/about", options)
}

/** Users by name, narrowed to names starting with `search`. */
export function listUsers(query: ListQuery = {}, options: Options = {}): Promise<Page<UserSummary>> {
  return getJson<Page<UserSummary>>(withQuery("/api/v1/users", query), options)
}

export function getUser(name: string, options: Options = {}): Promise<User> {
  return getJson<User>(`/api/v1/users/${encodeURIComponent(name)}`, options)
}

/**
 * The owner's repositories the viewer may read: newest activity first, or by
 * name when searching. A page may hold fewer items than asked for (repositories
 * the viewer can't read are skipped), so follow `next_cursor`, not the length.
 */
export function listUserRepos(name: string, query: ListQuery = {}, options: Options = {}): Promise<Page<RepoSummary>> {
  return getJson<Page<RepoSummary>>(withQuery(`/api/v1/users/${encodeURIComponent(name)}/repos`, query), options)
}
