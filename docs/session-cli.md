# `thel session`

`thel session` lets a program running in a thel terminal open sessions and
terminals, list them, type into them, close them and edit their notes. It is
meant for coding agents and scripts: an agent can start a dev server in its
own session, or a test watcher beside itself, and you see it in the sidebar
like any other session.

```
thel session new [-n NAME] [-c DIR] [-- CMD [ARG...]]
thel session terminal [-t SESSION] [-c DIR] [-- CMD [ARG...]]
thel session list [-a] [--json]
thel session send-keys -t TERMINAL [-l] KEY...
thel session note [-t SESSION] [-w | -a [TEXT...]]
thel session close -t TERMINAL
thel session close-session [-t SESSION]
```

It is off until you turn on **Let programs in terminals use `thel session`**,
on thel's initial screen or in **Settings > Sessions**. While it is off, every request fails with a message that
says where to turn it on, and a sandboxed caller's requests fail without
asking you.

| Command | Does |
|---|---|
| `new` | Opens a session with one terminal running CMD (default: `$SHELL`) in DIR (default: the current directory). The name defaults to DIR's last component, or `~` for your home folder. Prints the terminal's id. |
| `terminal` | Opens a terminal in SESSION, given as an id or a unique name. Without `-t`, the caller's own session. Prints the terminal's id. |
| `list` | Lists sessions and their terminals: `running`, `exited`, or `starting` (no window has shown it yet). `-a` shows every session to a sandboxed caller, which otherwise sees only its own session and those it started. `--json` for scripts. |
| `send-keys` | Types into a terminal. Each KEY is text or a key name: `Enter`, `Tab`, `Escape`, `BSpace`, `Space`, `Up`, `Down`, `Left`, `Right`, `Home`, `End`, `C-<letter>`, `M-<char>`. |
| `close` | Closes a terminal, as its tab's close button does. Always asks you first. |
| `close-session` | Closes SESSION (an id or a unique name; without `-t`, the caller's own session) with all its terminals and its notes, as the sidebar's Close session does. Always asks you first, and needs a thel window open. |
| `note` | Prints the notes of SESSION (an id or a unique name; without `-t`, the caller's own session). `-w` replaces them with stdin, and an empty stdin clears them. `-a` adds TEXT, or stdin when there is no TEXT, as new lines at the end. |

`send-keys` drops control characters from text, so an argument can't carry its
own escape sequences. `-l` sends every KEY as it is and turns key names off.

New terminals open in the background: the window adds them without switching
away from what you are looking at.

A note change shows up at once in an open notes panel. If you were typing in
that panel in the same moment, `-w` replaces what you typed, and `-a` adds
its lines after it.

```sh
thel session note -a "- [ ] fix the flaky login test"
thel session note -t api > api-notes.md
thel session note -t api -w < api-notes.md
```

## How it works

The CLI sends the request to the session daemon over its socket, the same way
`thel notify` does. The daemon starts the terminal itself, so it works while no
thel window is open; the next window to open shows it. Sessions belong to the
windows, so each window reports its sessions to the daemon, and the daemon asks
the right window to show a terminal it started. A window you close takes its
sessions out of reach, except the last one, whose sessions the next launch
reopens. The daemon also edits note files itself, in the folder a thel window
told it about, and tells the windows what changed. It and the windows lock
that folder around each edit, so neither saves over a change the other just
made.

Run one copy of the thel app at a time. A second copy reports its windows to
the same daemon under the same names, so `thel session` may list or open
sessions in the wrong one.

## Who may use it

The daemon socket is private to your user (a `0700` directory, a `0600` socket,
and a check of the caller's uid). On top of that, `thel session`:

- **Is off until you turn it on.** The window tells the daemon your setting,
  and the daemon refuses every request while it is off. A daemon starts with
  it off, until a window tells it otherwise.
- **Works only from inside a thel terminal.** The daemon gets the caller's pid
  from the socket and walks its parents up to one of its terminals. On Linux it
  also accepts a process in a terminal's cgroup scope, which covers programs
  that detached from the shell, but not for a sandboxed caller: one that can
  write to cgroupfs could move itself into another terminal's scope. Anything
  else is refused.
- **Asks you about sandboxed callers.** A process under Landlock, seccomp,
  bubblewrap or Flatpak runs with the kernel's `no_new_privs` flag, which the
  daemon reads from `/proc/<pid>/status`. A process it can't check, such as
  one that exited right after connecting, counts as sandboxed. What thel
  starts runs outside that sandbox, so a sandboxed caller's request waits up
  to two minutes for you to allow it in the thel window that shows its
  terminal, or in another one if you close that window. Stopping the caller (Ctrl-C) withdraws the question. You can
  allow everything from that program, named in the prompt, until it exits;
  a program the daemon can't name can only be allowed once.
  That covers whatever it runs too, such as build scripts and tests; another
  sandboxed program in the same terminal asks again. A terminal started
  this way comes back as a plain shell when thel restores it, so a yes runs
  the command once. A sandboxed caller's list shows its own session and those
  it started without asking; `list -a`, for the rest, asks. Reading notes
  asks too, since they can hold anything you wrote.
- **Asks you before closing anything.** `close` and `close-session` wait for
  your yes whoever asks, sandboxed or not, even a program you allowed
  everything. A yes holds for that one close. Without a window open, a
  terminal no window shows is ended by the daemon, and a session can't be
  closed.
- **Keeps the prompt honest.** A terminal gets one question at a time; a
  second request fails while the first waits. After you deny one, that
  terminal's requests fail without asking for 30 seconds, twice as long
  after each further no, up to 30 minutes. A request withdrawn while you
  look at it, or left unanswered, counts as a no. A request too long to show
  in full (over 4 KiB as the prompt words it) fails without asking. For a
  second after the prompt opens, and after the thel window comes back to the
  front, Allow and Deny are disabled and nothing else answers it either: not
  Escape, not a click outside it, not the close button. Keys typed then do
  nothing and keep it disabled until a second passes without one. The box that
  allows everything takes a click, never a key. So does Allow, except for
  Ctrl+Shift+Enter (Cmd+Enter on macOS) pressed on the prompt once that second
  is over, which a program writing to a terminal can't press. Allow also waits
  until you have scrolled to the end of a long request. Under X11, a sandbox
  that can connect to the X server can click Allow for you; under Wayland it
  can't. What runs and where
  comes first in the prompt, then the session it acts on by name. Names the
  program chose show cut short, with anything outside plain ASCII escaped.
  The folder shows with its links resolved.

A sandboxed process also can't use the daemon's other commands to open, type
into, resize or close terminals. It can still post notifications and read the
directory of its own terminal, but not of others.

What you allow, and what thel runs itself, can still run code a sandboxed
program wrote into a folder it can write:

- A command you allow reads that folder's files, such as a `Makefile` or
  `package.json`.
- The window's git, and its Fetch and new worktree buttons, run commands
  the repo's config names, such as hooks and filters.

So a sandbox that can write a repo's `.git` can get out through thel.

The check sees only what sets `no_new_privs`. AppArmor or snap confinement, a
Docker or Podman container started without `no-new-privileges`, and plain
namespaces don't, so a program in one of those reads as unconfined. So does
every caller when the daemon itself runs with the flag, for example when thel
was started from inside a sandbox; the daemon logs a warning then.

### macOS

thel on macOS is not a sandbox for the programs in its terminals. macOS has no
`no_new_privs`, and thel does not detect Seatbelt (`sandbox-exec`) or App
Sandbox confinement, so nothing reads as sandboxed there. With the setting on,
any program in a thel terminal, sandboxed or not, can open, list and type into
terminals and read and edit notes without asking you, with the same authority
as your user.

With the setting off, the CLI stops working, but a program can still talk to
the daemon's socket itself the way the window does. The daemon can't tell the
window apart from such a program: the macOS app is not signed, so the daemon
has no signature to check the caller against.

Running an agent in a thel terminal on macOS gives it your authority. If you
confine an agent with a sandbox profile, don't let it connect to the daemon's
socket, `$TMPDIR/thel/daemon.sock`.
