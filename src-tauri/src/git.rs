use std::process::Command;

use serde::Serialize;

/// Run `git -C <cwd> <args>` and return trimmed stdout, or None on failure.
fn git(cwd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[derive(Serialize)]
pub struct GitInfo {
    repo_root: String,
    branch: String,
    dirty: bool,
}

/// Branch + dirty state for a directory, or None if it isn't inside a repo.
#[tauri::command]
pub fn git_info(cwd: String) -> Option<GitInfo> {
    let repo_root = git(&cwd, &["rev-parse", "--show-toplevel"])?;
    let branch =
        git(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_else(|| "HEAD".into());
    let dirty = git(&cwd, &["status", "--porcelain"])
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    Some(GitInfo {
        repo_root,
        branch,
        dirty,
    })
}

#[derive(Serialize)]
pub struct Worktree {
    path: String,
    branch: Option<String>,
    head: String,
    is_main: bool,
    detached: bool,
}

/// All worktrees of the repo containing `cwd` (the first entry is the main one).
#[tauri::command]
pub fn list_worktrees(cwd: String) -> Vec<Worktree> {
    let Some(out) = git(&cwd, &["worktree", "list", "--porcelain"]) else {
        return vec![];
    };
    let mut res = Vec::new();
    for (i, block) in out.split("\n\n").enumerate() {
        let mut path = None;
        let mut head = String::new();
        let mut branch = None;
        let mut detached = false;
        for line in block.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                path = Some(p.to_string());
            } else if let Some(h) = line.strip_prefix("HEAD ") {
                head = h.to_string();
            } else if let Some(b) = line.strip_prefix("branch ") {
                branch = Some(b.trim_start_matches("refs/heads/").to_string());
            } else if line == "detached" {
                detached = true;
            }
        }
        if let Some(path) = path {
            res.push(Worktree {
                path,
                branch,
                head,
                is_main: i == 0,
                detached,
            });
        }
    }
    res
}

#[derive(Serialize)]
pub struct WorktreeInfo {
    /// cwd sits in a linked worktree (not the repo's main checkout).
    is_linked: bool,
    /// Top-level of the worktree containing cwd (the one a removal targets).
    path: String,
    /// The repo's main worktree. `git worktree remove` must run from here: git
    /// refuses to remove the worktree you're currently inside.
    main: String,
}

/// Whether `cwd` is in a linked git worktree, plus the paths needed to remove
/// it. None when cwd isn't in a repo. ponytail: plain path compare; canonicalize
/// if symlinked checkouts ever mismatch.
#[tauri::command]
pub fn worktree_info(cwd: String) -> Option<WorktreeInfo> {
    let top = git(&cwd, &["rev-parse", "--show-toplevel"])?;
    let list = git(&cwd, &["worktree", "list", "--porcelain"])?;
    // The first "worktree <path>" line is always the main checkout.
    let main = list
        .lines()
        .find_map(|l| l.strip_prefix("worktree "))?
        .to_string();
    Some(WorktreeInfo {
        is_linked: top != main,
        path: top,
        main,
    })
}

#[derive(Serialize)]
pub struct Branches {
    /// Local branch names, most recently committed first.
    branches: Vec<String>,
    /// The repo's main/default branch, whatever it's named.
    default_branch: Option<String>,
}

#[tauri::command]
pub fn branches(cwd: String) -> Branches {
    let branches: Vec<String> = git(
        &cwd,
        &["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"],
    )
    .map(|s| s.lines().map(|l| l.to_string()).collect())
    .unwrap_or_default();
    let default_branch = detect_default_branch(&cwd, &branches);
    Branches {
        branches,
        default_branch,
    }
}

fn detect_default_branch(cwd: &str, branches: &[String]) -> Option<String> {
    // Prefer the remote's default (origin/HEAD -> e.g. "origin/main").
    if let Some(s) = git(cwd, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) {
        return Some(s.strip_prefix("origin/").unwrap_or(&s).to_string());
    }
    // Otherwise the first conventional name that exists locally.
    for cand in ["main", "master", "trunk", "develop"] {
        if branches.iter().any(|b| b == cand) {
            return Some(cand.to_string());
        }
    }
    // Last resort: the current branch (unless detached).
    git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).filter(|b| b != "HEAD")
}

