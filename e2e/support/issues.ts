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

/** Turns a server repository's issues off (or on) through its settings form; the owner must be signed in. */
export async function setIssuesEnabled(context: APIRequestContext, backend: Backend, repo: { owner: string; name: string; description?: string; access: "public" | "private" }, enabled: boolean): Promise<void> {
  await post(context, backend, `/${repo.owner}:${repo.name}/repo/settings`, {
    name: repo.name,
    description: repo.description ?? "",
    access: repo.access,
    discuss_role: "anybody",
    issue_role: enabled ? "anybody" : "nobody",
    patch_role: "anybody",
  })
}
