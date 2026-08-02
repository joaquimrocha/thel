// Vitest setup: pin the reported platform so the unit tests are deterministic
// regardless of the host. The keymap logic branches on `isMac`
// (navigator.platform). Node exposes a global `navigator` only from v21, and
// with the *real* host platform -- so on a Mac (or newer Node) it reads
// "MacIntel" and the Ctrl-based keymap assertions would flip to Cmd, while on
// Node 20 there's no `navigator` at all. Normalise both: override platform when
// navigator exists, otherwise define a minimal one. Runs before any test module
// reads the value; set THEL_TEST_PLATFORM to exercise the mac bindings instead.
const g = globalThis as unknown as {
  navigator?: { platform?: string };
  // Reach process.env without pulling Node types into the browser tsconfig this
  // file is checked under; it only ever runs in vitest's Node environment.
  process?: { env?: Record<string, string | undefined> };
};
const platform = g.process?.env?.THEL_TEST_PLATFORM || "Linux x86_64";
if (g.navigator) {
  Object.defineProperty(g.navigator, "platform", {
    configurable: true,
    get: () => platform,
  });
} else {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { platform },
  });
}
