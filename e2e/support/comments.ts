import type { APIRequestContext } from "@playwright/test"
import type { Backend } from "./backend"

/**
 * Comments seeded through Haxy's own HTML form handlers (the paths the web UI
 * posts to; the TUI's comment forms write through the same shared
 * operations), and read back from Haxy's own server-rendered thread pages.
 * `repoBase` is as for `support/issues.ts`: `/<owner>:<name>` on a server, ""
 * in local mode. On a server, `context` must be signed in as a user who may
 * write in the thread's tab.
 */

/** Posts a comment on the issue, or a reply to its comment `parent`; returns the new comment's id, from the redirect to it. */
export async function postComment(context: APIRequestContext, backend: Backend, repoBase: string, issue: string, body: string, parent?: string): Promise<string> {
  const path = `${repoBase}/issue:${issue}${parent ? `/comment:${parent}` : ""}/new`
  const response = await context.post(`${backend.origin}${path}`, { form: { body }, maxRedirects: 0 })
  const match = /\/comment:([0-9a-f]{32})$/.exec(response.headers().location ?? "")
  if (response.status() !== 303 || !match) throw new Error(`POST ${path} failed: HTTP ${response.status()} ${response.headers().location ?? (await response.text())}\n${backend.output()}`)
  return match[1]
}

function pageText(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/g, "")
}

async function page(backend: Backend, path: string): Promise<string> {
  const response = await fetch(`${backend.origin}${path}`)
  if (response.status !== 200) throw new Error(`GET ${path}: HTTP ${response.status}`)
  return pageText(await response.text())
}

/** An issue's page in Haxy's web UI (the TUI's) at one of its comment windows (`start`, as the TUI's own links count). */
export function tuiThreadPage(backend: Backend, repoBase: string, issue: string, start = 0): Promise<string> {
  return page(backend, `${repoBase}/issue:${issue}${start ? `/start:${start}` : ""}`)
}

/** A comment's permalink page in Haxy's web UI (the TUI's): the comment and its replies. */
export function tuiCommentPage(backend: Backend, repoBase: string, issue: string, comment: string): Promise<string> {
  return page(backend, `${repoBase}/issue:${issue}/comment:${comment}`)
}

/** The comment ids a TUI page links permalinks to, in page order. */
export function tuiCommentIds(html: string, repoBase: string, issue: string): string[] {
  const prefix = `${repoBase}/issue:${issue}/comment:`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const ids: string[] = []
  for (const [, id] of html.matchAll(new RegExp(`href="${prefix}([0-9a-f]{32})"`, "g"))) if (!ids.includes(id)) ids.push(id)
  return ids
}

/** Replaces a comment's body through Haxy's own edit form (which, like the TUI's, sends no revision). */
export async function editCommentForm(context: APIRequestContext, backend: Backend, repoBase: string, issue: string, comment: string, body: string): Promise<void> {
  const path = `${repoBase}/issue:${issue}/comment:${comment}/edit`
  const response = await context.post(`${backend.origin}${path}`, { form: { body }, maxRedirects: 0 })
  if (response.status() !== 303) throw new Error(`POST ${path} failed: HTTP ${response.status()} ${await response.text()}`)
}
