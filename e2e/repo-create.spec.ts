import type { Page } from "@playwright/test"
import { alice, registerUser, writeHeaders, type Account } from "./support/accounts"
import { expect, test } from "./support/fixtures"

// Creating a repository in the browser — empty with a chosen hash format, or
// as a copy of a readable one — through Vite's proxy against a real Haxy.
// Every created repository is browsed again after a refresh and a backend
// restart.

const header = (page: Page) => page.getByRole("banner")
const bob: Account = { name: "bobby", email: "bobby@example.test", password: "bobby's password" }

async function logIn(page: Page, hubUrl: string, username: string, password: string, next = "/repos/new") {
  await page.goto(`${hubUrl}/login?next=${encodeURIComponent(next)}`)
  await page.getByLabel("Username").fill(username)
  await page.getByLabel("Password").fill(password)
  await page.getByRole("button", { name: "Log in" }).click()
  await expect(header(page)).toContainText(`Signed in as ${username}`)
}

const form = (page: Page) => page.getByRole("form", { name: "New repository" })

test("a user creates a repository with each hash format and lands on it, which survives a refresh and a restart", async ({ page, launch }) => {
  let backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  await logIn(page, hub.url, alice.name, alice.password, "/")

  const created = [
    { name: "tools", description: "Handy scripts", hash: "SHA-1", visibility: "Public" },
    { name: "vault", description: "Kept to myself", hash: "SHA-256", visibility: "Private" },
  ]
  for (const repo of created) {
    await header(page).getByRole("link", { name: "New repository" }).click()
    await expect(page).toHaveURL(`${hub.url}/repos/new`)
    await form(page).getByLabel("Name").fill(repo.name)
    await form(page).getByLabel("Description").fill(repo.description)
    await form(page).getByRole("radio", { name: repo.visibility }).check()
    await form(page).getByRole("radio", { name: repo.hash }).check()
    await form(page).getByRole("button", { name: "Create repository" }).click()

    await expect(page).toHaveURL(`${hub.url}/repos/${alice.name}/${repo.name}`)
    await expect(page.getByRole("heading", { level: 1, name: repo.name })).toBeVisible()
    await expect(page.getByText(repo.description)).toBeVisible()
    await expect(page.getByRole("region", { name: "This repository is empty" })).toBeVisible()
  }

  for (const step of ["refresh", "restart"] as const) {
    if (step === "restart") backend = await backend.restart!()
    for (const repo of created) {
      await page.goto(`${hub.url}/repos/${alice.name}/${repo.name}`)
      await expect(page.getByRole("heading", { level: 1, name: repo.name }), step).toBeVisible()
      await expect(page.getByText(repo.description)).toBeVisible()
      await expect(page.getByRole("region", { name: "This repository is empty" })).toBeVisible()
    }
    await expect(page.getByRole("heading", { level: 1, name: "vault" }).getByText("Private")).toBeVisible()
  }
  await page.goto(`${hub.url}/users/${alice.name}`)
  const listed = page.getByRole("list", { name: "Repositories" })
  await expect(listed.getByRole("link")).toHaveCount(2)
  for (const repo of created) await expect(listed.getByRole("link", { name: repo.name })).toBeVisible()
})

