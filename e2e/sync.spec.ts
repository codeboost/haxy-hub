import type { APIRequestContext, Page } from "@playwright/test"
import { expect, test } from "./support/fixtures"
import { writeHeaders } from "./support/accounts"
import { createIssue, editIssue, tuiIssueIds } from "./support/issues"
import { commitOnRemoteEvents, gitRemoteFixture, localGit, serverBase, silentRemote, syncFixture } from "./support/sync"

// Local mode's sync in the browser: the events page syncs with the remote
// through Vite's proxy against real Haxy processes (local mode and a server
// with SSH), and every result is checked again after a reload and on the
// server through its own pages.

type Detail = { id: string; revision: string }

async function send(request: APIRequestContext, hubUrl: string, method: string, path: string, body?: unknown) {
  const headers = { ...(await writeHeaders(request, hubUrl)), "Content-Type": "application/json" }
  return request.fetch(`${hubUrl}${path}`, { method, headers, data: body === undefined ? undefined : JSON.stringify(body) })
}

const panel = (page: Page) => page.getByRole("region", { name: "Sync" })

test("the events page syncs with the remote: both sides get each other's issues, and HEAD stays", async ({ page, playwright, request, launch }) => {
  const { server, owner, local, hub } = await syncFixture(playwright, launch)
  const head = await localGit(local, "rev-parse", "HEAD")
  const mine: Detail = await (await send(request, hub.url, "POST", "/api/v1/repo/issues", { title: "Found offline" })).json()
  await createIssue(owner, server, serverBase, { title: "Filed on the server" })

  await page.goto(`${hub.url}/repo/events`)
  await expect(panel(page).getByRole("heading", { name: "Sync with origin" })).toBeVisible()
  await expect(panel(page)).toContainText("Haxy has no copy of origin's events yet")
  await panel(page).getByRole("button", { name: "Sync now" }).click()
  await expect(panel(page).getByRole("status").filter({ hasText: "Synced with origin at" })).toBeVisible()
  await expect(panel(page)).toContainText("Events match origin's as of the last sync.")
  // the events list was read again: it has the server's issue now
  await expect(page.getByRole("list", { name: "Active events" }).getByRole("listitem")).toHaveCount(2)

  await page.reload()
  await expect(panel(page)).toContainText("Last sync: Synced with origin at")
  await page.goto(`${hub.url}/repo/issues`)
  await expect(page.getByRole("link", { name: "Filed on the server" })).toBeVisible()
  expect(await tuiIssueIds(server, serverBase, "open")).toContain(mine.id)
  expect(await localGit(local, "rev-parse", "HEAD")).toBe(head)
  expect(await localGit(local, "symbolic-ref", "HEAD")).toBe("refs/heads/main")
})

test("a sync while the server is down says what failed and that local changes are kept", async ({ page, playwright, request, launch }) => {
  const { server, hub } = await syncFixture(playwright, launch)
  await send(request, hub.url, "POST", "/api/v1/repo/issues", { title: "Kept while offline" })
  await server.stop()

  await page.goto(`${hub.url}/repo/events`)
  await panel(page).getByRole("button", { name: "Sync now" }).click()
  const alert = panel(page).getByRole("alert")
  await expect(alert).toContainText("failed. Couldn't fetch the remote's events")
  await expect(alert).toContainText("your local changes are kept")
  await expect(panel(page).getByRole("button", { name: "Sync now" })).toBeEnabled()

  await page.reload()
  await expect(panel(page).getByRole("alert")).toContainText("Last sync: The sync at")
  await page.goto(`${hub.url}/repo/issues`)
  await expect(page.getByRole("link", { name: "Kept while offline" })).toBeVisible()
})

test("a sync whose answer is lost is settled by reading Haxy's status before another is offered", async ({ page, playwright, request, launch }) => {
  const { server, hub } = await syncFixture(playwright, launch)
  const mine: Detail = await (await send(request, hub.url, "POST", "/api/v1/repo/issues", { title: "Sent despite the lost answer" })).json()
  await page.goto(`${hub.url}/repo/events`)
  await expect(panel(page)).toContainText("Haxy has no copy of origin's events yet")

  // Haxy syncs, but the answer never reaches the page
  await page.route("**/api/v1/repo/sync", async (route) => {
    if (route.request().method() !== "POST") return route.continue()
    await route.fetch()
    await route.abort("connectionreset")
  }, { times: 1 })
  await panel(page).getByRole("button", { name: "Sync now" }).click()
  await expect(panel(page).getByRole("status").filter({ hasText: "Haxy's answer was lost, but a sync has finished since: Synced with origin at" })).toBeVisible()
  expect(await tuiIssueIds(server, serverBase, "open")).toEqual([mine.id])

  // a request that never reached Haxy: no sync finished, so another may run
  await page.route("**/api/v1/repo/sync", (route) => (route.request().method() === "POST" ? route.abort("connectionreset") : route.continue()), { times: 1 })
  await panel(page).getByRole("button", { name: "Sync now" }).click()
  await expect(panel(page).getByRole("alert")).toContainText("Haxy has no record of a sync finishing since")
  await expect(panel(page).getByRole("button", { name: "Sync now" })).toBeEnabled()
})

