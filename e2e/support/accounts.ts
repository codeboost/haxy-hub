import type { APIRequestContext, Page } from "@playwright/test"
import type { Backend } from "./backend"

export type Account = { name: string; email: string; password: string }

/** A registered user's credentials; each test gets a fresh server, so names never collide. */
export const alice: Account = { name: "alice", email: "alice@example.test", password: "correct horse battery" }

/**
 * Registers `account` through Haxy's own sign-up form handler (`POST /user/new`),
 * the same code path a person uses in the web UI. It talks to the backend
 * directly, as fixture setup, and discards the session that sign-up logs in.
 */
export async function registerUser(backend: Backend, account: Account): Promise<void> {
  const response = await fetch(`${backend.origin}/user/new`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name: account.name, email: account.email, password: account.password, password_again: account.password }),
    redirect: "manual",
  })
  // success redirects to the new user's page; a failure redirects back to the form
  const location = response.headers.get("location")
  if (response.status !== 303 || location !== `/${account.name}`) {
    throw new Error(`Registering ${account.name} failed: HTTP ${response.status}, location ${location}\n${backend.output()}`)
  }
}

/** The CSRF header name Haxy requires on every state-changing /api/ request. */
export const csrfHeader = "X-Haxy-CSRF"

/**
 * Fetches this request context's CSRF token through the hub, the way the app
 * does (the HttpOnly nonce cookie it is bound to lands in the context's jar),
 * and returns the headers a same-origin browser write would carry.
 */
export async function writeHeaders(request: APIRequestContext, hubUrl: string): Promise<Record<string, string>> {
  const response = await request.get(`${hubUrl}/api/v1/session`)
  if (!response.ok()) throw new Error(`GET /api/v1/session failed: HTTP ${response.status()}`)
  const body = (await response.json()) as { csrf_token: string }
  return { [csrfHeader]: body.csrf_token, Origin: hubUrl }
}

/** Logs out through the header's user menu. */
export async function logOutFromHeader(page: Page): Promise<void> {
  await page.getByRole("banner").getByRole("button", { name: /^Signed in as / }).click()
  await page.getByRole("menuitem", { name: "Log out" }).click()
}
