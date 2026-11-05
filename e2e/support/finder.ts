import { readdirSync } from "node:fs"
import path from "node:path"
import type { PlaywrightWorkerArgs } from "@playwright/test"
import { alice, registerUser } from "./accounts"
import type { Backend } from "./backend"
import type { Launch } from "./fixtures"
import type { Hub } from "./hub"
import { pushRepo } from "./push"
import { createRepo, signedIn } from "./repos"
import { selectedBinaries } from "./binaries"
import { freePort, startProcess, waitUntil } from "./process"

/**
 * The directory of a server's repositories that have been created so far, by
 * the users who created them: `<data>/users/<user id>/repos/<repo id>`. Each
 * is an xit repository, with whatever indexes Haxy keeps in it.
 */
export function serverRepoDirs(server: Backend): string[] {
  const users = path.join(server.dataDir, "users")
  return readdirSync(users).flatMap((user) => {
    const repos = path.join(users, user, "repos")
    try {
      return readdirSync(repos).map((repo) => path.join(repos, repo))
    } catch {
      return []
    }
  })
}

/**
 * Haxy's local mode serving the existing repository `dir` (such as a server
 * repository a push indexed), without its terminal UI. The fixture's
 * teardown stops it with every other process; stop the server that owns
 * `dir` first, so only one Haxy has it open.
 */
export async function serveLocally(dir: string): Promise<Backend> {
  const port = await freePort()
  const process = startProcess("haxy (local, existing repo)", selectedBinaries().haxy, ["--no-tui", "--web-listen", `127.0.0.1:${port}`], {
    cwd: dir,
    // the repository's own sandbox holds its HOME, so no developer config is read
    env: { PATH: globalThis.process.env.PATH, HOME: path.dirname(dir), GIT_CONFIG_NOSYSTEM: "1", NO_COLOR: "1" },
  })
  try {
    await process.waitForOutput(/serving web UI\b/, 30_000)
    const origin = `http://127.0.0.1:${port}`
    await waitUntil(async () => {
      const response = await fetch(`${origin}/api/v1/status`, { signal: AbortSignal.timeout(2_000) })
      return ((await response.json()) as { mode?: string }).mode === "local" ? true : undefined
    }, 30_000, () => `local haxy in ${dir} never reported local mode:\n${process.output()}`)
    return { mode: "local", port, origin, dataDir: dir, output: process.output, stop: process.stop }
  } catch (error) {
    await process.stop()
    throw error
  }
}

/** A Latin-1 `é`: a name byte that isn't UTF-8. */
export const latin1Name = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x2e, 0x62, 0x69, 0x6e]) // "caf\xE9.bin"

/** How many files the fixture holds under `many/`, past the finder's cap of 1000. */
export const manyCount = 1005

/**
 * What the finder fixture's `main` holds: names with spaces (leading ones
 * too), Unicode, a byte that isn't UTF-8, literal `%41`/`%2F`, and more files
 * starting with "f" than the finder lists. `feature` adds a file of its own,
 * and `v1` tags `main`.
 */
export function finderContent() {
  const files: Record<string, string> = {
    "README.md": "# Finder fixture\n",
    "docs/sub dir/Read Me.md": "# Nested read me\n",
    "café.txt": "unicode name\n",
    "src/Café.md": "# Upper case\n",
    "a%41.txt": "literal percent 41\n",
    "a%2Fb.txt": "literal percent 2F\n",
    "aA.txt": "not a percent\n",
    " lead.txt": "leading space\n",
  }
  for (let index = 0; index < manyCount; index++) files[`many/f${String(index).padStart(4, "0")}.txt`] = "many\n"
  return {
    files,
    byteNamedFiles: [{ path: latin1Name, content: "latin-1 name\n" }],
    refs: [
      { kind: "tag" as const, name: "v1" },
      { kind: "branch" as const, name: "feature", files: { "feature only.txt": "only on feature\n" } },
    ],
  }
}

/**
 * A server (with SSH) where alice's public `tricky` holds `finderContent()`,
 * pushed over SSH, so Haxy indexed its branches as every push does; and Haxy
 * Hub in front of it.
 */
export async function indexedServer(playwright: PlaywrightWorkerArgs["playwright"], launch: Launch): Promise<{ server: Backend; hub: Hub }> {
  const server = await launch.server({ ssh: true })
  const hub = await launch.hub(server.port)
  await registerUser(server, alice)
  const context = await signedIn(playwright, server, hub.url, alice.name, alice.password)
  await createRepo(context, server, { name: "tricky", access: "public" })
  await context.dispose()
  await pushRepo(playwright, server, hub.url, alice, { owner: alice.name, name: "tricky" }, finderContent())
  return { server, hub }
}
