import type { APIRequestContext, Page, PlaywrightWorkerArgs } from "@playwright/test"
import { alice, registerUser, writeHeaders, type Account, logOutFromHeader } from "./support/accounts"
import { expect, test, type Launch } from "./support/fixtures"
import { createIssue } from "./support/issues"
import { createRepo, signedIn } from "./support/repos"

// Undo in the browser: paging the history, confirming an undo, its resulting record and
// the undo that reverses it, ownership lost after the page loaded, a lost answer, and local
// mode, through Vite's proxy against a real `haxy serve`. Every undo is checked again
// after a refresh, by what the repository's issues show.

const bob: Account = { name: "bobby", email: "bobby@example.test", password: "bobby's password" }

async function logIn(page: Page, hubUrl: string, account: Account, next: string) {
  await page.goto(`${hubUrl}/login?next=${encodeURIComponent(next)}`)
  await page.getByLabel("Username").fill(account.name)
  await page.getByLabel("Password").fill(account.password)
  await page.getByRole("button", { name: "Log in" }).click()
  await expect(page.getByRole("banner")).toContainText(`Signed in as ${account.name}`)
}

/** A server with alice and bobby, and alice's public repository `history` with `issues` issues ("Issue 0"…). */
async function setUp(launch: Launch, playwright: PlaywrightWorkerArgs["playwright"], issues: number) {
  const backend = await launch.server()
  for (const account of [alice, bob]) await registerUser(backend, account)
  const hub = await launch.hub(backend.port)
  const owner = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  await createRepo(owner, backend, { name: "history", access: "public" })
  for (let index = 0; index < issues; index++) await createIssue(owner, backend, "/alice:history", { title: `Issue ${index}` })
  return { backend, hub, owner, repoPage: `${hub.url}/repos/${alice.name}/history`, api: `${hub.url}/api/v1/repos/${alice.name}/history` }
}

/** Changes `name`'s membership through the API, as `owner`. */
async function setRole(owner: APIRequestContext, hubUrl: string, api: string, name: string, role: "member" | "owner" | null) {
  const headers = { ...(await writeHeaders(owner, hubUrl)), "Content-Type": "application/json" }
  if (role === null) return expect((await owner.delete(`${api}/settings/members/${name}`, { headers })).status()).toBe(200)
  const added = await owner.post(`${api}/settings/members`, { headers, data: { name } })
  if (added.status() !== 201) expect((await owner.put(`${api}/settings/members/${name}`, { headers, data: { role } })).status()).toBe(200)
  else if (role === "owner") expect((await owner.put(`${api}/settings/members/${name}`, { headers, data: { role } })).status()).toBe(200)
}

const historyList = (page: Page) => page.getByRole("list", { name: "Undo history" })
const row = (page: Page, transaction: string) => historyList(page).getByRole("listitem", { name: `Transaction ${transaction}`, exact: true })

/** Whether the repository's open issues list `title`, read in a fresh page load. */
async function hasIssue(page: Page, repoPage: string, title: string): Promise<boolean> {
  await page.goto(`${repoPage}/issues`)
  const list = page.getByRole("list", { name: "Open issues" })
  await expect(list).toBeVisible()
  return (await list.getByRole("link", { name: title, exact: true }).count()) > 0
}

