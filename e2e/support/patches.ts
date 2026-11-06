import { expect, type APIRequestContext, type Locator, type PlaywrightWorkerArgs } from "@playwright/test"
import type { Account } from "./accounts"
import type { Backend } from "./backend"
import { pushRepo, type Git } from "./push"
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

/** Posts a comment on the patch through Haxy's own comment form; returns the new comment's id. */
export async function commentOnPatch(context: APIRequestContext, backend: Backend, repoBase: string, id: string, body: string): Promise<string> {
  const response = await post(context, backend, `${repoBase}/patch:${id}/new`, { body })
  const match = /\/comment:([0-9a-f]{32})$/.exec(response.headers().location ?? "")
  if (!match) throw new Error(`Commenting redirected to ${response.headers().location}`)
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

/** Replaces the patch's fields and target through Haxy's own edit form, as another client would. */
export async function editPatch(context: APIRequestContext, backend: Backend, repoBase: string, id: string, patch: Omit<NewBranchPatch, "source">): Promise<void> {
  await post(context, backend, `${repoBase}/patch:${id}/edit`, { title: patch.title, labels: patch.labels ?? "", description: patch.description ?? "", target_branch: patch.target })
}

/** Removes the patch through Haxy's own remove form. */
export async function removePatch(context: APIRequestContext, backend: Backend, repoBase: string, id: string): Promise<void> {
  await post(context, backend, `${repoBase}/patch:${id}/remove`, {})
}

export async function closePatch(context: APIRequestContext, backend: Backend, repoBase: string, id: string): Promise<void> {
  await post(context, backend, `${repoBase}/patch:${id}/close`, {})
}

/**
 * On a server (launched with `{ ssh: true }`): pushes `account`'s existing,
 * empty repository `name` with a `feature` branch one commit ahead of `main`,
 * opens its patches tab to anybody who can read it, and opens a patch from
 * `feature` into `main` as `account` (`context` signed in as them). Returns
 * the patch's id.
 */
export async function pushedPatch(playwright: PlaywrightWorkerArgs["playwright"], backend: Backend, hubUrl: string, account: Account, context: APIRequestContext, name: string, title: string): Promise<string> {
  await pushRepo(playwright, backend, hubUrl, account, { owner: account.name, name }, {
    files: { "README.md": `# ${name}\n` },
    history: (git) => { divergeBranch(git, "feature", [{ message: "Add the feature", files: { "feature.txt": "new\n" } }]) },
  })
  await setPatchRole(context, backend, { owner: account.name, name, access: "public" }, "anybody")
  return createBranchPatch(context, backend, `/${account.name}:${name}`, { title, source: "feature", target: "main" })
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

// --- Hub's branch pickers ---------------------------------------------------------

/** A patch form's branch picker ("Source branch", "Target branch"): a text field that searches Haxy's branches. */
export function branchPicker(form: Locator, label: string): Locator {
  return form.getByRole("combobox", { name: label })
}

/** Types `search` into a patch form's branch picker and picks the branch listed as `option`. */
export async function chooseBranch(form: Locator, label: string, search: string, option: string): Promise<void> {
  const picker = branchPicker(form, label)
  await picker.click()
  await picker.fill(search)
  await form.getByRole("listbox", { name: label }).getByRole("option", { name: option, exact: true }).click()
  await expect(picker).toHaveValue(option.replace(/ \(.*\)$/, ""))
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

/** The text of a patch's own page in Haxy's web UI (the TUI's), without its scripts. */
export async function tuiPatchPage(backend: Backend, repoBase: string, id: string): Promise<string> {
  const response = await fetch(`${backend.origin}${repoBase}/patch:${id}`)
  return pageText(await response.text())
}

/** The text of a patch's edit form in Haxy's web UI (the TUI's), whose target field holds the patch's target branch. */
export async function tuiPatchEditPage(backend: Backend, repoBase: string, id: string): Promise<string> {
  const response = await fetch(`${backend.origin}${repoBase}/patch:${id}/edit`)
  return pageText(await response.text())
}
