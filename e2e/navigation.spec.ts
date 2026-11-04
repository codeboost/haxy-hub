import { expect, test } from "./support/fixtures"

test("header navigation changes the URL, and refresh and back restore the same views", async ({ page, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await page.goto(hub.url)
  await expect(page.getByRole("heading", { level: 1, name: "Haxy Hub" })).toBeVisible()

  await page.getByRole("navigation").getByRole("link", { name: "Connection" }).click()

  await expect(page).toHaveURL(`${hub.url}/connection`)
  const connectionHeading = page.getByRole("heading", { level: 1, name: "Connection" })
  await expect(connectionHeading).toBeVisible()
  await expect(page.getByRole("main")).toContainText("Server")

  await page.reload()
  await expect(connectionHeading).toBeVisible()

  await page.goBack()
  await expect(page).toHaveURL(`${hub.url}/`)
  await expect(page.getByRole("heading", { level: 1, name: "Haxy Hub" })).toBeVisible()
})

test("an unknown deep link shows not-found inside the shell, also after refresh", async ({ page, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)

  await page.goto(`${hub.url}/alice/notes/tree/main?view=raw`)

  const notFound = page.getByRole("heading", { level: 1, name: "Page not found" })
  await expect(notFound).toBeVisible()
  await expect(page.getByRole("main")).toContainText("/alice/notes/tree/main")
  await expect(page.getByRole("banner").getByText("Local mode")).toBeVisible()

  await page.reload()
  await expect(notFound).toBeVisible()
  await expect(page).toHaveURL(`${hub.url}/alice/notes/tree/main?view=raw`)
})

test("retrying after an outage returns to the page that was requested", async ({ page, launch }) => {
  const port = await launch.freePort()
  const hub = await launch.hub(port)

  await page.goto(`${hub.url}/connection`)
  await expect(page.getByRole("heading", { name: "Can't reach Haxy" })).toBeVisible()

  await launch.local({ port })
  await page.getByRole("button", { name: "Retry" }).click()

  await expect(page.getByRole("heading", { level: 1, name: "Connection" })).toBeVisible()
  await expect(page).toHaveURL(`${hub.url}/connection`)
})
