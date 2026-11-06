import http from "node:http"
import type { APIRequestContext, APIResponse } from "@playwright/test"
import { expect, test } from "./support/fixtures"
import { alice, registerUser, writeHeaders, type Account } from "./support/accounts"
import { createIssue, removeIssue, tuiIssuePage } from "./support/issues"
import { createRepo, signedIn } from "./support/repos"
import type { Backend } from "./support/backend"

// HTTP contract checks for the attachment routes every thread kind shares,
// through the same Vite proxy the browser uses. Every write is checked again
// in Haxy's own server-rendered issue page (the TUI's), and downloads through
// Haxy's own attachment URLs too, which share the same read check.

const bob: Account = { name: "bobby", email: "bobby@example.test", password: "battery staple horse" }
const hexId = expect.stringMatching(/^[0-9a-f]{32}$/)
const maxBytes = 10 * 1024 * 1024

type Availability = { available: boolean; reason?: { code: string; message: string } }
type Attachment = { id: string; name: string; content_type: string; inline: boolean; actions: { remove: Availability } }
type Detail = { id: string; attachments: Attachment[]; attachment_limits: { max_bytes: number; max_name_bytes: number }; actions: Record<string, Availability> }

function newId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** Uploads `bytes` as `name` (query parameters as Hub sends them), with a same-origin page's CSRF token. */
async function upload(request: APIRequestContext, hubUrl: string, thread: string, bytes: Buffer, params: { name?: string; id?: string }): Promise<APIResponse> {
  const query = new URLSearchParams()
  if (params.name !== undefined) query.set("name", params.name)
  if (params.id !== undefined) query.set("id", params.id)
  const headers = { ...(await writeHeaders(request, hubUrl)), "Content-Type": "application/octet-stream" }
  return request.fetch(`${hubUrl}${thread}/attachments?${query.toString().replace(/\+/g, "%20")}`, { method: "POST", headers, data: bytes })
}

async function send(request: APIRequestContext, hubUrl: string, method: string, path: string): Promise<APIResponse> {
  return request.fetch(`${hubUrl}${path}`, { method, headers: await writeHeaders(request, hubUrl) })
}

/** A repository of alice's with one issue of hers, and bob registered too; both signed in. */
async function aliceAndBob(playwright: Parameters<typeof signedIn>[0], backend: Backend, hubUrl: string, access: "public" | "private" = "public") {
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const owner = await signedIn(playwright, backend, hubUrl, alice.name, alice.password)
  const other = await signedIn(playwright, backend, hubUrl, bob.name, bob.password)
  await createRepo(owner, backend, { name: "tracker", access })
  const issue = await createIssue(owner, backend, "/alice:tracker", { title: "Crash on save" })
  return { owner, other, issue, thread: `/api/v1/repos/alice/tracker/issues/${issue}` }
}

