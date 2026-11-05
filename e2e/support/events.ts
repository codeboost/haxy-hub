import type { APIRequestContext } from "@playwright/test"
import type { Backend } from "./backend"

/**
 * Event fixtures beside `support/issues.ts`, through Haxy's own HTML form
 * handlers, and readers of what Haxy's own events and undo tabs (their
 * server-rendered TUI pages) show, to compare the API with. `repoBase` is
 * the repository's Haxy page path: `/<owner>:<name>` on a server, "" in
 * local mode.
 */

async function post(context: APIRequestContext, backend: Backend, path: string, form: Record<string, string>) {
  const response = await context.post(`${backend.origin}${path}`, { form, maxRedirects: 0 })
  if (response.status() !== 303) throw new Error(`POST ${path} failed: HTTP ${response.status()} ${await response.text()}\n${backend.output()}`)
  return response
}

/** Removes an issue through its remove form. */
export async function removeIssue(context: APIRequestContext, backend: Backend, repoBase: string, id: string): Promise<void> {
  await post(context, backend, `${repoBase}/issue:${id}/remove`, {})
}

/** Comments on an issue and returns the comment's id, from the redirect to it. */
export async function commentOnIssue(context: APIRequestContext, backend: Backend, repoBase: string, issue: string, body: string): Promise<string> {
  const response = await post(context, backend, `${repoBase}/issue:${issue}/new`, { body })
  const match = /\/comment:([0-9a-f]{32})$/.exec(response.headers().location ?? "")
  if (!match) throw new Error(`Commenting on ${issue} redirected to ${response.headers().location}`)
  return match[1]
}

async function page(backend: Backend, path: string, context?: APIRequestContext): Promise<string> {
  const url = `${backend.origin}${path}`
  const response = context ? await context.get(url) : await fetch(url)
  const status = typeof response.status === "function" ? response.status() : response.status
  if (status !== 200) throw new Error(`GET ${path}: HTTP ${status}`)
  return (await response.text()).replace(/<script[\s\S]*?<\/script>/g, "")
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * What the TUI's events tab shows for `view` (or a transaction's, with
 * `moment`): both tab counts, the window's event ids in order, and the
 * first event of the next window (its "next →" row). `start` roots the
 * window at an event, as that row's link does.
 */
export async function tuiEvents(context: APIRequestContext, backend: Backend, repoBase: string, view: "active" | "removed", options: { moment?: string; start?: { kind: string; id: string } } = {}) {
  const moment = options.moment ? `/moment:${options.moment}` : ""
  const path = options.start ? `${repoBase}/event:${options.start.id}/kind:${options.start.kind}${moment}` : `${repoBase}/events/${view}${moment}`
  const html = await page(backend, path, context)
  const count = (tab: string) => {
    // the shown view's tab links to the page itself
    const href = tab === view ? path : `${repoBase}/events/${tab}${moment}`
    const match = new RegExp(`href="${escape(href)}"[^>]*>(?:<span[^>]*>[^<]*</span>)?\\s*\\((\\d+)\\)`).exec(html)
    if (!match) throw new Error(`no ${tab} tab count on ${path}`)
    return { kind: "exact", value: Number(match[1]) }
  }
  const ids: string[] = []
  let next: string | null = null
  for (const [, id, kind, text] of html.matchAll(new RegExp(`<a [^>]*href="${escape(repoBase)}/event:([0-9a-f]{32})/kind:(\\w+)${escape(moment)}"[^>]*>([\\s\\S]*?)</a>`, "g"))) {
    if (text.includes("next →")) next = `${kind}:${id}`
    else if (!ids.includes(id)) ids.push(id)
  }
  if (next !== null) {
    const nextId = next.slice(next.indexOf(":") + 1)
    if (ids.includes(nextId)) ids.splice(ids.indexOf(nextId), 1)
  }
  return { counts: { active: count("active"), removed: count("removed") }, ids, next }
}

/**
 * The newest `limit` transactions of the TUI's undo tab whose detail links to
 * the events they wrote ("view events"), newest first: their history indices.
 */
export async function tuiEventTransactions(context: APIRequestContext, backend: Backend, repoBase: string, limit = 3): Promise<string[]> {
  const html = await page(backend, `${repoBase}/undo`, context)
  const rows: string[] = []
  for (const [, index] of html.matchAll(new RegExp(`href="${escape(repoBase)}/undo/(\\d+)"`, "g"))) {
    if (!rows.includes(index)) rows.push(index)
  }
  const indices: string[] = []
  for (const index of rows) {
    if (indices.length === limit) break
    const detail = await page(backend, `${repoBase}/undo/${index}`, context)
    if (detail.includes(`href="${repoBase}/events/active/moment:${index}"`)) indices.push(index)
  }
  return indices
}

/** Opens a discussion and returns its id, from the redirect to it. */
export async function createDiscussion(context: APIRequestContext, backend: Backend, repoBase: string, discussion: { title: string; description?: string }): Promise<string> {
  const response = await post(context, backend, `${repoBase}/discussions/new`, { title: discussion.title, labels: "", description: discussion.description ?? "" })
  const match = /\/discuss:([0-9a-f]{32})$/.exec(response.headers().location ?? "")
  if (!match) throw new Error(`Opening "${discussion.title}" redirected to ${response.headers().location}`)
  return match[1]
}
