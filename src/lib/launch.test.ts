import { test, expect, vi } from "vitest";

vi.mock("./pty", async (original) => ({
  ...(await original<typeof import("./pty")>()),
  homeDir: async () => "/home/u",
}));

import { sessionNameForDir } from "./launch";

test("a folder's session name matches the one thel session gives it", async () => {
  // paths.ts reads $HOME when it loads.
  await Promise.resolve();
  expect(sessionNameForDir("/home/u")).toBe("~");
  expect(sessionNameForDir("/home/u/")).toBe("~");
  expect(sessionNameForDir("/w/web/")).toBe("web");
  expect(sessionNameForDir("/tmp/a\\b")).toBe("a\\b");
});
