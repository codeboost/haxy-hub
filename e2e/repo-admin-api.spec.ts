import http from "node:http"
import { request as playwrightRequest, type APIRequestContext, type PlaywrightWorkerArgs } from "@playwright/test"
import { alice, registerUser, writeHeaders, type Account } from "./support/accounts"
import type { Backend } from "./support/backend"
import { expect, test, type Launch } from "./support/fixtures"
import { createIssue } from "./support/issues"
import { pushRepo } from "./support/push"
import { createRepo, signedIn } from "./support/repos"
import { sshUser } from "./support/ssh"

// HTTP contract and authorization cases for repository administration
// (`/api/v1/repos/{owner}/{name}/settings…` and `DELETE /api/v1/repos/{owner}/{name}`)
// that the browser can't express: refusals by the shared rules, every
// main-owner-only route called directly by a granted owner, permission
// changes reaching other users' next requests, and branch protection
// enforced on a real SSH push. They drive a real Haxy through Vite's proxy.

const bob: Account = { name: "bobby", email: "bobby@example.test", password: "bobby's password" }
const carol: Account = { name: "carol", email: "carol@example.test", password: "carol's password" }

type Session = { context: APIRequestContext; headers: Record<string, string>; name: string }
type ErrorBody = { error: { code: string; message: string; field_errors?: Record<string, string> } }

/** A request context logged in as `account` through the session API, with the headers a Hub write sends. */
async function loggedIn(hubUrl: string, account: Account): Promise<Session> {
  const context = await playwrightRequest.newContext()
  const login = await context.post(`${hubUrl}/api/v1/session`, {
    headers: await writeHeaders(context, hubUrl),
    data: { username: account.name, password: account.password },
  })
  expect(login.status()).toBe(200)
  return { context, name: account.name, headers: { ...(await writeHeaders(context, hubUrl)), "Content-Type": "application/json", "X-Haxy-Viewer": account.name } }
}

/** A server with alice, bob and carol, alice's repository `tools`, and the hub in front. */
async function setUp(launch: Launch, playwright: PlaywrightWorkerArgs["playwright"], access: "public" | "private", options: { ssh?: boolean } = {}) {
  const backend = await launch.server({ ssh: options.ssh })
  for (const account of [alice, bob, carol]) await registerUser(backend, account)
  const hub = await launch.hub(backend.port)
  const owner = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  await createRepo(owner, backend, { name: "tools", description: "Handy scripts", access })
  await owner.dispose()
  return { backend, hub, api: `${hub.url}/api/v1/repos/${alice.name}/tools` }
}

async function expectError(response: Awaited<ReturnType<APIRequestContext["get"]>>, status: number, code: string, field?: string) {
  expect(response.status()).toBe(status)
  const body = (await response.json()) as ErrorBody
  expect(body.error.code).toBe(code)
  if (field) expect(Object.keys(body.error.field_errors ?? {})).toEqual([field])
  else expect(body.error.field_errors).toBeUndefined()
}

/** A settings change made from the settings `revision`, with `fields` changed. */
const settings = (revision: string, fields: Partial<Record<"description" | "access" | "discuss_role" | "issue_role" | "patch_role", string>> = {}) =>
  ({ revision, description: "Handy scripts", access: "public", discuss_role: "anybody", issue_role: "anybody", patch_role: "nobody", ...fields })

/** The settings' current revision, as the owner `session` reads it. */
const revisionOf = async (session: Session, api: string) => ((await (await session.context.get(`${api}/settings`)).json()) as { revision: string }).revision

