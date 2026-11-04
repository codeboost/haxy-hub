import { test as base, expect } from "@playwright/test"
import { startDemoServer, startIncompatible, startLocal, startServer, type Backend, type BackendOptions, type IncompatibleVariant } from "./backend"
import { selectedBinaries } from "./binaries"
import { startHub, type Hub } from "./hub"
import { freePort, stopAllProcesses } from "./process"
import { createSandbox } from "./sandbox"

/**
 * Starts isolated backends and Haxy Hub dev servers for one test, and tears
 * all of them (and their temp dirs) down afterwards.
 */
export type Launch = {
  /** `haxy serve` against an empty, freshly initialised data dir. */
  server(options?: BackendOptions): Promise<Backend>
  /** A server seeded with the `zig build try` demo data. */
  demo(options?: BackendOptions): Promise<Backend>
  /** Local mode serving a fresh git repository. */
  local(options?: BackendOptions): Promise<Backend>
  /** An HTTP server Haxy Hub must reject as incompatible. */
  incompatible(variant: IncompatibleVariant, options?: BackendOptions): Promise<Backend>
  /** Vite proxying to the backend on `backendPort` (which need not be running yet). */
  hub(backendPort: number): Promise<Hub>
  freePort(): Promise<number>
}

export const test = base.extend<{ launch: Launch }>({
  launch: async ({}, use, testInfo) => {
    const binaries = selectedBinaries()
    const cleanups: Array<() => Promise<void>> = []
    const logs: Array<{ name: string; output: () => string }> = []
    let count = 0
    const sandboxed = (label: string, start: (sandbox: Awaited<ReturnType<typeof createSandbox>>) => Promise<Backend>) => async () => {
      const sandbox = await createSandbox(`${label}-${testInfo.workerIndex}-${count++}`)
      cleanups.push(() => sandbox.dispose())
      const backend = await start(sandbox)
      cleanups.push(() => backend.stop())
      logs.push({ name: `${label} backend`, output: backend.output })
      return backend
    }

    await use({
      server: (options) => sandboxed("server", (sandbox) => startServer(binaries, sandbox, options))(),
      demo: (options) => sandboxed("demo", (sandbox) => startDemoServer(binaries, sandbox, options))(),
      local: (options) => sandboxed("local", (sandbox) => startLocal(binaries, sandbox, options))(),
      async incompatible(variant, options) {
        const backend = await startIncompatible(variant, options)
        cleanups.push(() => backend.stop())
        return backend
      },
      async hub(backendPort) {
        const hub = await startHub(backendPort)
        cleanups.push(() => hub.stop())
        logs.push({ name: "vite", output: hub.output })
        return hub
      },
      freePort,
    })

    if (testInfo.status !== testInfo.expectedStatus) {
      for (const log of logs) await testInfo.attach(`${log.name}.log`, { body: log.output(), contentType: "text/plain" })
    }
    // Processes whose startup was cut short (e.g. by a test timeout) never
    // registered a cleanup, so stop everything still running before the
    // sandboxes they run in are deleted.
    await stopAllProcesses().catch((error: unknown) => console.warn("[haxy-e2e] stopping processes failed:", error))
    for (const cleanup of cleanups.reverse()) await cleanup().catch((error: unknown) => console.warn("[haxy-e2e] cleanup failed:", error))
  },
})

export { expect }
