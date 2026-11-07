import { realpathSync } from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
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

  await expect(page.getByRole("main")).toContainText("Connected to a multi-user Haxy server.")
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

test("requests sent as a test's last route goes away are still answered", async ({ page }) => {
  // No Haxy or Vite: the hang this guards against is Playwright's own (see
  // the `context` fixture), and it reproduces against any server.
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", request.url === "/" ? "text/html" : "application/json")
    response.end(request.url === "/" ? "<!doctype html><title>harness</title>" : "{}")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const { port } = server.address() as AddressInfo
    await page.goto(`http://127.0.0.1:${port}/`)
    // reads sent right after a write, as the app does once a write's answer is lost
    const writeThenRead = () => page.evaluate(async () => {
      await fetch("/api/write", { method: "POST", body: "{}" }).catch(() => undefined)
      const reads = Array.from({ length: 8 }, (_, i) => fetch(`/api/read?${i}`, { signal: AbortSignal.timeout(3_000) }).then(() => "answered", () => "never answered"))
      return Promise.all(reads)
    })
    const answered = Array<string>(8).fill("answered")
    for (let round = 0; round < 20; round++) {
      // the route is used up by the write, so it goes away as the reads start
      await page.route("**/api/write", async (route) => {
        await route.fetch()
        await route.abort("connectionreset")
      }, { times: 1 })
      expect(await writeThenRead(), `round ${round}, a one-time route`).toEqual(answered)

      // the same when a test removes its routes itself
      await page.route("**/api/write", (route) => route.abort("connectionreset"))
      const reads = writeThenRead()
      await page.unrouteAll()
      expect(await reads, `round ${round}, unrouteAll`).toEqual(answered)
    }
  } finally {
    server.close()
  }
})
