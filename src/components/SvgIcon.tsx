import { cn } from "@/lib/utils";

/**
 * Render a user-provided SVG (a session icon). Drawn via <img> with a data URI:
 * the webview never runs scripts or loads external refs from an <img>-loaded
 * SVG, so pasted/loaded markup can't execute code, no sanitizing needed.
 *
 * <img>-mode SVG doesn't resolve `currentColor`, so when a tint is given we bake
 * it in (monochrome icons like Lucide's use currentColor; already-colored icons
 * have no currentColor and keep their own palette).
 */
export function SvgIcon({
  svg,
  color,
  className,
}: {
  svg: string;
  color?: string;
  className?: string;
}) {
  const tinted = color ? svg.replace(/currentColor/g, color) : svg;
  const src = `data:image/svg+xml,${encodeURIComponent(tinted)}`;
  return <img src={src} alt="" aria-hidden className={cn("inline-block", className)} />;
}
