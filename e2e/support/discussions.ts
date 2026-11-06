import type { APIRequestContext } from "@playwright/test"
import type { Backend } from "./backend"

/**
 * Discussions seeded through Haxy's own HTML form handlers (the paths the web
 * UI posts to; the TUI's discussion tab writes through the same shared
 * operations), and read back from Haxy's own server-rendered discussion pages
 * (the TUI's). `repoBase` is as for `support/issues.ts`: `/<owner>:<name>` on
 * a server, "" in local mode. On a server, `context` must be signed in as a
 * user who may write discussions.
 */

export type NewDiscussion = { title: string; labels?: string; description?: string }

async function post(context: APIRequestContext, backend: Backend, path: string, form: Record<string, string>) {
  const response = await context.post(`${backend.origin}${path}`, { form, maxRedirects: 0 })
  if (response.status() !== 303) throw new Error(`POST ${path} failed: HTTP ${response.status()} ${await response.text()}\n${backend.output()}`)
  return response
}

/** Opens a discussion and returns its id, from the redirect to it. */
export async function createDiscussion(context: APIRequestContext, backend: Backend, repoBase: string, discussion: NewDiscussion): Promise<string> {
  const response = await post(context, backend, `${repoBase}/discussions/new`, { title: discussion.title, labels: discussion.labels ?? "", description: discussion.description ?? "" })
  const match = /\/discuss:([0-9a-f]{32})$/.exec(response.headers().location ?? "")
  if (!match) throw new Error(`Creating "${discussion.title}" redirected to ${response.headers().location}`)
  return match[1]
}

/** Edits a discussion through Haxy's own edit form (which, like the TUI's, sends no revision). */
export async function editDiscussion(context: APIRequestContext, backend: Backend, repoBase: string, id: string, discussion: NewDiscussion): Promise<void> {
  await post(context, backend, `${repoBase}/discuss:${id}/edit`, { title: discussion.title, labels: discussion.labels ?? "", description: discussion.description ?? "" })
}

/** Removes a discussion through Haxy's own removal form. */
export async function removeDiscussion(context: APIRequestContext, backend: Backend, repoBase: string, id: string): Promise<void> {
  await post(context, backend, `${repoBase}/discuss:${id}/remove`, {})
}

/** Posts a comment on the discussion, or a reply to its comment `parent`; returns the new comment's id. */
export async function commentOnDiscussion(context: APIRequestContext, backend: Backend, repoBase: string, id: string, body: string, parent?: string): Promise<string> {
  const response = await post(context, backend, `${repoBase}/discuss:${id}${parent ? `/comment:${parent}` : ""}/new`, { body })
  const match = /\/comment:([0-9a-f]{32})$/.exec(response.headers().location ?? "")
  if (!match) throw new Error(`Commenting redirected to ${response.headers().location}`)
  return match[1]
}

type SettingsRepo = { owner: string; name: string; description?: string; access: "public" | "private" }

/**
 * Sets who may write in a server repository's discussions tab through its
 * settings form: anybody who can read it, its members (the write role), or
 * nobody (discussions off). The owner must be signed in.
 */
export async function setDiscussRole(context: APIRequestContext, backend: Backend, repo: SettingsRepo, role: "anybody" | "members" | "nobody"): Promise<void> {
  await post(context, backend, `/${repo.owner}:${repo.name}/repo/settings`, {
    name: repo.name,
    description: repo.description ?? "",
    access: repo.access,
    discuss_role: role,
    issue_role: "anybody",
    patch_role: "anybody",
  })
}

// --- what Haxy's own pages show -------------------------------------------------

function pageText(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/g, "")
}

/**
 * What Haxy's own discussions tab (its server-rendered TUI page) lists for a
 * search: the recent tab's count, the window's discussion ids in order (most
 * recently active first), and the next window's first discussion.
 */
export async function tuiDiscussions(backend: Backend, repoBase: string, search = "") {
  const path = `${repoBase}/discussions${search ? `/recent/search:${encodeURIComponent(search)}` : ""}`
  const response = await fetch(`${backend.origin}${path}`)
  if (response.status !== 200) throw new Error(`GET ${path}: HTTP ${response.status}`)
  const html = pageText(await response.text())
  const prefix = repoBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const count = new RegExp(`href="${prefix}/discussions[^"]*"[^>]*>(?:<span[^>]*>[^<]*</span>)?\\s*\\((\\d+)(\\+?)\\)`).exec(html)
  const ids: string[] = []
  let next: string | null = null
  for (const [, id, text] of html.matchAll(new RegExp(`<a [^>]*href="${prefix}/discuss:([0-9a-f]{32})(?:/search:[^"]*)?"[^>]*>([\\s\\S]*?)</a>`, "g"))) {
    if (text.includes("next →")) next = id
    else if (!text.includes("← previous") && !ids.includes(id)) ids.push(id)
  }
  if (next !== null && ids.includes(next)) ids.splice(ids.indexOf(next), 1)
  return { count: count ? { kind: count[2] ? "at_least" : "exact", value: Number(count[1]) } : null, ids, next }
}

/** The text of a discussion's own page in Haxy's web UI (the TUI's), without its scripts. */
export async function tuiDiscussionPage(backend: Backend, repoBase: string, id: string): Promise<string> {
  const response = await fetch(`${backend.origin}${repoBase}/discuss:${id}`)
  return pageText(await response.text())
}
