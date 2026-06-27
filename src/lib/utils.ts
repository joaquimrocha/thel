import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Shared styling for the plain text inputs used across dialogs.
export const inputClass =
  "w-full rounded-sm border border-input bg-transparent px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-ring";
