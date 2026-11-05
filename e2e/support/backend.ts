import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
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
   * resolving once it is ready. Only `launch.server()` and `launch.demo()` backends can restart.
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
  return serveDataDir(binaries, sandbox, options.port ?? (await freePort()), sandbox.path("data"))
}

/** `haxy serve` on `dataDir`, restartable on the same port and data dir. */
function serveDataDir(binaries: Binaries, sandbox: Sandbox, port: number, dataDir: string): Promise<Backend> {
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
    const backend = await readyBackend("haxy try --cli", process, "server", dataDir, 120_000)
    // a restart serves the seeded data dir with `haxy serve`, as a real server would
    return { ...backend, restart: async () => { await backend.stop(); return serveDataDir(binaries, sandbox, port, dataDir) } }
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
  /**
   * Branches and tags to add at the commit on `main`, written straight into
   * the repository's refs, so names may be raw bytes (which some filesystems
   * refuse) or hold characters git's own commands reject, such as spaces.
   */
  refs?: FixtureRef[]
  /** The branch HEAD names after the commit, which needn't exist (an unborn branch); `main` by default. */
  head?: string
}

export type FixtureRef = {
  kind: "branch" | "tag"
  name: string | Uint8Array
  /** Files a commit of the ref's own, on top of `main`'s, adds or replaces. */
  files?: Record<string, string>
  /** For a tag: an annotated tag object rather than a plain ref to the commit. */
  annotated?: boolean
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
    if (options.refs) addRefs(repo, sandbox, options.refs)
    if (options.head !== undefined) git("symbolic-ref", "HEAD", `refs/heads/${options.head}`)
  }

  const process = startProcess("haxy (local)", binaries.haxy, ["--no-tui", "--web-listen", `127.0.0.1:${port}`], { cwd: repo, env: sandbox.env })
  try {
    return await readyBackend("haxy (local)", process, "local", repo, 30_000)
  } catch (error) {
    await process.stop()
    throw error
  }
}

/**
 * Writes `refs` into the git repository at `repo`: names a packed ref can
 * hold go into packed-refs (bytes and all), names with spaces become loose
 * ref files.
 */
function addRefs(repo: string, sandbox: Sandbox, refs: FixtureRef[]) {
  const run = (args: string[], input?: string | Buffer, env: NodeJS.ProcessEnv = {}) =>
    execFileSync("git", args, { cwd: repo, env: { ...sandbox.env, ...env }, input, stdio: "pipe" }).toString().trim()
  const main = run(["rev-parse", "HEAD"])
  // no header, which git reads as an unsorted packed-refs file without peeled tags
  const packed: Buffer[] = []
  refs.forEach((ref, index) => {
    let oid = main
    if (ref.files) {
      // a commit of its own, built in a scratch index so the work tree stays on main
      const env = { GIT_INDEX_FILE: path.join(repo, ".git", `fixture-index-${index}`) }
      run(["read-tree", main], undefined, env)
      // one blob per distinct content and one index update, so large refs stay fast
      const blobs = new Map<string, string>()
      const entries = Object.entries(ref.files).map(([name, content]) => {
        let blob = blobs.get(content)
        if (blob === undefined) blobs.set(content, (blob = run(["hash-object", "-w", "--stdin"], content)))
        return `100644 ${blob}\t${name}\n`
      })
      run(["update-index", "--add", "--index-info"], entries.join(""), env)
      const tree = run(["write-tree"], undefined, env)
      oid = run(["commit-tree", tree, "-p", main, "-m", `Commit for ref ${index}`])
    }
    if (ref.annotated) {
      oid = run(["mktag"], `object ${oid}\ntype commit\ntag fixture-${index}\ntagger Fixture <fixture@example.test> 1700000000 +0000\n\nAnnotated ${index}\n`)
    }
    const name = Buffer.from(ref.name)
    const refPath = Buffer.concat([Buffer.from(ref.kind === "branch" ? "refs/heads/" : "refs/tags/"), name])
    if (name.includes(0x20)) {
      const file = path.join(repo, ".git", refPath.toString())
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, `${oid}\n`)
    } else {
      packed.push(Buffer.concat([Buffer.from(`${oid} `), refPath, Buffer.from("\n")]))
    }
  })
  writeFileSync(path.join(repo, ".git", "packed-refs"), Buffer.concat(packed))
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
