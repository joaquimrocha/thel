import { invoke } from "@tauri-apps/api/core";

export interface GitInfo {
  repo_root: string;
  branch: string;
  dirty: boolean;
}

export interface Worktree {
  path: string;
  branch: string | null;
  head: string;
  is_main: boolean;
  detached: boolean;
}

export const gitInfo = (cwd: string) => invoke<GitInfo | null>("git_info", { cwd });

export interface WorktreeInfo {
  is_linked: boolean;
  path: string;
  main: string;
}

export const worktreeInfo = (cwd: string) =>
  invoke<WorktreeInfo | null>("worktree_info", { cwd });

export const listWorktrees = (cwd: string) =>
  invoke<Worktree[]>("list_worktrees", { cwd });

export interface Branches {
  branches: string[];
  default_branch: string | null;
}

export const branches = (cwd: string) =>
  invoke<Branches>("branches", { cwd });

export const createWorktree = (
  repoRoot: string,
  path: string,
  branch: string,
  base: string,
) => invoke<string>("create_worktree", { repoRoot, path, branch, base });

export const removeWorktree = (repoRoot: string, path: string, force: boolean) =>
  invoke<void>("remove_worktree", { repoRoot, path, force });
