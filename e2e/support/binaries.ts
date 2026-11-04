import { execFileSync } from "node:child_process"
import { accessSync, constants } from "node:fs"
import path from "node:path"

export const hubRoot = path.resolve(import.meta.dirname, "../..")

/** Where the harness installs the binaries it builds, away from the checkout's own zig-out. */
export const buildPrefix = path.join(hubRoot, "node_modules/.cache/haxy-e2e/zig-out")

export type Binaries = {
  haxy: string
  /** The `zig build try` demo seeder; absent when only HAXY_BIN was supplied. */
  demo: string | null
  /** Describes where the binaries came from, for the test report. */
  source: string
}

function executable(file: string, variable: string): string {
  const resolved = path.resolve(file)
  try {
    accessSync(resolved, constants.X_OK)
  } catch {
    throw new Error(`${variable}=${file} is not an executable file`)
  }
  return resolved
}

/**
 * Selects the backend binaries for this run:
 * - HAXY_BIN (and optionally HAXY_TRY_BIN) use prebuilt binaries as-is;
 * - otherwise `zig build install try-install` runs in HAXY_REPO (default ../haxy),
 *   installing into node_modules/.cache so the checkout's zig-out is untouched.
 */
export function resolveBinaries(): Binaries {
  if (process.env.HAXY_BIN) {
    return {
      haxy: executable(process.env.HAXY_BIN, "HAXY_BIN"),
      demo: process.env.HAXY_TRY_BIN ? executable(process.env.HAXY_TRY_BIN, "HAXY_TRY_BIN") : null,
      source: `HAXY_BIN=${process.env.HAXY_BIN}`,
    }
  }

  const repo = path.resolve(hubRoot, process.env.HAXY_REPO ?? "../haxy")
  const zig = process.env.ZIG ?? "zig"
  if (process.env.HAXY_E2E_SKIP_BUILD !== "1") {
    console.log(`[haxy-e2e] building Haxy in ${repo} (zig build install try-install)…`)
    execFileSync(zig, ["build", "--prefix", buildPrefix, "install", "try-install"], { cwd: repo, stdio: "inherit" })
  }
  return {
    haxy: executable(path.join(buildPrefix, "bin/haxy"), "built haxy"),
    demo: executable(path.join(buildPrefix, "bin/try"), "built try"),
    source: `built from ${repo}`,
  }
}

/** Binaries chosen by the global setup, read in each worker. */
export function selectedBinaries(): Binaries {
  const haxy = process.env.HAXY_E2E_HAXY_BIN
  if (!haxy) throw new Error("The e2e global setup did not run; use `npm run test:e2e`.")
  return { haxy, demo: process.env.HAXY_E2E_DEMO_BIN || null, source: process.env.HAXY_E2E_SOURCE ?? "" }
}