test("an owner reads and changes the settings, and other users' next reads follow the visibility", async ({ launch, request, playwright }) => {
  let { backend, hub, api } = await setUp(launch, playwright, "public")
  const owner = await loggedIn(hub.url, alice)
  const other = await loggedIn(hub.url, bob)
  try {
    const read = await owner.context.get(`${api}/settings`)
    expect(read.status()).toBe(200)
    expect(read.headers()["cache-control"]).toBe("no-store")
    expect(await read.json()).toEqual({
      owner: alice.name, name: "tools", revision: expect.stringMatching(/^[0-9a-f]{32}$/), description: "Handy scripts", access: "public",
      discuss_role: "anybody", issue_role: "anybody", patch_role: "nobody", hash: "sha1", main_owner: alice.name,
      actions: { delete: { available: true, reason: null } },
    })
    expect((await request.get(api)).status()).toBe(200)
    expect((await other.context.get(api)).status()).toBe(200)

    const changed = await owner.context.put(`${api}/settings`, { headers: owner.headers, data: settings(await revisionOf(owner, api), { description: "Now secret", access: "private", issue_role: "members" }) })
    expect(changed.status()).toBe(200)
    expect(await changed.json()).toMatchObject({ description: "Now secret", access: "private", issue_role: "members", hash: "sha1" })

    // the very next reads by anyone else find nothing
    await expectError(await request.get(api), 404, "not_found")
    await expectError(await other.context.get(api), 404, "not_found")
    await expectError(await other.context.get(`${api}/settings`), 404, "not_found")
    await expectError(await request.get(`${api}/settings`), 404, "not_found")

    backend = await backend.restart!()
    expect(await (await owner.context.get(`${api}/settings`)).json()).toMatchObject({ description: "Now secret", access: "private", discuss_role: "anybody", issue_role: "members", patch_role: "nobody" })
    expect(await (await owner.context.get(api)).json()).toMatchObject({ access: "private", sections: expect.arrayContaining(["issues", "settings"]) })

    // turning issues off takes the section away
    await owner.context.put(`${api}/settings`, { headers: owner.headers, data: settings(await revisionOf(owner, api), { access: "public", issue_role: "nobody" }) })
    const overview = (await (await request.get(api)).json()) as { sections: string[] }
    expect(overview.sections).not.toContain("issues")
    await expectError(await request.get(`${api}/issues`), 404, "not_found")
  } finally {
    await owner.context.dispose()
    await other.context.dispose()
  }
})

test("settings refusals name their field; readers, anonymous visitors and local mode can't manage a repository", async ({ launch, request, playwright }) => {
  const { hub, api } = await setUp(launch, playwright, "public")
  const owner = await loggedIn(hub.url, alice)
  const reader = await loggedIn(hub.url, bob)
  try {
    await expectError(await owner.context.put(`${api}/settings`, { headers: owner.headers, data: settings(await revisionOf(owner, api), { access: "secret" }) }), 400, "validation", "access")
    await expectError(await owner.context.put(`${api}/settings`, { headers: owner.headers, data: settings(await revisionOf(owner, api), { discuss_role: "owners" }) }), 400, "validation", "discuss_role")
    await expectError(await owner.context.put(`${api}/settings`, { headers: owner.headers, data: settings(await revisionOf(owner, api), { patch_role: "" }) }), 400, "validation", "patch_role")
    await expectError(await owner.context.put(`${api}/settings`, { headers: owner.headers, form: settings(await revisionOf(owner, api)) }), 400, "validation")
    await expectError(await owner.context.put(`${api}/settings`, { headers: owner.headers, data: { ...settings(""), revision: undefined } }), 400, "validation", "revision")

    // a change made from settings another owner changed since writes nothing
    const loaded = await revisionOf(owner, api)
    expect((await owner.context.put(`${api}/settings`, { headers: owner.headers, data: settings(loaded, { discuss_role: "members" }) })).status()).toBe(200)
    await expectError(await owner.context.put(`${api}/settings`, { headers: owner.headers, data: settings(loaded, { description: "Stale words" }) }), 409, "conflict", "revision")
    expect(await (await owner.context.get(`${api}/settings`)).json()).toMatchObject({ description: "Handy scripts", discuss_role: "members" })
    expect(await (await owner.context.get(`${api}/settings`)).json()).toMatchObject({ access: "public", discuss_role: "members", patch_role: "nobody" })

    // a reader sees the repository but may not manage it; anonymous visitors are asked to log in
    for (const path of ["settings", "settings/members", "settings/branches"]) {
      await expectError(await reader.context.get(`${api}/${path}`), 403, "forbidden")
      await expectError(await request.get(`${api}/${path}`), 401, "unauthenticated")
    }
    await expectError(await reader.context.put(`${api}/settings`, { headers: reader.headers, data: settings(await revisionOf(owner, api), { access: "private" }) }), 403, "forbidden")
    await expectError(await reader.context.post(`${api}/settings/members`, { headers: reader.headers, data: { name: carol.name } }), 403, "forbidden")
    await expectError(await reader.context.delete(api, { headers: reader.headers, data: { confirm: `${alice.name}:tools`, password: bob.password } }), 403, "forbidden")
    expect(await (await owner.context.get(`${api}/settings`)).json()).toMatchObject({ access: "public" })

    // a missing repository and an unknown route
    await expectError(await owner.context.get(`${hub.url}/api/v1/repos/${alice.name}/nothing/settings`), 404, "not_found")
    const wrongMethod = await owner.context.post(`${api}/settings`, { headers: owner.headers, data: settings(await revisionOf(owner, api)) })
    await expectError(wrongMethod, 405, "unsupported")
    expect(wrongMethod.headers().allow).toBe("GET, HEAD, PUT")
  } finally {
    await owner.context.dispose()
    await reader.context.dispose()
  }
})

