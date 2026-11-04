import { request as playwrightRequest, type APIRequestContext, type Page } from "@playwright/test"
import { alice, registerUser, writeHeaders, type Account } from "./support/accounts"
import type { Backend } from "./support/backend"
import { expect, test } from "./support/fixtures"

// Issue #30: a write never lands under a different signed-in user. Every
// route that starts, replaces or ends a session — Haxy's own HTML forms as
// well as the JSON API — rotates the browser's CSRF nonce, so a token issued
// before is refused; every API write may name the viewer it is for in
// `X-Haxy-Viewer`; and Haxy Hub binds each write to the viewer it was issued
// for, so a stale tab never replays a write as someone else. See "Security
// notes" in docs/api-conventions.md.

// bobby shares alice's password, so a password change or deletion meant for
// alice would also pass bobby's checks if it ever reached his account
const bob: Account = { name: "bobby", email: "bobby@example.test", password: alice.password }

const header = (page: Page) => page.getByRole("banner")

const csrfRefusal = { error: { code: "csrf", message: expect.stringMatching(/\S/) } }

async function errorCode(response: { json(): Promise<unknown> }): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code
}

/** Who `context` is signed in as, read through the hub. */
async function viewerOf(context: APIRequestContext, hubUrl: string): Promise<string | null> {
  const body = (await (await context.get(`${hubUrl}/api/v1/session`)).json()) as { viewer: { name: string } | null }
  return body.viewer?.name ?? null
}

/** Posts one of Haxy's own HTML forms the way a non-browser client does (no Origin). */
async function postForm(context: APIRequestContext, backend: Backend, path: string, form: Record<string, string>) {
  const response = await context.post(`${backend.origin}${path}`, { form, maxRedirects: 0 })
  expect(response.status(), path).toBe(303)
  // the form answer replaces the browser's CSRF nonce
  expect(response.headers()["set-cookie"], path).toMatch(/haxy_csrf=[0-9a-f]{32};[^\n]*HttpOnly/)
  return response
}

/** Whether `account` can log in with its password, in a fresh browser. */
async function canLogIn(hubUrl: string, account: Account, password = account.password): Promise<boolean> {
  const context = await playwrightRequest.newContext()
  try {
    const response = await context.post(`${hubUrl}/api/v1/session`, {
      headers: await writeHeaders(context, hubUrl),
      data: { username: account.name, password },
    })
    return response.status() === 200
  } finally {
    await context.dispose()
  }
}

// --- the nonce rotates whenever an HTML form changes the session ------------

