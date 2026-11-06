import type { Page, Route } from "@playwright/test"
import { alice, registerUser, type Account } from "./support/accounts"
import { postComment } from "./support/comments"
import { expect, test } from "./support/fixtures"
import { assignIssue, createIssue } from "./support/issues"
import { createRepo, signedIn } from "./support/repos"

// The inbox, the header's unread count, and subscribing and muting in the
// browser, through Vite's proxy against a real Haxy. Notifications come from
// real activity (comments through Haxy's own forms); every change is checked
// after a refresh and against Haxy's own pages or the API.

const bob: Account = { name: "bobby", email: "bobby@example.test", password: "bobby's password" }
const header = (page: Page) => page.getByRole("banner")
const bell = (page: Page) => header(page).getByRole("link", { name: /^Notifications/ })
const inbox = (page: Page) => page.getByRole("list", { name: "Notifications" })
const settings = (page: Page) => page.getByRole("region", { name: "Notifications" })

async function logIn(page: Page, hubUrl: string, account: Account, next: string) {
  await page.goto(`${hubUrl}/login?next=${encodeURIComponent(next)}`)
  await page.getByLabel("Username").fill(account.name)
  await page.getByLabel("Password").fill(account.password)
  await page.getByRole("button", { name: "Log in" }).click()
  await expect(header(page)).toContainText(`Signed in as ${account.name}`)
}

/** alice's public repository with an issue of hers that bob commented on; alice is signed in to the page. */
async function commentedIssue(page: Page, playwright: Parameters<typeof signedIn>[0], backend: Parameters<typeof signedIn>[1], hubUrl: string) {
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  await logIn(page, hubUrl, alice, "/")
  await createRepo(page.context().request, backend, { name: "tracker", access: "public" })
  const issue = await createIssue(page.context().request, backend, "/alice:tracker", { title: "Crash on save" })
  const other = await signedIn(playwright, backend, hubUrl, bob.name, bob.password)
  await postComment(other, backend, "/alice:tracker", issue, "Same here.")
  return { issue, other }
}

test("the inbox lists another user's activity as unread; hovering doesn't read it, opening the thread does", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { issue, other } = await commentedIssue(page, playwright, backend, hub.url)

  await page.goto(`${hub.url}/`)
  await expect(bell(page)).toHaveAccessibleName("Notifications, 1 unread")
  await expect(header(page).getByTestId("unread-count")).toHaveText("1")

  // no acknowledgement goes out until a thread page has shown its thread
  const acknowledgements: string[] = []
  page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/notifications/read")) acknowledgements.push(request.url()) })

  await bell(page).click()
  await expect(page).toHaveURL(`${hub.url}/notifications`)
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Notifications")
  await expect(page.getByText("1 unread.")).toBeVisible()
  const entry = inbox(page).getByRole("listitem")
  await expect(entry).toHaveCount(1)
  await expect(entry).toHaveAttribute("data-unread", "true")
  await expect(entry).toContainText("Unread")
  await expect(entry).toContainText("Issue in alice/tracker")
  const link = entry.getByRole("link", { name: "Crash on save" })
  await expect(link).toHaveAttribute("href", `/repos/alice/tracker/issues/${issue}`)

  await link.hover()
  await link.focus()
  await page.reload()
  await expect(entry).toHaveAttribute("data-unread", "true")
  await expect(bell(page)).toHaveAccessibleName("Notifications, 1 unread")
  expect(acknowledgements).toEqual([])

  await link.click()
  await expect(page.getByRole("heading", { name: "Crash on save" })).toBeVisible()
  await expect(bell(page)).toHaveAccessibleName("Notifications, 0 unread")
  await expect(header(page).getByTestId("unread-count")).toHaveCount(0)
  expect(acknowledgements).toHaveLength(1)

  await page.goto(`${hub.url}/notifications`)
  await expect(entry).toHaveAttribute("data-unread", "false")
  await expect(page.getByText("Everything is read.")).toBeVisible()

  // another comment: unread again in the header on the next navigation, and in the inbox
  await postComment(other, backend, "/alice:tracker", issue, "Still crashing.")
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Home", exact: true }).click()
  await expect(bell(page)).toHaveAccessibleName("Notifications, 1 unread")
  await bell(page).click()
  await expect(entry).toHaveAttribute("data-unread", "true")
})

