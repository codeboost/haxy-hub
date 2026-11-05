import type { APIRequestContext } from "@playwright/test"
import { expect, test } from "./support/fixtures"
import { alice, registerUser } from "./support/accounts"
import { commentOnIssue, createDiscussion, removeIssue, tuiEventTransactions } from "./support/events"
import { createIssue } from "./support/issues"
import { createRepo, signedIn } from "./support/repos"
import type { Backend } from "./support/backend"

// Browser workflows for a repository's events: the active and removed lists
// with counts and pages, each event's kind, author, time and detail link,
// and one transaction's events, against real Haxy fixtures through Vite's
// proxy.

/** Signs the browser page in through Hub's own login page. */
async function signIn(page: import("@playwright/test").Page, hubUrl: string) {
  await page.goto(`${hubUrl}/login`)
  await page.getByLabel("Username").fill(alice.name)
  await page.getByLabel("Password").fill(alice.password)
  await page.getByRole("button", { name: "Log in" }).click()
  await expect(page.getByRole("banner")).toContainText(`Signed in as ${alice.name}`)
}

/**
 * `alice:history`: 21 issues, a discussion, a comment on the first issue,
 * and the second issue removed: 22 active events and 1 removed.
 */
async function seed(owner: APIRequestContext, backend: Backend) {
  await createRepo(owner, backend, { name: "history", access: "public" })
  const repoBase = "/alice:history"
  const issues: string[] = []
  for (let index = 0; index < 21; index++) issues.push(await createIssue(owner, backend, repoBase, { title: `Issue ${index}` }))
  const discussion = await createDiscussion(owner, backend, repoBase, { title: "A discussion" })
  const comment = await commentOnIssue(owner, backend, repoBase, issues[0], "First comment")
  await removeIssue(owner, backend, repoBase, issues[1])
  return { repoBase, issues, discussion, comment }
}