test("local mode has no repository administration", async ({ launch, request }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  const headers = await writeHeaders(request, hub.url)
  for (const path of ["settings", "settings/members", "settings/branches"]) {
    await expectError(await request.get(`${hub.url}/api/v1/repo/${path}`), 405, "unsupported")
  }
  await expectError(await request.delete(`${hub.url}/api/v1/repo`, { headers, data: { confirm: "repo", password: "x" } }), 405, "unsupported")
  // the overview still reads
  expect((await request.get(`${hub.url}/api/v1/repo`)).status()).toBe(200)
})

test("members are granted, promoted, demoted and revoked, keeping the main owner apart, and persist after a restart", async ({ launch, playwright }) => {
  let { backend, hub, api } = await setUp(launch, playwright, "private")
  const owner = await loggedIn(hub.url, alice)
  const granted = await loggedIn(hub.url, bob)
  try {
    const members = async (session: Session) => (await (await session.context.get(`${api}/settings/members`)).json()) as { main_owner: string; items: unknown[]; page: unknown }

    const added = await owner.context.post(`${api}/settings/members`, { headers: owner.headers, data: { name: bob.name } })
    expect(added.status()).toBe(201)
    expect(await added.json()).toEqual({ name: bob.name, role: "member" })
    await expectError(await owner.context.post(`${api}/settings/members`, { headers: owner.headers, data: { name: "nobody-here" } }), 404, "not_found", "name")
    await expectError(await owner.context.post(`${api}/settings/members`, { headers: owner.headers, data: { name: "" } }), 400, "validation", "name")
    await expectError(await owner.context.post(`${api}/settings/members`, { headers: owner.headers, data: { name: bob.name } }), 409, "conflict", "name")
    await expectError(await owner.context.post(`${api}/settings/members`, { headers: owner.headers, data: { name: alice.name } }), 409, "conflict", "name")
    // a member reads the private repository now, but doesn't manage it
    expect((await granted.context.get(api)).status()).toBe(200)
    await expectError(await granted.context.get(`${api}/settings/members`), 403, "forbidden")

    const promoted = await owner.context.put(`${api}/settings/members/${bob.name}`, { headers: owner.headers, data: { role: "owner" } })
    expect(await promoted.json()).toEqual({ name: bob.name, role: "owner" })
    await expectError(await owner.context.put(`${api}/settings/members/${bob.name}`, { headers: owner.headers, data: { role: "reader" } }), 400, "validation", "role")
    // a granted owner manages members too
    expect((await granted.context.post(`${api}/settings/members`, { headers: granted.headers, data: { name: carol.name } })).status()).toBe(201)

    backend = await backend.restart!()
    expect(await members(owner)).toEqual({
      main_owner: alice.name,
      items: [{ name: carol.name, role: "member" }, { name: bob.name, role: "owner" }],
      page: { has_more: false, next_cursor: null, count: { kind: "unknown" } },
    })
    const firstPage = (await (await owner.context.get(`${api}/settings/members?page_size=1`)).json()) as { items: unknown[]; page: { next_cursor: string } }
    expect(firstPage.items).toEqual([{ name: carol.name, role: "member" }])
    const secondPage = (await (await owner.context.get(`${api}/settings/members?page_size=1&cursor=${firstPage.page.next_cursor}`)).json()) as { items: unknown[]; page: { has_more: boolean } }
    expect(secondPage).toMatchObject({ items: [{ name: bob.name, role: "owner" }], page: { has_more: false } })

    expect(await (await owner.context.put(`${api}/settings/members/${bob.name}`, { headers: owner.headers, data: { role: "member" } })).json()).toEqual({ name: bob.name, role: "member" })
    expect(await (await owner.context.delete(`${api}/settings/members/${carol.name}`, { headers: owner.headers })).json()).toEqual({ name: carol.name, role: null })
    await expectError(await owner.context.delete(`${api}/settings/members/${carol.name}`, { headers: owner.headers }), 404, "not_found")
    await expectError(await owner.context.put(`${api}/settings/members/nobody-here`, { headers: owner.headers, data: { role: "owner" } }), 404, "not_found")
    backend = await backend.restart!()
    expect((await members(owner)).items).toEqual([{ name: bob.name, role: "member" }])
    // bob, demoted, no longer manages it
    await expectError(await granted.context.get(`${api}/settings/members`), 403, "forbidden")
  } finally {
    await owner.context.dispose()
    await granted.context.dispose()
  }
})