test("a thread page shown in a background tab is acknowledged only once it is seen", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { issue } = await commentedIssue(page, playwright, backend, hub.url)

  await page.addInitScript(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (window as unknown as { hubVisible?: boolean }).hubVisible ? "visible" : "hidden" })
  })
  await page.goto(`${hub.url}/repos/alice/tracker/issues/${issue}`)
  await expect(settings(page)).toContainText("You're notified of activity on this issue.")
  await expect(bell(page)).toHaveAccessibleName("Notifications, 1 unread")

  const acknowledged = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/notifications/read"))
  await page.evaluate(() => {
    (window as unknown as { hubVisible?: boolean }).hubVisible = true
    document.dispatchEvent(new Event("visibilitychange"))
  })
  expect((await acknowledged).status()).toBe(200)
  await expect(bell(page)).toHaveAccessibleName("Notifications, 0 unread")
})

test("subscribing and muting persist; a full thread shows Haxy's capacity error", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const owner = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  await createRepo(owner, backend, { name: "tracker", access: "public" })
  const issue = await createIssue(owner, backend, "/alice:tracker", { title: "Crash on save" })
  await logIn(page, hub.url, bob, `/repos/alice/tracker/issues/${issue}`)

  await expect(settings(page)).toContainText("You're not notified of activity on this issue.")
  await settings(page).getByRole("button", { name: "Subscribe" }).click()
  await expect(settings(page)).toContainText("You're subscribed.")
  await expect(settings(page)).toContainText("You're notified of activity on this issue.")
  await page.reload()
  await expect(settings(page)).toContainText("You're notified of activity on this issue.")
  await expect(settings(page).getByRole("button", { name: "Mute" })).toBeVisible()

  // a comment by alice reaches bob
  await postComment(owner, backend, "/alice:tracker", issue, "Looking into it.")
  await page.goto(`${hub.url}/notifications`)
  await expect(inbox(page).getByRole("listitem")).toHaveCount(1)

  await inbox(page).getByRole("link", { name: "Crash on save" }).click()
  await settings(page).getByRole("button", { name: "Mute" }).click()
  await expect(settings(page)).toContainText("Muted. You won't be notified of this thread.")
  await page.reload()
  await expect(settings(page)).toContainText("You're not notified of activity on this issue.")
  await postComment(owner, backend, "/alice:tracker", issue, "Fixed, I think.")
  await page.goto(`${hub.url}/notifications`)
  await expect(page.getByRole("heading", { name: "No notifications" })).toBeVisible()

  // a thread at its subscriber cap: Haxy's refusal, as it sent it, beside the button
  await page.goto(`${hub.url}/repos/alice/tracker/issues/${issue}`)
  await page.route(`**/api/v1/repos/alice/tracker/issues/${issue}/notifications`, (route: Route) => {
    if (route.request().method() !== "PUT") return route.fallback()
    return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "conflict", message: "This issue already has 100 subscribers, the most Haxy allows." } }) })
  })
  await settings(page).getByRole("button", { name: "Subscribe" }).click()
  await expect(settings(page).getByRole("alert")).toHaveText("This issue already has 100 subscribers, the most Haxy allows.")
  await expect(settings(page)).toContainText("You're not notified of activity on this issue.")
})

test("a lost answer to subscribing is settled by reading the state again", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const owner = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  await createRepo(owner, backend, { name: "tracker", access: "public" })
  const issue = await createIssue(owner, backend, "/alice:tracker", { title: "Crash on save" })
  await logIn(page, hub.url, bob, `/repos/alice/tracker/issues/${issue}`)

  let lose = true
  await page.route(`**/api/v1/repos/alice/tracker/issues/${issue}/notifications`, async (route: Route) => {
    if (route.request().method() !== "PUT" || !lose) return route.fallback()
    lose = false
    await route.fetch()
    await route.fulfill({ status: 502, body: "" })
  })
  await settings(page).getByRole("button", { name: "Subscribe" }).click()
  await expect(settings(page)).toContainText("You're subscribed.")
  await expect(settings(page).getByRole("button", { name: "Mute" })).toBeVisible()
  await page.reload()
  await expect(settings(page).getByRole("button", { name: "Mute" })).toBeVisible()
})

