/**
 * A repository's overview and its files at the default branch. A server names
 * repositories by owner and name; local mode serves only the repository Haxy
 * opened. Mirrors haxy's src/api/repo.zig.
 */
import { getJson, type ObjectId, type Page, type PageQuery, type RequestOptions } from "@/lib/api"
import type { RepoAccess } from "@/lib/discovery"
import type { MarkdownBlock } from "@/lib/markdown"

/** Which repository a page shows. */
export type RepoLocator = { kind: "local" } | { kind: "server"; owner: string; name: string }

/** The sections (tabs) Haxy shows this viewer, in order. */
export type RepoSection = "files" | "commits" | "refs" | "discussions" | "issues" | "patches" | "events" | "undo" | "settings"

/** A command for working with the repository locally, built from the backend's own transport settings. */
export type GitCommand = { protocol: "http" | "ssh"; url: string; command: string }

export type RepoOverview = {
  /** null in local mode. */
  owner: string | null
  name: string
  description: string
  /** null in local mode. */
  access: RepoAccess | null
  /** The branch HEAD names, even before its first commit; null when HEAD is detached. */
  default_branch: string | null
  /** The default branch has no commit yet. */
  empty: boolean
  sections: RepoSection[]
  /** Empty in local mode, which has no remote. */
  clone: GitCommand[]
  /** For an empty repository the viewer may push to: how to point a local repository at it. */
  remote: GitCommand | null
}

/** The ref a files response was read at (always the default branch for now). */
export type ReadRef = { kind: "branch" | "tag" | "commit"; name: string | null; commit: ObjectId }

/**
 * A repository path as Haxy sends it. Git paths are bytes, not necessarily
 * UTF-8, so they travel percent-encoded (see "Repository paths" in
 * docs/api-conventions.md). Send it back and put it in Hub URLs unchanged;
 * show `name`s (or `displaySegment`) to people instead.
 */
export type EncodedPath = string

/** A path, and its last segment's name for display (ill-formed UTF-8 shown as U+FFFD). */
export type NamedPath = { name: string; path: EncodedPath }

export type DirItem = NamedPath & { kind: "dir" | "file" }

export type DirListing = Page<DirItem> & {
  ref: ReadRef
  /** Repository-relative, "" at the root. */
  path: EncodedPath
  kind: "dir"
  /** This directory's README, shown when it opens. */
  readme: NamedPath | null
}

export type FileContent =
  /** One window of the file's lines; `has_more` means the file continues at `next_line`. */
  | { kind: "text"; start_line: number; lines: string[]; total_lines: number; has_more: boolean; next_line: number | null }
  | { kind: "empty" }
  | { kind: "binary" }

export type FileView = {
  ref: ReadRef
  path: EncodedPath
  /** The file's name, for display. */
  name: string
  kind: "file"
  content: FileContent
  /** The file rendered as Haxy renders Markdown, when it does; otherwise null. */
  markdown: MarkdownBlock[] | null
}

export type FilesQuery = PageQuery & {
  path?: EncodedPath
  /** A file window's first line (1-based). */
  line?: number
}

type Options = Pick<RequestOptions, "signal">

