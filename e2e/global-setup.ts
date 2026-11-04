import { resolveBinaries } from "./support/binaries"

/** Builds or selects the Haxy binaries once; workers read them from the environment. */
export default function globalSetup() {
  const binaries = resolveBinaries()
  process.env.HAXY_E2E_HAXY_BIN = binaries.haxy
  process.env.HAXY_E2E_DEMO_BIN = binaries.demo ?? ""
  process.env.HAXY_E2E_SOURCE = binaries.source
  console.log(`[haxy-e2e] backend: ${binaries.haxy} (${binaries.source})`)
}
