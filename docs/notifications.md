# Notifications

thel raises a notification when a terminal you aren't looking at wants your
attention: it shows an attention dot on the session/tab, adds an entry to the
in-app notifications panel, and (when the window is unfocused) posts a desktop
notification. Which triggers are enabled is controlled in **Settings →
Notifications**.

## `thel notify`

The most reliable way to get notified is to have the program tell thel
explicitly. Run `thel notify` from inside a thel terminal:

```sh
thel notify "build finished"
```

It raises a notification for the terminal it runs in. Attribution is automatic:
thel is already reading that terminal's output, so it knows which one the
message came from. No id or configuration is needed.

Typical uses:

```sh
# Notify when a long build or test run completes.
make && thel notify "build ok" || thel notify "build failed"

# At the end of a script.
./deploy.sh; thel notify "deploy done"
```

With no message it uses a default:

```sh
thel notify
```

### How it works

`thel notify` writes a terminal escape sequence (OSC 9) to its controlling
terminal, which thel turns into a notification. Because of that:

- **It needs a controlling terminal.** It works from interactive shells,
  Makefiles, and `&&`/`;` chains. It does **not** work from a process detached
  from the terminal, such as an agent's completion hook that runs without a TTY.
  For those, have the tool emit the escape itself (see below).
- **A thel window must be attached.** If thel is fully closed, the notification
  has nowhere to go.
- **A focused terminal isn't interrupted.** If you're already looking at the
  terminal (its tab is visible and the window is focused), no notification is
  raised, by design.

The message is stripped of control characters, so it can't inject further
escape sequences into the terminal.

## Escape sequences and the bell

`thel notify` is a convenience wrapper; thel also reacts to notification signals
emitted directly by programs, so anything already using these works too:

- **Terminal bell** (`\a`, `BEL`). A program ringing the bell raises a
  notification once the terminal falls quiet (resident agents ring it
  mid-action, so thel waits for silence).
- **OSC 9** — `ESC ] 9 ; <message> BEL` (what iTerm2 and Claude Code's iTerm2
  channel emit). Carries a message.
- **OSC 777** — `ESC ] 777 ; notify ; <title> ; <body> BEL` (rxvt-style).
- **OSC 99** — `ESC ] 99 ; <metadata> ; <body> BEL` (kitty-style, body only).

Any program that emits one of these gets picked up automatically. For example, a
tool that can run a shell command on completion can do:

```sh
printf '\033]9;task done\007'
```

## Environment

Inside a thel terminal, these are set:

- `THEL=1` — present so scripts can detect they're running in thel.
- `THEL_TERMINAL_ID` — the terminal's id.

## Detecting when an agent is done

Some agents (e.g. Claude Code in a plain terminal) don't emit any signal on
turn completion. As a best-effort fallback, thel watches the terminal's on-screen
activity: while an agent works it animates (a spinner, an elapsed timer), and
when its turn ends the screen goes still. thel notifies on that transition. It is
heuristic and can be turned off under **Settings → Notifications → "An agent
finishes and waits for input"** if it fires at the wrong time. The reliable
alternative is to have the agent run `thel notify` (or emit an OSC 9) when it
finishes.