test("local mode has no inbox, count or notification controls, and says why", async ({ page, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  const issue = await createIssue(page.context().request, backend, "", { title: "Local issue" })

  await page.goto(`${hub.url}/repo/issues/${issue}`)
  await expect(page.getByRole("heading", { name: "Local issue" })).toBeVisible()
  await expect(settings(page)).toHaveCount(0)
  await expect(bell(page)).toHaveCount(0)

  await page.goto(`${hub.url}/notifications`)
  await expect(page.getByRole("status")).toHaveText("Local mode serves a single repository without accounts, so nobody is notified of anything.")
})

test("a signed-out visitor is asked to log in for the inbox, and sees no controls on threads", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  const owner = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  await createRepo(owner, backend, { name: "tracker", access: "public" })
  const issue = await createIssue(owner, backend, "/alice:tracker", { title: "Crash on save" })

  await page.goto(`${hub.url}/repos/alice/tracker/issues/${issue}`)
  await expect(page.getByRole("heading", { name: "Crash on save" })).toBeVisible()
  await expect(settings(page)).toHaveCount(0)
  await expect(bell(page)).toHaveCount(0)
  await page.goto(`${hub.url}/notifications`)
  await expect(page.getByText("Log in to see your notifications.")).toBeVisible()
})

// --- ordering against the rest of the page ---------------------------------------

/** Runs `handler` on the first `method` request to `pattern` only; the route never expires. */
async function onFirst(page: Page, pattern: RegExp, method: string, handler: (route: Route) => Promise<void>) {
  let pending = true
  await page.route(pattern, async (route) => {
    if (route.request().method() !== method || !pending) return route.fallback()
    pending = false
    await handler(route)
  })
}

/** A promise with its resolver, for holding an answer until a test lets it go. */
function gate() {
  let open: () => void = () => {}
  const opened = new Promise<void>((resolve) => { open = resolve })
  return { open, opened }
}

const acknowledgement = /\/notifications\/read$/
const issueRead = (issue: string) => new RegExp(`/api/v1/repos/alice/tracker/issues/${issue}$`)

test("a newer bump read beside a thread refresh that failed isn't acknowledged until the thread is shown", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { issue, other } = await commentedIssue(page, playwright, backend, hub.url)
  const acknowledgements: string[] = []
  page.on("request", (request) => { if (request.method() === "POST" && acknowledgement.test(request.url())) acknowledgements.push(request.url()) })

  await page.goto(`${hub.url}/repos/alice/tracker/issues/${issue}`)
  await expect(bell(page)).toHaveAccessibleName("Notifications, 0 unread")
  expect(acknowledgements).toHaveLength(1)

  // bob comments again; alice's own comment then reads the page again, and the issue's read fails
  await postComment(other, backend, "/alice:tracker", issue, "Still crashing.")
  await onFirst(page, issueRead(issue), "GET", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Haxy failed." } }) }))
  const stateRead = page.waitForResponse((response) => response.request().method() === "GET" && response.url().endsWith(`/issues/${issue}/notifications`))
  const composer = page.getByRole("form", { name: "New comment" })
  await composer.getByLabel("New comment").fill("Looking into it.")
  await composer.getByRole("button", { name: "Comment" }).click()
  expect((await stateRead).status()).toBe(200)
  const refresh = page.getByRole("alert").filter({ hasText: "Couldn't refresh this issue" })
  await expect(refresh).toBeVisible()
  // the state read named bob's new comment, which the page doesn't show yet
  await page.waitForTimeout(500)
  expect(acknowledgements).toHaveLength(1)
  await expect(bell(page)).toHaveAccessibleName("Notifications, 1 unread")

  // once the issue is read again and shown, it is acknowledged
  await refresh.getByRole("button", { name: "Retry" }).click()
  await expect(bell(page)).toHaveAccessibleName("Notifications, 0 unread")
  expect(acknowledgements).toHaveLength(2)
})

