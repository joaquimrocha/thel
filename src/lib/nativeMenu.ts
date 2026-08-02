import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isMac } from "@/lib/platform";
import { useProfiles } from "@/store/profiles";
import { useUI } from "@/store/ui";

// On macOS the window is native (no in-app title bar), so the app-menu actions
// live in the system menu bar. This keeps that native menu's Profiles list in
// sync with the store and turns menu selections back into the same store actions
// the Linux title-bar buttons call, so nothing is reachable on one platform but
// not the other. No-op off macOS.

type MenuAction = { action: string; id?: string };

// Push the current profile list to the Rust side, which rebuilds the native menu.
function pushMenu() {
  const { profiles, currentId } = useProfiles.getState();
  void invoke("update_app_menu", {
    profiles: profiles.map((p) => ({ id: p.id, name: p.name })),
    current: currentId,
  }).catch((e) => console.error("update_app_menu failed", e));
}

function dispatch(a: MenuAction) {
  const ui = useUI.getState();
  switch (a.action) {
    case "switch-profile":
      if (a.id) void useProfiles.getState().switchProfile(a.id);
      break;
    case "settings":
      ui.openSettings();
      break;
    case "manage-profiles":
      ui.openSettings("profiles");
      break;
    case "new-profile":
      ui.setProfileDialogOpen(true);
      break;
  }
}

/**
 * Start syncing the native menu bar and handling its events. Returns a cleanup
 * function. No-op (returns a no-op cleanup) on non-macOS.
 */
export function initNativeMenu(): () => void {
  if (!isMac) return () => {};

  pushMenu();
  // Rebuild whenever the profile set or the current profile changes.
  const unsubProfiles = useProfiles.subscribe((s, prev) => {
    if (s.profiles !== prev.profiles || s.currentId !== prev.currentId) pushMenu();
  });

  const unlisten = getCurrentWindow().listen<MenuAction>("menu-action", (e) =>
    dispatch(e.payload),
  );

  return () => {
    unsubProfiles();
    void unlisten.then((f) => f());
  };
}
