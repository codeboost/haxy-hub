import { request as playwrightRequest, type Page } from "@playwright/test"
import { alice, registerUser, writeHeaders } from "./support/accounts"
import { expect, test } from "./support/fixtures"

// Login, logout and the persistent session, driven in the browser through
// Vite's proxy against a real `haxy serve` with a user registered through
// Haxy's own sign-up form.

const header = (page: Page) => page.getByRole("banner")

async function logIn(page: Page, username: string, password: string) {
  await page.getByLabel("Username").fill(username)
  await page.getByLabel("Password").fill(password)
  await page.getByRole("button", { name: "Log in" }).click()
}

test("logging in returns to the page it started from and shows the viewer", async ({ page, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)

  await page.goto(`${hub.url}/connection?tab=details`)
  await expect(header(page)).toContainText("Server mode")
  await header(page).getByRole("link", { name: "Log in" }).click()
  await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible()
  await logIn(page, alice.name, alice.password)

  await expect(page).toHaveURL(`${hub.url}/connection?tab=details`)
  await expect(header(page)).toContainText(`Signed in as ${alice.name}`)
  await expect(header(page).getByRole("link", { name: "Log in" })).toHaveCount(0)
})

test("invalid credentials show an error and keep the username but not the password", async ({ page, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)

  await page.goto(`${hub.url}/login?next=%2Fconnection`)
  await logIn(page, alice.name, "not the password")

  await expect(page.getByRole("alert")).toContainText("Incorrect username or password.")
  await expect(page.getByLabel("Username")).toHaveValue(alice.name)
  await expect(page.getByLabel("Password")).toHaveValue("")
  await expect(page).toHaveURL(`${hub.url}/login?next=%2Fconnection`)
  await expect(header(page)).not.toContainText("Signed in as")

  // correcting the password then logs in and still returns to the origin
  await page.getByLabel("Password").fill(alice.password)
  await page.getByRole("button", { name: "Log in" }).click()
  await expect(page).toHaveURL(`${hub.url}/connection`)
  await expect(header(page)).toContainText(`Signed in as ${alice.name}`)
})

test("the session survives a refresh and a backend restart", async ({ page, launch }) => {
  let backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)

  await page.goto(`${hub.url}/login`)
  await logIn(page, alice.name, alice.password)
  await expect(header(page)).toContainText(`Signed in as ${alice.name}`)

  await page.reload()
  await expect(header(page)).toContainText(`Signed in as ${alice.name}`)

  backend = await backend.restart!()
  await page.reload()
  await expect(header(page)).toContainText(`Signed in as ${alice.name}`)
  // the CSRF token survives the restart too: logging out (a write) works
  await header(page).getByRole("button", { name: "Log out" }).click()
  await expect(header(page).getByRole("link", { name: "Log in" })).toBeVisible()
  await page.reload()
  await expect(header(page).getByRole("link", { name: "Log in" })).toBeVisible()
})

test("logging out clears viewer data, and going back does not show it again", async ({ page, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)

  await page.goto(`${hub.url}/login?next=%2F`)
  await logIn(page, alice.name, alice.password)
  await expect(page.getByRole("main")).toContainText(`Signed in as ${alice.name}`)
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Connection" }).click()
  await expect(page).toHaveURL(`${hub.url}/connection`)

  await header(page).getByRole("button", { name: "Log out" }).click()
  await expect(header(page).getByRole("link", { name: "Log in" })).toBeVisible()
  await expect(page.getByText(alice.name)).toHaveCount(0)

  // back through the history of this document
  await page.goBack()
  await expect(page).toHaveURL(`${hub.url}/`)
  await expect(header(page).getByRole("link", { name: "Log in" })).toBeVisible()
  await expect(page.getByText(alice.name)).toHaveCount(0)

  // and the session is gone server-side: a refresh stays logged out
  await page.reload()
  await expect(header(page).getByRole("link", { name: "Log in" })).toBeVisible()
  await expect(page.getByText(alice.name)).toHaveCount(0)
})