test("an acknowledgement answered after a mute doesn't undo the mute", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { issue } = await commentedIssue(page, playwright, backend, hub.url)

  const held = gate()
  await onFirst(page, acknowledgement, "POST", async (route) => {
    const response = await route.fetch()
    await held.opened
    await route.fulfill({ response })
  })
  const sent = page.waitForRequest((request) => request.method() === "POST" && acknowledgement.test(request.url()))
  await page.goto(`${hub.url}/repos/alice/tracker/issues/${issue}`)
  await sent
  await settings(page).getByRole("button", { name: "Mute" }).click()
  await expect(settings(page)).toContainText("Muted. You won't be notified of this thread.")

  // the acknowledgement's answer, from before the mute, arrives now; the count reads again after it
  const counted = page.waitForResponse((response) => response.url().endsWith("/api/v1/notifications/count"))
  held.open()
  await counted
  await expect(settings(page)).toContainText("You're not notified of activity on this issue.")
  await expect(settings(page).getByRole("button", { name: "Subscribe" })).toBeVisible()
  await page.reload()
  await expect(settings(page).getByRole("button", { name: "Subscribe" })).toBeVisible()
})

test("assigning yourself turns notifications on, and the panel says so without a reload", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const owner = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  await createRepo(owner, backend, { name: "tracker", access: "public" })
  const other = await signedIn(playwright, backend, hub.url, bob.name, bob.password)
  const issue = await createIssue(other, backend, "/alice:tracker", { title: "Bob's report" })
  await logIn(page, hub.url, alice, `/repos/alice/tracker/issues/${issue}`)

  await expect(settings(page)).toContainText("You're not notified of activity on this issue.")
  const assign = page.getByRole("form", { name: "Assign someone" })
  await assign.getByLabel("Assign").fill("alice")
  await assign.getByRole("button", { name: "Assign" }).click()
  await expect(page.getByRole("list", { name: "Assigned" }).getByRole("link")).toHaveText(["alice"])
  await expect(settings(page)).toContainText("You're notified of activity on this issue.")
  await expect(settings(page).getByRole("button", { name: "Mute" })).toBeVisible()
})

test("an acknowledgement sent while a mute is on its way doesn't undo the mute", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { issue, other } = await commentedIssue(page, playwright, backend, hub.url)
  await page.goto(`${hub.url}/repos/alice/tracker/issues/${issue}`)
  await expect(bell(page)).toHaveAccessibleName("Notifications, 0 unread")

  // the mute is held before it reaches Haxy
  const held = gate()
  await onFirst(page, new RegExp(`/issues/${issue}/notifications$`), "PUT", async (route) => {
    await held.opened
    await route.fallback()
  })
  await settings(page).getByRole("button", { name: "Mute" }).click()

  // meanwhile bob comments, alice's own comment reads the page again, and the new bump is acknowledged
  await postComment(other, backend, "/alice:tracker", issue, "Still crashing.")
  const acknowledged = page.waitForResponse((response) => response.request().method() === "POST" && acknowledgement.test(response.url()))
  const composer = page.getByRole("form", { name: "New comment" })
  await composer.getByLabel("New comment").fill("Looking into it.")
  await composer.getByRole("button", { name: "Comment" }).click()
  expect((await acknowledged).status()).toBe(200)

  // then the mute lands and answers
  const muted = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().endsWith(`/issues/${issue}/notifications`))
  held.open()
  expect((await muted).status()).toBe(200)
  await expect(settings(page)).toContainText("Muted. You won't be notified of this thread.")
  await expect(settings(page)).toContainText("You're not notified of activity on this issue.")
  await expect(settings(page).getByRole("button", { name: "Subscribe" })).toBeVisible()
})

test("opening a comment's own page acknowledges its thread", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { issue, other } = await commentedIssue(page, playwright, backend, hub.url)
  const comment = await postComment(other, backend, "/alice:tracker", issue, "Here is the trace.")

  await page.goto(`${hub.url}/repos/alice/tracker/issues/${issue}/comments/${comment}`)
  await expect(page.getByText("Here is the trace.")).toBeVisible()
  await expect(bell(page)).toHaveAccessibleName("Notifications, 0 unread")
})

test("retrying a failed read of the notification state acknowledges the thread it shows", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { issue } = await commentedIssue(page, playwright, backend, hub.url)

  // the state reads fail until the test lets them through
  let failing = true
  await page.route(new RegExp(`/issues/${issue}/notifications$`), (route) => {
    if (route.request().method() !== "GET" || !failing) return route.fallback()
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Haxy failed." } }) })
  })
  await page.goto(`${hub.url}/repos/alice/tracker/issues/${issue}`)
  await expect(page.getByRole("heading", { name: "Crash on save" })).toBeVisible()
  const failed = settings(page).getByRole("alert")
  await expect(failed).toContainText("Haxy failed.")
  await expect(bell(page)).toHaveAccessibleName("Notifications, 1 unread")

  failing = false
  await failed.getByRole("button", { name: "Retry" }).click()
  await expect(settings(page)).toContainText("You're notified of activity on this issue.")
  await expect(bell(page)).toHaveAccessibleName("Notifications, 0 unread")
})

