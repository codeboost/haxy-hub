import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import type { PlaywrightWorkerArgs } from "@playwright/test"
import type { Account } from "./accounts"
import { writeHeaders } from "./accounts"
import { buildRepo, type Backend, type RepoContent } from "./backend"
import { signedIn } from "./repos"
import { createSandbox } from "./sandbox"

/** Runs git in the repository being pushed and returns its trimmed output. */
export type Git = (args: string[], options?: { env?: NodeJS.ProcessEnv; input?: string | Buffer }) => string

export type PushContent = RepoContent & {
  /**
   * Adds to the repository after `files` and `refs` are committed and before
   * the push: more commits, branches, merges, other authors.
   */
  history?(git: Git): void
}

/**
 * Pushes a git repository holding `content` to the server repository
 * `owner`/`name` (which must exist, see `createRepo`), as `account` over SSH,
 * the only way Haxy takes pushes. A push is Haxy's own operation for adding
 * commits, so it also builds what Haxy derives from them, such as the commit
 * and file-finder indexes. `main` goes first, so a repository without commits
 * adopts it as its default branch, then every other branch and tag.
 *
 * Needs `launch.server({ ssh: true })`. It registers a fresh SSH key for
 * `account` through the API, and works in a throwaway sandbox of its own. It
 * doesn't force: a later push must extend what earlier ones pushed.
 */
export async function pushRepo(
  playwright: PlaywrightWorkerArgs["playwright"],
  backend: Backend,
  hubUrl: string,
  account: Account,
  repo: { owner: string; name: string },
  content: PushContent,
): Promise<void> {
  const context = await signedIn(playwright, backend, hubUrl, account.name, account.password)
  const sandbox = await createSandbox("push")
  try {
    const run = (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string | Buffer } = {}) =>
      execFileSync(command, args, { cwd: options.cwd ?? sandbox.root, env: { ...sandbox.env, ...options.env }, input: options.input, stdio: "pipe" }).toString().trim()

    const key = sandbox.path("id_ed25519")
    run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "haxy-e2e", "-f", key])
    const added = await context.post(`${hubUrl}/api/v1/account/keys`, {
      headers: await writeHeaders(context, hubUrl),
      data: { key: readFileSync(`${key}.pub`, "utf8").trim() },
    })
    if (added.status() !== 201) throw new Error(`Adding an SSH key for ${account.name} failed: HTTP ${added.status()} ${await added.text()}`)

    const overview = await context.get(`${hubUrl}/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`)
    if (!overview.ok()) throw new Error(`Reading ${repo.owner}/${repo.name} failed: HTTP ${overview.status()}`)
    const body = (await overview.json()) as { clone: Array<{ protocol: string; url: string }> }
    const url = body.clone.find((command) => command.protocol === "ssh")?.url
    if (url === undefined) throw new Error("The server offers no SSH URL; launch it with { ssh: true }.")

    const work = sandbox.path("work")
    await buildRepo(work, sandbox, content)
    const git: Git = (args, options = {}) => run("git", args, { cwd: work, ...options })
    content.history?.(git)

    const env = { GIT_SSH_COMMAND: `ssh -F /dev/null -i "${key}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR` }
    try {
      git(["push", "--quiet", url, "refs/heads/main:refs/heads/main"], { env })
      git(["push", "--quiet", url, "refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"], { env })
    } catch (error) {
      const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? ""
      throw new Error(`Pushing to ${url} failed: ${stderr}\n${backend.output()}`)
    }
  } finally {
    await context.dispose()
    await sandbox.dispose()
  }
}