// Playwright's Chromium (and Vite's HMR socket) keep pages out of the
// back/forward cache, so this covers the reloaded document; the app also
// re-reads the session on a bfcache restore (pageshow with persisted).
test("going back to a document loaded before logout does not show the viewer", async ({ page, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)

  await page.goto(`${hub.url}/login?next=%2F`)
  await logIn(page, alice.name, alice.password)
  await expect(page.getByRole("main")).toContainText(`Signed in as ${alice.name}`)

  // a full page load, so the logged-in page above becomes a separate history
  // entry the browser may restore from its back/forward cache
  await page.goto(`${hub.url}/connection`)
  await expect(header(page)).toContainText(`Signed in as ${alice.name}`)
  await header(page).getByRole("button", { name: "Log out" }).click()
  await expect(header(page).getByRole("link", { name: "Log in" })).toBeVisible()

  await page.goBack()
  await expect(page).toHaveURL(`${hub.url}/`)
  await expect(header(page).getByRole("link", { name: "Log in" })).toBeVisible()
  await expect(page.getByText(alice.name)).toHaveCount(0)
})

test("a session invalidated on the server shows as logged out on the next request", async ({ page, launch, context }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)

  await page.goto(`${hub.url}/login`)
  await logIn(page, alice.name, alice.password)
  await expect(header(page)).toContainText(`Signed in as ${alice.name}`)

  // another client holding the same session logs it out, revoking it on the
  // server; this browser still sends its (now dead) cookie
  const session = (await context.cookies(hub.url)).find((cookie) => cookie.name === "haxy_session")
  expect(session).toBeDefined()
  const other = await playwrightRequest.newContext({ storageState: { cookies: [session!], origins: [] } })
  try {
    const revoked = await other.delete(`${hub.url}/api/v1/session`, { headers: await writeHeaders(other, hub.url) })
    expect(revoked.status()).toBe(200)
  } finally {
    await other.dispose()
  }
  expect((await context.cookies(hub.url)).some((cookie) => cookie.name === "haxy_session")).toBe(true)

  // the next request (a client-side navigation) reflects it
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Home" }).click()
  await expect(header(page).getByRole("link", { name: "Log in" })).toBeVisible()
  await expect(page.getByText(alice.name)).toHaveCount(0)
})