test("a lost answer to a mute, once settled, updates the header's count", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { issue } = await commentedIssue(page, playwright, backend, hub.url)

  // a background tab: the thread isn't acknowledged, so it stays unread until the mute drops it
  await page.addInitScript(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" })
  })
  await page.goto(`${hub.url}/repos/alice/tracker/issues/${issue}`)
  await expect(bell(page)).toHaveAccessibleName("Notifications, 1 unread")

  await onFirst(page, new RegExp(`/issues/${issue}/notifications$`), "PUT", async (route) => {
    await route.fetch()
    await route.fulfill({ status: 502, body: "" })
  })
  await settings(page).getByRole("button", { name: "Mute" }).click()
  await expect(settings(page)).toContainText("Muted. You won't be notified of this thread.")
  await expect(bell(page)).toHaveAccessibleName("Notifications, 0 unread")
})

test("assignee changes that land while the panel is reading its state are read again after it", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const owner = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  await createRepo(owner, backend, { name: "tracker", access: "public" })
  const other = await signedIn(playwright, backend, hub.url, bob.name, bob.password)
  const issue = await createIssue(other, backend, "/alice:tracker", { title: "Bob's report" })
  await logIn(page, hub.url, alice, `/repos/alice/tracker/issues/${issue}`)
  await expect(settings(page)).toContainText("You're not notified of activity on this issue.")

  // the read after the first assignment answers as Haxy was then, but only after the second assignment
  const held = gate()
  let armed = true
  await page.route(new RegExp(`/issues/${issue}/notifications$`), async (route) => {
    if (route.request().method() !== "GET" || !armed) return route.fallback()
    armed = false
    const response = await route.fetch()
    await held.opened
    await route.fulfill({ response })
  })
  const assign = page.getByRole("form", { name: "Assign someone" })
  const assigned = page.getByRole("list", { name: "Assigned" }).getByRole("link")
  await assign.getByLabel("Assign").fill("outside@example.test")
  await assign.getByRole("button", { name: "Assign" }).click()
  await expect(assigned).toHaveText(["outside@example.test"])
  await assign.getByLabel("Assign").fill("alice")
  await assign.getByRole("button", { name: "Assign" }).click()
  await expect(assigned).toHaveText(["outside@example.test", "alice"])
  held.open()
  await expect(settings(page)).toContainText("You're notified of activity on this issue.")
  await expect(settings(page).getByRole("button", { name: "Mute" })).toBeVisible()
})

test("the inbox reads again when a thread's acknowledgement lands after it loaded", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await commentedIssue(page, playwright, backend, hub.url)

  // the acknowledgement is held before it reaches Haxy
  const held = gate()
  await onFirst(page, acknowledgement, "POST", async (route) => {
    await held.opened
    await route.fallback()
  })
  await page.goto(`${hub.url}/notifications`)
  const entry = inbox(page).getByRole("listitem")
  const sent = page.waitForRequest((request) => request.method() === "POST" && acknowledgement.test(request.url()))
  await entry.getByRole("link", { name: "Crash on save" }).click()
  await sent
  await page.goBack()
  await expect(entry).toHaveAttribute("data-unread", "true")

  held.open()
  await expect(bell(page)).toHaveAccessibleName("Notifications, 0 unread")
  await expect(entry).toHaveAttribute("data-unread", "false")
  await expect(page.getByText("Everything is read.")).toBeVisible()
})

test("a mute still on its way when the page is left updates the header's count once it lands", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { issue } = await commentedIssue(page, playwright, backend, hub.url)

  // a background tab: the thread stays unread until the mute drops its notification
  await page.addInitScript(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" })
  })
  await page.goto(`${hub.url}/repos/alice/tracker/issues/${issue}`)
  await expect(bell(page)).toHaveAccessibleName("Notifications, 1 unread")

  const held = gate()
  await onFirst(page, new RegExp(`/issues/${issue}/notifications$`), "PUT", async (route) => {
    await held.opened
    await route.fallback()
  })
  await settings(page).getByRole("button", { name: "Mute" }).click()
  // the next page counts before the mute lands
  const counted = page.waitForResponse((response) => response.url().endsWith("/api/v1/notifications/count"))
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Home", exact: true }).click()
  await counted
  await expect(bell(page)).toHaveAccessibleName("Notifications, 1 unread")

  const muted = page.waitForResponse((response) => response.request().method() === "PUT")
  held.open()
  expect((await muted).status()).toBe(200)
  await expect(bell(page)).toHaveAccessibleName("Notifications, 0 unread")
})

