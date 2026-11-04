import { hubPathForHaxyPath } from "@/lib/haxyPaths"

/**
 * Markdown as Haxy's own reader parses it (haxy's src/markdown.zig, a GFM
 * subset), so the browser shows the same structure as the TUI. Raw HTML never
 * reaches the page: the backend reduces it to text.
 */

export type MarkdownInline = {
  text: string
  bold: boolean
  italic: boolean
  strike: boolean
  code: boolean
  /** The destination as written, or null outside a link. Not yet checked for safety. */
  link: string | null
}

export type MarkdownItem = {
  /** null for a plain item, else whether its task box is checked. */
  task: boolean | null
  blocks: MarkdownBlock[]
}

export type MarkdownBlock =
  | { kind: "heading"; level: number; center: boolean; inlines: MarkdownInline[] }
  | { kind: "paragraph"; center: boolean; pre: boolean; inlines: MarkdownInline[] }
  | { kind: "code"; lines: string[] }
  | { kind: "quote"; blocks: MarkdownBlock[] }
  /** `start` is the first number of an ordered list (0 when unordered). */
  | { kind: "list"; ordered: boolean; start: number; items: MarkdownItem[] }
  | { kind: "rule" }
  /** Lines shown verbatim, such as tables. */
  | { kind: "raw"; lines: string[] }

export type LinkTarget =
  /** A web or mail link, opened as an ordinary external link. */
  | { kind: "external"; href: string }
  /** A page of this app (Haxy page paths are mapped to their Hub routes). */
  | { kind: "internal"; to: string }
  /** Not followable here: unsafe schemes, protocol-relative and relative links. */
  | { kind: "none" }

/**
 * Where a link outside any repository may lead, as the TUI decides for the
 * about page: http(s) and mailto links open as written, a leading `/` names a
 * page on this site (translated to its Hub route when there is one), and
 * everything else (javascript:, data:, `//host`,
 * relative paths) stays plain text.
 */
export function linkTarget(destination: string): LinkTarget {
  const lower = destination.toLowerCase()
  for (const scheme of ["http:", "https:", "mailto:"]) {
    if (lower.startsWith(scheme)) return { kind: "external", href: destination }
  }
  if (destination.startsWith("/") && !destination.startsWith("//")) return { kind: "internal", to: hubPathForHaxyPath(destination) }
  return { kind: "none" }
}
