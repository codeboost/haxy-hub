import type { APIRequestContext, PlaywrightWorkerArgs } from "@playwright/test"
import { alice, registerUser, type Account } from "./accounts"
import type { Backend } from "./backend"
import { divergeBranch, setPatchRole } from "./patches"
import { pushRepo } from "./push"
import { createRepo, signedIn } from "./repos"

/** A second account, for what someone other than a draft's author sees. */
export const bob: Account = { name: "bobby", email: "bobby@example.test", password: "battery staple horse" }

/**
 * On a server launched with `{ ssh: true }`: alice's public repository
 * `parser`, with `feature` one commit ahead of `main` and patches open to
 * anybody who can read it, and bob registered too. Returns request contexts
 * signed in as each.
 */
export async function draftsRepo(playwright: PlaywrightWorkerArgs["playwright"], backend: Backend, hubUrl: string) {
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const owner = await signedIn(playwright, backend, hubUrl, alice.name, alice.password)
  const other = await signedIn(playwright, backend, hubUrl, bob.name, bob.password)
  await createRepo(owner, backend, { name: "parser", access: "public" })
  await pushRepo(playwright, backend, hubUrl, alice, { owner: "alice", name: "parser" }, {
    files: { "README.md": "# parser\n" },
    history: (git) => { divergeBranch(git, "feature", [{ message: "Add the parser", files: { "src/parser.txt": "parse\n" } }]) },
  })
  const repo = { owner: "alice", name: "parser", access: "public" } as const
  await setPatchRole(owner, backend, repo, "anybody")
  return { owner, other, repo }
}

/**
 * Starts a draft with a new fork through Haxy's own new-patch form (no source
 * branch), as `context`'s user, and returns its id from the redirect to it.
 * `repoBase` is the repository's Haxy page path, `/<owner>:<name>`.
 */
export async function startForkDraft(context: APIRequestContext, backend: Backend, repoBase: string, draft: { title: string; target: string; labels?: string; description?: string }): Promise<string> {
  const response = await context.post(`${backend.origin}${repoBase}/patches/new`, {
    form: { title: draft.title, labels: draft.labels ?? "", description: draft.description ?? "", target_branch: draft.target },
    maxRedirects: 0,
  })
  const match = /\/patch:([0-9a-f]{32})$/.exec(response.headers().location ?? "")
  if (response.status() !== 303 || !match) throw new Error(`Starting "${draft.title}" failed: HTTP ${response.status()} ${response.headers().location}\n${backend.output()}`)
  return match[1]
}

/** The text of a page of Haxy's own web UI (the TUI's), as `context`'s user sees it. */
export async function tuiPage(context: APIRequestContext, backend: Backend, pagePath: string): Promise<string> {
  return (await context.get(`${backend.origin}${pagePath}`)).text()
}

/** Replaces a draft's fields through Haxy's own edit form, as another client (or another tab's TUI) would. */
export async function editForkDraft(context: APIRequestContext, backend: Backend, repoBase: string, id: string, draft: { title: string; target: string; labels?: string; description?: string }): Promise<void> {
  const response = await context.post(`${backend.origin}${repoBase}/patch:${id}/edit`, {
    form: { title: draft.title, labels: draft.labels ?? "", description: draft.description ?? "", target_branch: draft.target },
    maxRedirects: 0,
  })
  if (response.status() !== 303) throw new Error(`Editing draft ${id} failed: HTTP ${response.status()}\n${backend.output()}`)
}

/** Publishes a draft through Haxy's own publish form, as another client would. */
export async function publishForkDraft(context: APIRequestContext, backend: Backend, repoBase: string, id: string): Promise<void> {
  const response = await context.post(`${backend.origin}${repoBase}/patch:${id}/publish`, { maxRedirects: 0 })
  if (response.status() !== 303) throw new Error(`Publishing draft ${id} failed: HTTP ${response.status()}\n${backend.output()}`)
}
