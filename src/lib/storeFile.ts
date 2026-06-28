// Tauri store files live in the app config dir, keyed only by the bundle id, so
// a dev build would otherwise read and write the installed app's profiles,
// sessions, launchers, and keybindings. Namespace them in dev so `pnpm tauri
// dev` runs in an isolated sandbox.
//
// localStorage-backed prefs/theme need no equivalent: the dev build is served
// from a different origin (http://localhost:1420) than the bundled app, so it
// already gets its own localStorage.
export const storeFile = (name: string) => {
  // The e2e suite runs against the same dev server but with a localStorage
  // store mock seeded under the production names (window.__MOCK__ is set before
  // app code runs). Don't namespace there, or those seeds wouldn't be found.
  const underTestMock =
    typeof window !== "undefined" &&
    Object.prototype.hasOwnProperty.call(window, "__MOCK__");
  return import.meta.env.DEV && !underTestMock ? `dev-${name}` : name;
};
