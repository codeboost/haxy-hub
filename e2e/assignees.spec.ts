import type { Page, Route } from "@playwright/test"
import { alice, registerUser, type Account, logOutFromHeader } from "./support/accounts"
import { expect, test } from "./support/fixtures"
import { assignIssue, createIssue, tuiIssuePage } from "./support/issues"
import { createRepo } from "./support/repos"

// Assigning and unassigning people in the browser, through Vite's proxy
// against a real Haxy. Every change is checked again after a refresh and in
// Haxy's own server-rendered issue page (the TUI's).

const bob: Account = { name: "bobby", email: "bobby@example.test", password: "bobby's password" }
const header = (page: Page) => page.getByRole("banner")
const assignees = (page: Page) => page.getByRole("region", { name: "Assignees" })
const assigned = (page: Page) => assignees(page).getByRole("list", { name: "Assigned" }).getByRole("link")
const form = (page: Page) => page.getByRole("form", { name: "Assign someone" })

async function logIn(page: Page, hubUrl: string, account: Account, next: string) {
  await page.goto(`${hubUrl}/login?next=${encodeURIComponent(next)}`)
  await page.getByLabel("Username").fill(account.name)
  await page.getByLabel("Password").fill(account.password)
  await page.getByRole("button", { name: "Log in" }).click()
  await expect(header(page)).toContainText(`Signed in as ${account.name}`)
}

/**
 * Lets a request reach Haxy, then loses its answer on the way back, as the
 * proxy does when the backend's connection drops (502: outcome unknown).
 * (Aborting a request after fetching it sometimes leaves Chromium's fetch
 * unsettled under load.)
 */
async function answerLost(route: Route) {
  await route.fetch()
  await route.fulfill({ status: 502, body: "" })
}

/** Shows the assignees' controls, which sit behind the section's toggle. */
async function editAssignees(page: Page) {
  const toggle = assignees(page).getByRole("button", { name: "Edit assignees" })
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await toggle.click()
  await expect(form(page)).toBeVisible()
}

async function assign(page: Page, who: string) {
  await form(page).getByLabel("Assign").fill(who)
  await form(page).getByRole("button", { name: "Assign" }).click()
}

