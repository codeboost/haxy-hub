import { writeFile } from "node:fs/promises"
import path from "node:path"
import { expect, test } from "./support/fixtures"

// Browser workflows for discovery: the about page, the user directory and an
// owner's repositories, against real Haxy fixtures through Vite's proxy.

test("the about page shows the forge's about content", async ({ page, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await page.goto(hub.url)

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "About" }).click()

  await expect(page).toHaveURL(`${hub.url}/about`)
  await expect(page.getByRole("heading", { level: 1, name: "HAXY" })).toBeVisible()
  const main = page.getByRole("main")
  await expect(main).toContainText("Welcome to your Haxy instance!")
  await expect(main.locator("code", { hasText: "admin/ABOUT.md" })).toBeVisible()

  await page.reload()
  await expect(page.getByRole("heading", { level: 1, name: "HAXY" })).toBeVisible()
})

test("Haxy links in the about page lead to the matching Haxy Hub pages", async ({ page, launch }) => {
  const backend = await launch.server()
  // the documented way to change the about page: edit admin/ABOUT.md in the server dir
  await writeFile(path.join(backend.dataDir, "admin", "ABOUT.md"), [
    "# Links",
    "",
    "[home](/) [bobby](/bobby) [directory](/home/users/search:a/start:20) [bobby's repos](/bobby/repos/search:li)",
    "[unknown](/alice/notes/tree/main) [web](https://example.test/) [script](javascript:alert(1))",
  ].join("\n"))
  const hub = await launch.hub(backend.port)
  await page.goto(`${hub.url}/about`)

  const main = page.getByRole("main")
  await expect(main.getByRole("link", { name: "home" })).toHaveAttribute("href", "/about")
  await expect(main.getByRole("link", { name: "bobby", exact: true })).toHaveAttribute("href", "/users/bobby")
  await expect(main.getByRole("link", { name: "directory" })).toHaveAttribute("href", "/users?search=a")
  await expect(main.getByRole("link", { name: "bobby's repos" })).toHaveAttribute("href", "/users/bobby?search=li")
  await expect(main.getByRole("link", { name: "unknown" })).toHaveAttribute("href", "/alice/notes/tree/main")
  await expect(main.getByRole("link", { name: "web" })).toHaveAttribute("href", "https://example.test/")
  await expect(main.getByRole("link", { name: "script" })).toHaveCount(0)
  await expect(main).toContainText("script")

  await main.getByRole("link", { name: "directory" }).click()
  await expect(page).toHaveURL(`${hub.url}/users?search=a`)
  await expect(page.getByRole("searchbox", { name: "Search users" })).toHaveValue("a")
})