test("a granted owner can't perform main-owner-only actions through the API", async ({ launch, playwright }) => {
  let { backend, hub, api } = await setUp(launch, playwright, "public")
  const owner = await loggedIn(hub.url, alice)
  const granted = await loggedIn(hub.url, bob)
  try {
    await owner.context.post(`${api}/settings/members`, { headers: owner.headers, data: { name: bob.name } })
    await owner.context.put(`${api}/settings/members/${bob.name}`, { headers: owner.headers, data: { role: "owner" } })

    const read = (await (await granted.context.get(`${api}/settings`)).json()) as { main_owner: string; actions: { delete: { available: boolean; reason: { code: string } } } }
    expect(read.main_owner).toBe(alice.name)
    expect(read.actions.delete).toMatchObject({ available: false, reason: { code: "forbidden" } })

    // deleting, with bob's own password and the right typed name
    await expectError(await granted.context.delete(api, { headers: granted.headers, data: { confirm: `${alice.name}:tools`, password: bob.password } }), 403, "forbidden")
    // demoting or removing the main owner
    await expectError(await granted.context.put(`${api}/settings/members/${alice.name}`, { headers: granted.headers, data: { role: "member" } }), 403, "forbidden")
    await expectError(await granted.context.delete(`${api}/settings/members/${alice.name}`, { headers: granted.headers }), 403, "forbidden")

    backend = await backend.restart!()
    expect((await granted.context.get(api)).status()).toBe(200)
    expect(await (await owner.context.get(`${api}/settings`)).json()).toMatchObject({ main_owner: alice.name, actions: { delete: { available: true } } })
    expect(await (await owner.context.get(`${api}/settings/members`)).json()).toMatchObject({ items: [{ name: bob.name, role: "owner" }] })
  } finally {
    await owner.context.dispose()
    await granted.context.dispose()
  }
})

