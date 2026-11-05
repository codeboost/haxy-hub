import type { Page } from "@playwright/test"
import { alice, registerUser, type Account } from "./support/accounts"
import { expect, test } from "./support/fixtures"
import { createIssue, editIssue, removeIssue, setIssueRole, tuiIssueIds, tuiIssuePage } from "./support/issues"
import { createRepo, grantMember, revokeMember, signedIn } from "./support/repos"

// Opening, editing, closing, reopening and removing issues in the browser,
// through Vite's proxy against a real Haxy. Every change is checked again
// after a refresh, in Haxy's own server-rendered issues pages (the TUI's),
// and, where it matters, after a backend restart.

const bob: Account = { name: "bobby", email: "bobby@example.test", password: "bobby's password" }
const header = (page: Page) => page.getByRole("banner")

async function logIn(page: Page, hubUrl: string, account: Account, next: string) {
  await page.goto(`${hubUrl}/login?next=${encodeURIComponent(next)}`)
  await page.getByLabel("Username").fill(account.name)
  await page.getByLabel("Password").fill(account.password)
  await page.getByRole("button", { name: "Log in" }).click()
  await expect(header(page)).toContainText(`Signed in as ${account.name}`)
}

/** Counts the writes (anything but GET and HEAD) the page sends to `path`'s routes. */
function countWrites(page: Page, pattern: RegExp) {
  const writes: string[] = []
  page.on("request", (request) => {
    if (request.method() !== "GET" && request.method() !== "HEAD" && pattern.test(new URL(request.url()).pathname)) writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
  })
  return writes
}

const actions = (page: Page) => page.getByRole("group", { name: "Issue actions" })