test("an owner pages the history, confirms an undo, sees its record, and reverses it; the repository follows after a refresh", async ({ page, launch, playwright }) => {
  const { hub, repoPage } = await setUp(launch, playwright, 21)
  await logIn(page, hub.url, alice, `/repos/${alice.name}/history`)
  await page.getByRole("navigation", { name: "Repository sections" }).getByRole("link", { name: "Undo" }).click()
  await expect(page).toHaveURL(`${repoPage}/undo`)
  await expect(historyList(page).getByRole("listitem")).toHaveCount(20)
  // newest first: the last issue's creation, which wrote one event
  const newest = row(page, "21")
  await expect(newest).toContainText("events (1)")
  await expect(newest.locator("time")).toHaveAttribute("datetime", /^\d{4}-\d\d-\d\dT/)
  await expect(newest.getByRole("link", { name: "view events (1)" })).toHaveAttribute("href", `/repos/${alice.name}/history/events/transactions/21`)
  await expect(row(page, "20").getByRole("button", { name: "Undo this and all after it" })).toBeVisible()

  // the next page, kept across a refresh; the initial state can't be undone
  await page.getByRole("navigation", { name: "Undo history pages" }).getByRole("link", { name: "Next page" }).click()
  await expect(page).toHaveURL(/\/undo\?cursor=/)
  await expect(historyList(page).getByRole("listitem")).toHaveCount(2)
  await page.reload()
  await expect(row(page, "0")).toContainText("The initial state can't be undone.")
  await expect(row(page, "0").getByRole("button")).toHaveCount(0)

  // undo the newest issue's creation, after confirming (and once cancelling)
  await page.goto(`${repoPage}/undo`)
  await newest.getByRole("button", { name: "Undo this" }).click()
  const confirm = page.getByRole("group", { name: "Confirm: undo transaction 21" })
  await expect(confirm).toContainText("Undo transaction 21 (events (1))? The repository returns to its state before it.")
  await confirm.getByRole("button", { name: "Cancel" }).click()
  await expect(confirm).toHaveCount(0)
  await newest.getByRole("button", { name: "Undo this" }).click()
  await confirm.getByRole("button", { name: "Undo", exact: true }).click()
  const result = page.getByRole("region", { name: "Undo result" })
  await expect(result.getByRole("status")).toHaveText("Undone. Haxy recorded the undo as transaction 22:")
  await expect(result.getByRole("link", { name: "events (1)" })).toHaveAttribute("href", `/repos/${alice.name}/history/undo/21`)
  await expect(result).toContainText("what was undone")
  // the history follows: the undo on top, the issue's creation marked undone
  await expect(row(page, "22")).toContainText("undo")
  await expect(row(page, "21")).toContainText("Undone")

  // reverse it from the result, with its own confirmation
  await result.getByRole("button", { name: "Reverse this undo" }).click()
  await page.getByRole("group", { name: "Confirm: undo transaction 22" }).getByRole("button", { name: "Reverse the undo" }).click()
  await expect(result.getByRole("status")).toHaveText("Undone. Haxy recorded the undo as transaction 23:")
  await expect(result).toContainText("what was redone")

  // after a refresh: undoing the reversal again takes the issue away, and the history keeps every step
  await page.reload()
  await expect(row(page, "23")).toContainText("undo")
  await expect(row(page, "22")).toContainText("Undone")
  expect(await hasIssue(page, repoPage, "Issue 20")).toBe(true)
  await page.goto(`${repoPage}/undo`)
  await row(page, "21").getByRole("button", { name: "Undo this and all after it" }).click()
  await page.getByRole("group", { name: "Confirm: undo transaction 21" }).getByRole("button", { name: "Undo", exact: true }).click()
  await expect(page.getByRole("region", { name: "Undo result" })).toContainText("transaction 24")
  expect(await hasIssue(page, repoPage, "Issue 20")).toBe(false)
  expect(await hasIssue(page, repoPage, "Issue 19")).toBe(true)
})

test("Haxy's own undo links open the Hub's undo pages", async ({ page, launch, playwright }) => {
  const { hub, backend, owner, repoPage } = await setUp(launch, playwright, 3)
  const linker = await createIssue(owner, backend, "/alice:history", { title: "Links to undo", description: "[the history](/alice:history/undo)\n\n[from 2](/alice:history/undo/2)" })
  await logIn(page, hub.url, alice, `/repos/${alice.name}/history/issues/${linker}`)
  await expect(page.getByRole("link", { name: "the history" })).toHaveAttribute("href", `/repos/${alice.name}/history/undo`)
  await page.getByRole("link", { name: "from 2" }).click()
  await expect(page).toHaveURL(`${repoPage}/undo/2`)
  await expect(page.getByRole("heading", { name: "Undo history from transaction 2" })).toBeVisible()
  await expect(historyList(page).getByRole("listitem")).toHaveCount(3)
})

