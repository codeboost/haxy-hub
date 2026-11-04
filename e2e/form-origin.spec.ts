import type { APIRequestContext, APIResponse } from "@playwright/test"
import { alice, registerUser } from "./support/accounts"
import type { Backend } from "./support/backend"
import { expect, test } from "./support/fixtures"

// HTTP contract checks for the same-origin rule on Haxy's own server-rendered
// HTML form routes (everything outside /api/). A state-changing request that
// names an Origin must name the backend's own; one without an Origin (a
// non-browser client) behaves as before. See issue #29 and the Security notes
// in docs/api-conventions.md. These routes are served by the backend itself,
// not through Haxy Hub's proxy, so requests go to the backend's origin.

const loginForm = { username: alice.name, password: alice.password }

/** Origins a page outside the backend could post from, `null` included. */
function foreignOrigins(backend: Backend): string[] {
  return ["http://evil.example", `http://127.0.0.1:${backend.port + 1}`, `http://localhost:${backend.port}`, "null"]
}

async function expectRefused(response: APIResponse, label: string) {
  expect(response.status(), label).toBe(403)
  expect(response.headers()["content-type"], label).toContain("text/html")
  expect(await response.text(), label).toContain("Haxy only accepts changes sent from its own site.")
  // the handler never ran: no session, no form feedback, no redirect
  expect(response.headers()["set-cookie"], label).toBeUndefined()
  expect(response.headers()["location"], label).toBeUndefined()
}

async function viewer(request: APIRequestContext, backend: Backend): Promise<string | null> {
  const response = await request.get(`${backend.origin}/api/v1/session`)
  return ((await response.json()) as { viewer: { name: string } | null }).viewer?.name ?? null
}

async function repoNames(request: APIRequestContext, backend: Backend, owner: string): Promise<string[]> {
  const response = await request.get(`${backend.origin}/api/v1/users/${owner}/repos`)
  expect(response.status()).toBe(200)
  return ((await response.json()) as { items: Array<{ name: string }> }).items.map((repo) => repo.name)
}

test("a login form post from a foreign Origin is refused and logs nobody in", async ({ request, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)

  for (const Origin of foreignOrigins(backend)) {
    const response = await request.post(`${backend.origin}/home/user/login`, { form: loginForm, headers: { Origin }, maxRedirects: 0 })
    await expectRefused(response, Origin)
  }
  expect(await viewer(request, backend)).toBeNull()
})

test("the same login form post from Haxy's own origin logs in", async ({ request, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)

  const response = await request.post(`${backend.origin}/home/user/login`, { form: loginForm, headers: { Origin: backend.origin }, maxRedirects: 0 })

  expect(response.status()).toBe(303)
  expect(response.headers()["set-cookie"]).toMatch(/haxy_session=[0-9a-f]+;/)
  expect(await viewer(request, backend)).toBe(alice.name)
})

test("a form post without an Origin, as non-browser clients send, works as before", async ({ request, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)

  const response = await request.post(`${backend.origin}/home/user/login`, { form: loginForm, maxRedirects: 0 })

  expect(response.status()).toBe(303)
  expect(await viewer(request, backend)).toBe(alice.name)
})

test("creating a repository is refused from a foreign Origin and allowed from Haxy's own", async ({ request, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const login = await request.post(`${backend.origin}/home/user/login`, { form: loginForm, maxRedirects: 0 })
  expect(login.status()).toBe(303)
  const repoForm = { name: "planted", description: "", hash: "sha1", access: "public", copy: "" }

  for (const Origin of foreignOrigins(backend)) {
    const response = await request.post(`${backend.origin}/home/repo/new`, { form: repoForm, headers: { Origin }, maxRedirects: 0 })
    await expectRefused(response, Origin)
  }
  expect(await repoNames(request, backend, alice.name)).not.toContain("planted")

  const created = await request.post(`${backend.origin}/home/repo/new`, { form: repoForm, headers: { Origin: backend.origin }, maxRedirects: 0 })
  expect(created.status()).toBe(303)
  expect(created.headers()["location"]).toBe(`/${alice.name}:planted`)
  expect(await repoNames(request, backend, alice.name)).toContain("planted")
})

test("registering an account is refused from a foreign Origin and creates no user", async ({ request, launch }) => {
  const backend = await launch.server()
  const signUp = { name: "mallory", email: "mallory@example.test", password: "correct horse battery", password_again: "correct horse battery" }

  const response = await request.post(`${backend.origin}/home/user/new`, { form: signUp, headers: { Origin: "http://evil.example" }, maxRedirects: 0 })

  await expectRefused(response, "sign-up")
  expect((await request.get(`${backend.origin}/api/v1/users/mallory`)).status()).toBe(404)
})

test("the check covers every state-changing method, before any route is matched", async ({ request, launch }) => {
  const backend = await launch.server()

  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await request.fetch(`${backend.origin}/no/such/page`, { method, headers: { Origin: "http://evil.example" }, maxRedirects: 0 })
    await expectRefused(response, method)
    // from Haxy's own origin the request reaches routing, which answers as before
    const own = await request.fetch(`${backend.origin}/no/such/page`, { method, headers: { Origin: backend.origin }, maxRedirects: 0 })
    expect(own.status(), method).toBe(405)
  }
  // reads are never checked
  const read = await request.get(`${backend.origin}/home/user`, { headers: { Origin: "http://evil.example" } })
  expect(read.status()).toBe(200)
})

