import type { APIRequestContext, PlaywrightWorkerArgs } from "@playwright/test"
import type { Backend } from "./backend"

/**
 * A request context signed in as `username` through Haxy's own login form.
 * Cookies ignore ports, so the session cookie the backend sets also reaches
 * it through the hub's proxy at `hubUrl`.
 */
export async function signedIn(playwright: PlaywrightWorkerArgs["playwright"], backend: Backend, hubUrl: string, username: string, password: string): Promise<APIRequestContext> {
  const context = await playwright.request.newContext({ baseURL: hubUrl })
  const login = await context.post(`${backend.origin}/login`, { form: { username, password }, maxRedirects: 0 })
  if (login.status() !== 303) throw new Error(`Signing in as ${username} failed: HTTP ${login.status()}`)
  return context
}

export type NewRepo = { name: string; description?: string; access: "public" | "private" }

/**
 * Creates a repository (without commits) for the user `context` is signed in
 * as, through Haxy's own new-repo form handler (`POST /repo/new`).
 */
export async function createRepo(context: APIRequestContext, backend: Backend, repo: NewRepo): Promise<void> {
  const response = await context.post(`${backend.origin}/repo/new`, {
    form: { name: repo.name, description: repo.description ?? "", hash: "sha1", access: repo.access, copy: "" },
    maxRedirects: 0,
  })
  if (response.status() !== 303) throw new Error(`Creating ${repo.name} failed: HTTP ${response.status()}\n${backend.output()}`)
}

async function postMembers(context: APIRequestContext, backend: Backend, path: string, form?: Record<string, string>) {
  const response = await context.post(`${backend.origin}${path}`, { form, maxRedirects: 0 })
  if (response.status() !== 303) throw new Error(`POST ${path} failed: HTTP ${response.status()}\n${backend.output()}`)
}

/** Adds `user` as a member (the write role) through the repository's members form; an owner must be signed in. */
export async function grantMember(context: APIRequestContext, backend: Backend, repo: { owner: string; name: string }, user: string): Promise<void> {
  await postMembers(context, backend, `/${repo.owner}:${repo.name}/repo/members/grant`, { name: user })
}

/** Removes `user`'s role through the repository's members form; an owner must be signed in. */
export async function revokeMember(context: APIRequestContext, backend: Backend, repo: { owner: string; name: string }, user: string): Promise<void> {
  await postMembers(context, backend, `/${repo.owner}:${repo.name}/repo/members/user:${encodeURIComponent(user)}/revoke`)
}