test("members see the history without undo; an owner demoted after loading it is refused when confirming", async ({ page, launch, playwright }) => {
  const { hub, api, repoPage, owner } = await setUp(launch, playwright, 2)
  await setRole(owner, hub.url, api, bob.name, "member")
  await logIn(page, hub.url, bob, `/repos/${alice.name}/history/undo`)
  await expect(row(page, "2")).toContainText("events (1)")
  await expect(page.getByRole("status").filter({ hasText: "Only the repository's owners can undo." })).toBeVisible()
  await expect(historyList(page).getByRole("button")).toHaveCount(0)

  // promoted, bobby loads the history as an owner; alice demotes him before he confirms
  await setRole(owner, hub.url, api, bob.name, "owner")
  await page.reload()
  await row(page, "2").getByRole("button", { name: "Undo this" }).click()
  await setRole(owner, hub.url, api, bob.name, "member")
  await page.getByRole("group", { name: "Confirm: undo transaction 2" }).getByRole("button", { name: "Undo", exact: true }).click()
  await expect(page.getByRole("alert")).toHaveText("Only the repository's owners can undo.")
  // the history is read again as he may see it now
  await expect(historyList(page).getByRole("button")).toHaveCount(0)
  await page.reload()
  await expect(row(page, "2")).not.toContainText("Undone")
  expect(await hasIssue(page, repoPage, "Issue 1")).toBe(true)

  // removed from the repository: no history at all
  await setRole(owner, hub.url, api, bob.name, null)
  await page.goto(`${repoPage}/undo`)
  await expect(page.getByRole("status")).toHaveText("Only people who may write to this repository see its undo history.")
  await expect(page.getByRole("navigation", { name: "Repository sections" }).getByText("Undo")).toHaveCount(0)
})

test("an undo whose answer is lost reads the history again before another is offered, so it can't be applied twice", async ({ page, launch, playwright }) => {
  const { hub, repoPage } = await setUp(launch, playwright, 3)
  await logIn(page, hub.url, alice, `/repos/${alice.name}/history/undo`)

  // every undo lands, but its answer is lost; reads fail while `failReads` is set
  let posts = 0
  let failReads = false
  await page.route(`**/api/v1/repos/${alice.name}/history/undo`, async (route) => {
    if (route.request().method() === "POST") {
      posts++
      await route.fetch()
      return route.abort("connectionreset")
    }
    if (failReads) return route.abort("connectionreset")
    return route.continue()
  })
  await row(page, "3").getByRole("button", { name: "Undo this" }).click()
  await page.getByRole("group", { name: "Confirm: undo transaction 3" }).getByRole("button", { name: "Undo", exact: true }).click()
  await expect(page.getByRole("status").filter({ hasText: "may or may not be from this attempt" })).toContainText("The newest transaction is now 4 (undo)")
  await expect(page.getByRole("group", { name: /^Confirm/ })).toHaveCount(0)
  await expect(row(page, "3")).toContainText("Undone")
  expect(posts).toBe(1)

  // when the history can't be read either, no undo is offered until a check gets an answer
  failReads = true
  await row(page, "4").getByRole("button", { name: "Undo this" }).click()
  await page.getByRole("group", { name: "Confirm: undo transaction 4" }).getByRole("button", { name: "Undo", exact: true }).click()
  const unresolved = page.getByRole("alert").filter({ hasText: "no undo is offered until a check gets an answer" })
  await expect(unresolved).toBeVisible()
  await expect(historyList(page).getByRole("button", { name: /^Undo/ }).first()).toBeDisabled()
  failReads = false
  await unresolved.getByRole("button", { name: "Check again" }).click()
  await expect(page.getByRole("status").filter({ hasText: "may or may not be from this attempt" })).toContainText("The newest transaction is now 5 (undo)")
  expect(posts).toBe(2)

  // after a refresh: exactly the two undos, the second restoring the issue the first took away
  await page.unroute(`**/api/v1/repos/${alice.name}/history/undo`)
  await page.reload()
  await expect(row(page, "5")).toContainText("undo")
  await expect(row(page, "4")).toContainText("Undone")
  expect(await hasIssue(page, repoPage, "Issue 2")).toBe(true)
})

