import { test, expect } from "vitest";
import { toPersistedTerminal } from "./persistence";
import type { Terminal } from "@/store/sessions";

test("toPersistedTerminal keeps structural fields, drops runtime state", () => {
  const t: Terminal = {
    id: "1",
    title: "vim",
    defaultTitle: "shell",
    renamed: true,
    command: "vim",
    args: ["a.txt"],
    cwd: "/tmp",
    zoom: 2,
    // Runtime-only fields that must not be persisted:
    procTitle: "editing a.txt",
    started: true,
    exited: true,
    exitCode: 0,
    attention: true,
    busy: true,
  };
  // toEqual on the exact object also asserts no extra keys leaked through.
  expect(toPersistedTerminal(t)).toEqual({
    id: "1",
    title: "vim",
    defaultTitle: "shell",
    renamed: true,
    command: "vim",
    args: ["a.txt"],
    cwd: "/tmp",
    zoom: 2,
  });
});
