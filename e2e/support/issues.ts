import type { APIRequestContext } from "@playwright/test"
import type { Backend } from "./backend"

/**
 * Seeds issues through Haxy's own HTML form handlers, the same code paths the
 * web UI and the TUI's forms use. `repoBase` is the repository's Haxy page
 * path: `/<owner>:<name>` on a server, "" in local mode (whose routes elide
 * the repository). On a server, `context` must be signed in as a user who
 * may write issues; local mode has no accounts.
 */

export type NewIssue = { title: string; labels?: string; description?: string }

async function post(context: APIRequestContext, backend: Backend, path: string, form: Record<string, string>) {
  const response = await context.post(`${backend.origin}${path}`, { form, maxRedirects: 0 })
  if (response.status() !== 303) throw new Error(`POST ${path} failed: HTTP ${response.status()} ${await response.text()}\n${backend.output()}`)
  return response
}

/** Creates an issue and returns its id, from the redirect to it. */
export async function createIssue(context: APIRequestContext, backend: Backend, repoBase: string, issue: NewIssue): Promise<string> {
  const response = await post(context, backend, `${repoBase}/issues/new`, { title: issue.title, labels: issue.labels ?? "", description: issue.description ?? "" })
  const match = /\/issue:([0-9a-f]{32})$/.exec(response.headers().location ?? "")
  if (!match) throw new Error(`Creating "${issue.title}" redirected to ${response.headers().location}`)
  return match[1]
}

export async function closeIssue(context: APIRequestContext, backend: Backend, repoBase: string, id: string): Promise<void> {
  await post(context, backend, `${repoBase}/issue:${id}/close`, {})
}

/** Assigns an account name, or an email, to the issue. */
export async function assignIssue(context: APIRequestContext, backend: Backend, repoBase: string, id: string, assignee: string): Promise<void> {
  await post(context, backend, `${repoBase}/issue:${id}/assign`, { assignee })
}

type SettingsRepo = { owner: string; name: string; description?: string; access: "public" | "private" }

/** Turns a server repository's issues off (or on) through its settings form; the owner must be signed in. */
export async function setIssuesEnabled(context: APIRequestContext, backend: Backend, repo: SettingsRepo, enabled: boolean): Promise<void> {
  await setIssueRole(context, backend, repo, enabled ? "anybody" : "nobody")
}

/**
 * Sets who may write in a server repository's issues tab through its settings
 * form: anybody who can read it, its members (the write role), or nobody
 * (issues off). The owner must be signed in.
 */
export async function setIssueRole(context: APIRequestContext, backend: Backend, repo: SettingsRepo, role: "anybody" | "members" | "nobody"): Promise<void> {
  await post(context, backend, `/${repo.owner}:${repo.name}/repo/settings`, {
    name: repo.name,
    description: repo.description ?? "",
    access: repo.access,
    discuss_role: "anybody",
    issue_role: role,
    patch_role: "anybody",
  })
}

/** Removes an issue through Haxy's own removal form. */
export async function removeIssue(context: APIRequestContext, backend: Backend, repoBase: string, id: string): Promise<void> {
  await post(context, backend, `${repoBase}/issue:${id}/remove`, {})
}

/** Edits an issue through Haxy's own edit form. */
export async function editIssue(context: APIRequestContext, backend: Backend, repoBase: string, id: string, issue: NewIssue): Promise<void> {
  await post(context, backend, `${repoBase}/issue:${id}/edit`, { title: issue.title, labels: issue.labels ?? "", description: issue.description ?? "" })
}

// --- what Haxy's own pages show -------------------------------------------------

function pageText(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/g, "")
}

/**
 * The ids of the issues Haxy's own issues tab lists for `status` (its
 * server-rendered TUI page, first window only), in order. `repoBase` is as
 * for `createIssue`.
 */
export async function tuiIssueIds(backend: Backend, repoBase: string, status: "open" | "closed"): Promise<string[]> {
  const response = await fetch(`${backend.origin}${repoBase}/issues/${status}`)
  if (response.status !== 200) throw new Error(`GET ${repoBase}/issues/${status}: HTTP ${response.status}`)
  const html = pageText(await response.text())
  const ids: string[] = []
  const prefix = repoBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  for (const [, issue, text] of html.matchAll(new RegExp(`<a [^>]*href="${prefix}/issue:([0-9a-f]{32})(?:/search:[^"]*)?"[^>]*>([\\s\\S]*?)</a>`, "g"))) {
    if (!text.includes("next →") && !text.includes("← previous") && !ids.includes(issue)) ids.push(issue)
  }
  return ids
}

/** The text of an issue's own page in Haxy's web UI (the TUI's), without its scripts. */
export async function tuiIssuePage(backend: Backend, repoBase: string, id: string): Promise<string> {
  const response = await fetch(`${backend.origin}${repoBase}/issue:${id}`)
  return pageText(await response.text())
}
