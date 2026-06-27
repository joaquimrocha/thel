import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Tauri expects a fixed dev port and ignores the src-tauri tree for HMR.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
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
