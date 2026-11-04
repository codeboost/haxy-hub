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