test("the main owner deletes the repository with the typed name and password, and it stays gone after a restart", async ({ launch, request, playwright }) => {
  let { backend, hub, api } = await setUp(launch, playwright, "public")
  const owner = await loggedIn(hub.url, alice)
  try {
    await expectError(await owner.context.delete(api, { headers: owner.headers, data: { confirm: "tools", password: alice.password } }), 400, "validation", "confirm")
    await expectError(await owner.context.delete(api, { headers: owner.headers, data: { confirm: `${alice.name}:tools`, password: "wrong" } }), 400, "validation", "password")
    expect((await request.get(api)).status()).toBe(200)

    const deleted = await owner.context.delete(api, { headers: owner.headers, data: { confirm: `${alice.name}:tools`, password: alice.password } })
    expect(deleted.status()).toBe(200)
    expect(await deleted.json()).toEqual({ owner: alice.name, name: "tools" })
    await expectError(await owner.context.get(api), 404, "not_found")

    backend = await backend.restart!()
    await expectError(await owner.context.get(api), 404, "not_found")
    await expectError(await request.get(api), 404, "not_found")
    const repos = (await (await request.get(`${hub.url}/api/v1/users/${alice.name}/repos`)).json()) as { items: Array<{ name: string }> }
    expect(repos.items.map((repo) => repo.name)).not.toContain("tools")
    // the name is free again
    const again = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
    await createRepo(again, backend, { name: "tools", access: "public" })
    await again.dispose()
    expect(await (await request.get(api)).json()).toMatchObject({ name: "tools", empty: true })
  } finally {
    await owner.context.dispose()
  }
})

test("after a revoke, the member's next write is refused, over Haxy's own form and over SSH", async ({ launch, playwright }) => {
  const { backend, hub, api } = await setUp(launch, playwright, "public", { ssh: true })
  const owner = await loggedIn(hub.url, alice)
  const member = await loggedIn(hub.url, bob)
  const memberForms = await signedIn(playwright, backend, hub.url, bob.name, bob.password)
  try {
    await owner.context.put(`${api}/settings`, { headers: owner.headers, data: settings(await revisionOf(owner, api), { issue_role: "members" }) })
    await owner.context.post(`${api}/settings/members`, { headers: owner.headers, data: { name: bob.name } })
    const pusher = await sshUser(backend, hub.url, member.context, bob.name)
    const work = await pusher.workTree("bob", "main", [{ "README.md": "# Tools\n" }])
    await pusher.git(work, "push", "--quiet", await pusher.remote(alice.name, "tools"), "main")
    await createIssue(memberForms, backend, `/${alice.name}:tools`, { title: "Before the revoke" })

    expect((await owner.context.delete(`${api}/settings/members/${bob.name}`, { headers: owner.headers })).status()).toBe(200)

    const refused = await memberForms.post(`${backend.origin}/${alice.name}:tools/issues/new`, { form: { title: "After the revoke", labels: "", description: "" }, maxRedirects: 0 })
    expect(refused.status()).toBe(403)
    await pusher.git(work, "commit", "--quiet", "--allow-empty", "-m", "after the revoke")
    await expect(pusher.git(work, "push", "--quiet", await pusher.remote(alice.name, "tools"), "main")).rejects.toThrow(/cannot push|unauthorized/)

    const issues = (await (await owner.context.get(`${api}/issues`)).json()) as { items: Array<{ title: string }> }
    expect(issues.items.map((issue) => issue.title)).toEqual(["Before the revoke"])
  } finally {
    await owner.context.dispose()
    await member.context.dispose()
    await memberForms.dispose()
  }
})

