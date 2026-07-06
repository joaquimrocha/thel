import { defineConfig } from "vitest/config";
import path from "node:path";

// Unit tests for pure logic (ANSI parsing, notification heuristics, prefs,
// persistence shaping). The end-to-end behaviour lives in the Playwright suite
// under tests/; this covers the dependency-free modules that suite can only
// reach indirectly. Node environment: the modules under test use bare timers
// and strings, no DOM.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
