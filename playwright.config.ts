import { defineConfig, devices } from "@playwright/test"

// Each test launches its own backend(s) and Vite dev server through the
// `launch` fixture in e2e/support/fixtures.ts, so there is no shared webServer.
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  outputDir: "node_modules/.cache/haxy-e2e/test-results",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
})
