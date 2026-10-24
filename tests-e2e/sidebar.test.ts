import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import { App, until } from "./app.ts";

let app: App;

function session(i: number) {
  const id = `s${i}`;
  return {
    id,
    name: `s${i}`,
    cwd: tmpdir(),
    groups: [
      {
        id: `g-${id}`,
        activeTerminalId: `t-${id}`,
        terminals: [{ id: `t-${id}`, title: "shell", command: "", args: [] }],
      },
    ],
    layout: { t: "leaf", group: `g-${id}` },
    activeGroupId: `g-${id}`,
  };
}

before(async () => {
  const sessions = Array.from({ length: 30 }, (_, i) => session(i));
  app = await App.launch({ seed: { "thel-layout.json": { layout: { activeSessionId: "s0", sessions } } } });
});
after(async () => {
  await app?.close();
});

// WebKitGTK's overlay scrollbar takes no space and widens over the rows on
// hover. A classic one makes offsetWidth exceed clientWidth by its width.
test("the session list's scrollbar takes its own space in WebKit", async () => {
  await app.setWindowSize({ width: 1000, height: 500 });
  const gutter = await until("a scrolling session list", () =>
    app.exec(
      `const el = document.querySelector("[data-session-list]");
       return el && el.scrollHeight > el.clientHeight ? el.offsetWidth - el.clientWidth : false;`,
    ),
  );
  assert.equal(gutter, 6);
});
