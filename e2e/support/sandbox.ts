import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/**
 * A throwaway directory under the OS temp dir. Every backend process runs with
 * its cwd, HOME and git config inside one, so a test can never reach the
 * developer's data dir, `temp-try`, global git config or running session.
 */
export type Sandbox = {
  root: string
  env: NodeJS.ProcessEnv
  /** Resolves `relative` inside the sandbox, refusing anything that escapes it. */
  path(...relative: string[]): string
  dispose(): Promise<void>
}

const prefix = "haxy-hub-e2e-"

export async function createSandbox(label: string): Promise<Sandbox> {
  const tmp = await realpath(os.tmpdir())
  const root = await mkdtemp(path.join(tmp, `${prefix}${label.replace(/[^a-z0-9-]/gi, "-")}-`))
  const home = path.join(root, "home")
  await mkdir(path.join(home, ".config"), { recursive: true })
  // An identity for local-mode commits; never the developer's own config.
  await writeFile(path.join(home, ".gitconfig"), "[user]\n\tname = Haxy E2E\n\temail = e2e@example.test\n[init]\n\tdefaultBranch = main\n")

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG ?? "C.UTF-8",
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    NO_COLOR: "1",
  }

  return {
    root,
    env,
    path(...relative) {
      const resolved = path.resolve(root, ...relative)
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new Error(`Refusing to use ${resolved}: it is outside the test sandbox ${root}`)
      }
      return resolved
    },
    async dispose() {
      if (process.env.HAXY_E2E_KEEP === "1") return
      // Guard against ever deleting anything but our own temp dir.
      if (!path.basename(root).startsWith(prefix) || path.dirname(root) !== tmp) {
        throw new Error(`Refusing to delete ${root}`)
      }
      await rm(root, { recursive: true, force: true, maxRetries: 3 })
    },
  }
}