test("refused fields are marked beside the field and the form keeps what was entered", async ({ page, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  await logIn(page, hub.url, alice.name, alice.password)

  const name = form(page).getByLabel("Name")
  await name.fill("not valid!")
  await form(page).getByLabel("Description").fill("Kept across failures")
  await form(page).getByRole("radio", { name: "Public" }).check()
  await form(page).getByRole("radio", { name: "SHA-256" }).check()
  await form(page).getByRole("button", { name: "Create repository" }).click()
  await expect(name).toHaveAccessibleDescription(/letters, digits/)
  await expect(name).toHaveAttribute("aria-invalid", "true")
  await expect(name).toHaveValue("not valid!")
  await expect(form(page).getByLabel("Description")).toHaveValue("Kept across failures")
  await expect(form(page).getByRole("radio", { name: "Public" })).toBeChecked()
  await expect(form(page).getByRole("radio", { name: "SHA-256" })).toBeChecked()

  // a name already taken
  await name.fill("dup")
  await form(page).getByRole("button", { name: "Create repository" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/${alice.name}/dup`)
  await page.goto(`${hub.url}/repos/new`)
  await form(page).getByLabel("Name").fill("dup")
  await form(page).getByRole("button", { name: "Create repository" }).click()
  await expect(form(page).getByLabel("Name")).toHaveAccessibleDescription(/already have a repository/)

  // a copy source that isn't owner:name
  await form(page).getByLabel("Name").fill("copied")
  await form(page).getByLabel(/Copy/).fill("nothing")
  await form(page).getByRole("button", { name: "Create repository" }).click()
  await expect(form(page).getByLabel(/Copy/)).toHaveAccessibleDescription(/owner:name/)
  await expect(form(page).getByLabel(/Copy/)).toHaveValue("nothing")
})

test("anonymous visitors are sent to log in, and local mode offers no repository creation", async ({ page, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await page.goto(`${hub.url}/repos/new`)
  await expect(page.getByRole("heading", { level: 1, name: "New repository" })).toBeVisible()
  await expect(page.getByRole("main").getByRole("link", { name: "Log in" })).toHaveAttribute("href", `/login?next=${encodeURIComponent("/repos/new")}`)
  await expect(form(page)).toHaveCount(0)
  await expect(header(page).getByRole("link", { name: "New repository" })).toHaveCount(0)

  // logging in from a copy link comes back to the same copy
  await registerUser(backend, alice)
  await page.goto(`${hub.url}/repos/new?copy=bobby:linux`)
  await page.getByRole("main").getByRole("link", { name: "Log in" }).click()
  await page.getByLabel("Username").fill(alice.name)
  await page.getByLabel("Password").fill(alice.password)
  await page.getByRole("button", { name: "Log in" }).click()
  await expect(form(page).getByLabel(/Copy/)).toHaveValue("bobby:linux")
  expect(new URL(page.url()).pathname).toBe("/repos/new")
  await header(page).getByRole("button", { name: "Log out" }).click()
  await expect(header(page).getByRole("link", { name: "Log in" })).toBeVisible()

  const local = await launch.local()
  const localHub = await launch.hub(local.port)
  await page.goto(`${localHub.url}/repos/new`)
  await expect(page.getByRole("main")).toContainText("Local mode serves a single repository")
  await expect(form(page)).toHaveCount(0)
  await expect(header(page).getByRole("link", { name: "New repository" })).toHaveCount(0)
})

const internalError = { status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Haxy couldn't complete this request. Try again later." } }) }

test("a creation whose answer is lost says what exists now, never what this attempt did", async ({ page, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  await logIn(page, hub.url, alice.name, alice.password)
  const alert = page.getByRole("alert")

  // the backend creates it, but the answer is an internal error
  await page.route("**/api/v1/repos", async (route) => {
    await route.fetch()
    await route.fulfill(internalError)
  })
  await form(page).getByLabel("Name").fill("landed")
  await form(page).getByRole("button", { name: "Create repository" }).click()
  await expect(alert).toContainText("couldn't confirm")
  await expect(alert).toContainText(`${alice.name}/landed exists now`)
  await expect(alert).toContainText("may or may not be from this attempt")
  await expect(form(page).getByRole("button", { name: "Create repository" })).toHaveCount(0)

  // a repository that already existed (Haxy answered "name taken", but the
  // answer was lost) reads the same way: nothing says this attempt made it
  await page.goto(`${hub.url}/repos/new`)
  await form(page).getByLabel("Name").fill("landed")
  await form(page).getByRole("button", { name: "Create repository" }).click()
  await expect(alert).toContainText(`${alice.name}/landed exists now`)
  await expect(alert).toContainText("may or may not be from this attempt")
  await expect(alert).not.toContainText("was created")
  await alert.getByRole("link", { name: `${alice.name}/landed` }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/${alice.name}/landed`)
  await page.unroute("**/api/v1/repos")

  // the connection drops before the request reaches Haxy: the repository isn't found (yet)
  await page.goto(`${hub.url}/repos/new`)
  await page.route("**/api/v1/repos", (route) => route.abort("connectionreset"))
  await form(page).getByLabel("Name").fill("lost")
  await form(page).getByRole("button", { name: "Create repository" }).click()
  await expect(alert).toContainText(`didn't find ${alice.name}/lost`)
  await expect(alert).toContainText("may still be finishing")
  await expect(alert).not.toContainText("wasn't created")
  await expect(alert.getByRole("button", { name: "Check again" })).toBeVisible()
  await page.unroute("**/api/v1/repos")
  await form(page).getByRole("button", { name: "Create repository" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/${alice.name}/lost`)
  await page.reload()
  await expect(page.getByRole("heading", { level: 1, name: "lost" })).toBeVisible()
})

test("the exists-now notice belongs to the name it was about: another name can still be created", async ({ page, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  await logIn(page, hub.url, alice.name, alice.password)
  const alert = page.getByRole("alert")

  await page.route("**/api/v1/repos", async (route) => {
    await route.fetch()
    await route.fulfill(internalError)
  })
  await form(page).getByLabel("Name").fill("first")
  await form(page).getByLabel("Description").fill("Kept for the next one")
  await form(page).getByRole("radio", { name: "Public" }).check()
  await form(page).getByRole("button", { name: "Create repository" }).click()
  await expect(alert).toContainText(`${alice.name}/first exists now`)
  await expect(form(page).getByRole("button", { name: "Create repository" })).toHaveCount(0)
  await page.unroute("**/api/v1/repos")

  await form(page).getByLabel("Name").fill("second")
  await expect(alert).toHaveCount(0)
  await expect(form(page).getByLabel("Description")).toHaveValue("Kept for the next one")
  await expect(form(page).getByRole("radio", { name: "Public" })).toBeChecked()
  await form(page).getByRole("button", { name: "Create repository" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/${alice.name}/second`)
  await expect(page.getByText("Kept for the next one")).toBeVisible()
})

test("a late check for an earlier name never overrides what is known about a newer attempt", async ({ page, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  await logIn(page, hub.url, alice.name, alice.password)
  const alert = page.getByRole("alert")

  // every creation's answer is lost before it reaches Haxy
  await page.route("**/api/v1/repos", (route) => route.abort("connectionreset"))
  // the check for the first name is held back
  let release = () => {}
  const released = new Promise<void>((resolve) => { release = resolve })
  await page.route(`**/api/v1/repos/${alice.name}/first`, async (route) => {
    await released
    await route.continue()
  })
  // and the check for the second one fails
  await page.route(`**/api/v1/repos/${alice.name}/second`, (route) => route.abort("connectionreset"))

  await form(page).getByLabel("Name").fill("first")
  await form(page).getByRole("button", { name: "Create repository" }).click()
  await expect(alert).toContainText(`Checking whether ${alice.name}/first exists`)

  await form(page).getByLabel("Name").fill("second")
  await form(page).getByRole("button", { name: "Create repository" }).click()
  await expect(alert).toContainText("couldn't say whether it exists")
  await expect(form(page).getByRole("button", { name: "Create repository" })).toBeDisabled()

  const checked = page.waitForResponse((response) => response.url().endsWith(`/api/v1/repos/${alice.name}/first`))
  release()
  expect((await checked).status()).toBe(404)
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50))))
  // the second attempt's uncertainty stands
  await expect(alert).toContainText("couldn't say whether it exists")
  await expect(form(page).getByRole("button", { name: "Create repository" })).toBeDisabled()

  // and its own "Check again" still settles it
  await page.unrouteAll()
  await alert.getByRole("button", { name: "Check again" }).click()
  await expect(alert).toContainText(`didn't find ${alice.name}/second`)
  await expect(form(page).getByRole("button", { name: "Create repository" })).toBeEnabled()
})