test("conflicting edits from both sides are counted after a sync, with links to the conflicted issues", async ({ page, playwright, request, launch }) => {
  const { server, owner, hub } = await syncFixture(playwright, launch)
  const issue: Detail = await (await send(request, hub.url, "POST", "/api/v1/repo/issues", { title: "Shared", description: "Base" })).json()
  await page.goto(`${hub.url}/repo/events`)
  await panel(page).getByRole("button", { name: "Sync now" }).click()
  await expect(panel(page).getByRole("status").filter({ hasText: "Synced with origin at" })).toBeVisible()

  expect((await send(request, hub.url, "PATCH", `/api/v1/repo/issues/${issue.id}`, { revision: issue.revision, title: "Local title", labels: "", description: "Base" })).status()).toBe(200)
  await editIssue(owner, server, serverBase, issue.id, { title: "Server title", description: "Base" })
  await panel(page).getByRole("button", { name: "Sync now" }).click()
  const conflicts = panel(page).getByRole("region", { name: "Metadata conflicts" })
  await expect(conflicts).toContainText("1 issue has a conflict")

  await page.reload()
  await expect(conflicts).toContainText("1 issue has a conflict")
  await conflicts.getByRole("link", { name: "Local title" }).click()
  await expect(page.getByRole("heading", { level: 2, name: "Local title" })).toBeVisible()
  await expect(page.getByText("Concurrent edits to this issue conflict")).toBeVisible()
})

test("a sync refused because another is running waits for that one, then shows its result and reads the events again", async ({ page, request, launch }) => {
  // the other sync waits on a remote that never answers
  const remote = await silentRemote()
  try {
    const local = await launch.local({ config: { "remote.origin.url": remote.url } })
    const hub = await launch.hub(local.port)
    await page.goto(`${hub.url}/repo/events`)
    await expect(panel(page).getByRole("button", { name: "Sync now" })).toBeEnabled()

    // another client (a second tab, the TUI) starts a sync first
    const other = send(request, hub.url, "POST", "/api/v1/repo/sync")
    await expect.poll(async () => ((await (await request.get(`${hub.url}/api/v1/repo/sync`)).json()) as { running: boolean }).running, { timeout: 15_000 }).toBe(true)
    await panel(page).getByRole("button", { name: "Sync now" }).click()
    await expect(panel(page)).toContainText("already running")

    // the other sync finishes
    await remote.hangUp()
    expect((await other).status()).toBe(200)
    const eventsRead = page.waitForRequest((request) => request.url().includes("/api/v1/repo/events"), { timeout: 10_000 })
    await panel(page).getByRole("button", { name: "Check again" }).click()
    await expect(panel(page).getByRole("alert")).toContainText("failed. Couldn't fetch the remote's events")
    await expect(panel(page)).not.toContainText("already running")
    await eventsRead
    await expect(panel(page).getByRole("button", { name: "Sync now" })).toBeEnabled()
  } finally {
    await remote.close()
  }
})

test("a sync from a remote whose events Haxy can't read says what to fix, and the events and issues stay as they were", async ({ page, request, launch }) => {
  const fixture = await gitRemoteFixture(launch)
  const { hub } = fixture
  await send(request, hub.url, "POST", "/api/v1/repo/issues", { title: "Synced before" })
  await page.goto(`${hub.url}/repo/events`)
  await panel(page).getByRole("button", { name: "Sync now" }).click()
  await expect(panel(page).getByRole("status").filter({ hasText: "Synced with origin at" })).toBeVisible()

  await commitOnRemoteEvents(fixture, "{\"id\": \"not an event")
  await send(request, hub.url, "POST", "/api/v1/repo/issues", { title: "Written since" })
  await page.reload()
  const events = page.getByRole("list", { name: "Active events" }).getByRole("listitem")
  await expect(events).toHaveCount(2)

  await panel(page).getByRole("button", { name: "Sync now" }).click()
  const alert = panel(page).getByRole("alert")
  await expect(alert).toContainText("failed. Fetched the remote's events but couldn't merge them")
  await expect(alert).toContainText("Nothing changed here and nothing was pushed; your local changes are kept.")
  await expect(alert).toContainText("fix the branch there, then sync again")
  await expect(panel(page)).toContainText("a sync is needed")
  await expect(panel(page)).not.toContainText("Haxy couldn't read this repository's events")
  await expect(panel(page).getByRole("button", { name: "Sync now" })).toBeEnabled()
  // the events list was read again, and is as it was
  await expect(events).toHaveCount(2)

  await page.reload()
  await expect(panel(page).getByRole("alert")).toContainText("couldn't merge them")
  await expect(events).toHaveCount(2)
  await page.goto(`${hub.url}/repo/issues`)
  await expect(page.getByRole("link", { name: "Synced before" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Written since" })).toBeVisible()
})
