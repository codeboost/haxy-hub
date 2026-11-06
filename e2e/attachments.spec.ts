import { readFile } from "node:fs/promises"
import type { Page, Route } from "@playwright/test"
import { alice, registerUser, type Account } from "./support/accounts"
import { expect, test } from "./support/fixtures"
import { createIssue, tuiIssuePage } from "./support/issues"
import { createRepo, grantMember, revokeMember, signedIn } from "./support/repos"

// Attaching, opening, downloading and removing files in the browser, through
// Vite's proxy against a real Haxy. Every change is checked again after a
// refresh and in Haxy's own server-rendered issue page (the TUI's).

const bob: Account = { name: "bobby", email: "bobby@example.test", password: "bobby's password" }
const maxBytes = 10 * 1024 * 1024
const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5d9b6d50000000049454e44ae426082", "hex")

const header = (page: Page) => page.getByRole("banner")
const attachments = (page: Page) => page.getByRole("region", { name: "Attachments" })
const listed = (page: Page) => attachments(page).getByRole("list", { name: "Attached files" }).getByRole("link")
const form = (page: Page) => page.getByRole("form", { name: "Attach a file" })
const uploads = /\/issues\/[0-9a-f]{32}\/attachments\?/
const removals = /\/issues\/[0-9a-f]{32}\/attachments\/[0-9a-f]{32}$/

async function logIn(page: Page, hubUrl: string, account: Account, next: string) {
  await page.goto(`${hubUrl}/login?next=${encodeURIComponent(next)}`)
  await page.getByLabel("Username").fill(account.name)
  await page.getByLabel("Password").fill(account.password)
  await page.getByRole("button", { name: "Log in" }).click()
  await expect(header(page)).toContainText(`Signed in as ${account.name}`)
}

async function attach(page: Page, name: string, buffer: Buffer, mimeType = "application/octet-stream") {
  await form(page).getByLabel("Attach a file").setInputFiles({ name, mimeType, buffer })
  await form(page).getByRole("button", { name: "Attach file" }).click()
}

/** Handles the first `method` request matching `pattern`; the route never expires (see e2e/comments.spec.ts). */
async function onFirst(page: Page, pattern: RegExp, method: string, handler: (route: Route) => Promise<void>) {
  let pending = true
  await page.route(pattern, async (route) => {
    if (route.request().method() !== method || !pending) return route.fallback()
    pending = false
    await handler(route)
  })
}

/** Lets a request reach Haxy, then loses its answer on the way back (502: outcome unknown). */
async function answerLost(route: Route) {
  await route.fetch()
  await route.fulfill({ status: 502, body: "" })
}