test("an owner demoted meanwhile can't change anything with their next request", async ({ launch, playwright }) => {
  const { hub, api } = await setUp(launch, playwright, "public")
  const owner = await loggedIn(hub.url, alice)
  const granted = await loggedIn(hub.url, bob)
  try {
    await owner.context.post(`${api}/settings/members`, { headers: owner.headers, data: { name: bob.name } })
    await owner.context.put(`${api}/settings/members/${bob.name}`, { headers: owner.headers, data: { role: "owner" } })
    expect((await granted.context.put(`${api}/settings`, { headers: granted.headers, data: settings(await revisionOf(owner, api), { description: "by bob" }) })).status()).toBe(200)

    await owner.context.put(`${api}/settings/members/${bob.name}`, { headers: owner.headers, data: { role: "member" } })
    await expectError(await granted.context.put(`${api}/settings`, { headers: granted.headers, data: settings(await revisionOf(owner, api), { access: "private" }) }), 403, "forbidden")
    await expectError(await granted.context.post(`${api}/settings/members`, { headers: granted.headers, data: { name: carol.name } }), 403, "forbidden")
    await expectError(await granted.context.delete(`${api}/settings/members/${bob.name}`, { headers: granted.headers }), 403, "forbidden")
    expect(await (await owner.context.get(`${api}/settings`)).json()).toMatchObject({ description: "by bob", access: "public" })
  } finally {
    await owner.context.dispose()
    await granted.context.dispose()
  }
})

/**
 * Sends a JSON write whose body follows only once `beforeBody` resolves, so
 * Haxy has authorized the request and waits for its body meanwhile. Answers
 * with the status. It goes to the backend itself, as from its own origin:
 * Vite's proxy holds a request's headers back until its body comes, so the
 * wait would happen before Haxy saw the request at all.
 */
