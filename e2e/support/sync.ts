import { execFile } from "node:child_process"
import net from "node:net"
import type { APIRequestContext, PlaywrightWorkerArgs } from "@playwright/test"
import { alice, registerUser, type Account } from "./accounts"
import type { Backend } from "./backend"
import type { Launch } from "./fixtures"
import type { Hub } from "./hub"
import { waitUntil } from "./process"
import { createRepo, signedIn } from "./repos"
import { sshUser, type SshUser } from "./ssh"

/**
 * Local mode's sync fixture: a real Haxy server (with SSH) holding
 * `alice:shared`, and local mode serving a git repository whose `origin` is
 * that repository over SSH, authenticated with alice's key through
 * `core.sshCommand`, as a person who cloned it would have it. The local
 * repository's `main` is pushed to the server first, so both sides share it.
 */
export type SyncFixture = {
  server: Backend
  /** A hub proxying to the server, for its own API. */
  serverHub: Hub
  /** alice, signed in to the server. */
  owner: APIRequestContext
  ssh: SshUser
  /** The server repository's SSH URL. */
  url: string
  local: Backend
  /** A hub proxying to local mode. */
  hub: Hub
}

export const sharedRepo = { owner: alice.name, name: "shared", access: "public" as const }
export const serverBase = `/${sharedRepo.owner}:${sharedRepo.name}`

export async function syncFixture(playwright: PlaywrightWorkerArgs["playwright"], launch: Launch, options: { as?: Account } = {}): Promise<SyncFixture> {
  const server = await launch.server({ ssh: true })
  const serverHub = await launch.hub(server.port)
  await registerUser(server, alice)
  const owner = await signedIn(playwright, server, serverHub.url, alice.name, alice.password)
  await createRepo(owner, server, sharedRepo)
  let syncing = owner
  if (options.as) {
    await registerUser(server, options.as)
    syncing = await signedIn(playwright, server, serverHub.url, options.as.name, options.as.password)
  }
  const ssh = await sshUser(server, serverHub.url, syncing, options.as?.name ?? alice.name)
  const url = await ssh.remote(sharedRepo.owner, sharedRepo.name)
  const local = await launch.local({ config: { "remote.origin.url": url, "core.sshCommand": ssh.sshCommand } })
  const hub = await launch.hub(local.port)
  // the owner shares the code; another user only syncs
  const pusher = options.as ? await sshUser(server, serverHub.url, owner, alice.name) : ssh
  await pusher.git(local.dataDir, "push", "--quiet", url, "main:main")
  if (syncing !== owner) await syncing.dispose()
  return { server, serverHub, owner, ssh, url, local, hub }
}

/** Runs a read-only git command in local mode's repository, without anyone's git config, and returns its trimmed output. */
export function localGit(local: Backend, ...args: string[]): Promise<string> {
  const env = { PATH: process.env.PATH, HOME: local.dataDir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: local.dataDir, env, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(" ")} failed:\n${stdout}${stderr}\n${local.output()}`))
      else resolve(stdout.trim())
    })
  })
}

/**
 * A remote that accepts SSH connections and never answers, as a hung server
 * would, so a sync reaching it waits until `hangUp`.
 */
export type SilentRemote = {
  /** An ssh:// URL for a local repository's `remote.origin.url`. */
  url: string
  /**
   * Waits (at most 15 s) for a sync's connection, then drops every one, which
   * ends that sync with a fetch failure. A sync may say it runs before its ssh
   * has connected, so dropping without waiting could miss it.
   */
  hangUp(): Promise<void>
  close(): Promise<void>
}

export async function silentRemote(): Promise<SilentRemote> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => { sockets.add(socket); socket.on("error", () => {}) })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as net.AddressInfo).port
  const dropAll = () => { for (const socket of sockets) socket.destroy() }
  return {
    url: `ssh://git@127.0.0.1:${port}/alice/shared`,
    async hangUp() {
      await waitUntil(async () => (sockets.size > 0 ? true : undefined), 15_000, () => "No sync connected to the silent remote within 15 s.")
      dropAll()
    },
    async close() {
      dropAll()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
