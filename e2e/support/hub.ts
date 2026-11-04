import path from "node:path"
import { hubRoot } from "./binaries"
import { freePort, startProcess, waitUntil } from "./process"

export type Hub = {
  /** The UI origin the browser uses; /api/* is proxied to the backend. */
  url: string
  output(): string
  stop(): Promise<void>
}

/** Starts the Vite dev server (`npm run dev`) on a free port, proxying to `backendPort`. */
export async function startHub(backendPort: number): Promise<Hub> {
  const port = await freePort()
  const env = { ...process.env, HAXY_BACKEND_URL: `http://127.0.0.1:${backendPort}`, BROWSER: "none", FORCE_COLOR: "0" }
  const vite = startProcess("vite", process.execPath, [
    path.join(hubRoot, "node_modules/vite/bin/vite.js"), "--port", String(port), "--strictPort", "--clearScreen", "false",
  ], { cwd: hubRoot, env })
  const url = `http://127.0.0.1:${port}`
  try {
    await waitUntil(async () => ((await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok ? true : undefined), 60_000,
      () => `Vite did not start on ${url}:\n${vite.output()}`)
  } catch (error) {
    await vite.stop()
    throw error
  }
  return { url, output: vite.output, stop: vite.stop }
}
