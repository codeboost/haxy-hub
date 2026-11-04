import { realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { hubRoot } from "./support/binaries"
import { expect, test } from "./support/fixtures"
import { startProcess, stopAllProcesses } from "./support/process"

// Checks of the harness itself: fixtures stay in throwaway temp dirs and can
// run on any port, so a developer's forge and data are never involved.

const tmp = realpathSync(os.tmpdir())
const developerPaths = [path.resolve(hubRoot, "../haxy"), path.resolve(hubRoot, "../haxy-data"), hubRoot]

function expectIsolated(dataDir: string) {
  expect(dataDir.startsWith(tmp + path.sep)).toBe(true)
  for (const developerPath of developerPaths) expect(dataDir.startsWith(developerPath)).toBe(false)
}

test("server and local fixtures keep their data in temp sandboxes", async ({ launch }) => {
  const server = await launch.server()
  const local = await launch.local()

  expectIsolated(server.dataDir)
  expectIsolated(local.dataDir)
  expect(server.port).not.toBe(8080)
  expect(local.port).not.toBe(8080)
})

test("the demo fixture serves the seeded `zig build try` data in server mode", async ({ page, launch }) => {
  test.skip(!process.env.HAXY_E2E_DEMO_BIN, "HAXY_BIN was given without HAXY_TRY_BIN")
  const backend = await launch.demo()
  const hub = await launch.hub(backend.port)

  await page.goto(hub.url)

  await expect(page.getByRole("banner").getByText("Server mode")).toBeVisible()
  expectIsolated(backend.dataDir)
})

test("a process that fails to spawn settles instead of hanging", async () => {
  test.setTimeout(10_000)
  const missing = startProcess("missing binary", path.join(tmp, "no-such-haxy-binary"), [], {})

  await expect(missing.waitForOutput(/never printed/, 30_000)).rejects.toThrow(/exited before|failed to start/)
  await missing.stop()
  expect(missing.output()).toContain("failed to start")
})

test("stopping all processes also stops ones whose startup is still pending", async () => {
  test.setTimeout(15_000)
  const sleeper = startProcess("sleeper", process.execPath, ["-e", "setInterval(() => {}, 1000)"], {})
  const pendingStartup = sleeper.waitForOutput(/a ready line that never comes/, 60_000).catch((error: unknown) => error)

  await stopAllProcesses()

  expect(sleeper.child.exitCode !== null || sleeper.child.signalCode !== null).toBe(true)
  expect(await pendingStartup).toBeInstanceOf(Error)
})