test("a CSRF token from before an HTML login is refused, and changes nothing", async ({ request, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  const before = { ...(await writeHeaders(request, hub.url)), "Content-Type": "application/json" }

  await postForm(request, backend, "/home/user/login", { username: alice.name, password: alice.password })
  expect(await viewerOf(request, hub.url)).toBe(alice.name)

  const stale = await request.put(`${hub.url}/api/v1/account/email`, { headers: before, data: { email: "stale@example.test" } })
  expect(stale.status()).toBe(403)
  expect(await stale.json()).toEqual(csrfRefusal)
  expect(await (await request.get(`${hub.url}/api/v1/account`)).json()).toEqual({ name: alice.name, email: alice.email })

  // a token read after the login works
  const fresh = await request.put(`${hub.url}/api/v1/account/email`, {
    headers: { ...(await writeHeaders(request, hub.url)), "Content-Type": "application/json" },
    data: { email: "fresh@example.test" },
  })
  expect(fresh.status()).toBe(200)
})

test("a CSRF token from before an HTML logout is refused", async ({ request, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  await postForm(request, backend, "/home/user/login", { username: alice.name, password: alice.password })
  const before = await writeHeaders(request, hub.url)

  await postForm(request, backend, "/home/user/logout", {})
  expect(await viewerOf(request, hub.url)).toBeNull()

  const stale = await request.post(`${hub.url}/api/v1/session`, { headers: before, data: { username: alice.name, password: alice.password } })
  expect(stale.status()).toBe(403)
  expect(await stale.json()).toEqual(csrfRefusal)
  expect(await viewerOf(request, hub.url)).toBeNull()
})

test("a CSRF token from before an HTML sign-up is refused", async ({ request, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const before = { ...(await writeHeaders(request, hub.url)), "Content-Type": "application/json" }

  await postForm(request, backend, "/home/user/new", { name: alice.name, email: alice.email, password: alice.password, password_again: alice.password })
  expect(await viewerOf(request, hub.url)).toBe(alice.name)

  const stale = await request.put(`${hub.url}/api/v1/account/email`, { headers: before, data: { email: "stale@example.test" } })
  expect(stale.status()).toBe(403)
  expect(await stale.json()).toEqual(csrfRefusal)
  expect(await (await request.get(`${hub.url}/api/v1/account`)).json()).toEqual({ name: alice.name, email: alice.email })
})

test("a CSRF token from before an HTML account deletion is refused", async ({ request, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  await postForm(request, backend, "/home/user/login", { username: alice.name, password: alice.password })
  const before = await writeHeaders(request, hub.url)

  await postForm(request, backend, "/home/user/delete/delete", { confirm: alice.name, password: alice.password })
  expect(await viewerOf(request, hub.url)).toBeNull()

  const stale = await request.post(`${hub.url}/api/v1/account`, {
    headers: before,
    data: { name: "mallory", email: "mallory@example.test", password: "x", password_again: "x" },
  })
  expect(stale.status()).toBe(403)
  expect(await stale.json()).toEqual(csrfRefusal)
  expect(await viewerOf(request, hub.url)).toBeNull()
})

// --- every API write may name its viewer ------------------------------------

test("any API write naming someone other than the signed-in user is refused before routing", async ({ request, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  await postForm(request, backend, "/home/user/login", { username: alice.name, password: alice.password })
  const headers = { ...(await writeHeaders(request, hub.url)), "Content-Type": "application/json" }
  const forBob = { ...headers, "X-Haxy-Viewer": bob.name }

  // checked once in the shared guard, so it covers every write, whatever route it names
  for (const [method, path] of [["POST", "/api/v1/no-such-route"], ["PUT", "/api/v1/account/email"], ["DELETE", "/api/v1/session"]] as const) {
    const response = await request.fetch(`${hub.url}${path}`, { method, headers: forBob, data: { email: "bob@example.test" } })
    expect(response.status(), `${method} ${path}`).toBe(409)
    const body = (await response.json()) as { error: { code: string; field_errors?: unknown } }
    expect(body.error.code).toBe("conflict")
    expect(body.error.field_errors).toBeUndefined()
  }
  expect(await viewerOf(request, hub.url)).toBe(alice.name)
  expect(await (await request.get(`${hub.url}/api/v1/account`)).json()).toEqual({ name: alice.name, email: alice.email })

  // naming the signed-in user, or nobody, reaches the route
  const named = await request.fetch(`${hub.url}/api/v1/no-such-route`, { method: "POST", headers: { ...headers, "X-Haxy-Viewer": alice.name } })
  expect(named.status()).toBe(404)
  const unnamed = await request.fetch(`${hub.url}/api/v1/no-such-route`, { method: "POST", headers })
  expect(unnamed.status()).toBe(404)
})

test("an anonymous write naming a user is unauthenticated; registration without the header still works", async ({ request, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  const headers = { ...(await writeHeaders(request, hub.url)), "Content-Type": "application/json" }
  const forAlice = { ...headers, "X-Haxy-Viewer": alice.name }
  const carol = { name: "carol", email: "carol@example.test", password: "a long password", password_again: "a long password" }

  for (const [method, path] of [["POST", "/api/v1/no-such-route"], ["PUT", "/api/v1/account/email"], ["POST", "/api/v1/account"]] as const) {
    const response = await request.fetch(`${hub.url}${path}`, { method, headers: forAlice, data: path === "/api/v1/account" ? carol : { email: "x@example.test" } })
    expect(response.status(), `${method} ${path}`).toBe(401)
    expect(await errorCode(response)).toBe("unauthenticated")
  }
  expect(await viewerOf(request, hub.url)).toBeNull()
  expect((await request.get(`${hub.url}/api/v1/users/carol`)).status()).toBe(404)

  // a registration names nobody, and signs the browser in
  const registered = await request.post(`${hub.url}/api/v1/account`, { headers, data: carol })
  expect(registered.status()).toBe(201)
  expect(await viewerOf(request, hub.url)).toBe("carol")
})

// --- a stale Haxy Hub tab, in the browser -----------------------------------

async function logInThroughHub(page: Page, hubUrl: string, account: Account) {
  await page.goto(`${hubUrl}/login?next=%2Faccount`)
  await page.getByLabel("Username").fill(account.name)
  await page.getByLabel("Password").fill(account.password)
  await page.getByRole("button", { name: "Log in" }).click()
  await expect(header(page)).toContainText(`Signed in as ${account.name}`)
}

/** Submits the form on Haxy's own (server-rendered) page whose action ends in `/<route>`, as a person does. */
async function submitHaxyForm(page: Page, route: string, fields: Record<string, string>) {
  const form = page.locator(`form[action$="/${route}"]`)
  const id = await form.getAttribute("id")
  for (const [name, value] of Object.entries(fields)) await page.locator(`input[form="${id}"][name="${name}"]`).fill(value)
  // the form answers with a redirect, so a new page loads
  await Promise.all([page.waitForEvent("load"), page.locator(`button[form="${id}"]`).click()])
}

/** Counts the requests `page` sends to `path` with `method`. */
function countRequests(page: Page, method: string, path: string): () => number {
  let count = 0
  page.on("request", (request) => {
    if (request.method() === method && new URL(request.url()).pathname === path) count++
  })
  return () => count
}

test("a stale tab's writes never reach a user who signed in through Haxy's own login form", async ({ page, context, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const hub = await launch.hub(backend.port)
  await logInThroughHub(page, hub.url, alice)
  await expect(page.getByRole("textbox", { name: "Email" })).toHaveValue(alice.email)
  const passwordChanges = countRequests(page, "PUT", "/api/v1/account/password")

  // another tab of the same browser (sharing its cookies) switches to bobby
  // on Haxy's own server-rendered pages
  const other = await context.newPage()
  await other.goto(`${backend.origin}/home/user`)
  await submitHaxyForm(other, "logout", {})
  await other.goto(`${backend.origin}/home/user`)
  await submitHaxyForm(other, "login", { username: bob.name, password: bob.password })
  await expect.poll(() => viewerOf(other.request, hub.url)).toBe(bob.name)

  // alice's tab changes "her" password: refused, and not replayed as bobby
  const passwords = page.getByRole("region", { name: "Password", exact: true })
  await passwords.getByLabel("Current password").fill(alice.password)
  await passwords.getByLabel("New password", { exact: true }).fill("taken over")
  await passwords.getByLabel("Confirm new password").fill("taken over")
  await passwords.getByRole("button", { name: "Change password" }).click()
  await expect(passwords.getByRole("alert")).toContainText(`signed in as ${bob.name}`)
  expect(passwordChanges()).toBe(1)

  // a second stale write, now with a fresh token, is refused by the backend
  await page.getByLabel("Public key").fill("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl stale@host")
  await page.getByRole("button", { name: "Add key" }).click()
  await expect(page.getByRole("region", { name: "SSH keys" }).getByRole("alert")).toContainText(`signed in as ${bob.name}`)

  // neither account changed
  expect(await canLogIn(hub.url, bob)).toBe(true)
  expect(await canLogIn(hub.url, alice)).toBe(true)
  await other.goto(`${hub.url}/account`)
  await expect(header(other)).toContainText(`Signed in as ${bob.name}`)
  await expect(other.getByText("You have no SSH keys.")).toBeVisible()

  // reloading shows who is signed in now
  await passwords.getByRole("button", { name: "Reload" }).click()
  await expect(header(page)).toContainText(`Signed in as ${bob.name}`)
})

test("a stale tab's writes never reach a user who signed in through Haxy Hub", async ({ page, context, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const hub = await launch.hub(backend.port)
  await logInThroughHub(page, hub.url, alice)
  const email = page.getByRole("textbox", { name: "Email" })
  await expect(email).toHaveValue(alice.email)
  const emailChanges = countRequests(page, "PUT", "/api/v1/account/email")

  const other = await context.newPage()
  await other.goto(hub.url)
  await header(other).getByRole("button", { name: "Log out" }).click()
  await expect(header(other).getByRole("link", { name: "Log in" })).toBeVisible()
  await logInThroughHub(other, hub.url, bob)

  // alice's tab changes "her" email: refused, and not replayed as bobby
  await email.fill("hijacked@example.test")
  await page.getByRole("button", { name: "Save email" }).click()
  await expect(page.getByRole("region", { name: "Email address" }).getByRole("alert")).toContainText(`signed in as ${bob.name}`)
  expect(emailChanges()).toBe(1)

  // and "her" account deletion, now with a fresh token, is refused too
  const danger = page.getByRole("region", { name: "Delete account" })
  await danger.getByLabel(`Type ${alice.name} to confirm`).fill(alice.name)
  await danger.getByLabel("Password").fill(alice.password)
  await danger.getByRole("button", { name: "Permanently delete this account" }).click()
  await expect(danger.getByRole("alert")).toContainText(`signed in as ${bob.name}`)

  // both accounts are as they were, and bobby is still signed in
  await other.goto(`${hub.url}/account`)
  await expect(header(other)).toContainText(`Signed in as ${bob.name}`)
  await expect(other.getByRole("textbox", { name: "Email" })).toHaveValue(bob.email)
  expect(await canLogIn(hub.url, alice)).toBe(true)

  await page.getByRole("button", { name: "Reload" }).first().click()
  await expect(header(page)).toContainText(`Signed in as ${bob.name}`)
  await expect(email).toHaveValue(bob.email)
})

// --- the token cache never outlives the viewer it was read for --------------

type WriteOutcome = { ok: true } | { ok: false; name: string; code: string; message: string }

/**
 * Runs a write through the app's own `requestJson` (the module instance the
 * page already loaded, so it shares the page's token cache and shown viewer),
 * as a form on that page would.
 */
async function writeFromPage(page: Page, path: string, init: { method: string; body?: unknown; viewer?: string | null }): Promise<WriteOutcome> {
  return page.evaluate(async ({ path, init, client }) => {
    const api = (await import(/* @vite-ignore */ client)) as typeof import("../src/lib/api")
    try {
      await api.requestJson(path, {
        method: init.method,
        headers: { "Content-Type": "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        ...("viewer" in init ? { viewer: init.viewer } : {}),
      })
      return { ok: true }
    } catch (error) {
      const failure = error as { name: string; code: string; message: string }
      return { ok: false, name: failure.name, code: failure.code, message: failure.message }
    }
  }, { path, init, client: "/src/lib/api.ts" })
}

test("a write issued while nobody was signed in never runs as someone who signed in since, even with a refreshed token", async ({ page, context, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  await page.goto(hub.url)
  await expect(header(page).getByRole("link", { name: "Log in" })).toBeVisible()
  const emailChanges = countRequests(page, "PUT", "/api/v1/account/email")

  const other = await context.newPage()
  await logInThroughHub(other, hub.url, alice)

  // the anonymous page's first write is refused (the token was rotated), and
  // the refusal leaves alice's fresh token in the page's cache
  for (const viewer of [undefined, null]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const outcome = await writeFromPage(page, "/api/v1/account/email", { method: "PUT", body: { email: "anonymous@example.test" }, ...(viewer === undefined ? {} : { viewer }) })
      expect(outcome, `viewer ${viewer}, attempt ${attempt}`).toMatchObject({ ok: false, name: "ViewerChangedError" })
      expect((outcome as { message: string }).message).toContain(`signed in as ${alice.name}`)
    }
  }
  // only the very first write was sent; none ran as alice
  expect(emailChanges()).toBe(1)
  await other.goto(`${hub.url}/account`)
  await expect(other.getByRole("textbox", { name: "Email" })).toHaveValue(alice.email)
})

test("a write for one user never sends a token cached for another", async ({ page, context, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const hub = await launch.hub(backend.port)
  await logInThroughHub(page, hub.url, alice)
  const keyAdditions = countRequests(page, "POST", "/api/v1/account/keys")

  const other = await context.newPage()
  await other.goto(hub.url)
  await header(other).getByRole("button", { name: "Log out" }).click()
  await logInThroughHub(other, hub.url, bob)

  const key = { key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl stale@host" }
  for (let attempt = 0; attempt < 2; attempt++) {
    const outcome = await writeFromPage(page, "/api/v1/account/keys", { method: "POST", body: key, viewer: alice.name })
    expect(outcome, `attempt ${attempt}`).toMatchObject({ ok: false, name: "ViewerChangedError" })
  }
  // the second write is refused before it is sent, rather than by the backend
  expect(keyAdditions()).toBe(1)
  await other.goto(`${hub.url}/account`)
  await expect(other.getByText("You have no SSH keys.")).toBeVisible()
})