/// Create a new worktree at `path` on a new `branch` started from `base`.
/// Returns the worktree path on success.
#[tauri::command]
pub fn create_worktree(
    repo_root: String,
    path: String,
    branch: String,
    base: String,
) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(&repo_root)
        // `--` so a path or base beginning with `-` can't be read as an option.
        .args(["worktree", "add", "-b", &branch, "--", &path, &base])
        .output()
        .map_err(|e| e.to_string())?;
    // `git worktree add` runs the new worktree's post-checkout hook, which exits
    // non-zero when the repo is configured for Git LFS but git-lfs isn't on PATH,
    // even though the worktree was created and checked out fine. Accept a worktree
    // that actually got created (its `.git` link exists) regardless of the hook's
    // exit code; a genuine failure (e.g. a duplicate branch) leaves nothing behind.
    if out.status.success() || std::path::Path::new(&path).join(".git").exists() {
        return Ok(path);
    }
    Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
}

/// Remove the worktree at `path`. `force` deletes it even with uncommitted or
/// untracked changes (git refuses otherwise); the caller warns the user first.
#[tauri::command]
pub fn remove_worktree(repo_root: String, path: String, force: bool) -> Result<(), String> {
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    // `--` so a path beginning with `-` can't be read as an option.
    args.push("--");
    args.push(path.as_str());
    let out = Command::new("git")
        .arg("-C")
        .arg(&repo_root)
        .args(&args)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(());
    }
    Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};

    fn git_available() -> bool {
        Command::new("git").arg("--version").output().is_ok()
    }

    fn run(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?} failed");
    }

    // A fresh repo with one commit on `main`. Unique per call so tests can run
    // in parallel without clobbering each other.
    fn setup_repo() -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("thel_git_{}_{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        run(&dir, &["init", "-b", "main"]);
        run(&dir, &["config", "user.email", "t@example.com"]);
        run(&dir, &["config", "user.name", "Test"]);
        std::fs::write(dir.join("a.txt"), "hi").unwrap();
        run(&dir, &["add", "."]);
        run(&dir, &["commit", "-m", "init"]);
        dir
    }

    #[test]
    fn git_info_reports_branch_and_dirty() {
        if !git_available() {
            return;
        }
        let dir = setup_repo();
        let s = dir.to_string_lossy().to_string();
        let info = git_info(s.clone()).expect("inside a repo");
        assert_eq!(info.branch, "main");
        assert!(!info.dirty);

        std::fs::write(dir.join("a.txt"), "changed").unwrap();
        assert!(git_info(s).unwrap().dirty);

        // A non-repo path returns None.
        assert!(git_info(std::env::temp_dir().to_string_lossy().to_string()).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_worktrees_includes_added_worktree() {
        if !git_available() {
            return;
        }
        let dir = setup_repo();
        let wt = dir.with_extension("wt");
        let _ = std::fs::remove_dir_all(&wt);
        run(&dir, &["worktree", "add", "-b", "feature", wt.to_str().unwrap()]);

        let list = list_worktrees(dir.to_string_lossy().to_string());
        assert_eq!(list.len(), 2);
        assert!(list[0].is_main);
        assert_eq!(list[0].branch.as_deref(), Some("main"));

        let feat = list
            .iter()
            .find(|w| w.branch.as_deref() == Some("feature"))
            .expect("feature worktree");
        assert!(!feat.is_main && !feat.detached);

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&wt);
    }

    #[test]
    fn branches_lists_and_detects_default() {
        if !git_available() {
            return;
        }
        let dir = setup_repo();
        run(&dir, &["branch", "dev"]);
        let b = branches(dir.to_string_lossy().to_string());
        assert!(b.branches.contains(&"main".to_string()));
        assert!(b.branches.contains(&"dev".to_string()));
        // No origin remote, so it falls back to the conventional "main".
        assert_eq!(b.default_branch.as_deref(), Some("main"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_worktree_succeeds_then_rejects_duplicate_branch() {
        if !git_available() {
            return;
        }
        let dir = setup_repo();
        let root = dir.to_string_lossy().to_string();
        let wt = dir.with_extension("cw");
        let _ = std::fs::remove_dir_all(&wt);
        let path = wt.to_string_lossy().to_string();

        let ok = create_worktree(root.clone(), path.clone(), "feat".into(), "main".into());
        assert_eq!(ok.unwrap(), path);

        // Reusing the branch name must fail (and report git's error).
        let wt2 = dir.with_extension("cw2");
        let err = create_worktree(
            root,
            wt2.to_string_lossy().to_string(),
            "feat".into(),
            "main".into(),
        );
        assert!(err.is_err());

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&wt);
    }

    #[test]
    fn worktree_info_distinguishes_main_and_linked() {
        if !git_available() {
            return;
        }
        let dir = setup_repo();
        let root = dir.to_string_lossy().to_string();
        let wt = dir.with_extension("wi");
        let _ = std::fs::remove_dir_all(&wt);
        run(&dir, &["worktree", "add", "-b", "wifeat", wt.to_str().unwrap()]);

        // From the main checkout: not linked.
        let main = worktree_info(root.clone()).expect("in a repo");
        assert!(!main.is_linked);
        assert_eq!(main.path, main.main);

        // From the linked worktree: linked, and `main` points back to the repo.
        let linked = worktree_info(wt.to_string_lossy().to_string()).unwrap();
        assert!(linked.is_linked);
        assert_eq!(linked.path, wt.to_string_lossy());
        assert_eq!(linked.main, main.path);

        // A non-repo path yields nothing.
        assert!(worktree_info(std::env::temp_dir().to_string_lossy().to_string()).is_none());

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&wt);
    }

    #[test]
    fn remove_worktree_clean_ok_dirty_needs_force() {
        if !git_available() {
            return;
        }
        let dir = setup_repo();
        let root = dir.to_string_lossy().to_string();

        // Clean worktree removes without force.
        let wt = dir.with_extension("rm1");
        let _ = std::fs::remove_dir_all(&wt);
        let p = wt.to_string_lossy().to_string();
        create_worktree(root.clone(), p.clone(), "f1".into(), "main".into()).unwrap();
        assert!(remove_worktree(root.clone(), p.clone(), false).is_ok());
        assert!(!wt.exists());

        // Untracked files block removal unless forced.
        let wt2 = dir.with_extension("rm2");
        let _ = std::fs::remove_dir_all(&wt2);
        let p2 = wt2.to_string_lossy().to_string();
        create_worktree(root.clone(), p2.clone(), "f2".into(), "main".into()).unwrap();
        std::fs::write(wt2.join("untracked.txt"), "x").unwrap();
        assert!(remove_worktree(root.clone(), p2.clone(), false).is_err());
        assert!(remove_worktree(root, p2, true).is_ok());
        assert!(!wt2.exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    // A failing post-checkout hook (e.g. Git LFS configured but git-lfs missing)
    // makes `git worktree add` exit non-zero, but the worktree is still created.
    #[test]
    fn create_worktree_survives_a_failing_post_checkout_hook() {
        if !git_available() {
            return;
        }
        let dir = setup_repo();
        let hook = dir.join(".git/hooks/post-checkout");
        std::fs::write(&hook, "#!/bin/sh\necho 'git-lfs missing' >&2\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755))
                .unwrap();
        }

        let wt = dir.with_extension("hookwt");
        let _ = std::fs::remove_dir_all(&wt);
        let path = wt.to_string_lossy().to_string();
        let res = create_worktree(
            dir.to_string_lossy().to_string(),
            path.clone(),
            "hooked".into(),
            "main".into(),
        );
        assert_eq!(res.unwrap(), path);
        assert!(Path::new(&path).join(".git").exists());

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&wt);
    }
}
