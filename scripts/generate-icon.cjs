// Generates the 1024x1024 app-icon master (icon-src.png) from the brand mark in
// logo.svg, composited on thel's dark rounded panel, then feed it to
// `pnpm tauri icon icon-src.png` to produce the tracked desktop icons under
// src-tauri/icons/. Requires ImageMagick (`magick`) to rasterize the SVG.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const svg = path.join(root, "logo.svg");
const out = path.join(root, "icon-src.png");

// #09090b app background with an #18181b rounded panel (the same surfaces used in
// the UI), and the green logo centered at ~55% with padding.
execFileSync(
  "magick",
  [
    "-size", "1024x1024", "xc:#09090b",
    "-fill", "#18181b",
    "-draw", "roundrectangle 96,96 928,928 140,140",
    "(", "-background", "none", "-density", "1536", svg, "-resize", "560x560", ")",
    "-gravity", "center", "-composite",
    "-depth", "8", "PNG32:" + out,
  ],
  { stdio: "inherit" },
);

console.log("wrote", out);