test("local mode has no login UI", async ({ page, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)

  await page.goto(hub.url)
  await expect(header(page)).toContainText("Local mode")
  await expect(page.getByRole("link", { name: "Log in" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Log out" })).toHaveCount(0)

  await page.goto(`${hub.url}/login`)
  await expect(page.getByRole("heading", { name: "No accounts in local mode" })).toBeVisible()
  await expect(page.getByLabel("Password")).toHaveCount(0)
})

test("the web UI's form login and the API share one session", async ({ request, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)

  // the existing browser-rendered UI posts this form; it still redirects with a session cookie
  const form = await fetch(`${backend.origin}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: alice.name, password: alice.password }),
    redirect: "manual",
  })
  expect(form.status).toBe(303)
  const cookie = /haxy_session=[0-9a-f]+/.exec(form.headers.get("set-cookie") ?? "")?.[0]
  expect(cookie).toBeDefined()

  const session = await request.get(`${hub.url}/api/v1/session`, { headers: { cookie: cookie! } })
  expect((await session.json()).viewer).toEqual({ name: alice.name })
})

test("the login page only returns to paths inside Haxy Hub", async ({ page, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  await page.goto(hub.url)

  const external = ["//evil.example", "/.//evil.example", "/./../evil.example/..//evil.example", "/\\evil.example", "/.\\/evil.example",
    "https://evil.example", "javascript:alert(1)", "evil.example", "", "/login?next=/connection"]
  const kept: Record<string, string> = { "/connection?tab=a#b": "/connection?tab=a#b", "/a/./b/../c": "/a/c", "/": "/",
    // an encoded slash stays part of one path segment, so it's an in-app path
    "/%2F/evil.example": "/%2F/evil.example" }
  const results = await page.evaluate(`
    import("/src/lib/session.ts").then(({ returnPath }) =>
      ${JSON.stringify([...external, ...Object.keys(kept)])}.map((next) => [next, returnPath(next)]))
  `) as Array<[string, string]>
  for (const [next, path] of results) {
    expect(path, next).toBe(kept[next] ?? "/")
  }

  // a protocol-relative URL hidden behind dot segments neither redirects
  // after login nor becomes the logged-in page's Continue link
  await page.goto(`${hub.url}/login?next=${encodeURIComponent("/.//evil.example")}`)
  await logIn(page, alice.name, alice.password)
  await expect(page).toHaveURL(`${hub.url}/`)
  await page.goto(`${hub.url}/login?next=${encodeURIComponent("/.//evil.example")}`)
  await expect(page.getByRole("link", { name: "Continue" })).toHaveAttribute("href", "/")
})

/**
 * Makes the next session read (GET /api/v1/session) answer as the backend did
 * *before* a logout, delivered only after the logout's response: the read is
 * sent to Haxy while the logout is held back, and its answer is held until
 * the logout has been answered.
 */
async function staleReadDuringLogout(page: Page) {
  let readSent!: () => void
  const readWasSent = new Promise<void>((resolve) => { readSent = resolve })
  let logoutAnswered!: () => void
  const logoutWasAnswered = new Promise<void>((resolve) => { logoutAnswered = resolve })
  let staleDelivered!: () => void
  const delivered = new Promise<void>((resolve) => { staleDelivered = resolve })

  let staleRead = false
  await page.route("**/api/v1/session", async (route) => {
    const method = route.request().method()
    if (method === "DELETE") {
      await readWasSent
      await route.fulfill({ response: await route.fetch() })
      logoutAnswered()
      return
    }
    if (method === "GET" && !staleRead) {
      staleRead = true
      const response = await route.fetch()
      readSent()
      await logoutWasAnswered
      // let the app handle the logout first
      await new Promise((resolve) => setTimeout(resolve, 300))
      await route.fulfill({ response })
      staleDelivered()
      return
    }
    await route.continue()
  })
  // wrapped, so awaiting this function doesn't also await the delivery
  return { delivered }
}

test("a session read in flight during logout cannot undo the logout", async ({ page, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  await page.goto(`${hub.url}/login`)
  await logIn(page, alice.name, alice.password)
  await expect(header(page)).toContainText(`Signed in as ${alice.name}`)

  const { delivered } = await staleReadDuringLogout(page)
  await header(page).getByRole("button", { name: "Log out" }).click()
  // navigating while the logout is pending reads the session again
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Connection" }).click()
  await delivered

  await expect(header(page).getByRole("link", { name: "Log in" })).toBeVisible()
  await expect(page.getByText(alice.name)).toHaveCount(0)
})

test("a session read in flight during logout cannot restore the old CSRF token", async ({ page, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  await page.goto(`${hub.url}/login`)
  await logIn(page, alice.name, alice.password)
  await expect(header(page)).toContainText(`Signed in as ${alice.name}`)

  const { delivered } = await staleReadDuringLogout(page)
  await header(page).getByRole("button", { name: "Log out" }).click()
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Connection" }).click()
  await delivered

  // the next write from this document (logging in again through the app's
  // own client module) carries the token the logout issued
  const outcome = await page.evaluate(`
    import("/src/lib/session.ts").then(({ logIn }) =>
      logIn(${JSON.stringify(alice.name)}, ${JSON.stringify(alice.password)}).then(
        (session) => ({ viewer: session.viewer }),
        (error) => ({ code: error.code, message: error.message })))
  `)
  expect(outcome).toEqual({ viewer: { name: alice.name } })
})