test("the owner assigns by name and by email, follows an assignee to their issues, and unassigns", async ({ page, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  await logIn(page, hub.url, alice, "/")
  await createRepo(page.context().request, backend, { name: "tracker", access: "public" })
  const id = await createIssue(page.context().request, backend, "/alice:tracker", { title: "Crash on save" })
  await createIssue(page.context().request, backend, "/alice:tracker", { title: "Someone else's" })

  await page.goto(`${hub.url}/repos/alice/tracker/issues/${id}`)
  await expect(assignees(page).getByText("Nobody is assigned to this issue.")).toBeVisible()
  await expect(form(page)).toHaveCount(0)
  await editAssignees(page)
  await assign(page, "bobby")
  await expect(assigned(page)).toHaveText(["bobby"])
  await expect(form(page).getByLabel("Assign")).toHaveValue("")
  await assign(page, "outside@example.test")
  await expect(assigned(page)).toHaveText(["bobby", "outside@example.test"])

  await page.reload()
  await expect(assigned(page)).toHaveText(["bobby", "outside@example.test"])
  const tui = await tuiIssuePage(backend, "/alice:tracker", id)
  expect(tui).toContain("bobby")
  expect(tui).toContain("outside@example.test")

  // Haxy's refusals show beside the field, keeping what was typed
  await editAssignees(page)
  await assign(page, "nobody-here")
  await expect(form(page).getByText("No account has this name.")).toBeVisible()
  await expect(form(page).getByLabel("Assign")).toHaveValue("nobody-here")
  await assign(page, "bobby@example.test")
  await expect(form(page).getByText("This person is already assigned.")).toBeVisible()
  await expect(assigned(page)).toHaveText(["bobby", "outside@example.test"])

  // an assignee leads to the issues assigned to them
  await assigned(page).getByText("bobby", { exact: true }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/tracker/issues?search=assignee%3Abobby`)
  await expect(page.getByRole("status", { name: "Active filters" })).toHaveText("Showing open issues assigned to bobby.")
  await expect(page.getByRole("list", { name: "Open issues" }).getByRole("link", { name: "Crash on save" })).toBeVisible()
  await expect(page.getByRole("list", { name: "Open issues" }).getByRole("link", { name: "Someone else's" })).toHaveCount(0)
  await page.goBack()
  await assigned(page).getByText("outside@example.test").click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/tracker/issues?search=assignee%3Aoutside%40example.test`)
  await expect(page.getByRole("list", { name: "Open issues" }).getByRole("link", { name: "Crash on save" })).toBeVisible()
  await page.goBack()

  await editAssignees(page)
  await assignees(page).getByRole("button", { name: "Unassign bobby" }).click()
  await expect(assigned(page)).toHaveText(["outside@example.test"])
  await page.reload()
  await expect(assigned(page)).toHaveText(["outside@example.test"])
  expect(await tuiIssuePage(backend, "/alice:tracker", id)).not.toContain("bobby")
})

test("someone who may not change the issue sees its assignees, but no way to change them", async ({ page, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  await logIn(page, hub.url, alice, "/")
  await createRepo(page.context().request, backend, { name: "tracker", access: "public" })
  const id = await createIssue(page.context().request, backend, "/alice:tracker", { title: "Alice's" })
  await assignIssue(page.context().request, backend, "/alice:tracker", id, "alice")
  await logOutFromHeader(page)
  await expect(header(page)).not.toContainText("Signed in as")

  await logIn(page, hub.url, bob, `/repos/alice/tracker/issues/${id}`)
  await expect(assigned(page)).toHaveText(["alice"])
  await expect(form(page)).toHaveCount(0)
  await expect(assignees(page).getByRole("button")).toHaveCount(0)
})

test("a write whose answer is lost is settled by reading the issue; repeating it settles too, rather than failing", async ({ page, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  await logIn(page, hub.url, alice, "/")
  await createRepo(page.context().request, backend, { name: "tracker", access: "public" })
  const id = await createIssue(page.context().request, backend, "/alice:tracker", { title: "Lost answers" })
  const route = /\/assignees(\/[0-9a-f]{32})?$/
  const loseAnswer = () => page.route(route, answerLost, { times: 1 })
  await page.goto(`${hub.url}/repos/alice/tracker/issues/${id}`)
  await editAssignees(page)

  // Haxy assigns bobby, but its answer never arrives: the issue says he is
  await loseAnswer()
  await assign(page, "bobby")
  await expect(form(page).getByText("bobby is assigned.")).toBeVisible()
  await expect(assigned(page)).toHaveText(["bobby"])
  await expect(form(page).getByLabel("Assign")).toHaveValue("")

  // the request never reaches Haxy: nothing changed, and trying again assigns once
  await page.route(route, (request) => request.abort("connectionreset"), { times: 1 })
  await assign(page, "outside@example.test")
  await expect(form(page).getByText("assigning again is safe")).toBeVisible()
  await expect(assigned(page)).toHaveText(["bobby"])
  await form(page).getByRole("button", { name: "Assign" }).click()
  await expect(assigned(page)).toHaveText(["bobby", "outside@example.test"])

  // bob's own email shows as his name, so the read can't tell; assigning
  // again is refused as already assigned, which settles it
  await assignees(page).getByRole("button", { name: "Unassign bobby" }).click()
  await expect(assigned(page)).toHaveText(["outside@example.test"])
  await loseAnswer()
  await assign(page, "bobby@example.test")
  await expect(form(page).getByText("assigning again is safe")).toBeVisible()
  await expect(assigned(page)).toHaveText(["bobby", "outside@example.test"])
  await form(page).getByRole("button", { name: "Assign" }).click()
  await expect(form(page).getByText("bobby@example.test is assigned.")).toBeVisible()
  await expect(form(page).getByText("already assigned")).toHaveCount(0)
  await expect(form(page).getByLabel("Assign")).toHaveValue("")

  // an unassignment whose answer is lost is settled the same way
  await loseAnswer()
  await assignees(page).getByRole("button", { name: "Unassign outside@example.test" }).click()
  await expect(form(page).getByText("outside@example.test is no longer assigned.")).toBeVisible()
  await expect(assigned(page)).toHaveText(["bobby"])
  await page.reload()
  await expect(assigned(page)).toHaveText(["bobby"])
  const tui = await tuiIssuePage(backend, "/alice:tracker", id)
  expect(tui).toContain("bobby")
  expect(tui).not.toContain("outside@example.test")
})

test("local mode assigns by email, shows unresolved assignees by email, and links to their issues", async ({ page, request, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  const id = await createIssue(request, backend, "", { title: "Offline crash" })
  await createIssue(request, backend, "", { title: "Unrelated" })
  // one assigned from Haxy's own page
  await assignIssue(request, backend, "", id, "tui@example.test")

  await page.goto(`${hub.url}/repo/issues/${id}`)
  await expect(assigned(page)).toHaveText(["tui@example.test"])
  await editAssignees(page)
  await expect(form(page).getByText("An email address: local mode has no accounts.")).toBeVisible()
  await assign(page, "ada")
  await expect(form(page).getByText("Enter an email address.")).toBeVisible()
  await assign(page, "ada@example.test")
  await expect(assigned(page)).toHaveText(["tui@example.test", "ada@example.test"])
  await page.reload()
  await expect(assigned(page)).toHaveText(["tui@example.test", "ada@example.test"])
  expect(await tuiIssuePage(backend, "", id)).toContain("ada@example.test")

  await assigned(page).getByText("ada@example.test").click()
  await expect(page).toHaveURL(`${hub.url}/repo/issues?search=assignee%3Aada%40example.test`)
  await expect(page.getByRole("list", { name: "Open issues" }).getByRole("link", { name: "Offline crash" })).toBeVisible()
  await expect(page.getByRole("list", { name: "Open issues" }).getByRole("link", { name: "Unrelated" })).toHaveCount(0)
  await page.goBack()

  await editAssignees(page)
  await assignees(page).getByRole("button", { name: "Unassign tui@example.test" }).click()
  await expect(assigned(page)).toHaveText(["ada@example.test"])
  await page.reload()
  await expect(assigned(page)).toHaveText(["ada@example.test"])
  expect(await tuiIssuePage(backend, "", id)).not.toContain("tui@example.test")
})

/** An issue of alice's in her public tracker, alice (and bobby) registered, and alice signed in on its page. */
async function onAlicesIssue(page: Page, launch: Parameters<Parameters<typeof test>[2]>[0]["launch"]) {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  await logIn(page, hub.url, alice, "/")
  await createRepo(page.context().request, backend, { name: "tracker", access: "public" })
  const id = await createIssue(page.context().request, backend, "/alice:tracker", { title: "Busy issue" })
  await page.goto(`${hub.url}/repos/alice/tracker/issues/${id}`)
  await editAssignees(page)
  return { backend, hub, id }
}

const issueActions = (page: Page) => page.getByRole("group", { name: "Issue actions" })

test("an assignment and a status change whose answers cross each show what Haxy holds, neither undoing the other", async ({ page, launch }) => {
  const { backend, id } = await onAlicesIssue(page, launch)

  // the assignment lands, but its answer arrives only after the issue is closed
  let releaseAssign = () => {}
  const assignHeld = new Promise<void>((resolve) => { releaseAssign = resolve })
  let assignLanded = () => {}
  const landed = new Promise<void>((resolve) => { assignLanded = resolve })
  await page.route(/\/assignees$/, async (route) => {
    const response = await route.fetch()
    assignLanded()
    await assignHeld
    await route.fulfill({ response })
  }, { times: 1 })
  await assign(page, "bobby")
  await landed
  await expect(form(page).getByRole("button", { name: "Assign" })).toBeDisabled()
  await issueActions(page).getByRole("button", { name: "Close issue" }).click()
  await expect(issueActions(page).getByRole("button", { name: "Reopen issue" })).toBeVisible()
  releaseAssign()
  await expect(assigned(page)).toHaveText(["bobby"])
  await expect(issueActions(page).getByRole("button", { name: "Reopen issue" })).toBeVisible()
  await expect(page.getByText("Closed", { exact: true })).toBeVisible()

  // the reopening lands first, and its answer (without the assignment) arrives after it
  let releaseStatus = () => {}
  const statusHeld = new Promise<void>((resolve) => { releaseStatus = resolve })
  await page.route(/\/status$/, async (route) => {
    const response = await route.fetch()
    await statusHeld
    await route.fulfill({ response })
  }, { times: 1 })
  await issueActions(page).getByRole("button", { name: "Reopen issue" }).click()
  await expect(issueActions(page).getByRole("button", { name: "Reopen issue" })).toBeDisabled()
  await assign(page, "outside@example.test")
  await expect(assigned(page)).toHaveText(["bobby", "outside@example.test"])
  releaseStatus()
  await expect(issueActions(page).getByRole("button", { name: "Close issue" })).toBeVisible()
  await expect(assigned(page)).toHaveText(["bobby", "outside@example.test"])

  await page.reload()
  await expect(assigned(page)).toHaveText(["bobby", "outside@example.test"])
  await expect(issueActions(page).getByRole("button", { name: "Close issue" })).toBeVisible()
  expect(await tuiIssuePage(backend, "/alice:tracker", id)).toContain("outside@example.test")
})

test("a repeat that settles an earlier write, when the issue can't be read again, waits for a check instead of claiming the list is current", async ({ page, launch }) => {
  const { backend, id } = await onAlicesIssue(page, launch)
  const issueRead = new RegExp(`/api/v1/repos/alice/tracker/issues/${id}$`)
  // reads of the issue fail while `failing` is set (a flag, not `times`, so a
  // background read can't use up the failure meant for the form's own read).
  // Each answer is followed by a background read of the issue; failing it keeps
  // the list as this page last showed it, so the change someone else makes
  // below can't reach the page before the form's own read
  await expect(form(page).getByLabel("Assign")).toBeVisible()
  let failing = true
  await page.route(issueRead, (route) => (failing && route.request().method() === "GET" ? route.abort("connectionreset") : route.fallback()))
  await assign(page, "outside@example.test")
  await expect(assigned(page)).toHaveText(["outside@example.test"])

  // someone else unassigns them meanwhile; unassigning again is refused as not
  // assigned, and the read that would show the list as it is fails
  const unassignForm = await page.context().request.post(`${backend.origin}/alice:tracker/issue:${id}/assignee:${encodeURIComponent("outside@example.test")}/unassign`, { maxRedirects: 0 })
  expect(unassignForm.status()).toBe(303)
  await assignees(page).getByRole("button", { name: "Unassign outside@example.test" }).click()
  await expect(form(page).getByRole("button", { name: "Check again" })).toBeVisible()
  await expect(form(page).getByRole("button", { name: "Assign" })).toBeDisabled()
  failing = false
  await form(page).getByRole("button", { name: "Check again" }).click()
  await expect(assignees(page).getByText("Nobody is assigned to this issue.")).toBeVisible()
  await expect(form(page).getByRole("button", { name: "Check again" })).toHaveCount(0)
  await expect(form(page).getByRole("button", { name: "Assign" })).toBeEnabled()

  // an assignment whose answer is lost, then repeated and refused as already
  // assigned, with the read after it failing too
  await page.route(/\/assignees$/, answerLost, { times: 1 })
  await assign(page, "bobby@example.test")
  await expect(form(page).getByText("assigning again is safe")).toBeVisible()
  failing = true
  await form(page).getByRole("button", { name: "Assign" }).click()
  await expect(form(page).getByRole("button", { name: "Check again" })).toBeVisible()
  await expect(form(page).getByRole("button", { name: "Assign" })).toBeDisabled()
  failing = false
  await form(page).getByRole("button", { name: "Check again" }).click()
  await expect(assigned(page)).toHaveText(["bobby"])
  await expect(form(page).getByText("bobby@example.test is assigned.")).toBeVisible()
  await expect(form(page).getByRole("button", { name: "Assign" })).toBeEnabled()
})

test("a double click on Assign assigns once, even when the first answer arrives between the clicks", async ({ page, launch }) => {
  await onAlicesIssue(page, launch)
  const writes: string[] = []
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/assignees$/.test(new URL(request.url()).pathname)) writes.push(request.postData() ?? "")
  })
  await form(page).getByLabel("Assign").fill("bobby")
  await form(page).getByRole("button", { name: "Assign" }).dblclick({ delay: 400 })
  await expect(assigned(page)).toHaveText(["bobby"])
  // give a second submission time to be sent and answered
  await page.waitForTimeout(500)
  expect(writes).toEqual([JSON.stringify({ assignee: "bobby" })])
  await expect(form(page).getByText("Enter an account name or an email address.")).toHaveCount(0)
})
