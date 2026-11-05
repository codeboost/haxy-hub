import type { Page, Route } from "@playwright/test"
import { alice, registerUser, type Account } from "./support/accounts"
import { postComment } from "./support/comments"
import { expect, test } from "./support/fixtures"
import { createIssue } from "./support/issues"
import { createRepo, signedIn } from "./support/repos"

// An issue's page reads the issue again in the background when the page
// navigates within itself (a comment posted, another comment page). Those
// reads meet the page's own writes: a failed read must not take away what the
// page shows (or the drafts in it), and a read that started before a write
// answered must not undo what the write confirmed.

const bob: Account = { name: "bobby", email: "bobby@example.test", password: "bobby's password" }
const header = (page: Page) => page.getByRole("banner")
const actions = (page: Page) => page.getByRole("group", { name: "Issue actions" })
const card = (page: Page, text: string) => page.getByRole("article", { name: /^Comment by / }).filter({ hasText: text })
const composer = (page: Page) => page.getByRole("form", { name: "New comment" })

async function logIn(page: Page, hubUrl: string, account: Account, next: string) {
  await page.goto(`${hubUrl}/login?next=${encodeURIComponent(next)}`)
  await page.getByLabel("Username").fill(account.name)
  await page.getByLabel("Password").fill(account.password)
  await page.getByRole("button", { name: "Log in" }).click()
  await expect(header(page)).toContainText(`Signed in as ${account.name}`)
}

/** Runs `handler` on the first `method` request to `pattern` only; the route never expires. */
async function onFirst(page: Page, pattern: RegExp, method: string, handler: (route: Route) => Promise<void>) {
  let pending = true
  await page.route(pattern, async (route) => {
    if (route.request().method() !== method || !pending) return route.fallback()
    pending = false
    await handler(route)
  })
}

/** A promise with its resolver, for holding a request until a test lets it go. */
function gate() {
  let open: () => void = () => {}
  const opened = new Promise<void>((resolve) => { open = resolve })
  return { open, opened }
}

/** alice's public tracker with one issue, alice and bob registered. */
async function tracker(playwright: Parameters<typeof signedIn>[0], backend: Parameters<typeof signedIn>[1], hubUrl: string) {
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const owner = await signedIn(playwright, backend, hubUrl, alice.name, alice.password)
  await createRepo(owner, backend, { name: "tracker", access: "public" })
  const issue = await createIssue(owner, backend, "/alice:tracker", { title: "Crash on save" })
  return { owner, issue }
}

// the issue itself, not its comments or status
const issueRead = (issue: string) => new RegExp(`/api/v1/repos/alice/tracker/issues/${issue}$`)

test("a failed background read of the issue keeps the page and its drafts, and says so with a retry", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, issue } = await tracker(playwright, backend, hub.url)
  await postComment(owner, backend, "/alice:tracker", issue, "Being edited")
  await logIn(page, hub.url, alice, `/repos/alice/tracker/issues/${issue}`)

  await card(page, "Being edited").getByRole("button", { name: "Edit" }).click()
  await page.getByRole("form", { name: "Edit comment" }).getByLabel("Comment").fill("Unsaved edit")

  // posting a comment reads the issue again; that read fails
  const internal = { status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Haxy failed." } }) }
  await onFirst(page, issueRead(issue), "GET", (route) => route.fulfill(internal))
  await composer(page).getByLabel("New comment").fill("Posted meanwhile")
  await composer(page).getByRole("button", { name: "Comment" }).click()
  await expect(card(page, "Posted meanwhile")).toBeVisible()

  const refresh = page.getByRole("alert").filter({ hasText: "Couldn't refresh this issue" })
  await expect(refresh).toBeVisible()
  await expect(page.getByRole("heading", { level: 2, name: "Crash on save" })).toBeVisible()
  await expect(page.getByRole("form", { name: "Edit comment" }).getByLabel("Comment")).toHaveValue("Unsaved edit")

  await refresh.getByRole("button", { name: "Retry" }).click()
  await expect(refresh).toBeHidden()
  await expect(page.getByRole("form", { name: "Edit comment" }).getByLabel("Comment")).toHaveValue("Unsaved edit")
  await owner.dispose()
})

test("a Close whose answer arrives after the page read the issue again still shows", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, issue } = await tracker(playwright, backend, hub.url)
  await logIn(page, hub.url, alice, `/repos/alice/tracker/issues/${issue}`)

  // the close is held before it reaches Haxy
  const closeSent = gate()
  const closeHeld = gate()
  await onFirst(page, new RegExp(`/issues/${issue}/status$`), "PUT", async (route) => {
    closeSent.open()
    await closeHeld.opened
    await route.continue()
  })
  await actions(page).getByRole("button", { name: "Close issue" }).click()
  await closeSent.opened

  // meanwhile a comment is posted, and the page reads the issue again: still open
  const reread = page.waitForResponse((response) => issueRead(issue).test(new URL(response.url()).pathname) && response.request().method() === "GET")
  await composer(page).getByLabel("New comment").fill("Posted while closing")
  await composer(page).getByRole("button", { name: "Comment" }).click()
  await reread
  await expect(card(page, "Posted while closing")).toBeVisible()

  closeHeld.open()
  await expect(actions(page).getByRole("button", { name: "Reopen issue" })).toBeVisible()
  await expect(page.getByText("Closed", { exact: true })).toBeVisible()
  await page.reload()
  await expect(actions(page).getByRole("button", { name: "Reopen issue" })).toBeVisible()
  await owner.dispose()
})

test("a read of the issue that started before Close answered doesn't undo the close", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, issue } = await tracker(playwright, backend, hub.url)
  await logIn(page, hub.url, alice, `/repos/alice/tracker/issues/${issue}`)
  await expect(actions(page).getByRole("button", { name: "Close issue" })).toBeVisible()

  // posting a comment reads the issue again; Haxy answers that read (open),
  // but the answer is held back until after the close has answered
  const readAnswered = gate()
  const readHeld = gate()
  await onFirst(page, issueRead(issue), "GET", async (route) => {
    const response = await route.fetch()
    readAnswered.open()
    await readHeld.opened
    await route.fulfill({ response })
  })
  await composer(page).getByLabel("New comment").fill("Posted before closing")
  await composer(page).getByRole("button", { name: "Comment" }).click()
  await readAnswered.opened

  await actions(page).getByRole("button", { name: "Close issue" }).click()
  await expect(actions(page).getByRole("button", { name: "Reopen issue" })).toBeVisible()

  // the stale read lands; the close stands
  const landed = page.waitForResponse((response) => issueRead(issue).test(new URL(response.url()).pathname) && response.request().method() === "GET")
  readHeld.open()
  await landed
  await expect(card(page, "Posted before closing")).toBeVisible()
  await expect(actions(page).getByRole("button", { name: "Reopen issue" })).toBeVisible()
  await expect(page.getByText("Closed", { exact: true })).toBeVisible()
  await owner.dispose()
})
