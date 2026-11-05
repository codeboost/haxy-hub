import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Backend } from "./backend"
import type { Git } from "./push"

/** A person as git records one. */
export type Identity = { name: string; email: string }

export type FixtureCommit = {
  message: string
  author?: Identity
  /** Defaults to the author. */
  committer?: Identity
  /** Unix seconds; commits made in a row get increasing defaults, so the order is stable. */
  at?: number
  /** Files the commit adds or replaces. */
  files?: Record<string, string | Uint8Array>
  /** A branch to merge in (with `--no-ff`), making this a merge commit. */
  merge?: string
}

export const alice: Identity = { name: "Alice", email: "alice@example.test" }

let clock = 1_700_000_000

/** A runner for git in `dir`, isolated from the developer's own git config. */
export function gitIn(dir: string): Git {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: path.dirname(dir),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    LANG: "C.UTF-8",
  }
  // a synchronous call blocks the test worker, so Playwright's own timeout
  // can't end a hung git; this one does
  return (args, options = {}) => execFileSync("git", args, { cwd: dir, env: { ...env, ...options.env }, input: options.input, stdio: "pipe", timeout: 60_000 }).toString().trim()
}

/** The git runner of a local-mode backend's repository. */
export function localGit(backend: Backend): Git {
  if (backend.mode !== "local") throw new Error("Only a local backend's repository is on disk here.")
  return gitIn(backend.dataDir)
}

/**
 * Adds `commits` to the checked-out branch with `git`, in order, and returns
 * their ids. Messages go through a file, so they may be any length.
 */
export function addCommits(git: Git, commits: FixtureCommit[]): string[] {
  return commits.map((commit) => {
    const author = commit.author ?? alice
    const committer = commit.committer ?? author
    const at = `${commit.at ?? (clock += 60)} +0000`
    const env = {
      GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_AUTHOR_DATE: at,
      GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email, GIT_COMMITTER_DATE: at,
    }
    for (const [name, content] of Object.entries(commit.files ?? {})) {
      const blob = git(["hash-object", "-w", "--stdin"], { input: typeof content === "string" ? content : Buffer.from(content) })
      git(["update-index", "--add", "--cacheinfo", `100644,${blob},${name}`])
    }
    if (commit.merge) {
      git(["merge", "--quiet", "--no-ff", "--no-edit", commit.merge, "-m", commit.message], { env })
    } else {
      // not through stdin: a message past the pipe's buffer can leave git
      // waiting for an end of input that never comes
      const dir = mkdtempSync(path.join(os.tmpdir(), "haxy-hub-e2e-message-"))
      try {
        const file = path.join(dir, "message")
        writeFileSync(file, commit.message)
        git(["commit", "--quiet", "--allow-empty", "--no-verify", "--cleanup=verbatim", "-F", file], { env })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
    return git(["rev-parse", "HEAD"])
  })
}
