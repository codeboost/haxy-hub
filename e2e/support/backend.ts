import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import type { Binaries } from "./binaries"
import { freePort, startProcess, waitUntil, type Managed } from "./process"
import type { Sandbox } from "./sandbox"

export type BackendMode = "server" | "local"

export type Backend = {
  mode: BackendMode
  port: number
  /** The backend's own origin; browsers must go through the hub's proxy instead. */
  origin: string
  /** Where this fixture keeps its data; always inside the test sandbox. */
  dataDir: string
  output(): string
  stop(): Promise<void>
  /**
   * Stops this backend and starts it again on the same port and data dir,
   * resolving once it is ready. Only `launch.server()` backends can restart.
   */
  restart?(): Promise<Backend>
}

export type BackendOptions = { port?: number }

const servingLine = /serving web UI\b[^\n]*?http:\/\/[^:/\s]+:(\d+)\//

async function readyBackend(name: string, process: Managed, mode: BackendMode, dataDir: string, timeoutMs: number): Promise<Backend> {
  // Read the port the backend reports, which may differ from the one asked
  // for when a fixture uses Haxy's fall-back-on-busy-port policy.
  const [, reported] = await process.waitForOutput(servingLine, timeoutMs)
  const port = Number(reported)
  const origin = `http://127.0.0.1:${port}`
  await waitUntil(async () => {
    const response = await fetch(`${origin}/api/v1/status`, { signal: AbortSignal.timeout(2_000) })
    const body = (await response.json()) as { mode?: string }
    return body.mode === mode ? true : undefined
  }, timeoutMs, () => `${name} on ${origin} never reported mode "${mode}":\n${process.output()}`)
  return { mode, port, origin, dataDir, output: process.output, stop: process.stop }
}

/** A multi-user server with a fresh data dir, initialised by `haxy serve` itself. */
export async function startServer(binaries: Binaries, sandbox: Sandbox, options: BackendOptions = {}): Promise<Backend> {
  const port = options.port ?? (await freePort())
  const dataDir = sandbox.path("data")
  const start = async (): Promise<Backend> => {
    const process = startProcess("haxy serve", binaries.haxy, [
      "serve", "--data-dir", dataDir, "--web-listen", `127.0.0.1:${port}`, "--ssh-listen", "none",
    ], { cwd: sandbox.root, env: sandbox.env })
    try {
      const backend = await readyBackend("haxy serve", process, "server", dataDir, 30_000)
      // the fixture's teardown stops every process still running, restarted ones included
      return { ...backend, restart: async () => { await backend.stop(); return start() } }
    } catch (error) {
      await process.stop()
      throw error
    }
  }
  return start()
}

/**
 * A multi-user server seeded with the `zig build try` demo data (users,
 * repos, issues, patches) through Haxy's own event utilities. The demo writes
 * `./temp-try` relative to its cwd, which here is the sandbox.
 * Note: the demo leaves a one-shot admin auto-login; tests must not rely on it.
 */
export async function startDemoServer(binaries: Binaries, sandbox: Sandbox, options: BackendOptions = {}): Promise<Backend> {
  if (!binaries.demo) throw new Error("The demo fixture needs the try binary: unset HAXY_BIN or also set HAXY_TRY_BIN.")
  const port = options.port ?? (await freePort())
  const sshPort = await freePort()
  const dataDir = sandbox.path("data")
  const process = startProcess("haxy try --cli", binaries.demo, [
    "--cli", "--data-dir", dataDir, "--web-listen", `127.0.0.1:${port}`, "--ssh-listen", `127.0.0.1:${sshPort}`,
  ], { cwd: sandbox.root, env: sandbox.env })
  try {
    return await readyBackend("haxy try --cli", process, "server", dataDir, 120_000)
  } catch (error) {
    await process.stop()
    throw error
  }
}

export type LocalOptions = BackendOptions & {
  /**
   * The files of the repository's one commit on `main`, by repo-relative
   * path. Defaults to a README; `null` leaves the repository without commits.
   */
  files?: Record<string, string | Uint8Array> | null
  /**
   * Files whose paths are raw bytes (such as names that aren't UTF-8, which
   * some filesystems refuse), committed straight into the index alongside
   * `files`.
   */
  byteNamedFiles?: Array<{ path: Uint8Array; content: string | Uint8Array }>
}

/** Haxy's local mode (no subcommand) serving a fresh git repository, without its terminal UI. */
export async function startLocal(binaries: Binaries, sandbox: Sandbox, options: LocalOptions = {}): Promise<Backend> {
  const port = options.port ?? (await freePort())
  const repo = sandbox.path("repo")
  await mkdir(repo, { recursive: true })
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env: sandbox.env, stdio: "pipe" })
  git("init", "--quiet", "--initial-branch=main")
  const files = options.files === undefined ? { "README.md": "# e2e fixture\n" } : options.files
  if (files !== null) {
    for (const [name, content] of Object.entries(files)) {
      const file = sandbox.path("repo", name)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, content)
    }
    git("add", "--all")
    // one blob per distinct content and one index update, so large fixtures stay fast
    const blobs = new Map<string | Uint8Array, string>()
    const entries = (options.byteNamedFiles ?? []).map((file) => {
      let blob = blobs.get(file.content)
      if (blob === undefined) {
        blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, env: sandbox.env, input: file.content }).toString().trim()
        blobs.set(file.content, blob)
      }
      return Buffer.concat([Buffer.from(`100644 ${blob}\t`), file.path, Buffer.from("\n")])
    })
    if (entries.length > 0) execFileSync("git", ["update-index", "--add", "--index-info"], { cwd: repo, env: sandbox.env, input: Buffer.concat(entries) })
    git("commit", "--quiet", "-m", "Initial commit")
  }

  const process = startProcess("haxy (local)", binaries.haxy, ["--no-tui", "--web-listen", `127.0.0.1:${port}`], { cwd: repo, env: sandbox.env })
  try {
    return await readyBackend("haxy (local)", process, "local", repo, 30_000)
  } catch (error) {
    await process.stop()
    throw error
  }
}

export type IncompatibleVariant =
  /** An older Haxy (or another service) without the status API: HTML for every path. */
  | "no-status-api"
  /** A backend that sends status headers, then stalls mid-body like a hung or dropped connection. */
  | "stalled-status-body"
  /** A Haxy speaking an API version this Haxy Hub doesn't know. */
  | "future-api-version"

/**
 * A stand-in for a backend this Haxy Hub can't use. The real binary under test
 * is by definition compatible, so this is the one deliberate fake in the suite;
 * it only answers HTTP the way an incompatible server would.
 */
export async function startIncompatible(variant: IncompatibleVariant, options: BackendOptions = {}): Promise<Backend> {
  const port = options.port ?? (await freePort())
  const server = http.createServer((request, response) => {
    if (variant === "stalled-status-body" && request.url === "/api/v1/status") {
      response.writeHead(200, { "content-type": "application/json" })
      response.write('{"service":"haxy",')
      return
    }
    if (variant === "future-api-version" && request.url === "/api/v1/status") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ service: "haxy", api_version: 2, mode: "server" }))
      return
    }
    response.writeHead(404, { "content-type": "text/html; charset=utf-8" })
    response.end("<!doctype html><title>Not found</title><p>Not found</p>")
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => resolve())
  })
  return {
    mode: "server",
    port,
    origin: `http://127.0.0.1:${port}`,
    dataDir: "",
    output: () => "",
    stop: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}