test("the page reads the thread only after the notification state, so it never acknowledges a bump it doesn't show", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const owner = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  await createRepo(owner, backend, { name: "tracker", access: "public" })
  const other = await signedIn(playwright, backend, hub.url, bob.name, bob.password)
  const issue = await createIssue(other, backend, "/alice:tracker", { title: "Bob's report" })
  await logIn(page, hub.url, alice, "/")

  // the state reads are held before they reach Haxy, and bob assigns alice meanwhile
  const held = gate()
  await page.route(new RegExp(`/issues/${issue}/notifications$`), async (route) => {
    if (route.request().method() !== "GET") return route.fallback()
    await held.opened
    await route.fallback()
  })
  await page.goto(`${hub.url}/repos/alice/tracker/issues/${issue}`)
  await expect(page.getByRole("status").filter({ hasText: "Loading the issue" })).toBeVisible()
  await assignIssue(other, backend, "/alice:tracker", issue, "alice")
  held.open()

  // the acknowledged bump is the assignment, which the page shows
  await expect(bell(page)).toHaveAccessibleName("Notifications, 0 unread")
  await expect(page.getByRole("list", { name: "Assigned" }).getByRole("link")).toHaveText(["alice"])
})

test("a mute whose answer is lost after its page is left still makes the inbox and count read again", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { issue } = await commentedIssue(page, playwright, backend, hub.url)

  // a background tab: the thread stays unread until the mute drops its notification
  await page.addInitScript(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" })
  })
  await page.goto(`${hub.url}/repos/alice/tracker/issues/${issue}`)
  await expect(bell(page)).toHaveAccessibleName("Notifications, 1 unread")

  // the mute is held before it reaches Haxy, and its answer is lost after it lands
  const held = gate()
  await onFirst(page, new RegExp(`/issues/${issue}/notifications$`), "PUT", async (route) => {
    await held.opened
    await route.fetch()
    await route.fulfill({ status: 502, body: "" })
  })
  await settings(page).getByRole("button", { name: "Mute" }).click()
  const listed = page.waitForResponse((response) => response.url().includes("/api/v1/notifications?") || response.url().endsWith("/api/v1/notifications"))
  await bell(page).click()
  await listed
  await expect(inbox(page).getByRole("listitem")).toHaveCount(1)

  const lost = page.waitForResponse((response) => response.request().method() === "PUT")
  held.open()
  expect((await lost).status()).toBe(502)
  await expect(page.getByRole("heading", { name: "No notifications" })).toBeVisible()
  await expect(bell(page)).toHaveAccessibleName("Notifications, 0 unread")
})

const commentsRead = (issue: string) => new RegExp(`/issues/${issue}/comments(\\?|$)`)

test("a thread page acknowledges only once it has shown its comments", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { issue } = await commentedIssue(page, playwright, backend, hub.url)
  const acknowledgements: string[] = []
  page.on("request", (request) => { if (request.method() === "POST" && acknowledgement.test(request.url())) acknowledgements.push(request.url()) })

  // the comment reads fail until the test lets them through
  let failing = true
  await page.route(commentsRead(issue), (route) => {
    if (route.request().method() !== "GET" || !failing) return route.fallback()
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Haxy failed." } }) })
  })
  await page.goto(`${hub.url}/repos/alice/tracker/issues/${issue}`)
  await expect(page.getByRole("heading", { name: "Crash on save" })).toBeVisible()
  const failed = page.getByRole("alert").filter({ hasText: "Couldn't load the comments" })
  await expect(failed).toBeVisible()
  await page.waitForTimeout(500)
  expect(acknowledgements).toEqual([])
  await expect(bell(page)).toHaveAccessibleName("Notifications, 1 unread")

  failing = false
  await failed.getByRole("button", { name: "Retry" }).click()
  await expect(page.getByText("Same here.")).toBeVisible()
  await expect(bell(page)).toHaveAccessibleName("Notifications, 0 unread")
  expect(acknowledgements).toHaveLength(1)
})