test("the author attaches files, downloads one under its name, opens an image in place, and removes one after confirming", async ({ page, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  await logIn(page, hub.url, alice, "/")
  await createRepo(page.context().request, backend, { name: "tracker", access: "public" })
  const id = await createIssue(page.context().request, backend, "/alice:tracker", { title: "Crash on save" })

  await page.goto(`${hub.url}/repos/alice/tracker/issues/${id}`)
  await expect(attachments(page).getByText("Nothing is attached to this issue.")).toBeVisible()
  await expect(form(page).getByText("Up to 10 MB.")).toBeVisible()
  await attach(page, "crash log.txt", Buffer.from("it crashed\n"), "text/plain")
  await expect(listed(page)).toHaveText(["crash log.txt"])
  await attach(page, "shot.png", png, "image/png")
  await expect(listed(page)).toHaveText(["crash log.txt", "shot.png"])

  await page.reload()
  await expect(listed(page)).toHaveText(["crash log.txt", "shot.png"])
  const tui = await tuiIssuePage(backend, "/alice:tracker", id)
  expect(tui).toContain("crash log.txt")
  expect(tui).toContain("shot.png")

  // a file downloads under its own name, with its bytes
  const downloading = page.waitForEvent("download")
  await listed(page).getByText("crash log.txt").click()
  const download = await downloading
  expect(download.suggestedFilename()).toBe("crash log.txt")
  expect(await readFile(await download.path())).toEqual(Buffer.from("it crashed\n"))

  // an image opens in a new tab, as an image
  const opening = page.context().waitForEvent("page")
  await listed(page).getByText("shot.png").click()
  const image = await opening
  await image.waitForLoadState()
  expect(image.url()).toMatch(new RegExp(`/api/v1/repos/alice/tracker/issues/${id}/attachments/[0-9a-f]{32}$`))
  const shown = await page.request.get(image.url())
  expect(shown.headers()["content-type"]).toBe("image/png")
  expect(shown.headers()["content-disposition"]).toBe("inline; filename=\"shot.png\"; filename*=UTF-8''shot.png")
  await image.close()

  // removing asks first; cancelling keeps it
  await attachments(page).getByRole("button", { name: "Remove crash log.txt" }).click()
  const confirm = attachments(page).getByRole("alertdialog", { name: "Remove crash log.txt?" })
  await expect(confirm).toContainText("It disappears from this issue for everyone.")
  await confirm.getByRole("button", { name: "Cancel" }).click()
  await expect(confirm).toHaveCount(0)
  await expect(listed(page)).toHaveText(["crash log.txt", "shot.png"])
  await attachments(page).getByRole("button", { name: "Remove crash log.txt" }).click()
  await confirm.getByRole("button", { name: "Remove attachment" }).click()
  await expect(listed(page)).toHaveText(["shot.png"])

  await page.reload()
  await expect(listed(page)).toHaveText(["shot.png"])
  expect(await tuiIssuePage(backend, "/alice:tracker", id)).not.toContain("crash log.txt")
})

test("files Haxy would refuse are refused before sending, and Haxy's own refusals show beside the file", async ({ page, launch, playwright }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const owner = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  await createRepo(owner, backend, { name: "tracker", access: "public" })
  await grantMember(owner, backend, { owner: "alice", name: "tracker" }, "bobby")
  const id = await createIssue(owner, backend, "/alice:tracker", { title: "Crash on save" })
  await logIn(page, hub.url, bob, `/repos/alice/tracker/issues/${id}`)
  await expect(form(page)).toBeVisible()

  let sent = 0
  page.on("request", (request) => { if (request.method() === "POST" && uploads.test(request.url())) sent++ })
  // each refusal is announced, and the file input says it is invalid
  await attach(page, "empty.txt", Buffer.alloc(0))
  await expect(form(page).getByRole("alert")).toHaveText("The file is empty.")
  await expect(form(page).getByLabel("Attach a file")).toHaveAttribute("aria-invalid", "true")
  await attach(page, "big.bin", Buffer.alloc(maxBytes + 1))
  await expect(form(page).getByRole("alert")).toHaveText("Files can be up to 10 MB; this one is 10,485,761 bytes.")
  expect(sent).toBe(0)

  // Haxy's limit is the authority: a file it finds too large is refused beside the field
  await onFirst(page, uploads, "POST", (route) => route.continue({ postData: Buffer.alloc(maxBytes + 1, 1) }))
  await attach(page, "fits.bin", Buffer.alloc(16, 1))
  await expect(form(page).getByRole("alert")).toHaveText("Files can be up to 10 MB.")
  expect(sent).toBe(1)

  // bob loses his role after the page loaded: Haxy refuses, and nothing is attached
  await revokeMember(owner, backend, { owner: "alice", name: "tracker" }, "bobby")
  await attach(page, "late.txt", Buffer.from("late"))
  await expect(attachments(page).getByText("Only the issue's author and the repository's writers can attach files to it.")).toBeVisible()
  await page.reload()
  await expect(attachments(page)).toHaveCount(0)
  expect(await tuiIssuePage(backend, "/alice:tracker", id)).not.toContain("fits.bin")
  await owner.dispose()
})

test("a reader sees and opens attachments but is offered no upload or removal", async ({ page, launch, playwright }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const owner = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  await createRepo(owner, backend, { name: "tracker", access: "public" })
  const id = await createIssue(owner, backend, "/alice:tracker", { title: "Crash on save" })
  const query = new URLSearchParams({ name: "notes.txt" })
  const csrf = (await (await owner.get(`${hub.url}/api/v1/session`)).json()).csrf_token as string
  const uploaded = await owner.post(`${hub.url}/api/v1/repos/alice/tracker/issues/${id}/attachments?${query}`, { headers: { "X-Haxy-CSRF": csrf, Origin: hub.url }, data: Buffer.from("notes") })
  expect(uploaded.status()).toBe(201)

  await logIn(page, hub.url, bob, `/repos/alice/tracker/issues/${id}`)
  await expect(listed(page)).toHaveText(["notes.txt"])
  await expect(form(page)).toHaveCount(0)
  await expect(attachments(page).getByRole("button", { name: /^Remove/ })).toHaveCount(0)
  await owner.dispose()
})

test("an upload or a removal whose answer is lost is settled by reading the issue, never doubled", async ({ page, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  await logIn(page, hub.url, alice, "/")
  await createRepo(page.context().request, backend, { name: "tracker", access: "public" })
  const id = await createIssue(page.context().request, backend, "/alice:tracker", { title: "Crash on save" })
  await page.goto(`${hub.url}/repos/alice/tracker/issues/${id}`)

  // Haxy attaches it, but its answer never arrives: reading the issue finds it
  await onFirst(page, uploads, "POST", answerLost)
  await attach(page, "lost.txt", Buffer.from("lost"))
  await expect(attachments(page).getByText("lost.txt is attached.")).toBeVisible()
  await expect(listed(page)).toHaveText(["lost.txt"])

  // the request never reaches Haxy: it isn't attached, and attaching again sends the same upload once
  await onFirst(page, uploads, "POST", (route) => route.abort("connectionreset"))
  await attach(page, "never.txt", Buffer.from("never"))
  await expect(attachments(page).getByText("It isn't attached now; attaching it again is safe.")).toBeVisible()
  await expect(listed(page)).toHaveText(["lost.txt"])
  await form(page).getByRole("button", { name: "Attach file" }).click()
  await expect(listed(page)).toHaveText(["lost.txt", "never.txt"])

  // a removal whose answer is lost: the read shows it gone
  await onFirst(page, removals, "DELETE", answerLost)
  await attachments(page).getByRole("button", { name: "Remove lost.txt" }).click()
  await attachments(page).getByRole("alertdialog").getByRole("button", { name: "Remove attachment" }).click()
  await expect(attachments(page).getByText("lost.txt was removed.")).toBeVisible()
  await expect(listed(page)).toHaveText(["never.txt"])

  await page.reload()
  await expect(listed(page)).toHaveText(["never.txt"])
  const tui = await tuiIssuePage(backend, "/alice:tracker", id)
  expect(tui).not.toContain("lost.txt")
  expect(tui.split("never.txt").length - 1).toBe(1)
})

/** A promise with its resolver, for holding a request until a test lets it go. */
function gate() {
  let open: () => void = () => {}
  const opened = new Promise<void>((resolve) => { open = resolve })
  return { open, opened }
}

test("a status answer that Haxy read before an upload and an assignment, arriving after a fresh read of the issue, undoes neither", async ({ page, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  await logIn(page, hub.url, alice, "/")
  await createRepo(page.context().request, backend, { name: "tracker", access: "public" })
  const id = await createIssue(page.context().request, backend, "/alice:tracker", { title: "Crash on save" })
  await page.goto(`${hub.url}/repos/alice/tracker/issues/${id}`)
  const actions = page.getByRole("group", { name: "Issue actions" })
  const assigned = page.getByRole("region", { name: "Assignees" }).getByRole("list", { name: "Assigned" }).getByRole("link")

  // Haxy closes the issue, but its answer (with nothing attached or assigned) is held back
  const closed = gate()
  const closeHeld = gate()
  await onFirst(page, new RegExp(`/issues/${id}/status$`), "PUT", async (route) => {
    const response = await route.fetch()
    closed.open()
    await closeHeld.opened
    await route.fulfill({ response })
  })
  await actions.getByRole("button", { name: "Close issue" }).click()
  await closed.opened

  // meanwhile a file is attached and someone assigned, and their answers arrive
  await attach(page, "notes.txt", Buffer.from("notes"))
  await expect(listed(page)).toHaveText(["notes.txt"])
  const assignForm = page.getByRole("form", { name: "Assign someone" })
  await assignForm.getByLabel("Assign").fill("outside@example.test")
  await assignForm.getByRole("button", { name: "Assign" }).click()
  await expect(assigned).toHaveText(["outside@example.test"])

  // then a comment is posted, and the page reads the issue again, holding both
  const reread = page.waitForResponse((response) => new RegExp(`/issues/${id}$`).test(new URL(response.url()).pathname) && response.request().method() === "GET")
  const composer = page.getByRole("form", { name: "New comment" })
  await composer.getByLabel("New comment").fill("Posted meanwhile")
  await composer.getByRole("button", { name: "Comment" }).click()
  await reread

  // the close's answer lands last: the issue shows closed, still with both
  closeHeld.open()
  await expect(actions.getByRole("button", { name: "Reopen issue" })).toBeVisible()
  await expect(listed(page)).toHaveText(["notes.txt"])
  await expect(assigned).toHaveText(["outside@example.test"])
  await page.reload()
  await expect(listed(page)).toHaveText(["notes.txt"])
  await expect(assigned).toHaveText(["outside@example.test"])
})

test("a repeated upload refused because its first attempt landed is reported as removed when someone removed it meanwhile", async ({ page, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  await logIn(page, hub.url, alice, "/")
  const request = page.context().request
  await createRepo(request, backend, { name: "tracker", access: "public" })
  const id = await createIssue(request, backend, "/alice:tracker", { title: "Crash on save" })
  await page.goto(`${hub.url}/repos/alice/tracker/issues/${id}`)
  await expect(form(page)).toBeVisible()

  // the upload lands but its answer is lost; before the page reads the issue
  // again, another client removes the attachment
  let attachment = ""
  await onFirst(page, uploads, "POST", async (route) => {
    const response = await route.fetch()
    attachment = ((await response.json()) as { attachments: Array<{ id: string }> }).attachments[0].id
    await route.fulfill({ status: 502, body: "" })
  })
  await onFirst(page, new RegExp(`/issues/${id}$`), "GET", async (route) => {
    const csrf = ((await (await request.get(`${hub.url}/api/v1/session`)).json()) as { csrf_token: string }).csrf_token
    const removed = await request.delete(`${hub.url}/api/v1/repos/alice/tracker/issues/${id}/attachments/${attachment}`, { headers: { "X-Haxy-CSRF": csrf, Origin: hub.url } })
    expect(removed.status()).toBe(200)
    await route.continue()
  })
  await attach(page, "gone.txt", Buffer.from("gone"))
  await expect(attachments(page).getByText("It isn't attached now; attaching it again is safe.")).toBeVisible()

  // the repeat is refused (the id stays taken): it landed, and was removed since
  await form(page).getByRole("button", { name: "Attach file" }).click()
  await expect(attachments(page).getByText("gone.txt was attached, but has been removed since.")).toBeVisible()
  await expect(attachments(page).getByText("gone.txt is attached.")).toHaveCount(0)
  await expect(attachments(page).getByText("Nothing is attached to this issue.")).toBeVisible()

  // the file is still chosen, and attaching it once more uploads it anew
  await form(page).getByRole("button", { name: "Attach file" }).click()
  await expect(listed(page)).toHaveText(["gone.txt"])
  await page.reload()
  await expect(listed(page)).toHaveText(["gone.txt"])
})

test("after a write, the page reads the issue again, so changes another client made meanwhile show", async ({ page, launch, playwright }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  const other = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  await createRepo(other, backend, { name: "tracker", access: "public" })
  const id = await createIssue(other, backend, "/alice:tracker", { title: "Crash on save" })
  await logIn(page, hub.url, alice, `/repos/alice/tracker/issues/${id}`)
  const actions = page.getByRole("group", { name: "Issue actions" })
  const assigned = page.getByRole("region", { name: "Assignees" }).getByRole("list", { name: "Assigned" }).getByRole("link")
  await expect(actions.getByRole("button", { name: "Close issue" })).toBeVisible()

  // another client assigns someone and attaches a file after this page loaded
  const csrf = ((await (await other.get(`${hub.url}/api/v1/session`)).json()) as { csrf_token: string }).csrf_token
  const headers = { "X-Haxy-CSRF": csrf, Origin: hub.url }
  const thread = `${hub.url}/api/v1/repos/alice/tracker/issues/${id}`
  expect((await other.post(`${thread}/assignees`, { headers: { ...headers, "Content-Type": "application/json" }, data: JSON.stringify({ assignee: "outside@example.test" }) })).status()).toBe(200)
  expect((await other.post(`${thread}/attachments?name=theirs.txt`, { headers, data: Buffer.from("theirs") })).status()).toBe(201)

  // this page closes the issue: what the other client did shows too, without a reload
  await actions.getByRole("button", { name: "Close issue" }).click()
  await expect(actions.getByRole("button", { name: "Reopen issue" })).toBeVisible()
  await expect(assigned).toHaveText(["outside@example.test"])
  await expect(listed(page)).toHaveText(["theirs.txt"])
  await other.dispose()
})