test("the header fits a phone-width screen without horizontal scrolling", async ({ page, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(`${hub.url}/users`)
  await expect(page.getByRole("heading", { level: 1, name: "Users" })).toBeVisible()

  const nav = page.getByRole("navigation", { name: "Main" })
  for (const name of ["Home", "About", "Users", "Connection"]) await expect(nav.getByRole("link", { name })).toBeInViewport()
  await expect(page.getByRole("banner").getByText("Server mode")).toBeInViewport()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBe(0)
})

test.describe("with the demo data", () => {
  test.skip(!process.env.HAXY_E2E_DEMO_BIN, "HAXY_BIN was given without HAXY_TRY_BIN")

  test("the user directory pages and searches through the URL, surviving refresh, back and forward", async ({ page, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)
    await page.goto(hub.url)

    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Users" }).click()
    await expect(page).toHaveURL(`${hub.url}/users`)
    const users = page.getByRole("list", { name: "Users" })
    await expect(users.getByRole("link")).toHaveCount(20)
    await expect(users.getByRole("link", { name: "admin" })).toBeVisible()

    await page.getByRole("link", { name: "Next page" }).click()
    await expect(page).toHaveURL(/\/users\?cursor=/)
    await expect(users.getByRole("link")).toHaveText(["tessa"])
    await expect(page.getByRole("link", { name: "Next page" })).toHaveCount(0)
    await page.reload()
    await expect(users.getByRole("link")).toHaveText(["tessa"])

    await page.goBack()
    await expect(page).toHaveURL(`${hub.url}/users`)
    await expect(users.getByRole("link", { name: "admin" })).toBeVisible()
    await page.goForward()
    await expect(users.getByRole("link")).toHaveText(["tessa"])

    await page.getByRole("searchbox", { name: "Search users" }).fill("a")
    await page.getByRole("button", { name: "Search" }).click()
    await expect(page).toHaveURL(`${hub.url}/users?search=a`)
    await expect(users.getByRole("link")).toHaveText(["admin", "alice"])
    await page.reload()
    await expect(users.getByRole("link")).toHaveText(["admin", "alice"])
    await expect(page.getByRole("searchbox", { name: "Search users" })).toHaveValue("a")

    await page.getByRole("searchbox", { name: "Search users" }).fill("zz")
    await page.getByRole("button", { name: "Search" }).click()
    await expect(page.getByRole("heading", { name: "No users match “zz”" })).toBeVisible()
    await expect(page.getByRole("alert")).toHaveCount(0)

    await page.goBack()
    await expect(users.getByRole("link")).toHaveText(["admin", "alice"])
    await expect(page.getByRole("searchbox", { name: "Search users" })).toHaveValue("a")
  })

  test("an owner's page lists only the repositories an anonymous viewer may read", async ({ page, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)
    await page.goto(`${hub.url}/users?search=bob`)

    await page.getByRole("list", { name: "Users" }).getByRole("link", { name: "bobby" }).click()

    await expect(page).toHaveURL(`${hub.url}/users/bobby`)
    await expect(page.getByRole("heading", { level: 1, name: "bobby" })).toBeVisible()
    const repos = page.getByRole("list", { name: "Repositories" })
    await expect(repos).toContainText("linux")
    await expect(repos).toContainText("Linux kernel source tree")
    await expect(repos).toContainText("scikit-learn")
    await expect(page.getByRole("main")).not.toContainText("neovim")
    await expect(page.getByRole("main")).not.toContainText("Private")

    await page.getByRole("searchbox", { name: "Search repositories" }).fill("neo")
    await page.getByRole("button", { name: "Search" }).click()
    await expect(page).toHaveURL(`${hub.url}/users/bobby?search=neo`)
    await expect(page.getByRole("heading", { name: "No repositories match “neo”" })).toBeVisible()
    await expect(page.getByRole("main")).not.toContainText("neovim")

    await page.getByRole("searchbox", { name: "Search repositories" }).fill("lin")
    await page.getByRole("button", { name: "Search" }).click()
    await expect(repos.getByRole("listitem")).toHaveCount(1)
    await expect(repos).toContainText("linux")
    await page.reload()
    await expect(repos.getByRole("listitem")).toHaveCount(1)
    await page.goBack()
    await expect(page.getByRole("heading", { name: "No repositories match “neo”" })).toBeVisible()
  })

  test("a later page that comes back empty offers the first page, even while searching", async ({ page, request, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)
    // Cursors from other listings stand in for links that went stale after
    // the data changed; the page must not claim the search matches nothing.
    const usersCursor = (await (await request.get(`${hub.url}/api/v1/users?page_size=2`)).json()).page.next_cursor
    const reposCursor = (await (await request.get(`${hub.url}/api/v1/users/bobby/repos?page_size=1`)).json()).page.next_cursor

    await page.goto(`${hub.url}/users?search=a&cursor=${encodeURIComponent(usersCursor)}`)
    await expect(page.getByRole("heading", { name: "No more users" })).toBeVisible()
    await expect(page.getByRole("link", { name: "Back to the first page" })).toHaveAttribute("href", "/users?search=a")
    await expect(page.getByText(/No users match/)).toHaveCount(0)

    await page.goto(`${hub.url}/users/bobby?search=lin&cursor=${encodeURIComponent(reposCursor)}`)
    await expect(page.getByRole("heading", { name: "No more repositories" })).toBeVisible()
    await expect(page.getByText(/No repositories match/)).toHaveCount(0)
    await page.getByRole("link", { name: "Back to the first page" }).click()
    await expect(page).toHaveURL(`${hub.url}/users/bobby?search=lin`)
    await expect(page.getByRole("list", { name: "Repositories" })).toContainText("linux")
  })
})

test("an empty directory, a search without matches and an unknown user are distinct states", async ({ page, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)

  await page.goto(`${hub.url}/users`)
  await expect(page.getByRole("heading", { name: "No users yet" })).toBeVisible()
  await expect(page.getByRole("alert")).toHaveCount(0)

  await page.getByRole("searchbox", { name: "Search users" }).fill("zz")
  await page.getByRole("button", { name: "Search" }).click()
  await expect(page.getByRole("heading", { name: "No users match “zz”" })).toBeVisible()

  await page.goto(`${hub.url}/users/nobody`)
  await expect(page.getByRole("heading", { level: 1, name: "User not found" })).toBeVisible()
})

test("a user without repositories shows the no-repositories state", async ({ page, request, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  // register through Haxy's existing sign-up form, with throwaway test values
  const signup = await request.post(`${backend.origin}/user/new`, {
    form: { name: "newbie", email: "newbie@example.test", password: "e2e-newbie-pass", password_again: "e2e-newbie-pass" },
    maxRedirects: 0,
  })
  expect(signup.status()).toBe(303)

  await page.goto(`${hub.url}/users`)
  await page.getByRole("list", { name: "Users" }).getByRole("link", { name: "newbie" }).click()

  await expect(page.getByRole("heading", { level: 1, name: "newbie" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "No repositories" })).toBeVisible()
  await expect(page.getByRole("alert")).toHaveCount(0)
})

test("a failed load is reported as a failure with a retry, not as an empty list", async ({ page, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await page.goto(`${hub.url}/users`)
  await expect(page.getByRole("heading", { name: "No users yet" })).toBeVisible()

  await backend.stop()
  await page.getByRole("searchbox", { name: "Search users" }).fill("al")
  await page.getByRole("button", { name: "Search" }).click()

  const failure = page.getByRole("alert")
  await expect(failure.getByRole("heading", { name: "Couldn't load users" })).toBeVisible()
  await expect(page.getByText(/No users/)).toHaveCount(0)

  await launch.server({ port: backend.port })
  await failure.getByRole("button", { name: "Retry" }).click()
  await expect(page.getByRole("heading", { name: "No users match “al”" })).toBeVisible()
})

test("local mode shows the discovery views as unavailable", async ({ page, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  await page.goto(hub.url)

  const nav = page.getByRole("navigation", { name: "Main" })
  await expect(nav.getByRole("link", { name: "Connection" })).toBeVisible()
  await expect(nav.getByRole("link", { name: "Users" })).toHaveCount(0)
  await expect(nav.getByRole("link", { name: "About" })).toHaveCount(0)

  for (const path of ["/about", "/users", "/users/alice"]) {
    await page.goto(`${hub.url}${path}`)
    await expect(page.getByRole("status").filter({ hasText: "local mode" })).toBeVisible()
    await expect(page.getByRole("alert")).toHaveCount(0)
  }
})