test("a writer pages through active events, opens their threads, and switches to removed ones; the URL keeps each view across refresh", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  const owner = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  const { issues, discussion, comment } = await seed(owner, backend)
  await owner.dispose()
  await signIn(page, hub.url)

  await page.goto(`${hub.url}/repos/alice/history`)
  await page.getByRole("navigation", { name: "Repository sections" }).getByRole("link", { name: "Events" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/history/events`)
  const tabs = page.getByRole("navigation", { name: "Event lists" })
  await expect(tabs.getByRole("link", { name: "Active 22" })).toHaveAttribute("aria-current", "page")
  await expect(tabs.getByRole("link", { name: "Removed 1" })).toBeVisible()
  const events = page.getByRole("list", { name: "Active events" })
  await expect(events.getByRole("listitem")).toHaveCount(20)

  // newest first: the comment opens its own page
  const newest = events.getByRole("listitem").first()
  await expect(newest).toContainText("Comment")
  await expect(newest.getByRole("link", { name: "alice" })).toBeVisible()
  await expect(newest.locator("time")).toHaveAttribute("datetime", /^\d{4}-\d\d-\d\dT/)
  await expect(newest.getByRole("link", { name: "View comment" })).toHaveAttribute("href", `/repos/alice/history/issues/${issues[0]}/comments/${comment}`)
  // a discussion has no Hub page yet
  const discussionRow = events.getByRole("listitem").filter({ hasText: "Discussion" })
  await expect(discussionRow).toContainText("No Haxy Hub page for discussions yet")
  await expect(discussionRow.getByRole("link", { name: /^View/ })).toHaveCount(0)
  expect(discussion).toMatch(/^[0-9a-f]{32}$/)
  expect(comment).toMatch(/^[0-9a-f]{32}$/)

  await page.getByRole("navigation", { name: "Events pages" }).getByRole("link", { name: "Next page" }).click()
  await expect(page).toHaveURL(/\/repos\/alice\/history\/events\?cursor=/)
  await expect(events.getByRole("listitem")).toHaveCount(2)
  const secondPage = await events.getByRole("listitem").allTextContents()
  await page.reload()
  await expect(events.getByRole("listitem")).toHaveCount(2)
  expect(await events.getByRole("listitem").allTextContents()).toEqual(secondPage)

  await tabs.getByRole("link", { name: "Removed 1" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/history/events/removed`)
  const removed = page.getByRole("list", { name: "Removed events" })
  await expect(removed.getByRole("listitem")).toHaveCount(1)
  await expect(removed.getByRole("listitem")).toContainText("Issue")
  // removed events open nothing, as in the TUI
  await expect(removed.getByRole("link", { name: /^View/ })).toHaveCount(0)
  await page.reload()
  await expect(removed.getByRole("listitem")).toHaveCount(1)

  await tabs.getByRole("link", { name: "Active 22" }).click()
  await events.getByRole("listitem").nth(2).getByRole("link", { name: "View issue" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/history/issues/${issues[20]}`)
  await expect(page.getByRole("heading", { level: 2, name: "Issue 20" })).toBeVisible()
})

test("a transaction's events show as the transaction left them; viewers who may not write see none", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  const owner = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  const { repoBase, issues } = await seed(owner, backend)
  const [removal, commenting] = await tuiEventTransactions(owner, backend, repoBase, 2)
  // Haxy's own transaction links in Markdown open the Hub's transaction pages
  const linker = await createIssue(owner, backend, repoBase, {
    title: "Links to events",
    description: [
      `[removal](/alice:history/events/removed/moment:${removal})`,
      `[comment transaction](/alice:history/events/active/moment:${commenting})`,
      "[removed events](/alice:history/events/removed)",
      `[event window](/alice:history/event:${issues[3]}/kind:issue)`,
    ].join("\n\n"),
  })
  await owner.dispose()

  // anonymous readers of a public repository have no events section
  await page.goto(`${hub.url}/repos/alice/history/events`)
  await expect(page.getByRole("status")).toHaveText("Only people who may write to this repository see its events.")
  await expect(page.getByRole("navigation", { name: "Repository sections" }).getByText("Events")).toHaveCount(0)
  await page.goto(`${hub.url}/repos/alice/history/events/transactions/${removal}`)
  await expect(page.getByRole("status")).toHaveText("Only people who may write to this repository see its events.")

  await signIn(page, hub.url)
  await page.goto(`${hub.url}/repos/alice/history/issues/${linker}`)
  const description = page.getByRole("region", { name: "Description" })
  await expect(description.getByRole("link", { name: "comment transaction" })).toHaveAttribute("href", `/repos/alice/history/events/transactions/${commenting}`)
  await expect(description.getByRole("link", { name: "removed events" })).toHaveAttribute("href", "/repos/alice/history/events/removed")
  await expect(description.getByRole("link", { name: "event window" })).toHaveAttribute("href", "/repos/alice/history/events")
  await description.getByRole("link", { name: "removal" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/history/events/transactions/${removal}/removed`)

  await expect(page.getByRole("heading", { name: `Transaction ${removal}` })).toBeVisible()
  const tabs = page.getByRole("navigation", { name: "Event lists" })
  await expect(tabs.getByRole("link", { name: "Active 0" })).toBeVisible()
  await expect(tabs.getByRole("link", { name: "Removed 1" })).toHaveAttribute("aria-current", "page")
  await expect(page.getByRole("list", { name: "Removed events" }).getByRole("listitem")).toHaveCount(1)
  await page.reload()
  await expect(page.getByRole("list", { name: "Removed events" }).getByRole("listitem")).toHaveCount(1)
  await tabs.getByRole("link", { name: "Active 0" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/history/events/transactions/${removal}`)
  await expect(page.getByRole("region", { name: "No active events" })).toBeVisible()

  await page.getByRole("link", { name: "All events" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/history/events`)

  await page.goto(`${hub.url}/repos/alice/history/events/transactions/999999`)
  await expect(page.getByRole("status")).toHaveText("There is no transaction with this id whose events can be shown.")
})

test("local mode lists the opened repository's events, and Haxy's local event links open them", async ({ page, request, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  const gone = await createIssue(request, backend, "", { title: "Gone" })
  const kept = await createIssue(request, backend, "", { title: "Kept", description: "[removed events](/events/removed) and [active events](/events)" })
  await removeIssue(request, backend, "", gone)

  await page.goto(`${hub.url}/repo/issues/${kept}`)
  const description = page.getByRole("region", { name: "Description" })
  await expect(description.getByRole("link", { name: "active events" })).toHaveAttribute("href", "/repo/events")
  await description.getByRole("link", { name: "removed events" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/events/removed`)
  await expect(page.getByRole("list", { name: "Removed events" }).getByRole("listitem")).toHaveCount(1)
  await expect(page.getByRole("list", { name: "Removed events" })).toContainText("e2e@example.test")

  await page.getByRole("navigation", { name: "Event lists" }).getByRole("link", { name: "Active 1" }).click()
  await page.getByRole("list", { name: "Active events" }).getByRole("link", { name: "View issue" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/issues/${kept}`)
})