test("a writer opens an issue through the form; it survives a refresh and a restart, and Haxy's own pages show it", async ({ page, launch }) => {
  let backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  await logIn(page, hub.url, alice, "/")
  await createRepo(page.context().request, backend, { name: "tracker", access: "public" })

  await page.goto(`${hub.url}/repos/alice/tracker/issues`)
  await expect(page.getByText("No open issues")).toBeVisible()
  await page.getByRole("link", { name: "New issue" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/tracker/issues/new`)
  const form = page.getByRole("form", { name: "New issue" })
  await form.getByLabel("Title").fill("Crash on save")
  await form.getByLabel("Labels").fill("bug ui")
  await form.getByLabel("Description").fill("Steps:\n\n1. Open a file\n2. **Save**")

  // a double click opens one issue
  const writes = countWrites(page, /\/api\/v1\/repos\/alice\/tracker\/issues$/)
  await form.getByRole("button", { name: "Open issue" }).dblclick()
  await expect(page).toHaveURL(/\/repos\/alice\/tracker\/issues\/[0-9a-f]{32}$/)
  const id = page.url().split("/").pop()!
  expect(writes).toEqual(["POST /api/v1/repos/alice/tracker/issues"])
  await expect(page.getByRole("heading", { level: 2, name: "Crash on save" })).toBeVisible()

  for (const step of ["refresh", "restart"] as const) {
    if (step === "restart") backend = await backend.restart!()
    await page.reload()
    await expect(page.getByRole("heading", { level: 2, name: "Crash on save" }), step).toBeVisible()
    await expect(page.getByRole("region", { name: "Description" }).getByText("Save", { exact: true })).toBeVisible()
    await expect(page.getByRole("region", { name: "Labels" }).getByRole("link")).toHaveText(["bug", "ui"])
    expect(await tuiIssueIds(backend, "/alice:tracker", "open"), step).toEqual([id])
    expect(await tuiIssuePage(backend, "/alice:tracker", id), step).toContain("Crash on save")
  }

  // the form keeps what was typed when Haxy refuses it
  await page.goto(`${hub.url}/repos/alice/tracker/issues/new`)
  await form.getByLabel("Description").fill("No title yet")
  await form.getByRole("button", { name: "Open issue" }).click()
  await expect(form.getByText("Enter a title.")).toBeVisible()
  await expect(form.getByLabel("Description")).toHaveValue("No title yet")
  expect(await tuiIssueIds(backend, "/alice:tracker", "open")).toEqual([id])
})

test("a writer edits, closes, reopens and removes an issue; each change shows after a refresh and in Haxy's own lists", async ({ page, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  await logIn(page, hub.url, alice, "/")
  await createRepo(page.context().request, backend, { name: "tracker", access: "public" })
  const id = await createIssue(page.context().request, backend, "/alice:tracker", { title: "Typo", labels: "docs", description: "In the README." })

  await page.goto(`${hub.url}/repos/alice/tracker/issues/${id}`)
  await actions(page).getByRole("link", { name: "Edit" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/tracker/issues/${id}/edit`)
  const form = page.getByRole("form", { name: "Edit issue" })
  await expect(form.getByLabel("Title")).toHaveValue("Typo")
  await expect(form.getByLabel("Labels")).toHaveValue("docs")
  await expect(form.getByLabel("Description")).toHaveValue("In the README.")
  await form.getByLabel("Title").fill("Typo in the README")
  await form.getByLabel("Labels").fill("docs good-first-issue")
  await form.getByRole("button", { name: "Save changes" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/tracker/issues/${id}`)
  await page.reload()
  await expect(page.getByRole("heading", { level: 2, name: "Typo in the README" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Labels" }).getByRole("link")).toHaveText(["docs", "good-first-issue"])
  expect(await tuiIssuePage(backend, "/alice:tracker", id)).toContain("Typo in the README")

  // closing: a double click is one write, even when the first answer arrives
  // before the second click lands on the button it turned into "Reopen"
  const writes = countWrites(page, /\/status$/)
  await actions(page).getByRole("button", { name: "Close issue" }).dblclick({ delay: 400 })
  await expect(actions(page).getByRole("button", { name: "Reopen issue" })).toBeVisible()
  expect(writes).toHaveLength(1)
  await expect(page.getByText("Closed", { exact: true })).toBeVisible()
  await page.reload()
  await expect(actions(page).getByRole("button", { name: "Reopen issue" })).toBeVisible()
  expect(await tuiIssueIds(backend, "/alice:tracker", "closed")).toEqual([id])

  await actions(page).getByRole("button", { name: "Reopen issue" }).click()
  await expect(actions(page).getByRole("button", { name: "Close issue" })).toBeVisible()
  await page.reload()
  await expect(page.getByText("Open", { exact: true })).toBeVisible()
  expect(await tuiIssueIds(backend, "/alice:tracker", "open")).toEqual([id])

  // removing asks first; cancelling changes nothing
  await actions(page).getByRole("button", { name: "Remove" }).click()
  const confirm = page.getByRole("alertdialog", { name: "Remove this issue?" })
  await expect(confirm).toContainText("Typo in the README")
  await confirm.getByRole("button", { name: "Cancel" }).click()
  await expect(confirm).toHaveCount(0)
  expect(await tuiIssueIds(backend, "/alice:tracker", "open")).toEqual([id])

  const removals = countWrites(page, /\/issues\/[0-9a-f]{32}$/)
  await actions(page).getByRole("button", { name: "Remove" }).click()
  await confirm.getByRole("button", { name: "Remove issue" }).dblclick()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/tracker/issues`)
  expect(removals).toEqual([`DELETE /api/v1/repos/alice/tracker/issues/${id}`])
  await expect(page.getByText("No open issues")).toBeVisible()
  await page.goto(`${hub.url}/repos/alice/tracker/issues/${id}`)
  await expect(page.getByRole("heading", { name: "Issue not found" })).toBeVisible()
  expect(await tuiIssueIds(backend, "/alice:tracker", "open")).toEqual([])
  expect(await tuiIssueIds(backend, "/alice:tracker", "closed")).toEqual([])
})

test("anonymous viewers and readers get no write controls, and a direct visit to the form says why", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const owner = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  const repo = { owner: alice.name, name: "tracker", access: "public" as const }
  await createRepo(owner, backend, repo)
  const id = await createIssue(owner, backend, "/alice:tracker", { title: "Owner's issue" })

  await page.goto(`${hub.url}/repos/alice/tracker/issues`)
  await expect(page.getByRole("link", { name: "Owner's issue" })).toBeVisible()
  await expect(page.getByRole("link", { name: "New issue" })).toHaveCount(0)
  await page.goto(`${hub.url}/repos/alice/tracker/issues/${id}`)
  await expect(page.getByRole("heading", { level: 2, name: "Owner's issue" })).toBeVisible()
  await expect(actions(page)).toHaveCount(0)
  await page.goto(`${hub.url}/repos/alice/tracker/issues/new`)
  await expect(page.getByText("to open an issue.")).toBeVisible()
  await expect(page.getByRole("form", { name: "New issue" })).toHaveCount(0)
  await page.goto(`${hub.url}/repos/alice/tracker/issues/${id}/edit`)
  await expect(page.getByText("Log in to change this issue.")).toBeVisible()
  await expect(page.getByRole("form", { name: "Edit issue" })).toHaveCount(0)

  // a reader may open issues while anybody may, but can't change the owner's
  await logIn(page, hub.url, bob, `/repos/alice/tracker/issues/${id}`)
  await expect(page.getByRole("heading", { level: 2, name: "Owner's issue" })).toBeVisible()
  await expect(actions(page)).toHaveCount(0)
  await page.goto(`${hub.url}/repos/alice/tracker/issues`)
  await expect(page.getByRole("link", { name: "New issue" })).toBeVisible()

  // once only members may write issues, a reader gets nothing
  await setIssueRole(owner, backend, repo, "members")
  await page.goto(`${hub.url}/repos/alice/tracker/issues`)
  await expect(page.getByRole("link", { name: "Owner's issue" })).toBeVisible()
  await expect(page.getByRole("link", { name: "New issue" })).toHaveCount(0)
  await page.goto(`${hub.url}/repos/alice/tracker/issues/new`)
  await expect(page.getByText("Your role in this repository doesn't allow opening issues.")).toBeVisible()
  await owner.dispose()
})

test("a member whose role is revoked after the page loaded is refused, not told it worked", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const owner = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  const repo = { owner: alice.name, name: "tracker", access: "public" as const }
  await createRepo(owner, backend, repo)
  await setIssueRole(owner, backend, repo, "members")
  await grantMember(owner, backend, repo, bob.name)
  const id = await createIssue(owner, backend, "/alice:tracker", { title: "Owner issue" })

  await logIn(page, hub.url, bob, `/repos/alice/tracker/issues/${id}`)
  await expect(actions(page).getByRole("button", { name: "Close issue" })).toBeVisible()
  await revokeMember(owner, backend, repo, bob.name)
  await actions(page).getByRole("button", { name: "Close issue" }).click()
  await expect(page.getByRole("alert")).toContainText("Your role in this repository doesn't allow writing issues.")
  await page.reload()
  await expect(page.getByText("Open", { exact: true })).toBeVisible()
  expect(await tuiIssueIds(backend, "/alice:tracker", "open")).toEqual([id])

  // the new-issue form, loaded while bob was a member
  await grantMember(owner, backend, repo, bob.name)
  await page.goto(`${hub.url}/repos/alice/tracker/issues/new`)
  const form = page.getByRole("form", { name: "New issue" })
  await form.getByLabel("Title").fill("Member's idea")
  await revokeMember(owner, backend, repo, bob.name)
  await form.getByRole("button", { name: "Open issue" }).click()
  await expect(form.getByRole("alert")).toContainText("Your role in this repository doesn't allow writing issues.")
  await expect(page).toHaveURL(`${hub.url}/repos/alice/tracker/issues/new`)
  await expect(form.getByLabel("Title")).toHaveValue("Member's idea")
  expect(await tuiIssueIds(backend, "/alice:tracker", "open")).toEqual([id])
  await owner.dispose()
})