test("local mode refuses a foreign-Origin form post too, and accepts its own", async ({ request, launch }) => {
  const backend = await launch.local()
  const issue = (title: string) => ({ title, labels: "", description: "" })
  const openIssues = async () => (await request.get(`${backend.origin}/issues/open`)).text()

  for (const Origin of foreignOrigins(backend)) {
    const response = await request.post(`${backend.origin}/issues/new`, { form: issue("Planted issue"), headers: { Origin }, maxRedirects: 0 })
    await expectRefused(response, Origin)
  }
  expect(await openIssues()).not.toContain("Planted issue")

  const created = await request.post(`${backend.origin}/issues/new`, { form: issue("Own issue"), headers: { Origin: backend.origin }, maxRedirects: 0 })
  expect(created.status()).toBe(303)
  expect(await openIssues()).toContain("Own issue")
})

test("git's smart HTTP is answered by git's own handler, whatever Origin it carries", async ({ request, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  // a public repository to fetch from, created through Haxy's own form
  await request.post(`${backend.origin}/home/user/login`, { form: loginForm, maxRedirects: 0 })
  const created = await request.post(`${backend.origin}/home/repo/new`, {
    form: { name: "tools", description: "", hash: "sha1", access: "public", copy: "" },
    headers: { Origin: backend.origin },
    maxRedirects: 0,
  })
  expect(created.headers()["location"]).toBe(`/${alice.name}:tools`)
  const repo = `${backend.origin}/${alice.name}:tools`
  const headers = { Origin: "http://evil.example" }

  // fetching posts to git-upload-pack; a lone flush packet asks for nothing
  const fetch = await request.post(`${repo}/git-upload-pack`, {
    data: Buffer.from("0000"),
    headers: { ...headers, "content-type": "application/x-git-upload-pack-request" },
  })
  expect(fetch.status()).toBe(200)
  expect(fetch.headers()["content-type"]).toBe("application/x-git-upload-pack-result")

  // pushing over HTTP keeps its own refusal, not the form routes' page
  const push = await request.post(`${repo}/git-receive-pack`, {
    data: Buffer.from("0000"),
    headers: { ...headers, "content-type": "application/x-git-receive-pack-request" },
  })
  expect(push.status()).toBe(403)
  expect(push.headers()["content-type"]).toBe("text/plain")
  expect(await push.text()).toBe("push over HTTP is not supported")
})

for (const javaScriptEnabled of [true, false]) {
  test(`Haxy's own login form still logs in from its page ${javaScriptEnabled ? "with the WASM renderer" : "without JavaScript"}`, async ({ browser, launch }) => {
    const backend = await launch.server()
    await registerUser(backend, alice)
    const context = await browser.newContext({ javaScriptEnabled })
    try {
      const page = await context.newPage()
      await page.goto(`${backend.origin}/home/user`)
      if (javaScriptEnabled) {
        // the WASM renderer takes over the page once its module and fonts load
        await page.waitForFunction("typeof wasmInstance !== 'undefined'")
        await page.evaluate(() => document.fonts.ready.then(() => undefined))
      }
      await page.locator('input[name="username"]').fill(alice.name)
      await page.locator('input[name="password"]').fill(alice.password)
      const posted = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/home/user/login"))
      await page.locator('button[type="submit"]').click()

      // what the browser itself sends for a same-origin form post
      expect(await (await posted).headerValue("origin")).toBe(backend.origin)
      await page.waitForURL(`${backend.origin}/`)
      expect(await viewer(context.request, backend)).toBe(alice.name)
    } finally {
      await context.close()
    }
  })
}
