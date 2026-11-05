import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import http from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { request as playwrightRequest, type APIRequestContext } from "@playwright/test"
import { alice, registerUser, writeHeaders, type Account } from "./support/accounts"
import { expect, test } from "./support/fixtures"

// HTTP contract and security cases for repository creation (POST /api/v1/repos)
// that the browser can't express: each hash format, the shared validation
// rules, copying visible and hidden repositories, forged viewers, anonymous
// requests and local mode. They drive a real Haxy through Vite's proxy.

const demoAlice: Account = { name: "alice", email: "alice@example.test", password: "password" }
const demoBobby: Account = { name: "bobby", email: "bobby@example.test", password: "password" }

/** A request context logged in as `account` through the session API, with the headers a Hub write sends. */
async function loggedIn(hubUrl: string, account: Account): Promise<{ context: APIRequestContext; headers: Record<string, string> }> {
  const context = await playwrightRequest.newContext()
  const login = await context.post(`${hubUrl}/api/v1/session`, {
    headers: await writeHeaders(context, hubUrl),
    data: { username: account.name, password: account.password },
  })
  expect(login.status()).toBe(200)
  return { context, headers: { ...(await writeHeaders(context, hubUrl)), "Content-Type": "application/json", "X-Haxy-Viewer": account.name } }
}

type ErrorBody = { error: { code: string; message: string; field_errors?: Record<string, string> } }

const newRepo = (fields: Partial<Record<"name" | "description" | "access" | "hash" | "copy", string>>) =>
  ({ name: "tools", description: "", access: "public", hash: "sha1", ...fields })

