import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// Each checkout gets its own Vite port, derived from its path. On the shared
// 1420, reuseExistingServer picked up whatever served it, often another
// worktree's `tauri dev`, and tested that worktree's code. THEL_TEST_PORT
// overrides it.
const port = Number(
  process.env.THEL_TEST_PORT ??
    20000 + (createHash("sha1").update(fileURLToPath(new URL(".", import.meta.url))).digest().readUInt16BE(0) % 10000),
);
const url = `http://localhost:${port}`;

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
    baseURL: url,
    trace: "on-first-retry",
  },
  webServer: {
    command: `pnpm dev --port ${port}`,
    url,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
