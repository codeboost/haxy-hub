import { execFile, execFileSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { APIRequestContext } from "@playwright/test"
import { writeHeaders } from "./accounts"
import type { Backend } from "./backend"
import { waitUntil } from "./process"

/**
 * Git over SSH against a `launch.server({ ssh: true })` backend, as a person
 * works with a repository over time: a fresh ed25519 key pair whose public
 * key is added to the account through Haxy's own key API, and the system
 * `git` and `ssh` using only that key, for pushes that may fail (a force-push
 * to a protected branch, a push after a revoke) and reads such as
 * `ls-remote`. `pushRepo` (`./push.ts`) is the one-shot way to fill a
 * repository; this keeps the key and a work tree across steps. Everything
 * lives in the backend's test sandbox, never in the developer's ~/.ssh or git
 * config.
 */
export type SshUser = {
  name: string
  /** The ssh command that authenticates as this user (its key only), for a `core.sshCommand` setting. */
  sshCommand: string
  /** The repository's SSH URL, as its overview's clone command names it (the repository must be readable to this user). */
  remote(owner: string, name: string): Promise<string>
  /** Runs git in `cwd` as this user; rejects with git's output when it fails. */
  git(cwd: string, ...args: string[]): Promise<string>
  /**
   * A new work tree (in the sandbox) holding one commit per entry of
   * `commits`, each writing its files, on `branch`.
   */
  workTree(label: string, branch: string, commits: Array<Record<string, string>>): Promise<string>
}

/** The sandbox directory a backend's data dir lives in. */
function sandboxRoot(backend: Backend): string {
  return path.dirname(backend.dataDir)
}

/**
 * Makes `context` (signed in as `name`) an SSH user: generates its key pair
 * and adds the public key to the account with `POST /api/v1/account/keys`
 * through the hub, as the account page does.
 */
export async function sshUser(backend: Backend, hubUrl: string, context: APIRequestContext, name: string): Promise<SshUser> {
  await waitUntil(async () => (backend.output().includes("serving SSH on") ? true : undefined), 30_000, () => `SSH never started:\n${backend.output()}`)

  const home = path.join(sandboxRoot(backend), `ssh-${name}`)
  await mkdir(home, { recursive: true })
  const key = path.join(home, "id_ed25519")
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `${name}@e2e`, "-f", key], { stdio: "pipe", timeout: 30_000 })
  const added = await context.post(`${hubUrl}/api/v1/account/keys`, {
    headers: { ...(await writeHeaders(context, hubUrl)), "Content-Type": "application/json" },
    data: { key: (await readFile(`${key}.pub`, "utf8")).trim() },
  })
  if (added.status() !== 201) throw new Error(`Adding ${name}'s SSH key failed: HTTP ${added.status()} ${await added.text()}`)

  // single quotes, which both git's shell and Haxy's own ssh command parsing
  // read; options in their space form, since Haxy's git config reader (xit's)
  // spaces out an "=" inside a value
  const sshCommand = `ssh -F /dev/null -i '${key}' -o 'IdentitiesOnly yes' -o 'IdentityAgent none'`
  const gitconfig = path.join(home, ".gitconfig")
  await writeFile(gitconfig, `[user]\n\tname = ${name}\n\temail = ${name}@example.test\n[init]\n\tdefaultBranch = main\n`)
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG ?? "C.UTF-8",
    HOME: home,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    // this key only, no ssh config, and the test host's key unchecked; no
    // agent either, so a developer's loaded keys can't stand in for it (a
    // push that must be refused would otherwise run as someone else)
    GIT_SSH_COMMAND: `${sshCommand} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR`,
  }
  const git = (cwd: string, ...args: string[]) => new Promise<string>((resolve, reject) => {
    execFile("git", args, { cwd, env }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(" ")} failed:\n${stdout}${stderr}`))
      else resolve(`${stdout}${stderr}`)
    })
  })
  let trees = 0
  return {
    name,
    sshCommand,
    async remote(owner, repo) {
      const overview = await context.get(`${hubUrl}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`)
      if (!overview.ok()) throw new Error(`Reading ${owner}/${repo} failed: HTTP ${overview.status()}`)
      const url = ((await overview.json()) as { clone: Array<{ protocol: string; url: string }> }).clone.find((command) => command.protocol === "ssh")?.url
      if (url === undefined) throw new Error("The server offers no SSH URL; launch it with { ssh: true }.")
      return url
    },
    git,
    async workTree(label, branch, commits) {
      const dir = path.join(home, `work-${trees++}-${label}`)
      await mkdir(dir, { recursive: true })
      await git(dir, "init", "--quiet", `--initial-branch=${branch}`)
      for (const [index, files] of commits.entries()) {
        for (const [file, content] of Object.entries(files)) {
          await mkdir(path.dirname(path.join(dir, file)), { recursive: true })
          await writeFile(path.join(dir, file), content)
        }
        await git(dir, "add", "--all")
        await git(dir, "commit", "--quiet", "-m", `${label} commit ${index + 1}`)
      }
      return dir
    },
  }
}