test("a creation that finishes after the user has left the form doesn't pull them back", async ({ page, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  await logIn(page, hub.url, alice.name, alice.password)

  // the answer is held back, as for a slow copy
  let release = () => {}
  const released = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/v1/repos", async (route) => {
    await released
    await route.continue()
  })
  await form(page).getByLabel("Name").fill("slow")
  await form(page).getByRole("button", { name: "Create repository" }).click()
  await expect(form(page).getByRole("button", { name: "Create repository" })).toBeDisabled()

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Users" }).click()
  await expect(page).toHaveURL(`${hub.url}/users`)
  const answered = page.waitForResponse((response) => response.url().endsWith("/api/v1/repos"))
  release()
  expect((await answered).status()).toBe(201)
  // let the page run whatever the answer set off
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50))))
  await expect(page).toHaveURL(`${hub.url}/users`)
  await expect(page.getByRole("heading", { level: 1, name: "Users" })).toBeVisible()

  // it was created all the same
  await page.goto(`${hub.url}/repos/${alice.name}/slow`)
  await expect(page.getByRole("heading", { level: 1, name: "slow" })).toBeVisible()
})

test("a lost creation that finishes later is found by checking again, and a retry that finds the name taken says it exists", async ({ page, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  await logIn(page, hub.url, alice.name, alice.password)
  const alert = page.getByRole("alert")
  // stands in for the original request (a slow copy) registering the repository after the check
  const finishLater = async (name: string) => {
    const response = await page.request.post(`${hub.url}/api/v1/repos`, {
      headers: { ...(await writeHeaders(page.request, hub.url)), "Content-Type": "application/json", "X-Haxy-Viewer": alice.name },
      data: { name, description: "", access: "private", hash: "sha1", copy: "" },
    })
    expect(response.status()).toBe(201)
  }

  await page.route("**/api/v1/repos", (route) => route.abort("connectionreset"))
  await form(page).getByLabel("Name").fill("slow")
  await form(page).getByRole("button", { name: "Create repository" }).click()
  await expect(alert).toContainText(`didn't find ${alice.name}/slow`)
  await finishLater("slow")
  await alert.getByRole("button", { name: "Check again" }).click()
  await expect(alert).toContainText(`${alice.name}/slow exists now`)
  await expect(form(page).getByRole("button", { name: "Create repository" })).toHaveCount(0)

  await page.goto(`${hub.url}/repos/new`)
  await form(page).getByLabel("Name").fill("slower")
  await form(page).getByRole("button", { name: "Create repository" }).click()
  await expect(alert).toContainText(`didn't find ${alice.name}/slower`)
  await page.unroute("**/api/v1/repos")
  await finishLater("slower")
  // the retry is refused as a taken name: that is the repository, not a mistake in the form
  await form(page).getByRole("button", { name: "Create repository" }).click()
  await expect(alert).toContainText(`${alice.name}/slower exists now`)
  await expect(alert).toContainText("may or may not be from this attempt")
  await expect(form(page).getByLabel("Name")).not.toHaveAttribute("aria-invalid", "true")
  await alert.getByRole("link", { name: `${alice.name}/slower` }).click()
  await expect(page.getByRole("heading", { level: 1, name: "slower" })).toBeVisible()
})

test("when Haxy can't say whether a lost creation landed, a retry waits for a successful check", async ({ page, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  await logIn(page, hub.url, alice.name, alice.password)

  // the repository is created, the answer is lost, and so is the check that follows
  await page.route("**/api/v1/repos", async (route) => {
    await route.fetch()
    await route.abort("connectionreset")
  })
  await page.route(`**/api/v1/repos/${alice.name}/unsure`, (route) => route.abort("connectionreset"))
  await form(page).getByLabel("Name").fill("unsure")
  await form(page).getByRole("button", { name: "Create repository" }).click()
  const alert = page.getByRole("alert")
  await expect(alert).toContainText("couldn't say whether it exists")
  await expect(form(page).getByRole("button", { name: "Create repository" })).toBeDisabled()

  await page.unrouteAll()
  await alert.getByRole("button", { name: "Check again" }).click()
  await expect(alert).toContainText(`${alice.name}/unsure exists now`)
  await alert.getByRole("link", { name: `${alice.name}/unsure` }).click()
  await expect(page.getByRole("heading", { level: 1, name: "unsure" })).toBeVisible()
})

test("a form loaded for one user never creates a repository for another who signed in from another tab", async ({ page, context, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const hub = await launch.hub(backend.port)
  await logIn(page, hub.url, alice.name, alice.password)
  await expect(form(page)).toBeVisible()

  const other = await context.newPage()
  await other.goto(hub.url)
  await header(other).getByRole("button", { name: "Log out" }).click()
  await expect(header(other).getByRole("link", { name: "Log in" })).toBeVisible()
  await logIn(other, hub.url, bob.name, bob.password, "/")

  await form(page).getByLabel("Name").fill("misplaced")
  // public, so it would be visible wherever it landed
  await form(page).getByRole("radio", { name: "Public" }).check()
  await form(page).getByRole("button", { name: "Create repository" }).click()
  await expect(page.getByRole("alert")).toContainText(`signed in as ${bob.name}`)

  for (const owner of [alice.name, bob.name]) {
    expect((await other.request.get(`${hub.url}/api/v1/repos/${owner}/misplaced`)).status()).toBe(404)
  }
})

test.describe("with the demo data", () => {
  test.skip(!process.env.HAXY_E2E_DEMO_BIN, "HAXY_BIN was given without HAXY_TRY_BIN")

  test("a user copies a readable repository and browses its files; a hidden one is refused like a missing one", async ({ page, launch }) => {
    let backend = await launch.demo()
    const hub = await launch.hub(backend.port)
    await logIn(page, hub.url, "alice", "password")

    const copy = form(page).getByLabel(/Copy/)
    await form(page).getByLabel("Name").fill("stolen")
    await copy.fill("bobby:neovim")
    // a copy keeps its source's hash format
    await expect(form(page).getByRole("radio", { name: "SHA-256" })).toBeDisabled()
    await form(page).getByRole("button", { name: "Create repository" }).click()
    await expect(copy).toHaveAccessibleDescription(/no repository by that name that you can see/)
    const hidden = await form(page).innerText()
    await copy.fill("bobby:no-such-repo")
    const answered = page.waitForResponse((response) => response.url().endsWith("/api/v1/repos"))
    await form(page).getByRole("button", { name: "Create repository" }).click()
    await answered
    await expect(copy).toHaveAccessibleDescription(/no repository by that name that you can see/)
    await expect(copy).toHaveValue("bobby:no-such-repo")
    expect(await form(page).innerText()).toBe(hidden)

    await form(page).getByLabel("Name").fill("my-linux")
    await copy.fill("bobby:linux")
    await form(page).getByRole("button", { name: "Create repository" }).click()
    await expect(page).toHaveURL(`${hub.url}/repos/alice/my-linux`)
    const files = page.getByRole("list", { name: "Files" })
    await expect(files.getByRole("link")).toHaveText(["docs", "src", "README.md"])

    backend = await backend.restart!()
    await page.reload()
    await expect(page.getByRole("list", { name: "Files" }).getByRole("link")).toHaveText(["docs", "src", "README.md"])
    await page.getByRole("list", { name: "Files" }).getByRole("link", { name: "README.md" }).click()
    await expect(page).toHaveURL(`${hub.url}/repos/alice/my-linux/files/README.md`)
    await expect(page.getByRole("main").getByRole("heading", { name: "Sample Repo" })).toBeVisible()
  })
})
