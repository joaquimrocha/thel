import { getCurrentWindow } from "@tauri-apps/api/window";
import { cn } from "@/lib/utils";

// Mirrors @tauri-apps/api/window's ResizeDirection, which isn't exported.
type ResizeDirection =
  | "North"
  | "South"
  | "East"
  | "West"
  | "NorthEast"
  | "NorthWest"
  | "SouthEast"
  | "SouthWest";

// Invisible drag grips along the window edges and corners. A custom title bar
// runs with OS decorations off, which on Linux/WebKitGTK removes the window
// manager's resize borders, so we drive the resize ourselves. Corners are
// listed last so they sit above the edge strips where they overlap.
const GRIPS: { dir: ResizeDirection; className: string }[] = [
  { dir: "North", className: "top-0 inset-x-0 h-1.5 cursor-ns-resize" },
  { dir: "South", className: "bottom-0 inset-x-0 h-1.5 cursor-ns-resize" },
  { dir: "West", className: "inset-y-0 left-0 w-1.5 cursor-ew-resize" },
  { dir: "East", className: "inset-y-0 right-0 w-1.5 cursor-ew-resize" },
  { dir: "NorthWest", className: "top-0 left-0 size-3 cursor-nwse-resize" },
  { dir: "NorthEast", className: "top-0 right-0 size-3 cursor-nesw-resize" },
  { dir: "SouthWest", className: "bottom-0 left-0 size-3 cursor-nesw-resize" },
  { dir: "SouthEast", className: "bottom-0 right-0 size-3 cursor-nwse-resize" },
];

export function ResizeHandles() {
  return (
    <>
      {GRIPS.map((g) => (
        <div
          key={g.dir}
          data-window-resize
          className={cn("fixed z-50", g.className)}
          onMouseDown={(e) => {
            // Only a primary-button drag should resize.
            if (e.button !== 0) return;
            e.preventDefault();
            void getCurrentWindow().startResizeDragging(g.dir);
          }}
        />
      ))}
    </>
  );
}
