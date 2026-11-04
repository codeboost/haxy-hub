import { request as playwrightRequest, type APIRequestContext } from "@playwright/test"
import { alice, registerUser, writeHeaders, type Account } from "./support/accounts"
import { expect, test } from "./support/fixtures"

// HTTP contract and security cases for the account routes that the browser
// can't express: forged requests for another user, anonymous and deleted
// sessions, malformed bodies, and local mode. They drive the same real
// `haxy serve` through Vite's proxy.

const bob: Account = { name: "bobby", email: "bobby@example.test", password: "bobby's password" }
const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl bobby@host"

/** A request context logged in as `account` through the session API, with write headers. */
async function loggedIn(hubUrl: string, account: Account): Promise<{ context: APIRequestContext; headers: Record<string, string> }> {
  const context = await playwrightRequest.newContext()
  const login = await context.post(`${hubUrl}/api/v1/session`, {
    headers: await writeHeaders(context, hubUrl),
    data: { username: account.name, password: account.password },
  })
  expect(login.status()).toBe(200)
  // login rotates the token
  return { context, headers: { ...(await writeHeaders(context, hubUrl)), "Content-Type": "application/json", "X-Haxy-Viewer": account.name } }
}

async function errorCode(response: { json(): Promise<unknown> }): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code
}

test("anonymous requests to the account routes are unauthenticated", async ({ launch, request }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const headers = { ...(await writeHeaders(request, hub.url)), "Content-Type": "application/json" }

  const responses = [
    await request.get(`${hub.url}/api/v1/account`),
    await request.get(`${hub.url}/api/v1/account/keys`),
    await request.put(`${hub.url}/api/v1/account/email`, { headers, data: { email: "x@example.test" } }),
    await request.put(`${hub.url}/api/v1/account/password`, { headers, data: { current_password: "a", new_password: "b", new_password_again: "b" } }),
    await request.post(`${hub.url}/api/v1/account/keys`, { headers, data: { key } }),
    await request.delete(`${hub.url}/api/v1/account/keys/${encodeURIComponent("SHA256:x")}`, { headers }),
    await request.delete(`${hub.url}/api/v1/account`, { headers, data: { confirm: "x", password: "y" } }),
  ]
  for (const response of responses) {
    expect(response.status()).toBe(401)
    expect(await errorCode(response)).toBe("unauthenticated")
  }
})