/** The object format of the repository `git` clones from `url` (over HTTP, as Haxy serves public repositories). */
async function clonedObjectFormat(url: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "haxy-e2e-clone-"))
  try {
    const target = path.join(dir, "clone")
    execFileSync("git", ["clone", "--quiet", url, target], { stdio: "pipe" })
    return execFileSync("git", ["rev-parse", "--show-object-format"], { cwd: target }).toString().trim()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("a user creates repositories with each hash format, which stay browseable after a restart", async ({ launch, request }) => {
  let backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  const { context, headers } = await loggedIn(hub.url, alice)
  try {
    for (const hash of ["sha1", "sha256"]) {
      const created = await context.post(`${hub.url}/api/v1/repos`, { headers, data: newRepo({ name: `tools-${hash}`, description: `Made with ${hash}`, hash }) })
      expect(created.status()).toBe(201)
      expect(created.headers()["cache-control"]).toBe("no-store")
      expect(await created.json()).toEqual({ owner: alice.name, name: `tools-${hash}` })
    }
    const secret = await context.post(`${hub.url}/api/v1/repos`, { headers, data: newRepo({ name: "secret", access: "private", hash: "sha256" }) })
    expect(secret.status()).toBe(201)

    backend = await backend.restart!()
    for (const hash of ["sha1", "sha256"]) {
      const overview = await context.get(`${hub.url}/api/v1/repos/${alice.name}/tools-${hash}`)
      expect(overview.status()).toBe(200)
      expect(await overview.json()).toMatchObject({ owner: alice.name, name: `tools-${hash}`, description: `Made with ${hash}`, access: "public", empty: true })
      expect(await clonedObjectFormat(`${backend.origin}/${alice.name}:tools-${hash}`)).toBe(hash)
    }
    expect(await (await context.get(`${hub.url}/api/v1/repos/${alice.name}/secret`)).json()).toMatchObject({ access: "private", empty: true })
    // a private repository is hidden from everyone else
    expect((await request.get(`${hub.url}/api/v1/repos/${alice.name}/secret`)).status()).toBe(404)
  } finally {
    await context.dispose()
  }
})

test("refusals by the shared rules name their field, and nothing is created", async ({ launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  const { context, headers } = await loggedIn(hub.url, alice)
  try {
    expect((await context.post(`${hub.url}/api/v1/repos`, { headers, data: newRepo({ name: "taken" }) })).status()).toBe(201)

    const cases: Array<[Record<string, string>, number, string, string]> = [
      [newRepo({ name: "" }), 400, "validation", "name"],
      [newRepo({ name: "has space" }), 400, "validation", "name"],
      [newRepo({ name: ".." }), 400, "validation", "name"],
      [newRepo({ name: "x".repeat(33) }), 400, "validation", "name"],
      [newRepo({ name: "taken" }), 409, "conflict", "name"],
      [newRepo({ access: "internal" }), 400, "validation", "access"],
      [newRepo({ access: "" }), 400, "validation", "access"],
      [newRepo({ hash: "md5" }), 400, "validation", "hash"],
      [newRepo({ hash: "" }), 400, "validation", "hash"],
      [newRepo({ hash: "", copy: "linux" }), 400, "validation", "copy"],
      [newRepo({ hash: "sha256", copy: "alice:taken" }), 400, "validation", "hash"],
    ]
    for (const [data, status, code, field] of cases) {
      const response = await context.post(`${hub.url}/api/v1/repos`, { headers, data })
      expect(response.status(), JSON.stringify(data)).toBe(status)
      const body = (await response.json()) as ErrorBody
      expect(body.error.code).toBe(code)
      expect(Object.keys(body.error.field_errors ?? {})).toEqual([field])
    }

    // a form post, which any page can send, is refused
    const form = await context.post(`${hub.url}/api/v1/repos`, { headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" }, data: "name=form&access=public&hash=sha1" })
    expect(form.status()).toBe(400)

    const repos = await context.get(`${hub.url}/api/v1/users/${alice.name}/repos`)
    expect(((await repos.json()) as { items: Array<{ name: string }> }).items.map((repo) => repo.name)).toEqual(["taken"])
  } finally {
    await context.dispose()
  }
})

test("anonymous requests, wrong methods and local mode create nothing", async ({ launch, request }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const anonymous = await request.post(`${hub.url}/api/v1/repos`, { headers: { ...(await writeHeaders(request, hub.url)), "Content-Type": "application/json" }, data: newRepo({}) })
  expect(anonymous.status()).toBe(401)
  expect(((await anonymous.json()) as ErrorBody).error.code).toBe("unauthenticated")

  const get = await request.get(`${hub.url}/api/v1/repos`)
  expect(get.status()).toBe(405)
  expect(get.headers()["allow"]).toBe("POST")

  const local = await launch.local()
  const localHub = await launch.hub(local.port)
  const context = await playwrightRequest.newContext()
  try {
    const refused = await context.post(`${localHub.url}/api/v1/repos`, { headers: { ...(await writeHeaders(context, localHub.url)), "Content-Type": "application/json" }, data: newRepo({}) })
    expect(refused.status()).toBe(405)
    expect(((await refused.json()) as ErrorBody).error.code).toBe("unsupported")
  } finally {
    await context.dispose()
  }
})

test("a creation meant for another signed-in user is refused without creating anything", async ({ launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  const { context, headers } = await loggedIn(hub.url, alice)
  try {
    const forged = await context.post(`${hub.url}/api/v1/repos`, { headers: { ...headers, "X-Haxy-Viewer": "bobby" }, data: newRepo({}) })
    expect(forged.status()).toBe(409)
    const body = (await forged.json()) as ErrorBody
    expect(body.error.code).toBe("conflict")
    expect(body.error.field_errors).toBeUndefined()
    expect((await context.get(`${hub.url}/api/v1/repos/${alice.name}/tools`)).status()).toBe(404)
  } finally {
    await context.dispose()
  }
})

test.describe("with the demo data", () => {
  test.skip(!process.env.HAXY_E2E_DEMO_BIN, "HAXY_BIN was given without HAXY_TRY_BIN")

  test("copying a readable repository brings its files; a hidden one is refused exactly like a missing one", async ({ launch }) => {
    let backend = await launch.demo()
    const hub = await launch.hub(backend.port)
    const asAlice = await loggedIn(hub.url, demoAlice)
    const asBobby = await loggedIn(hub.url, demoBobby)
    try {
      const copied = await asAlice.context.post(`${hub.url}/api/v1/repos`, { headers: asAlice.headers, data: newRepo({ name: "my-linux", description: "A copy", hash: "", copy: "bobby:linux" }) })
      expect(copied.status()).toBe(201)
      expect(await copied.json()).toEqual({ owner: "alice", name: "my-linux" })

      // bobby's private repository is invisible to alice: the answer is a missing repository's
      const hidden = await asAlice.context.post(`${hub.url}/api/v1/repos`, { headers: asAlice.headers, data: newRepo({ name: "stolen", hash: "", copy: "bobby:neovim" }) })
      const missing = await asAlice.context.post(`${hub.url}/api/v1/repos`, { headers: asAlice.headers, data: newRepo({ name: "stolen", hash: "", copy: "bobby:no-such-repo" }) })
      expect(hidden.status()).toBe(404)
      expect(missing.status()).toBe(404)
      const hiddenBody = (await hidden.json()) as ErrorBody
      expect(hiddenBody).toEqual(await missing.json())
      expect(hiddenBody.error.code).toBe("not_found")
      expect(Object.keys(hiddenBody.error.field_errors ?? {})).toEqual(["copy"])
      expect(JSON.stringify(hiddenBody)).not.toContain("neovim")

      // its owner may copy it
      expect((await asBobby.context.post(`${hub.url}/api/v1/repos`, { headers: asBobby.headers, data: newRepo({ name: "neovim-copy", access: "private", hash: "", copy: "bobby:neovim" }) })).status()).toBe(201)

      backend = await backend.restart!()
      const source = await asAlice.context.get(`${hub.url}/api/v1/repos/bobby/linux/files`)
      const copy = await asAlice.context.get(`${hub.url}/api/v1/repos/alice/my-linux/files`)
      expect(copy.status()).toBe(200)
      const names = (body: unknown) => (body as { items: Array<{ name: string }> }).items.map((item) => item.name)
      expect(names(await copy.json())).toEqual(names(await source.json()))
      expect(names(await copy.json())).toContain("README.md")
      expect(await (await asAlice.context.get(`${hub.url}/api/v1/repos/alice/my-linux`)).json()).toMatchObject({ owner: "alice", description: "A copy", access: "public", empty: false })
      expect((await asAlice.context.get(`${hub.url}/api/v1/repos/alice/stolen`)).status()).toBe(404)
      expect((await asBobby.context.get(`${hub.url}/api/v1/repos/bobby/neovim-copy/files`)).status()).toBe(200)
    } finally {
      await asAlice.context.dispose()
      await asBobby.context.dispose()
    }
  })
})

test("the hub's proxy waits for a slow creation instead of cutting it off as unreachable", async ({ launch, request }) => {
  // Copying a large repository can outlast the proxy's 10s bound for reads.
  // Real copies are fast (a 55 MB repository copies in about 50 ms), so a
  // stand-in backend answers this one route slowly.
  const port = await launch.freePort()
  const slow = http.createServer((incoming, response) => {
    const answer = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8" })
      response.end(JSON.stringify(body))
    }
    if (incoming.url === "/api/v1/status") return answer(200, { service: "haxy", api_version: 1, mode: "server" })
    if (incoming.method === "POST" && incoming.url === "/api/v1/repos") {
      incoming.resume()
      setTimeout(() => answer(201, { owner: "alice", name: "big" }), 11_000)
      return
    }
    answer(404, { error: { code: "not_found", message: "No API route matches this path." } })
  })
  await new Promise<void>((resolve) => slow.listen(port, "127.0.0.1", resolve))
  try {
    const hub = await launch.hub(port)
    const started = Date.now()
    const created = await request.post(`${hub.url}/api/v1/repos`, { headers: { Origin: hub.url, "Content-Type": "application/json" }, data: newRepo({ name: "big", hash: "", copy: "bobby:linux" }), timeout: 30_000 })
    expect(created.status()).toBe(201)
    expect(Date.now() - started).toBeGreaterThan(10_000)
  } finally {
    slow.closeAllConnections()
    await new Promise<void>((resolve) => slow.close(() => resolve()))
  }
})
