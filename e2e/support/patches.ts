import type { APIRequestContext } from "@playwright/test"
import type { Backend } from "./backend"
import type { Git } from "./push"
import { addCommits, type FixtureCommit } from "./history"

/**
 * Seeds branch-backed patches through Haxy's own HTML form handlers, the
 * same code paths the web UI and the TUI's patch form use. `repoBase` is the
 * repository's Haxy page path: `/<owner>:<name>` on a server, "" in local
 * mode. On a server, `context` must be signed in as a user who may write
 * patches; local mode has no accounts.
 */

export type NewBranchPatch = { title: string; source: string; target: string; labels?: string; description?: string }

async function post(context: APIRequestContext, backend: Backend, path: string, form: Record<string, string>) {
  const response = await context.post(`${backend.origin}${path}`, { form, maxRedirects: 0 })
  if (response.status() !== 303) throw new Error(`POST ${path} failed: HTTP ${response.status()} ${await response.text()}\n${backend.output()}`)
  return response
}

/** Creates a patch from `source` into `target` and returns its id, from the redirect to it. */
export async function createBranchPatch(context: APIRequestContext, backend: Backend, repoBase: string, patch: NewBranchPatch): Promise<string> {
  const response = await post(context, backend, `${repoBase}/patches/new`, {
    title: patch.title,
    labels: patch.labels ?? "",
    description: patch.description ?? "",
    target_branch: patch.target,
    source_branch: patch.source,
  })
  const match = /\/patch:([0-9a-f]{32})$/.exec(response.headers().location ?? "")
  if (!match) throw new Error(`Creating "${patch.title}" redirected to ${response.headers().location}`)
  return match[1]
}

type SettingsRepo = { owner: string; name: string; description?: string; access: "public" | "private" }

/**
 * Sets who may write in a server repository's patches tab through its
 * settings form (a new repository has patches off); discussions and issues
 * stay open to anybody who can read it. The owner must be signed in.
 */
export async function setPatchRole(context: APIRequestContext, backend: Backend, repo: SettingsRepo, role: "anybody" | "members" | "nobody"): Promise<void> {
  await post(context, backend, `/${repo.owner}:${repo.name}/repo/settings`, {
    name: repo.name,
    description: repo.description ?? "",
    access: repo.access,
    discuss_role: "anybody",
    issue_role: "anybody",
    patch_role: role,
  })
}

export async function closePatch(context: APIRequestContext, backend: Backend, repoBase: string, id: string): Promise<void> {
  await post(context, backend, `${repoBase}/patch:${id}/close`, {})
}

/**
 * Builds a branch that forked off `main` and a `main` that moved on since,
 * with `git` in a repository whose `main` is checked out: `branch` gets
 * `ahead` on top of `main` as it is now, then `main` gets `behind`. Both are
 * built in the index alone (the work tree is never touched), and `main` is
 * left checked out. Returns the commit ids of each.
 */
export function divergeBranch(git: Git, branch: string, ahead: FixtureCommit[], behind: FixtureCommit[] = []): { base: string; branch: string[]; main: string[] } {
  const base = git(["rev-parse", "main"])
  git(["branch", branch, "main"])
  git(["symbolic-ref", "HEAD", `refs/heads/${branch}`])
  const onBranch = addCommits(git, ahead)
  git(["symbolic-ref", "HEAD", "refs/heads/main"])
  git(["read-tree", "main"])
  const onMain = addCommits(git, behind)
  return { base, branch: onBranch, main: onMain }
}

// --- what Haxy's own pages show -------------------------------------------------

function pageText(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/g, "")
}

/**
 * What the TUI's patches tab shows for `status` (its server-rendered page):
 * its open, closed and merged tab counts, and the first window's patch ids
 * in order. `repoBase` is as for `createBranchPatch`.
 */
export async function tuiPatches(backend: Backend, repoBase: string, status: "open" | "closed" | "merged") {
  const path = `${repoBase}/patches/${status}`
  const response = await fetch(`${backend.origin}${path}`)
  if (response.status !== 200) throw new Error(`GET ${path}: HTTP ${response.status}`)
  const html = pageText(await response.text())
  const prefix = repoBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const count = (tab: string) => {
    const match = new RegExp(`href="${prefix}/patches/${tab}[^"]*"[^>]*>(?:<span[^>]*>[^<]*</span>)?\\s*\\((\\d+)(\\+?)\\)`).exec(html)
    if (!match) throw new Error(`no ${tab} tab count on ${path}`)
    return { kind: match[2] ? "at_least" : "exact", value: Number(match[1]) }
  }
  const ids: string[] = []
  for (const [, patch, text] of html.matchAll(new RegExp(`<a [^>]*href="${prefix}/patch:([0-9a-f]{32})(?:/search:[^"]*)?"[^>]*>([\\s\\S]*?)</a>`, "g"))) {
    if (!text.includes("next →") && !text.includes("← previous") && !ids.includes(patch)) ids.push(patch)
  }
  return { counts: { open: count("open"), closed: count("closed"), merged: count("merged") }, ids }
}