function apiBase(repo: RepoLocator): string {
  return repo.kind === "local" ? "/api/v1/repo" : `/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
}

export function getRepo(repo: RepoLocator, options: Options = {}): Promise<RepoOverview> {
  return getJson<RepoOverview>(apiBase(repo), options)
}

/** A directory listing or a file window at `path`. */
export function getFiles(repo: RepoLocator, query: FilesQuery = {}, options: Options = {}): Promise<DirListing | FileView> {
  const params = new URLSearchParams()
  if (query.line !== undefined && query.line > 1) params.set("line", String(query.line))
  if (query.cursor) params.set("cursor", query.cursor)
  if (query.page_size !== undefined) params.set("page_size", String(query.page_size))
  // Already percent-encoded, so it goes in as is and the backend decodes it once.
  const path = query.path ? canonicalPath(query.path) : ""
  const text = [path ? `path=${path}` : "", params.toString()].filter((part) => part.length > 0).join("&")
  return getJson<DirListing | FileView>(`${apiBase(repo)}/files${text ? `?${text}` : ""}`, options)
}

// --- Encoded paths -------------------------------------------------------------

const utf8 = new TextEncoder()

/**
 * The bytes `text` stands for: each valid `%XX` escape is a byte, anything
 * else is its UTF-8. Decoding exactly once is what keeps a file literally
 * named `a%2Fb.txt` (sent as `a%252Fb.txt`) apart from `a/b.txt`.
 */
function percentBytes(text: string): number[] {
  const bytes: number[] = []
  let index = 0
  while (index < text.length) {
    const escape = text.slice(index + 1, index + 3)
    if (text[index] === "%" && /^[0-9a-fA-F]{2}$/.test(escape)) {
      bytes.push(parseInt(escape, 16))
      index += 3
      continue
    }
    const char = String.fromCodePoint(text.codePointAt(index) ?? 0)
    bytes.push(...utf8.encode(char))
    index += char.length
  }
  return bytes
}

function isUnreserved(byte: number): boolean {
  return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) ||
    byte === 0x2d || byte === 0x2e || byte === 0x5f || byte === 0x7e
}

/** Bytes written as Haxy writes paths: unreserved bytes and `/` as is, every other byte as `%XX`. */
function encodeBytes(bytes: number[]): EncodedPath {
  return bytes.map((byte) => (isUnreserved(byte) || byte === 0x2f ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)).join("")
}

/**
 * `text` (a path from a URL, as Haxy encoded it, as someone typed it or as a
 * browser escaped it) in Haxy's canonical encoding, naming the same bytes.
 */
export function canonicalPath(text: string): EncodedPath {
  return encodeBytes(percentBytes(text))
}

/** An encoded path segment's name for display, ill-formed UTF-8 shown as U+FFFD (as in Haxy's `name`s). */
export function displaySegment(segment: EncodedPath): string {
  return new TextDecoder().decode(Uint8Array.from(percentBytes(segment)))
}

// --- Hub routes ----------------------------------------------------------------

/** `path` split into its non-empty segments. */
export function pathSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0)
}

function repoBase(repo: RepoLocator): string {
  return repo.kind === "local" ? "/repo" : `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
}

/**
 * The Hub route showing `path` (an encoded directory or file path) in `repo`:
 * `/repos/<owner>/<name>[/files/<path>]` on a server, `/repo[/files/<path>]`
 * in local mode. The path goes in exactly as Haxy encoded it. A later ref
 * selection adds a query parameter, so these routes stay valid.
 */
export function repoRoute(repo: RepoLocator, path: EncodedPath = ""): string {
  const segments = pathSegments(path)
  return segments.length === 0 ? repoBase(repo) : `${repoBase(repo)}/files/${segments.join("/")}`
}

/**
 * The encoded path a Hub URL names, read from its pathname as the browser
 * holds it. The router decodes splat parameters, which would turn a literal
 * `%2F` in a file name into a separator, so the raw pathname is used.
 */
export function routePath(repo: RepoLocator, pathname: string): EncodedPath {
  // the base's segments, then "files"
  const skip = pathSegments(repoBase(repo)).length + 1
  return canonicalPath(pathSegments(pathname).slice(skip).join("/"))
}

/** `dir`/`name`, or `name` at the root. */
export function childPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

/** `path` without its last segment ("" for a single segment). */
export function parentPath(path: string): string {
  return pathSegments(path).slice(0, -1).join("/")
}

/**
 * Where a link in a repository file's Markdown leads, as the TUI's files tab
 * decides: http(s) and mailto links open as written; any other scheme and
 * `//host` links are not links; a path is a repository path (percent-decoded
 * once, to bytes), relative to the file's directory `dir` or, with a leading
 * `/`, to the root (its query and fragment are dropped); climbing above the
 * root is not a link. The path comes back encoded.
 */
export function repoLinkPath(destination: string, dir: EncodedPath): { kind: "external"; href: string } | { kind: "repo"; path: EncodedPath } | { kind: "none" } {
  const lower = destination.toLowerCase()
  for (const scheme of ["http:", "https:", "mailto:"]) {
    if (lower.startsWith(scheme)) return { kind: "external", href: destination }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(destination) || destination.startsWith("//")) return { kind: "none" }
  const end = destination.search(/[?#]/)
  const raw = end === -1 ? destination : destination.slice(0, end)
  if (raw.length === 0) return { kind: "none" }
  // in canonical form every separator byte is a literal "/", as in the TUI's decoded path
  const decoded = canonicalPath(raw)
  const segments = decoded.startsWith("/") ? [] : pathSegments(dir)
  for (const part of pathSegments(decoded)) {
    if (part === ".") continue
    if (part === "..") {
      if (segments.pop() === undefined) return { kind: "none" }
      continue
    }
    segments.push(part)
  }
  return { kind: "repo", path: segments.join("/") }
}
