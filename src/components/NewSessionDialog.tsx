import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Folder, GitBranch, Check, ChevronRight } from "lucide-react";
import { cn, inputClass } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { homeDir, dirExists } from "@/lib/pty";
import { listWorktrees, gitInfo, branches, createWorktree, type Worktree } from "@/lib/git";
import { createSessionInDir, basename, sessionNameForDir } from "@/lib/launch";
import { abbreviatePath, expandPath } from "@/lib/paths";
import { useUI } from "@/store/ui";
import { useSessions } from "@/store/sessions";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import { ActionTooltip } from "./ActionTooltip";
import { PathInput } from "./PathInput";
import { BranchInput } from "./BranchInput";

export function NewSessionDialog() {
  const open_ = useUI((s) => s.newSessionOpen);
  const setOpen = useUI((s) => s.setNewSessionOpen);
  const focusTerminal = useUI((s) => s.focusTerminal);

  const [pathInput, setPathInput] = useState("");
  const [cwd, setCwd] = useState<string | null>(null);
  const [repoRoot, setRepoRoot] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [branchList, setBranchList] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [tab, setTab] = useState<"use" | "create">("use");
  const [showOpts, setShowOpts] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [base, setBase] = useState("");
  const [wtPath, setWtPath] = useState("");
  const [wtPathEdited, setWtPathEdited] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const typeTimer = useRef<number>();
  // Guards against out-of-order resolution when the user keeps typing.
  const loadReq = useRef(0);

  // Anchor to a directory: select it and load its git state (if any).
  const loadDir = async (dir: string) => {
    const req = ++loadReq.current;
    setTab("use");
    setNewBranch("");
    setBase("");
    setWtPathEdited(false);
    setError(null);
    const reset = () => {
      setCwd(null);
      setSelected(null);
      setRepoRoot(null);
      setWorktrees([]);
      setBranchList([]);
    };
    if (!dir) {
      setNotFound(false);
      reset();
      return;
    }
    // Validate the folder exists before anchoring to it.
    const exists = await dirExists(dir).catch(() => false);
    if (req !== loadReq.current) return; // a newer request superseded this one
    if (!exists) {
      setNotFound(true);
      reset();
      return;
    }
    setNotFound(false);
    setCwd(dir);
    setSelected(dir);
    const info = await gitInfo(dir).catch(() => null);
    if (req !== loadReq.current) return;
    if (info) {
      setRepoRoot(info.repo_root);
      const [wts, b] = await Promise.all([
        listWorktrees(info.repo_root).catch(() => []),
        branches(info.repo_root).catch(() => ({ branches: [], default_branch: null })),
      ]);
      setWorktrees(wts);
      setBranchList(b.branches);
      // Default the base to the repo's main branch (falls back to HEAD on use).
      setBase(b.default_branch ?? "");
    } else {
      setRepoRoot(null);
      setWorktrees([]);
      setBranchList([]);
    }
  };

  // On open, reset and default the suggested directory to the path of the
  // session we were just in, falling back to $HOME.
  useEffect(() => {
    if (!open_) return;
    setPathInput("");
    setCwd(null);
    setRepoRoot(null);
    setWorktrees([]);
    setBranchList([]);
    setSelected(null);
    setTab("use");
    setShowOpts(false);
    setNewBranch("");
    setBase("");
    setWtPath("");
    setWtPathEdited(false);
    setError(null);
    setNotFound(false);
    let cancelled = false;
    void (async () => {
      const { sessions, activeSessionId } = useSessions.getState();
      const prev = sessions.find((s) => s.id === activeSessionId)?.cwd;
      const dir = prev ?? (await homeDir().catch(() => null));
      if (cancelled || !dir) return;
      setPathInput(abbreviatePath(dir));
      await loadDir(dir);
    })();
    return () => {
      cancelled = true;
      // Cancel a pending path debounce so a stale loadDir can't clobber the
      // freshly-loaded directory after the dialog closes and reopens.
      window.clearTimeout(typeTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open_]);

  // Typing a path is the primary way to choose a folder; resolve it (debounced).
  const onType = (v: string) => {
    setPathInput(v);
    window.clearTimeout(typeTimer.current);
    typeTimer.current = window.setTimeout(() => void loadDir(expandPath(v.trim())), 400);
  };

  const pickFolder = async () => {
    const home = (await homeDir()) ?? undefined;
    const dir = await open({ directory: true, defaultPath: home });
    if (!dir || Array.isArray(dir)) return;
    setPathInput(abbreviatePath(dir));
    await loadDir(dir);
  };

  // Default worktree location: a sibling of the project dir, "PROJECT.branch".
  const derivedPath = repoRoot
    ? `${repoRoot}.${newBranch.trim().replace(/\//g, "-") || "<branch>"}`
    : "";
  const shownPath = wtPathEdited ? wtPath : abbreviatePath(derivedPath);

  // Creating a session also creates the worktree when the Create Worktree tab
  // is active. If the user filled the create fields but switched back to Use
  // Worktree, we honor the selection instead and create nothing.
  const creatingWorktree = !!repoRoot && tab === "create";

  // Catch the common conflicts before calling git, with clear feedback. The
  // backend error still covers anything we don't pre-check (e.g. the path
  // exists as a non-worktree directory, or an invalid base).
  const trimmedBranch = newBranch.trim();
  const targetWtPath = wtPathEdited ? expandPath(wtPath.trim()) : derivedPath.trim();
  const existingWtForBranch = worktrees.find((w) => w.branch === trimmedBranch);
  const branchTaken = !!trimmedBranch && branchList.includes(trimmedBranch);
  const pathTaken = worktrees.some((w) => w.path === targetWtPath);
  const blockReason =
    branchTaken && existingWtForBranch
      ? `Branch "${trimmedBranch}" already has a worktree — pick it under Use Worktree.`
      : branchTaken
        ? `A branch named "${trimmedBranch}" already exists.`
        : pathTaken
          ? "A worktree already exists at this location."
          : null;

  const canConfirm = creatingWorktree
    ? !!trimmedBranch && !creating && !blockReason
    : !!selected;

  const confirm = async () => {
    if (creatingWorktree) {
      if (!trimmedBranch || creating || blockReason) return;
      setCreating(true);
      setError(null);
      try {
        const created = await createWorktree(
          repoRoot!,
          targetWtPath,
          trimmedBranch,
          base.trim() || "HEAD",
        );
        await createSessionInDir({
          cwd: created,
          repoRoot: repoRoot!,
          name: basename(created),
        });
        setOpen(false);
      } catch (e) {
        setError(String(e));
      } finally {
        setCreating(false);
      }
      return;
    }
    if (!selected) return;
    await createSessionInDir({
      cwd: selected,
      repoRoot: repoRoot ?? undefined,
      name: sessionNameForDir(selected),
    });
    setOpen(false);
  };

  const folderIsWorktree = worktrees.some((w) => w.path === cwd);

  // Enter in any text field creates the session (the default action), when
  // enabled. Scoped to inputs so it doesn't fire the worktree-list buttons or
  // the branch autocomplete.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      e.target instanceof HTMLInputElement &&
      canConfirm &&
      !creating
    ) {
      e.preventDefault();
      void confirm();
    }
  };

  return (
    <Dialog open={open_} onOpenChange={setOpen}>
      <DialogContent
        onKeyDown={onKeyDown}
        // Don't hand focus back to the trigger button on close; focus the active
        // terminal instead (the one just created), so you can type right away.
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          focusTerminal();
        }}
      >
        <DialogHeader>
          <DialogTitle>New session</DialogTitle>
          <DialogDescription>
            Anchor a session to a folder or git worktree.
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-4">
          <div className="flex items-center gap-2">
            <PathInput value={pathInput} onChange={onType} />
            <ActionTooltip label="Browse for folder">
              <Button
                variant="ghost"
                size="icon"
                onClick={pickFolder}
                aria-label="Browse for folder"
              >
                <Folder className="size-4" />
              </Button>
            </ActionTooltip>
          </div>

          {cwd && repoRoot && (
            <div className="space-y-3 rounded-md border border-border p-3">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <GitBranch className="size-4" /> Git repository
              </div>

              <Tabs
                value={tab}
                onValueChange={(v) => setTab(v as "use" | "create")}
                className="space-y-3"
              >
                <TabsList className="w-full">
                  <TabsTrigger value="use" className="flex-1">
                    Use Worktree
                  </TabsTrigger>
                  <TabsTrigger value="create" className="flex-1">
                    Create Worktree
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="use">
                  <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border p-1">
                    {!folderIsWorktree && cwd && (
                      <SelectRow
                        selected={selected === cwd}
                        onSelect={() => setSelected(cwd)}
                        primary="Selected folder"
                        secondary={abbreviatePath(cwd)}
                      />
                    )}
                    {worktrees.map((w) => (
                      <SelectRow
                        key={w.path}
                        selected={selected === w.path}
                        onSelect={() => setSelected(w.path)}
                        primary={w.branch ?? "(detached)"}
                        secondary={abbreviatePath(w.path)}
                        badge={w.is_main ? "main" : undefined}
                      />
                    ))}
                  </div>
                </TabsContent>

                <TabsContent value="create" className="space-y-3">
                  <Field label="Branch">
                    <input
                      autoFocus
                      placeholder="my-new-branch"
                      value={newBranch}
                      onChange={(e) => setNewBranch(e.target.value)}
                      spellCheck={false}
                      className={inputClass}
                    />
                  </Field>

                  <div>
                    <button
                      type="button"
                      onClick={() => setShowOpts((v) => !v)}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <ChevronRight
                        className={cn("size-3.5 transition-transform", showOpts && "rotate-90")}
                      />
                      Options
                    </button>
                    {showOpts && (
                      <div className="mt-2 space-y-3">
                        <Field label="Base">
                          <BranchInput
                            value={base}
                            onChange={setBase}
                            options={branchList}
                            placeholder="HEAD"
                          />
                        </Field>
                        <Field label="Location">
                          <input
                            value={shownPath}
                            onChange={(e) => {
                              setWtPath(e.target.value);
                              setWtPathEdited(true);
                            }}
                            spellCheck={false}
                            className={cn(inputClass, "font-mono text-xs")}
                          />
                        </Field>
                      </div>
                    )}
                  </div>

                  {(blockReason || error) && (
                    <p className="break-words text-xs text-destructive">
                      {blockReason || error}
                    </p>
                  )}
                </TabsContent>
              </Tabs>
            </div>
          )}

          {notFound && (
            <p className="text-sm text-destructive">
              Folder not found. Check the path or browse for it.
            </p>
          )}

          {cwd && !repoRoot && (
            <p className="text-sm text-muted-foreground">
              Not a git repository. The session will use this folder.
            </p>
          )}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button onClick={confirm} disabled={!canConfirm}>
            {creating ? "Creating…" : "Create session"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function SelectRow({
  selected,
  onSelect,
  primary,
  secondary,
  badge,
}: {
  selected: boolean;
  onSelect: () => void;
  primary: string;
  secondary: string;
  badge?: string;
}) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
    >
      <Check className={cn("size-4 shrink-0", selected ? "opacity-100" : "opacity-0")} />
      <span title={primary} className="min-w-0 truncate font-medium">
        {primary}
      </span>
      {badge && (
        <span className="shrink-0 rounded bg-muted px-1 text-xs text-muted-foreground">
          {badge}
        </span>
      )}
      <span
        title={secondary}
        className="min-w-0 flex-1 truncate text-right font-mono text-xs text-muted-foreground"
      >
        {secondary}
      </span>
    </button>
  );
}
