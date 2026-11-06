import type { APIRequestContext, PlaywrightWorkerArgs } from "@playwright/test"
import { alice, registerUser, type Account } from "./accounts"
import type { Backend } from "./backend"
import { createBranchPatch, divergeBranch, setPatchRole } from "./patches"
import { pushRepo } from "./push"
import { createRepo, signedIn } from "./repos"

/**
 * Merging patches, seeded and driven through Haxy's own forms: a server
 * repository whose `feature` and `other` branches each add a file of their
 * own on top of `main`, with a patch from each into `main`.
 */

export const bob: Account = { name: "bobby", email: "bobby@example.test", password: "bobby's password" }

export type Reviewed = { revision: string; target_commit: string }

/** alice's public `parser`, bob registered too (both signed in), with patches open to anybody who can read it. */
export async function mergeRepo(playwright: PlaywrightWorkerArgs["playwright"], backend: Backend, hubUrl: string) {
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const owner = await signedIn(playwright, backend, hubUrl, alice.name, alice.password)
  const other = await signedIn(playwright, backend, hubUrl, bob.name, bob.password)
  await createRepo(owner, backend, { name: "parser", access: "public" })
  await pushRepo(playwright, backend, hubUrl, alice, { owner: "alice", name: "parser" }, {
    files: { "README.md": "# parser\n" },
    history: (git) => {
      divergeBranch(git, "feature", [{ message: "Add the parser", files: { "src/parser.txt": "parse\n" } }, { message: "Test the parser", files: { "src/parser.test.txt": "test\n" } }])
      divergeBranch(git, "other", [{ message: "Add the docs", files: { "docs.txt": "docs\n" } }])
    },
  })
  const repo = { owner: "alice", name: "parser", access: "public" } as const
  await setPatchRole(owner, backend, repo, "anybody")
  const feature = await createBranchPatch(owner, backend, "/alice:parser", { title: "Add a parser", source: "feature", target: "main" })
  const docs = await createBranchPatch(owner, backend, "/alice:parser", { title: "Add the docs", source: "other", target: "main" })
  return { owner, other, repo, feature, docs, base: "/api/v1/repos/alice/parser/patches" }
}

/**
 * Posts Haxy's own merge form (the TUI's merge page) for patch `id`, with
 * what its page showed; returns where Haxy redirected.
 */
export async function formMerge(context: APIRequestContext, backend: Backend, id: string, method: "source" | "squash", reviewed: Reviewed | null): Promise<string> {
  const query = reviewed ? `?${new URLSearchParams({ revision: reviewed.revision, target: reviewed.target_commit })}` : ""
  const path = `/alice:parser/patch:${id}/merge${method === "squash" ? "/squash" : ""}${query}`
  const response = await context.post(`${backend.origin}${path}`, { form: {}, maxRedirects: 0 })
  if (response.status() !== 303) throw new Error(`POST ${path} failed: HTTP ${response.status()} ${await response.text()}\n${backend.output()}`)
  return response.headers().location ?? ""
}

/** Haxy's own merge page for patch `id` as `context` sees it, without its scripts. */
export async function tuiMergePage(context: APIRequestContext, backend: Backend, id: string): Promise<string> {
  const response = await context.get(`${backend.origin}/alice:parser/patch:${id}/merge`)
  return (await response.text()).replace(/<script[\s\S]*?<\/script>/g, "")
}