test("a confirmed undo stays shown, with its reversal, when the history can't be read again afterwards", async ({ page, launch, playwright }) => {
  const { hub } = await setUp(launch, playwright, 2)
  await logIn(page, hub.url, alice, `/repos/${alice.name}/history/undo`)
  await expect(row(page, "2")).toContainText("events (1)")
  let failReads = false
  await page.route(`**/api/v1/repos/${alice.name}/history/undo`, async (route) => {
    if (route.request().method() === "POST") {
      const response = await route.fetch()
      failReads = true
      return route.fulfill({ response })
    }
    if (failReads) return route.abort("connectionreset")
    return route.continue()
  })
  await row(page, "2").getByRole("button", { name: "Undo this" }).click()
  await page.getByRole("group", { name: "Confirm: undo transaction 2" }).getByRole("button", { name: "Undo", exact: true }).click()
  const result = page.getByRole("region", { name: "Undo result" })
  await expect(page.getByRole("alert").filter({ hasText: "Couldn't load the undo history" })).toBeVisible()
  await expect(result.getByRole("status")).toHaveText("Undone. Haxy recorded the undo as transaction 3:")
  await expect(result.getByRole("button", { name: "Reverse this undo" })).toBeEnabled()
})

test("an undo after signing out in another tab says so and offers a reload, rather than reading the history as someone else", async ({ page, context, launch, playwright }) => {
  const { hub } = await setUp(launch, playwright, 2)
  await logIn(page, hub.url, alice, `/repos/${alice.name}/history/undo`)
  await row(page, "2").getByRole("button", { name: "Undo this" }).click()
  const other = await context.newPage()
  await other.goto(`${hub.url}/repos/${alice.name}/history`)
  await logOutFromHeader(other)
  await expect(other.getByRole("link", { name: "Log in" })).toBeVisible()

  const confirm = page.getByRole("group", { name: "Confirm: undo transaction 2" })
  await confirm.getByRole("button", { name: "Undo", exact: true }).click()
  await expect(confirm.getByRole("alert")).toContainText("You're signed out now (perhaps from another tab)")
  await expect(confirm.getByRole("button", { name: "Reload" })).toBeVisible()
  await expect(row(page, "2")).not.toContainText("Undone")
})

test("an owner demoted after an undo can't keep sending its reversal", async ({ page, launch, playwright }) => {
  const { hub, api, owner } = await setUp(launch, playwright, 2)
  await setRole(owner, hub.url, api, bob.name, "owner")
  await logIn(page, hub.url, bob, `/repos/${alice.name}/history/undo`)
  await row(page, "2").getByRole("button", { name: "Undo this" }).click()
  await page.getByRole("group", { name: "Confirm: undo transaction 2" }).getByRole("button", { name: "Undo", exact: true }).click()
  const result = page.getByRole("region", { name: "Undo result" })
  await expect(result.getByRole("status")).toHaveText("Undone. Haxy recorded the undo as transaction 3:")

  await setRole(owner, hub.url, api, bob.name, "member")
  await result.getByRole("button", { name: "Reverse this undo" }).click()
  await page.getByRole("group", { name: "Confirm: undo transaction 3" }).getByRole("button", { name: "Reverse the undo" }).click()
  await expect(page.getByRole("alert").filter({ hasText: "Only the repository's owners can undo." })).toBeVisible()
  await expect(result.getByRole("button", { name: "Reverse this undo" })).toHaveCount(0)
  await expect(result).toContainText("Only the repository's owners can undo.")
})

test("local mode shows undo as unavailable", async ({ page, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  await page.goto(`${hub.url}/repo/undo`)
  await expect(page.getByRole("status")).toHaveText("Undo is not available in local mode.")
  await expect(page.getByRole("navigation", { name: "Repository sections" }).getByText("Undo")).toHaveCount(0)
  await expect(page.getByRole("button", { name: /^Undo/ })).toHaveCount(0)
})