async function slowWrite(session: Session, backend: Backend, path: string, method: string, body: unknown, beforeBody: () => Promise<void>): Promise<number> {
  const url = `${backend.origin}${path}`
  const cookies = (await session.context.storageState()).cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
  const text = JSON.stringify(body)
  return new Promise<number>((resolve, reject) => {
    const request = http.request(url, { method, headers: { ...session.headers, Origin: backend.origin, Cookie: cookies, "Content-Length": Buffer.byteLength(text) } }, (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    request.on("error", reject)
    request.flushHeaders()
    beforeBody().then(() => request.end(text), reject)
  })
}

test("an owner demoted while their default-branch change waits for its body moves nothing", async ({ launch, playwright }) => {
  const { backend, hub, api } = await setUp(launch, playwright, "public", { ssh: true })
  await pushRepo(playwright, backend, hub.url, alice, { owner: alice.name, name: "tools" }, { refs: [{ kind: "branch", name: "dev", files: { "dev.txt": "dev\n" } }] })
  const owner = await loggedIn(hub.url, alice)
  const granted = await loggedIn(hub.url, bob)
  try {
    await owner.context.post(`${api}/settings/members`, { headers: owner.headers, data: { name: bob.name } })
    await owner.context.put(`${api}/settings/members/${bob.name}`, { headers: owner.headers, data: { role: "owner" } })
    const status = await slowWrite(granted, backend, `/api/v1/repos/${alice.name}/tools/settings/branches/default`, "PUT", { ref: "branch:dev" }, async () => {
      // Haxy has authorized bob by now and is reading the body
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect((await owner.context.put(`${api}/settings/members/${bob.name}`, { headers: owner.headers, data: { role: "member" } })).status()).toBe(200)
    })
    expect(status).toBe(403)
    expect(await (await owner.context.get(`${api}/settings/branches`)).json()).toMatchObject({ default_branch: { name: "main" } })
    expect(await (await owner.context.get(api)).json()).toMatchObject({ default_branch: "main" })
  } finally {
    await owner.context.dispose()
    await granted.context.dispose()
  }
})

/** alice's repository `tools` with `main` (two commits) and `dev` pushed over SSH. */
async function pushedRepo(backend: Backend, hubUrl: string) {
  const owner = await loggedIn(hubUrl, alice)
  const git = await sshUser(backend, hubUrl, owner.context, alice.name)
  const work = await git.workTree("tools", "main", [{ "README.md": "# Main\n" }, { "notes.txt": "two\n" }])
  await git.git(work, "push", "--quiet", await git.remote(alice.name, "tools"), "main")
  await git.git(work, "checkout", "--quiet", "-b", "dev")
  await git.git(work, "commit", "--quiet", "--allow-empty", "-m", "dev only")
  await git.git(work, "push", "--quiet", await git.remote(alice.name, "tools"), "dev")
  await git.git(work, "checkout", "--quiet", "main")
  return { owner, git, work }
}

test("the default branch changes the landing view, and a protected branch refuses a force-push over SSH", async ({ launch, request, playwright }) => {
  let { backend, hub, api } = await setUp(launch, playwright, "public", { ssh: true })
  const { owner, git, work } = await pushedRepo(backend, hub.url)
  try {
    expect(await (await owner.context.get(`${api}/settings/branches`)).json()).toEqual({ default_branch: { name: "main", id: "branch:main" }, protected: [], max_protected: 50 })

    const changed = await owner.context.put(`${api}/settings/branches/default`, { headers: owner.headers, data: { ref: "branch:dev" } })
    expect(changed.status()).toBe(200)
    expect(await changed.json()).toMatchObject({ default_branch: { name: "dev", id: "branch:dev" } })
    expect(await (await request.get(api)).json()).toMatchObject({ default_branch: "dev" })
    expect(await (await request.get(`${api}/files`)).json()).toMatchObject({ ref: { kind: "branch", name: "dev", id: "branch:dev" } })

    await expectError(await owner.context.put(`${api}/settings/branches/default`, { headers: owner.headers, data: { ref: "branch:nothing" } }), 404, "not_found", "ref")
    await expectError(await owner.context.put(`${api}/settings/branches/default`, { headers: owner.headers, data: { ref: "tag:v1" } }), 400, "validation", "ref")

    const revision = await revisionOf(owner, api)
    const protectedMain = await owner.context.post(`${api}/settings/branches/protected`, { headers: owner.headers, data: { ref: "branch:main" } })
    expect(protectedMain.status()).toBe(201)
    expect(await protectedMain.json()).toMatchObject({ protected: [{ name: "main", id: "branch:main" }] })
    await expectError(await owner.context.post(`${api}/settings/branches/protected`, { headers: owner.headers, data: { ref: "branch:main" } }), 409, "conflict", "ref")
    // protecting a branch changes no setting, so a settings form loaded before stays current
    expect(await revisionOf(owner, api)).toBe(revision)
    await expectError(await owner.context.post(`${api}/settings/branches/protected`, { headers: owner.headers, data: { ref: "branch:nothing" } }), 404, "not_found", "ref")

    backend = await backend.restart!()
    expect(await (await owner.context.get(`${api}/settings/branches`)).json()).toMatchObject({ default_branch: { name: "dev" }, protected: [{ name: "main" }] })

    // rewrite main's history and force it: refused, and main keeps its commit
    const before = (await git.git(work, "ls-remote", await git.remote(alice.name, "tools"), "refs/heads/main")).split(/\s/)[0]
    await git.git(work, "reset", "--quiet", "--hard", "HEAD~1")
    await git.git(work, "commit", "--quiet", "--allow-empty", "-m", "rewritten")
    await expect(git.git(work, "push", "--quiet", "--force", await git.remote(alice.name, "tools"), "main")).rejects.toThrow(/main/)
    expect((await git.git(work, "ls-remote", await git.remote(alice.name, "tools"), "refs/heads/main")).split(/\s/)[0]).toBe(before)

    // unprotected, the same force-push lands
    const unprotected = await owner.context.delete(`${api}/settings/branches/protected?ref=branch:main`, { headers: owner.headers })
    expect(await unprotected.json()).toMatchObject({ protected: [] })
    // unprotecting again changes nothing
    expect((await owner.context.delete(`${api}/settings/branches/protected?ref=branch:main`, { headers: owner.headers })).status()).toBe(200)
    await git.git(work, "push", "--quiet", "--force", await git.remote(alice.name, "tools"), "main")
    expect((await git.git(work, "ls-remote", await git.remote(alice.name, "tools"), "refs/heads/main")).split(/\s/)[0]).not.toBe(before)
  } finally {
    await owner.context.dispose()
  }
})