test("a refresh whose comment read fails doesn't acknowledge the newer bump it read", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { issue, other } = await commentedIssue(page, playwright, backend, hub.url)
  const acknowledgements: string[] = []
  page.on("request", (request) => { if (request.method() === "POST" && acknowledgement.test(request.url())) acknowledgements.push(request.url()) })
  await page.goto(`${hub.url}/repos/alice/tracker/issues/${issue}`)
  await expect(bell(page)).toHaveAccessibleName("Notifications, 0 unread")
  expect(acknowledgements).toHaveLength(1)

  // bob comments; alice's own comment reads the page again, and its comment reads fail
  await postComment(other, backend, "/alice:tracker", issue, "Still crashing.")
  let failing = false
  await page.route(commentsRead(issue), (route) => {
    if (route.request().method() !== "GET" || !failing) return route.fallback()
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Haxy failed." } }) })
  })
  const composer = page.getByRole("form", { name: "New comment" })
  await composer.getByLabel("New comment").fill("Looking into it.")
  failing = true
  await composer.getByRole("button", { name: "Comment" }).click()
  const refresh = page.getByRole("alert").filter({ hasText: "Couldn't refresh the comments" })
  await expect(refresh).toBeVisible()
  await page.waitForTimeout(500)
  expect(acknowledgements).toHaveLength(1)
  await expect(bell(page)).toHaveAccessibleName("Notifications, 1 unread")

  failing = false
  await refresh.getByRole("button", { name: "Retry" }).click()
  await expect(page.getByText("Still crashing.")).toBeVisible()
  await expect(bell(page)).toHaveAccessibleName("Notifications, 0 unread")
  expect(acknowledgements).toHaveLength(2)
})

test("an acknowledgement whose answer is lost still makes the header count again", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { issue } = await commentedIssue(page, playwright, backend, hub.url)

  await onFirst(page, acknowledgement, "POST", async (route) => {
    await route.fetch()
    await route.fulfill({ status: 502, body: "" })
  })
  const lost = page.waitForResponse((response) => response.request().method() === "POST" && acknowledgement.test(response.url()))
  await page.goto(`${hub.url}/repos/alice/tracker/issues/${issue}`)
  expect((await lost).status()).toBe(502)
  await expect(bell(page)).toHaveAccessibleName("Notifications, 0 unread")
})

test("a comment read cut short by a page change doesn't stop the next state read from acknowledging", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { issue, other } = await commentedIssue(page, playwright, backend, hub.url)
  // more than one page of comments
  for (let i = 1; i <= 10; i++) await postComment(other, backend, "/alice:tracker", issue, `Comment ${i}.`)
  await page.goto(`${hub.url}/repos/alice/tracker/issues/${issue}`)
  await expect(bell(page)).toHaveAccessibleName("Notifications, 0 unread")
  await postComment(other, backend, "/alice:tracker", issue, "A newer one.")

  // the next page's comments are read before the state answers, so one more read is asked
  // for; that one is held, and the user changes page again while it is. That page's
  // comments then answer only after its state and thread have.
  let reads = 0
  const extraSent = gate()
  const threadLanded = gate()
  await page.route(commentsRead(issue), async (route) => {
    if (route.request().method() !== "GET") return route.fallback()
    reads += 1
    if (reads === 2) {
      extraSent.open()
      return new Promise<void>(() => {})
    }
    if (reads === 3) {
      const response = await route.fetch()
      await threadLanded.opened
      return route.fulfill({ response })
    }
    return route.fallback()
  })
  const pages = page.getByRole("navigation", { name: "Comment pages" })
  await pages.getByRole("link", { name: "Next page" }).click()
  await extraSent.opened
  await expect(bell(page)).toHaveAccessibleName("Notifications, 1 unread")
  const thread = page.waitForResponse((response) => issueRead(issue).test(response.url()))
  await pages.getByRole("link", { name: "First page" }).click()
  await thread
  threadLanded.open()

  await expect(page.getByText("Same here.")).toBeVisible()
  await expect(bell(page)).toHaveAccessibleName("Notifications, 0 unread")
})
