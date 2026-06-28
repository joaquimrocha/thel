import { defineConfig, devices } from "@playwright/test";

// The app is a Tauri webview, but the React frontend runs in a plain browser
// with the Tauri IPC layer mocked (see tests/tauri.ts). These tests exercise the
// UI/behaviour, not the Rust backend.
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : [["list"]],
  // Code-coverage collection (V8 -> src via source maps); see tests/coverage.ts.
  globalSetup: "./tests/coverage-setup.ts",
  globalTeardown: "./tests/coverage-teardown.ts",
  use: {
    baseURL: "http://localhost:1420",
    trace: "on-first-retry",
  },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
