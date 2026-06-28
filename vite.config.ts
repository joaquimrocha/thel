import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Tauri expects a fixed dev port and ignores the src-tauri tree for HMR.
const host = process.env.TAURI_DEV_HOST;

const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, "package.json"), "utf8"),
);

// The git tag/describe at build time, shown on the About settings tab. Falls
// back to the short commit when untagged, and to "" outside a git checkout.
function gitTag(): string {
  try {
    return execSync("git describe --tags --always --dirty", {
      cwd: __dirname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_TAG__: JSON.stringify(gitTag()),
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  // Tauri reads cargo output on stderr; don't let Vite clear it.
  clearScreen: false,
  build: {
    // The app loads from the local Tauri protocol, not over a network, so a
    // single bundle parses just as fast as split chunks. Manual vendor chunking
    // tripped a React/Radix init-order error, so keep one chunk and just lift
    // the cosmetic size warning.
    chunkSizeWarningLimit: 1024,
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