test("an edit based on a version someone else changed is refused until the current version has been seen", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  const other = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  await logIn(page, hub.url, alice, "/")
  await createRepo(other, backend, { name: "tracker", access: "public" })
  const id = await createIssue(other, backend, "/alice:tracker", { title: "First title" })

  await page.goto(`${hub.url}/repos/alice/tracker/issues/${id}/edit`)
  const form = page.getByRole("form", { name: "Edit issue" })
  await form.getByLabel("Title").fill("My title")
  // another client (Haxy's own edit form) changes it meanwhile
  await editIssue(other, backend, "/alice:tracker", id, { title: "Their title", description: "Their words." })
  await form.getByRole("button", { name: "Save changes" }).click()
  await expect(form.getByRole("alert")).toContainText("Someone changed this issue since you opened the form")
  await expect(form.getByRole("button", { name: "Save changes" })).toBeDisabled()
  expect(await tuiIssuePage(backend, "/alice:tracker", id)).toContain("Their title")

  await form.getByRole("button", { name: "Show the current version" }).click()
  const current = form.getByRole("region", { name: "Current version" })
  await expect(current).toContainText("Their title")
  await expect(current).toContainText("Their words.")
  await expect(form.getByLabel("Title")).toHaveValue("My title")
  await form.getByRole("button", { name: "Save changes" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/tracker/issues/${id}`)
  await page.reload()
  await expect(page.getByRole("heading", { level: 2, name: "My title" })).toBeVisible()
  expect(await tuiIssuePage(backend, "/alice:tracker", id)).toContain("My title")
  await other.dispose()
})

test("a creation whose answer is lost is looked up by its id; a retry never opens a second issue", async ({ page, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  await logIn(page, hub.url, alice, "/")
  await createRepo(page.context().request, backend, { name: "tracker", access: "public" })
  const create = /\/api\/v1\/repos\/alice\/tracker\/issues$/

  // Haxy opens the issue, but its answer never arrives
  await page.route(create, async (route) => {
    if (route.request().method() !== "POST") return route.continue()
    await route.fetch()
    await route.abort("connectionreset")
  }, { times: 1 })
  await page.goto(`${hub.url}/repos/alice/tracker/issues/new`)
  const form = page.getByRole("form", { name: "New issue" })
  await form.getByLabel("Title").fill("Lost answer")
  await form.getByRole("button", { name: "Open issue" }).click()
  await expect(form.getByText("The issue was opened.")).toBeVisible()
  await expect(form.getByRole("button", { name: "Open issue" })).toBeDisabled()
  const opened = await tuiIssueIds(backend, "/alice:tracker", "open")
  expect(opened).toHaveLength(1)
  await form.getByRole("link", { name: "Open the issue" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/tracker/issues/${opened[0]}`)

  // the request never reaches Haxy: nothing was opened, and a retry opens it once
  await page.route(create, (route) => (route.request().method() === "POST" ? route.abort("connectionreset") : route.continue()), { times: 1 })
  await page.goto(`${hub.url}/repos/alice/tracker/issues/new`)
  await form.getByLabel("Title").fill("Never sent")
  await form.getByRole("button", { name: "Open issue" }).click()
  await expect(form.getByText("nothing was opened")).toBeVisible()
  await form.getByRole("button", { name: "Open issue" }).click()
  await expect(page).toHaveURL(/\/repos\/alice\/tracker\/issues\/[0-9a-f]{32}$/)
  await expect(page.getByRole("heading", { level: 2, name: "Never sent" })).toBeVisible()
  expect(await tuiIssueIds(backend, "/alice:tracker", "open")).toHaveLength(2)

  // the answer is lost and someone removes the issue before the form looks it
  // up: the retry is refused (the id stays taken), and the form says the
  // issue was opened and removed, keeping the draft for a fresh issue
  let removedId = ""
  await page.route(create, async (route) => {
    if (route.request().method() !== "POST") return route.continue()
    const response = await route.fetch()
    removedId = ((await response.json()) as { id: string }).id
    await removeIssue(page.context().request, backend, "/alice:tracker", removedId)
    await route.abort("connectionreset")
  }, { times: 1 })
  await page.goto(`${hub.url}/repos/alice/tracker/issues/new`)
  await form.getByLabel("Title").fill("Removed meanwhile")
  await form.getByRole("button", { name: "Open issue" }).click()
  await expect(form.getByText("nothing was opened")).toBeVisible()
  await form.getByRole("button", { name: "Open issue" }).click()
  await expect(form.getByText("was opened and then removed")).toBeVisible()
  await expect(form.getByRole("link", { name: "Open the issue" })).toHaveCount(0)
  await expect(form.getByRole("button", { name: "Open issue" })).toBeDisabled()
  await expect(form.getByLabel("Title")).toHaveValue("Removed meanwhile")
  await form.getByRole("button", { name: "Open it as a new issue" }).click()
  await form.getByRole("button", { name: "Open issue" }).click()
  await expect(page).toHaveURL(/\/repos\/alice\/tracker\/issues\/[0-9a-f]{32}$/)
  expect(page.url()).not.toContain(removedId)
  await expect(page.getByRole("heading", { level: 2, name: "Removed meanwhile" })).toBeVisible()
  expect(await tuiIssueIds(backend, "/alice:tracker", "open")).toHaveLength(3)

  // a removal whose answer is lost is settled the same way
  await page.route(/\/issues\/[0-9a-f]{32}$/, async (route) => {
    if (route.request().method() !== "DELETE") return route.continue()
    await route.fetch()
    await route.abort("connectionreset")
  }, { times: 1 })
  await actions(page).getByRole("button", { name: "Remove" }).click()
  await page.getByRole("alertdialog", { name: "Remove this issue?" }).getByRole("button", { name: "Remove issue" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/tracker/issues`)
  await expect(page.getByRole("list", { name: "Open issues" }).getByRole("listitem")).toHaveCount(2)
})

test("local mode opens, edits, closes and removes issues without logging in", async ({ page, request, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  const existing = await createIssue(request, backend, "", { title: "From the TUI" })

  await page.goto(`${hub.url}/repo/issues`)
  await page.getByRole("link", { name: "New issue" }).click()
  const form = page.getByRole("form", { name: "New issue" })
  await form.getByLabel("Title").fill("From Hub")
  await form.getByLabel("Labels").fill("local")
  await form.getByRole("button", { name: "Open issue" }).click()
  await expect(page).toHaveURL(/\/repo\/issues\/[0-9a-f]{32}$/)
  const id = page.url().split("/").pop()!
  await expect(page.getByText("e2e@example.test")).toBeVisible()

  await actions(page).getByRole("link", { name: "Edit" }).click()
  await page.getByRole("form", { name: "Edit issue" }).getByLabel("Title").fill("From Hub, edited")
  await page.getByRole("form", { name: "Edit issue" }).getByRole("button", { name: "Save changes" }).click()
  await expect(page.getByRole("heading", { level: 2, name: "From Hub, edited" })).toBeVisible()
  await actions(page).getByRole("button", { name: "Close issue" }).click()
  await expect(actions(page).getByRole("button", { name: "Reopen issue" })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("heading", { level: 2, name: "From Hub, edited" })).toBeVisible()
  expect(await tuiIssueIds(backend, "", "closed")).toEqual([id])
  expect(await tuiIssuePage(backend, "", id)).toContain("From Hub, edited")

  await page.goto(`${hub.url}/repo/issues/${existing}`)
  await actions(page).getByRole("button", { name: "Remove" }).click()
  await page.getByRole("alertdialog", { name: "Remove this issue?" }).getByRole("button", { name: "Remove issue" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/issues`)
  expect(await tuiIssueIds(backend, "", "open")).toEqual([])
})