test("an issue's author attaches a file; it is listed, downloads with its name and type, shows in Haxy's own page, and its removal lasts", async ({ playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, other, issue, thread } = await aliceAndBob(playwright, backend, hub.url)

  const loaded: Detail = await (await owner.get(`${hub.url}${thread}`)).json()
  expect(loaded.attachments).toEqual([])
  expect(loaded.attachment_limits).toEqual({ max_bytes: maxBytes, max_name_bytes: 255 })
  expect(loaded.actions.attach).toEqual({ available: true })

  const id = newId()
  const bytes = Buffer.from("it crashed at line 3\n")
  const uploaded = await upload(owner, hub.url, thread, bytes, { name: "crash log.txt", id })
  expect(uploaded.status(), await uploaded.text()).toBe(201)
  const detail: Detail = await uploaded.json()
  expect(detail.id).toBe(issue)
  expect(detail.attachments).toEqual([{ id, name: "crash log.txt", content_type: "text/plain; charset=utf-8", inline: false, actions: { remove: { available: true } } }])
  expect(await tuiIssuePage(backend, "/alice:tracker", issue)).toContain("crash log.txt")

  // the same upload again (a retry after a lost answer) attaches nothing more
  const again = await upload(owner, hub.url, thread, bytes, { name: "crash log.txt", id })
  expect(again.status()).toBe(409)
  expect((await again.json()).error).toMatchObject({ code: "conflict", field_errors: { id: "An event in this repository already has this id." } })

  // anyone who can read the repository downloads it, named, typed and never sniffed
  const anonymous = await playwright.request.newContext()
  for (const reader of [owner, other, anonymous]) {
    const download = await reader.get(`${hub.url}${thread}/attachments/${id}`)
    expect(download.status()).toBe(200)
    expect(await download.body()).toEqual(bytes)
    expect(download.headers()).toMatchObject({
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": "attachment; filename=\"crash log.txt\"; filename*=UTF-8''crash%20log.txt",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "cache-control": "private, no-store",
    })
  }
  await anonymous.dispose()
  const head = await owner.fetch(`${hub.url}${thread}/attachments/${id}`, { method: "HEAD" })
  expect(head.status()).toBe(200)
  expect(head.headers()["content-length"]).toBe(String(bytes.length))
  // Haxy's own attachment URL serves the same bytes the same way
  const own = await fetch(`${backend.origin}/alice:tracker/attachment:${id}`)
  expect(own.status).toBe(200)
  expect(own.headers.get("content-disposition")).toBe("attachment; filename=\"crash log.txt\"; filename*=UTF-8''crash%20log.txt")
  expect(own.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox")

  // bob may read it but not remove it
  const bobs: Detail = await (await other.get(`${hub.url}${thread}`)).json()
  expect(bobs.attachments[0].actions.remove).toEqual({ available: false, reason: { code: "forbidden", message: "Only the attachment's author and the repository's writers can remove it." } })
  const refused = await send(other, hub.url, "DELETE", `${thread}/attachments/${id}`)
  expect(refused.status()).toBe(403)
  // one that isn't there is not found, before any rights are checked
  const unknown = await send(other, hub.url, "DELETE", `${thread}/attachments/${newId()}`)
  expect(unknown.status()).toBe(404)
  expect(await unknown.json()).toEqual({ error: { code: "not_found", message: "There is no attachment with this id on this issue." } })

  const restarted = await backend.restart!()
  const removed = await send(owner, hub.url, "DELETE", `${thread}/attachments/${id}`)
  expect(removed.status(), await removed.text()).toBe(200)
  expect((await removed.json() as Detail).attachments).toEqual([])
  expect(await tuiIssuePage(restarted, "/alice:tracker", issue)).not.toContain("crash log.txt")
  const gone = await owner.get(`${hub.url}${thread}/attachments/${id}`)
  expect(gone.status()).toBe(404)
  expect(await gone.json()).toEqual({ error: { code: "not_found", message: "There is no attachment with this id on this issue." } })
  expect((await fetch(`${restarted.origin}/alice:tracker/attachment:${id}`)).status).toBe(404)
  // removing it again changes nothing, and says so
  const twice = await send(owner, hub.url, "DELETE", `${thread}/attachments/${id}`)
  expect(twice.status()).toBe(404)
  expect((await (await owner.get(`${hub.url}${thread}`)).json() as Detail).attachments).toEqual([])
  await owner.dispose()
  await other.dispose()
})

test("only images on the safe list open inline; active content downloads as opaque bytes", async ({ playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, other, thread } = await aliceAndBob(playwright, backend, hub.url)

  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5d9b6d50000000049454e44ae426082", "hex")
  const cases = [
    { name: "shot.png", bytes: png, type: "image/png", disposition: "inline; filename=\"shot.png\"; filename*=UTF-8''shot.png" },
    { name: "page.html", bytes: Buffer.from("<script>alert(1)</script>"), type: "application/octet-stream", disposition: "attachment; filename=\"page.html\"; filename*=UTF-8''page.html" },
    { name: "logo.svg", bytes: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"), type: "application/octet-stream", disposition: "attachment; filename=\"logo.svg\"; filename*=UTF-8''logo.svg" },
    { name: "café.js", bytes: Buffer.from("alert(1)"), type: "application/octet-stream", disposition: "attachment; filename=\"caf__.js\"; filename*=UTF-8''caf%C3%A9.js" },
  ]
  for (const file of cases) {
    const uploaded = await upload(owner, hub.url, thread, file.bytes, { name: file.name })
    expect(uploaded.status(), await uploaded.text()).toBe(201)
    const listed = (await uploaded.json() as Detail).attachments.find((attachment) => attachment.name === file.name)!
    expect(listed).toEqual({ id: hexId, name: file.name, content_type: file.type, inline: file.type === "image/png", actions: { remove: { available: true } } })
    const download = await other.get(`${hub.url}${thread}/attachments/${listed.id}`)
    expect(download.status()).toBe(200)
    expect(await download.body()).toEqual(file.bytes)
    expect(download.headers()["content-type"], file.name).toBe(file.type)
    expect(download.headers()["content-disposition"], file.name).toBe(file.disposition)
    expect(download.headers()["x-content-type-options"]).toBe("nosniff")
  }
  // listed oldest first, as the TUI lists them
  const read: Detail = await (await other.get(`${hub.url}${thread}`)).json()
  expect(read.attachments.map((attachment) => attachment.name)).toEqual(cases.map((file) => file.name))
  await owner.dispose()
  await other.dispose()
})

test("a private repository's attachments are not found to anyone who can't read it, by direct URL too", async ({ playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, other, issue, thread } = await aliceAndBob(playwright, backend, hub.url, "private")
  const id = newId()
  expect((await upload(owner, hub.url, thread, Buffer.from("secret"), { name: "secret.txt", id })).status()).toBe(201)
  expect((await owner.get(`${hub.url}${thread}/attachments/${id}`)).status()).toBe(200)

  const notFound = { error: { code: "not_found", message: "There is no repository with this name." } }
  const anonymous = await playwright.request.newContext()
  for (const reader of [other, anonymous]) {
    const download = await reader.get(`${hub.url}${thread}/attachments/${id}`)
    expect(download.status()).toBe(404)
    expect(await download.json()).toEqual(notFound)
    // an id that names nothing answers the same
    expect(await (await reader.get(`${hub.url}${thread}/attachments/${newId()}`)).json()).toEqual(notFound)
    expect((await send(reader, hub.url, "DELETE", `${thread}/attachments/${id}`)).status()).toBe(404)
    const sneaked = await upload(reader, hub.url, thread, Buffer.from("x"), { name: "x.txt" })
    expect(sneaked.status()).toBe(404)
    expect(await sneaked.json()).toEqual(notFound)
  }
  // Haxy's own URL hides it too, logged out or as bob
  expect((await fetch(`${backend.origin}/alice:tracker/attachment:${id}`)).status).toBe(404)
  expect((await other.get(`${backend.origin}/alice:tracker/attachment:${id}`)).status()).toBe(404)

  // a removed issue's attachments are gone with it
  await removeIssue(owner, backend, "/alice:tracker", issue)
  expect((await owner.get(`${hub.url}${thread}/attachments/${id}`)).status()).toBe(404)
  expect((await owner.get(`${backend.origin}/alice:tracker/attachment:${id}`)).status()).toBe(404)
  await anonymous.dispose()
  await owner.dispose()
  await other.dispose()
})

test("uploads that break the rules are refused with typed errors, and nothing is attached", async ({ playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, other, thread } = await aliceAndBob(playwright, backend, hub.url)
  const check = "Check the highlighted fields."

  const tooLarge = await upload(owner, hub.url, thread, Buffer.alloc(maxBytes + 1, 1), { name: "big.bin" })
  expect(tooLarge.status()).toBe(413)
  expect(await tooLarge.json()).toEqual({ error: { code: "validation", message: check, field_errors: { file: "Files can be up to 10 MB." } } })
  for (const [params, bytes, field, message] of [
    [{ name: "empty.txt" }, Buffer.alloc(0), "file", "The file is empty."],
    [{}, Buffer.from("x"), "name", "Name the file."],
    [{ name: "a/b.txt" }, Buffer.from("x"), "name", "A file name can be up to 255 bytes, without slashes or control characters, and not . or .."],
    [{ name: ".." }, Buffer.from("x"), "name", "A file name can be up to 255 bytes, without slashes or control characters, and not . or .."],
    [{ name: "n".repeat(256) }, Buffer.from("x"), "name", "A file name can be up to 255 bytes, without slashes or control characters, and not . or .."],
    [{ name: "ok.txt", id: "not-hex" }, Buffer.from("x"), "id", "Leave the id out, or send 32 lowercase hex digits."],
  ] as const) {
    const refused = await upload(owner, hub.url, thread, bytes, params)
    expect(refused.status(), JSON.stringify(params)).toBe(400)
    expect(await refused.json()).toEqual({ error: { code: "validation", message: check, field_errors: { [field]: message } } })
  }

  // the exact limit is allowed
  const atLimit = await upload(owner, hub.url, thread, Buffer.alloc(maxBytes, 2), { name: "exact.bin" })
  expect(atLimit.status(), await atLimit.text()).toBe(201)

  // bob may read the issue but didn't open it, and anonymous viewers must log in
  const forbidden = await upload(other, hub.url, thread, Buffer.from("x"), { name: "bobs.txt" })
  expect(forbidden.status()).toBe(403)
  expect(await forbidden.json()).toEqual({ error: { code: "forbidden", message: "Only the issue's author and the repository's writers can attach files to it." } })
  const bobs: Detail = await (await other.get(`${hub.url}${thread}`)).json()
  expect(bobs.actions.attach).toEqual({ available: false, reason: { code: "forbidden", message: "Only the issue's author and the repository's writers can attach files to it." } })
  const anonymous = await playwright.request.newContext()
  const loggedOut = await upload(anonymous, hub.url, thread, Buffer.from("x"), { name: "anon.txt" })
  expect(loggedOut.status()).toBe(401)
  expect((await loggedOut.json()).error.code).toBe("unauthenticated")

  // an issue that doesn't exist takes nothing
  const missing = await upload(owner, hub.url, `/api/v1/repos/alice/tracker/issues/${newId()}`, Buffer.from("x"), { name: "x.txt" })
  expect(missing.status()).toBe(404)
  expect(await missing.json()).toEqual({ error: { code: "not_found", message: "There is no issue with this id." } })
  // other methods are refused
  const wrong = await owner.get(`${hub.url}${thread}/attachments`)
  expect(wrong.status()).toBe(405)
  expect(wrong.headers().allow).toBe("POST")
  expect((await send(owner, hub.url, "PUT", `${thread}/attachments/${newId()}`)).headers().allow).toBe("GET, HEAD, DELETE")

  const read: Detail = await (await owner.get(`${hub.url}${thread}`)).json()
  expect(read.attachments.map((attachment) => attachment.name)).toEqual(["exact.bin"])
  await anonymous.dispose()
  await owner.dispose()
  await other.dispose()
})

test("local mode attaches without logging in, and removes, as its repository's owner", async ({ request, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  const issue = await createIssue(request, backend, "", { title: "Offline bug" })
  const thread = `/api/v1/repo/issues/${issue}`
  const uploaded = await upload(request, hub.url, thread, Buffer.from("offline"), { name: "notes.md" })
  expect(uploaded.status(), await uploaded.text()).toBe(201)
  const [attachment] = (await uploaded.json() as Detail).attachments
  expect(attachment).toEqual({ id: hexId, name: "notes.md", content_type: "text/markdown; charset=utf-8", inline: false, actions: { remove: { available: true } } })
  expect(await (await request.get(`${hub.url}${thread}/attachments/${attachment.id}`)).text()).toBe("offline")
  expect(await tuiIssuePage(backend, "", issue)).toContain("notes.md")
  const removed = await send(request, hub.url, "DELETE", `${thread}/attachments/${attachment.id}`)
  expect(removed.status(), await removed.text()).toBe(200)
  expect(await tuiIssuePage(backend, "", issue)).not.toContain("notes.md")
})

test("the hub's proxy waits for a slow upload or download instead of cutting it off as unreachable", async ({ launch, request }) => {
  // A file can take longer than the proxy's 10s bound for reads to arrive
  // on a slow link. A stand-in backend answers the attachment routes slowly.
  const port = await launch.freePort()
  const thread = `/api/v1/repos/alice/tracker/issues/${newId()}`
  const slow = http.createServer((incoming, response) => {
    const answer = (code: number, body: string, type = "application/json; charset=utf-8") => {
      response.writeHead(code, { "content-type": type })
      response.end(body)
    }
    if (incoming.url === "/api/v1/status") return answer(200, JSON.stringify({ service: "haxy", api_version: 1, mode: "server" }))
    if (incoming.url?.startsWith(`${thread}/attachments`)) {
      incoming.resume()
      setTimeout(() => answer(incoming.method === "POST" ? 201 : 200, incoming.method === "POST" ? "{}" : "bytes", incoming.method === "POST" ? undefined : "application/octet-stream"), 11_000)
      return
    }
    answer(404, JSON.stringify({ error: { code: "not_found", message: "No API route matches this path." } }))
  })
  await new Promise<void>((resolve) => slow.listen(port, "127.0.0.1", resolve))
  try {
    const hub = await launch.hub(port)
    const started = Date.now()
    const [uploaded, downloaded] = await Promise.all([
      request.post(`${hub.url}${thread}/attachments?name=big.bin&id=${newId()}`, { headers: { Origin: hub.url }, data: Buffer.from("x"), timeout: 30_000 }),
      request.get(`${hub.url}${thread}/attachments/${newId()}`, { timeout: 30_000 }),
    ])
    expect(uploaded.status()).toBe(201)
    expect(downloaded.status()).toBe(200)
    expect(Date.now() - started).toBeGreaterThan(10_000)
  } finally {
    slow.closeAllConnections()
    await new Promise<void>((resolve) => slow.close(() => resolve()))
  }
})
