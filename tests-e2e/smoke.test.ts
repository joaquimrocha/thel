import { after, before, test } from "node:test";
import { App } from "./app.ts";

let app: App;
before(async () => {
  app = await App.launch();
});
after(() => app?.close());

test("a new session runs a real shell", async () => {
  await app.press("N", { ctrl: true, shift: true });
  await app.click(await app.button("Create session"));
  await app.find(".xterm-helper-textarea:focus");
  await app.terminalMatching(/\$ $/m);
  await app.type("echo thel-$((6*7))");
  await app.press("Enter");
  await app.terminalMatching(/^thel-42$/m);
});