test("the account body names the viewer and their email, and nothing secret", async ({ launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  const { context } = await loggedIn(hub.url, alice)
  try {
    const response = await context.get(`${hub.url}/api/v1/account`)
    expect(response.status()).toBe(200)
    expect(response.headers()["cache-control"]).toBe("no-store")
    expect(await response.json()).toEqual({ name: alice.name, email: alice.email })
  } finally {
    await context.dispose()
  }
})

test("one user cannot change another user's email, password, keys or account through the API", async ({ launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const hub = await launch.hub(backend.port)
  const asBob = await loggedIn(hub.url, bob)
  const asAlice = await loggedIn(hub.url, alice)
  try {
    const added = await asBob.context.post(`${hub.url}/api/v1/account/keys`, { headers: asBob.headers, data: { key } })
    expect(added.status()).toBe(201)
    const { fingerprint } = (await added.json()) as { fingerprint: string }

    // no route names another user: the routes act on the session's viewer
    const forged = await asAlice.context.put(`${hub.url}/api/v1/users/${bob.name}/email`, { headers: asAlice.headers, data: { email: "pwned@example.test" } })
    expect(forged.status()).toBe(404)
    // removing bob's key as alice finds no such key
    const removed = await asAlice.context.delete(`${hub.url}/api/v1/account/keys/${encodeURIComponent(fingerprint)}`, { headers: asAlice.headers })
    expect(removed.status()).toBe(404)
    expect(await errorCode(removed)).toBe("not_found")
    // bob's password doesn't change alice's password, or bob's
    const password = await asAlice.context.put(`${hub.url}/api/v1/account/password`, {
      headers: asAlice.headers,
      data: { current_password: bob.password, new_password: "taken over", new_password_again: "taken over" },
    })
    expect(password.status()).toBe(400)
    expect(((await password.json()) as { error: { field_errors: Record<string, string> } }).error.field_errors).toHaveProperty("current_password")
    // typing bob's name and password deletes nothing
    const deleted = await asAlice.context.delete(`${hub.url}/api/v1/account`, { headers: asAlice.headers, data: { confirm: bob.name, password: bob.password } })
    expect(deleted.status()).toBe(400)

    // bob is untouched
    expect(await (await asBob.context.get(`${hub.url}/api/v1/account`)).json()).toEqual({ name: bob.name, email: bob.email })
    const keys = (await (await asBob.context.get(`${hub.url}/api/v1/account/keys`)).json()) as { items: Array<{ fingerprint: string }> }
    expect(keys.items.map((item) => item.fingerprint)).toEqual([fingerprint])
    const relogin = await loggedIn(hub.url, bob)
    await relogin.context.dispose()
  } finally {
    await asBob.context.dispose()
    await asAlice.context.dispose()
  }
})

test("a deleted account's other sessions lose access", async ({ launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  const first = await loggedIn(hub.url, alice)
  const second = await loggedIn(hub.url, alice)
  try {
    const deleted = await first.context.delete(`${hub.url}/api/v1/account`, { headers: first.headers, data: { confirm: alice.name, password: alice.password } })
    expect(deleted.status()).toBe(200)
    expect(((await deleted.json()) as { viewer: unknown }).viewer).toBeNull()

    const after = await second.context.get(`${hub.url}/api/v1/account`)
    expect(after.status()).toBe(401)
    const session = (await (await second.context.get(`${hub.url}/api/v1/session`)).json()) as { viewer: unknown }
    expect(session.viewer).toBeNull()
    const write = await second.context.put(`${hub.url}/api/v1/account/email`, { headers: second.headers, data: { email: "ghost@example.test" } })
    expect(write.status()).toBe(401)
  } finally {
    await first.context.dispose()
    await second.context.dispose()
  }
})

test("registration refuses form posts and a browser that is already logged in", async ({ launch, request }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)

  const form = await request.post(`${hub.url}/api/v1/account`, {
    headers: await writeHeaders(request, hub.url),
    form: { name: "mallory", email: "m@example.test", password: "x", password_again: "x" },
  })
  expect(form.status()).toBe(400)
  expect(await errorCode(form)).toBe("validation")

  const { context, headers } = await loggedIn(hub.url, alice)
  try {
    const again = await context.post(`${hub.url}/api/v1/account`, { headers, data: { name: "mallory", email: "m@example.test", password: "x", password_again: "x" } })
    expect(again.status()).toBe(403)
    expect(await errorCode(again)).toBe("forbidden")
  } finally {
    await context.dispose()
  }
  // nothing was created
  const users = (await (await request.get(`${hub.url}/api/v1/users?search=mallory`)).json()) as { items: unknown[] }
  expect(users.items).toEqual([])
})

test("local mode has no account routes", async ({ launch, request }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  const headers = { ...(await writeHeaders(request, hub.url)), "Content-Type": "application/json" }

  const responses = [
    await request.get(`${hub.url}/api/v1/account`),
    await request.post(`${hub.url}/api/v1/account`, { headers, data: { name: "carol", email: "c@example.test", password: "x", password_again: "x" } }),
    await request.get(`${hub.url}/api/v1/account/keys`),
    await request.put(`${hub.url}/api/v1/account/email`, { headers, data: { email: "c@example.test" } }),
  ]
  for (const response of responses) {
    expect(response.status()).toBe(405)
    expect(await errorCode(response)).toBe("unsupported")
  }
})

test("a change naming an account other than the signed-in user's is refused; one naming none proceeds", async ({ launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const hub = await launch.hub(backend.port)
  const { context, headers } = await loggedIn(hub.url, alice)
  try {
    // a form loaded for bob, sent while the browser is signed in as alice
    const forBob = { ...headers, "X-Haxy-Viewer": bob.name }
    const responses = [
      await context.put(`${hub.url}/api/v1/account/email`, { headers: forBob, data: { email: "a2@example.test" } }),
      await context.put(`${hub.url}/api/v1/account/password`, { headers: forBob, data: { current_password: alice.password, new_password: "n", new_password_again: "n" } }),
      await context.post(`${hub.url}/api/v1/account/keys`, { headers: forBob, data: { key } }),
      await context.delete(`${hub.url}/api/v1/account/keys/${encodeURIComponent("SHA256:x")}`, { headers: forBob }),
      await context.delete(`${hub.url}/api/v1/account`, { headers: forBob, data: { confirm: alice.name, password: alice.password } }),
    ]
    for (const response of responses) {
      expect(response.status()).toBe(409)
      expect(await errorCode(response)).toBe("conflict")
    }
    // nothing changed
    expect(await (await context.get(`${hub.url}/api/v1/account`)).json()).toEqual({ name: alice.name, email: alice.email })
    expect(((await (await context.get(`${hub.url}/api/v1/account/keys`)).json()) as { items: unknown[] }).items).toEqual([])

    // the header is optional: a client that names nobody acts on the session's viewer
    const { "X-Haxy-Viewer": _, ...unnamed } = headers
    const changed = await context.put(`${hub.url}/api/v1/account/email`, { headers: unnamed, data: { email: "a2@example.test" } })
    expect(changed.status()).toBe(200)
    expect(await changed.json()).toEqual({ name: alice.name, email: "a2@example.test" })
    const added = await context.post(`${hub.url}/api/v1/account/keys`, { headers: unnamed, data: { key } })
    expect(added.status()).toBe(201)
  } finally {
    await context.dispose()
  }
})
