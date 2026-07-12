import { appConfigDir, join } from "@tauri-apps/api/path";
import {
  load as loadStore,
  type Store,
  type StoreOptions,
} from "@tauri-apps/plugin-store";

// Store files are thel's actual configuration, so they belong in the app
// config dir (~/.config/<app id> on Linux). plugin-store resolves relative
// names against the app *data* dir instead, where WebKit also dumps its
// browser storage, so resolve to an absolute config-dir path here.
//
// Dev builds get a `dev-` prefix: the config dir is keyed only by the bundle
// id, so `pnpm tauri dev` would otherwise read and write the installed app's
// profiles, sessions, launchers, and keybindings.
//
// localStorage-backed prefs/theme need no equivalent: the dev build is served
// from a different origin (http://localhost:1420) than the bundled app, so it
// already gets its own localStorage.
const storeFile = async (name: string): Promise<string> => {
  // The e2e suite runs against the same dev server but with a localStorage
  // store mock seeded under the production names (window.__MOCK__ is set before
  // app code runs). The mock keys stores by bare name, so skip path resolution
  // there, or those seeds wouldn't be found.
  const underTestMock =
    typeof window !== "undefined" &&
    Object.prototype.hasOwnProperty.call(window, "__MOCK__");
  if (underTestMock) return name;
  const file = import.meta.env.DEV ? `dev-${name}` : name;
  return join(await appConfigDir(), file);
};

/** plugin-store's `load`, with bare names resolved into the app config dir. */
export const load = async (
  name: string,
  options?: StoreOptions,
): Promise<Store> => loadStore(await storeFile(name), options);
