import { alice, csrfHeader, registerUser, writeHeaders } from "./support/accounts"
import { expect, test } from "./support/fixtures"

// HTTP contract checks for the same-origin + CSRF guard on state-changing
// /api/ requests, through the same Vite proxy the browser uses. The browser
// itself cannot forge these requests, which is the point; see the Security
// notes in docs/api-conventions.md. Logging in is the write under test.

const forbidden = { error: { code: "csrf", message: expect.stringMatching(/\S/) } }
const credentials = { username: alice.name, password: alice.password }

test("a write without the CSRF token is rejected and changes nothing", async ({ request, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  const { Origin } = await writeHeaders(request, hub.url)

  const response = await request.post(`${hub.url}/api/v1/session`, { data: credentials, headers: { Origin } })

  expect(response.status()).toBe(403)
  expect(response.headers()["content-type"]).toContain("application/json")
  expect(await response.json()).toEqual(forbidden)
  expect(response.headers()["set-cookie"] ?? "").not.toContain("haxy_session=")
  const session = await request.get(`${hub.url}/api/v1/session`)
  expect((await session.json()).viewer).toBeNull()
})

test("a write from a foreign Origin is rejected even with a valid token", async ({ request, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  const headers = await writeHeaders(request, hub.url)

  for (const Origin of ["http://evil.example", `http://127.0.0.1:${backend.port}`, "null"]) {
    const response = await request.post(`${hub.url}/api/v1/session`, { data: credentials, headers: { ...headers, Origin } })
    expect(response.status(), Origin).toBe(403)
    expect(await response.json()).toEqual(forbidden)
  }
  const session = await request.get(`${hub.url}/api/v1/session`)
  expect((await session.json()).viewer).toBeNull()
})

test("a token issued to another browser is rejected", async ({ request, playwright, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  const other = await playwright.request.newContext()
  try {
    const theirs = await writeHeaders(other, hub.url)
    await writeHeaders(request, hub.url)
    const response = await request.post(`${hub.url}/api/v1/session`, { data: credentials, headers: theirs })
    expect(response.status()).toBe(403)
    expect(await response.json()).toEqual(forbidden)
  } finally {
    await other.dispose()
  }
})

test("the same write with a valid token and same Origin succeeds and is persisted", async ({ request, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  const headers = await writeHeaders(request, hub.url)

  const response = await request.post(`${hub.url}/api/v1/session`, { data: credentials, headers })

  expect(response.status()).toBe(200)
  const body = await response.json()
  expect(body).toEqual({ viewer: { name: alice.name }, csrf_token: expect.stringMatching(/^[0-9a-f]{64}$/) })
  // logging in rotates the token
  expect(body.csrf_token).not.toBe(headers[csrfHeader])
  // the session cookie is HttpOnly; nothing secret is in the body
  expect(response.headers()["set-cookie"]).toMatch(/haxy_session=[0-9a-f]+;[^\n]*HttpOnly/)
  expect(JSON.stringify(body)).not.toMatch(/password|hash|email/i)

  const session = await request.get(`${hub.url}/api/v1/session`)
  expect(await session.json()).toEqual({ viewer: { name: alice.name }, csrf_token: body.csrf_token })
})

test("login validation and bad credentials answer with the conventions' envelope", async ({ request, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  const headers = await writeHeaders(request, hub.url)

  const empty = await request.post(`${hub.url}/api/v1/session`, { data: { username: "", password: "" }, headers })
  expect(empty.status()).toBe(400)
  expect(await empty.json()).toEqual({ error: {
    code: "validation",
    message: expect.any(String),
    field_errors: { username: expect.any(String), password: expect.any(String) },
  } })

  for (const attempt of [{ username: alice.name, password: "wrong" }, { username: "nobody", password: "wrong" }]) {
    const response = await request.post(`${hub.url}/api/v1/session`, { data: attempt, headers })
    expect(response.status()).toBe(401)
    // the same answer whether or not the user exists
    expect(await response.json()).toEqual({ error: { code: "unauthenticated", message: "Incorrect username or password." } })
  }
})

test("logging out revokes the session on the server", async ({ request, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  const login = await request.post(`${hub.url}/api/v1/session`, { data: credentials, headers: await writeHeaders(request, hub.url) })
  const sessionCookie = /haxy_session=([0-9a-f]+)/.exec(login.headers()["set-cookie"])![1]

  const logout = await request.delete(`${hub.url}/api/v1/session`, { headers: await writeHeaders(request, hub.url) })
  expect(logout.status()).toBe(200)
  expect(await logout.json()).toEqual({ viewer: null, csrf_token: expect.stringMatching(/^[0-9a-f]{64}$/) })

  // replaying the old cookie no longer names anyone
  const replay = await fetch(`${hub.url}/api/v1/session`, { headers: { cookie: `haxy_session=${sessionCookie}` } })
  expect((await replay.json()).viewer).toBeNull()
})

test("local mode guards writes too, and has no accounts to log in to", async ({ request, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)

  const session = await request.get(`${hub.url}/api/v1/session`)
  expect(session.status()).toBe(200)
  expect(await session.json()).toEqual({ viewer: null, csrf_token: expect.stringMatching(/^[0-9a-f]{64}$/) })

  const unguarded = await request.post(`${hub.url}/api/v1/session`, { data: credentials, headers: { Origin: hub.url } })
  expect(unguarded.status()).toBe(403)
  expect(await unguarded.json()).toEqual(forbidden)

  const headers = await writeHeaders(request, hub.url)
  for (const method of ["POST", "DELETE"]) {
    const response = await request.fetch(`${hub.url}/api/v1/session`, { method, data: credentials, headers })
    expect(response.status(), method).toBe(405)
    expect(response.headers()["allow"]).toBe("GET, HEAD")
    expect(await response.json()).toEqual({ error: { code: "unsupported", message: expect.any(String) } })
  }
})

test("the guard covers every write to /api/, including paths no route serves", async ({ request, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)

  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await request.fetch(`${hub.url}/api/v1/no-such-thing`, { method, headers: { Origin: hub.url } })
    expect(response.status(), method).toBe(403)
    expect(await response.json()).toEqual(forbidden)
  }
})

test("the app refreshes a stale CSRF token and retries the write once", async ({ page, context, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await page.goto(hub.url)
  await expect(page.getByRole("main")).toContainText("Connected to a multi-user Haxy server.")

  const outcome = (code: string) => page.evaluate(code)
  // Prime the app's in-memory token, then make it stale by replacing the
  // browser's CSRF cookie, as a cleared cookie or another tab would.
  await outcome(`import("/src/lib/api.ts").then(({ requestJson }) => requestJson("/api/v1/status", { method: "POST", body: "{}" }).catch((error) => error.code))`)
  await context.clearCookies({ name: "haxy_csrf" })

  // POST to the read-only status route: once the guard passes, the route answers unsupported.
  expect(await outcome(`import("/src/lib/api.ts").then(({ requestJson }) => requestJson("/api/v1/status", { method: "POST", body: "{}" }).then(() => "ok", (error) => error.code))`)).toBe("unsupported")
})
