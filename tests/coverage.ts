import { test as base } from "@playwright/test";
import { CoverageReport } from "monocart-coverage-reports";

// V8 coverage collected from Chromium, mapped back to src/* via Vite's source
// maps. Each test appends to a shared on-disk cache; the global teardown merges
// and reports it.
export const coverageOptions = {
  name: "thel frontend coverage",
  outputDir: "./coverage",
  reports: ["v8", "console-summary", "lcovonly"] as ("v8" | "console-summary" | "lcovonly")[],
  // Vite/esbuild source-maps our app modules to bare basenames (App.tsx,
  // Titlebar.tsx, actions.ts, …), while dependencies keep a path or "@". Keep
  // bare .ts/.tsx names; drop anything with a slash or node_modules.
  sourceFilter: (sourcePath: string) =>
    /^[\w.-]+\.tsx?$/.test(sourcePath) && !/node_modules/.test(sourcePath),
};

// Auto fixture: starts/stops JS coverage around every test.
export const test = base.extend<{ autoCoverage: void }>({
  autoCoverage: [
    async ({ page }, use) => {
      const cov = page.coverage;
      if (cov) await cov.startJSCoverage({ resetOnNavigation: false });
      await use();
      if (cov) {
        const entries = await cov.stopJSCoverage();
        await new CoverageReport(coverageOptions).add(entries);
      }
    },
    { auto: true },
  ],
});
