import { expect, test } from "./support/fixtures"

test("a server-mode backend is shown as connected in server mode", async ({ page, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)

  await page.goto(hub.url)

  await expect(page.getByRole("banner").getByText("Server mode")).toBeVisible()
})

test("a local-mode backend serving a git repository is shown in local mode", async ({ page, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)

  await page.goto(hub.url)

  await expect(page.getByRole("banner").getByText("Local mode")).toBeVisible()
})

test("an unreachable backend shows a recoverable error, and retry connects once it is up", async ({ page, launch }) => {
  const port = await launch.freePort()
  const hub = await launch.hub(port)

  await page.goto(hub.url)

  await expect(page.getByRole("heading", { name: "Can't reach Haxy" })).toBeVisible()
  await expect(page.getByRole("banner").getByText("Offline")).toBeVisible()

  await launch.server({ port })
  await page.getByRole("button", { name: "Retry" }).click()

  await expect(page.getByRole("banner").getByText("Server mode")).toBeVisible()
  await expect(page.getByRole("heading", { name: "Can't reach Haxy" })).toBeHidden()
})

test("a server without the status API is reported as incompatible, and retry recovers after an upgrade", async ({ page, launch }) => {
  const port = await launch.freePort()
  const legacy = await launch.incompatible("no-status-api", { port })
  const hub = await launch.hub(port)

  await page.goto(hub.url)

  const problem = page.getByRole("alert")
  await expect(problem.getByRole("heading", { name: "Incompatible Haxy backend" })).toBeVisible()
  await expect(problem).toContainText("does not provide the Haxy status API")
  await expect(page.getByRole("banner").getByText("Incompatible")).toBeVisible()

  await legacy.stop()
  await launch.server({ port })
  await page.getByRole("button", { name: "Retry" }).click()

  await expect(page.getByRole("banner").getByText("Server mode")).toBeVisible()
})

test("a Haxy speaking an unknown API version is reported as incompatible", async ({ page, launch }) => {
  const future = await launch.incompatible("future-api-version")
  const hub = await launch.hub(future.port)

  await page.goto(hub.url)

  const problem = page.getByRole("alert")
  await expect(problem.getByRole("heading", { name: "Incompatible Haxy backend" })).toBeVisible()
  await expect(problem).toContainText("API version 2")
  await expect(page.getByRole("button", { name: "Retry" })).toBeEnabled()
})

test("a status response that stalls after its headers is reported as unreachable, not incompatible", async ({ page, launch }) => {
  const stalled = await launch.incompatible("stalled-status-body")
  const hub = await launch.hub(stalled.port)

  await page.goto(hub.url)

  await expect(page.getByRole("heading", { name: "Can't reach Haxy" })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole("heading", { name: "Incompatible Haxy backend" })).toBeHidden()
})
