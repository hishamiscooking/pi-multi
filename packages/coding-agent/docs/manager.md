# Multi-Instance Manager (pim)

`pi manager` opens a control surface for running many pi agents at once — spawn, watch, attach, and manage instances from one board instead of one terminal tab per agent.

Requires tmux (macOS/Linux). Each instance is a full interactive pi process inside a detached tmux session on a private tmux server (socket `pim`, isolated config — your `~/.tmux.conf` is untouched). Instances keep running while the manager is closed and survive manager restarts.

## The board

```
pi manager
```

Instances are shown as live cards in a responsive grid: columns scale with terminal width, and card height scales with terminal height so at most two rows of cards fill the screen. Each card has a dot-matrix status indicator rendered on a braille pixel grid: a particle tracing a figure-eight while working (yellow while starting), a red X slashing in when the agent flagged itself blocked, a question mark drawing in (dot blinking) when it needs an answer, a pink checkmark for a finished response you haven't seen, a dotted blue baseline at rest, and a flat line when exited. Cards also show model, a context-usage bar, cumulative token/cost totals, the branch the agent is on, its workspace path, the current tool call while working, and a streaming preview of the latest output. Attaching or opening history marks a card seen. Unnamed instances get generated adjective-noun names (e.g. `lucid-heron`).

The board is scoped to the current project (the git repo root, or the cwd outside a repo). Worktree instances count toward the repo they were created from.

Keys:

| Key | Action |
|-----|--------|
| `n` | Spawn a new instance (name → task → model → workspace) |
| `enter` | Attach to the selected instance (`ctrl+q` inside detaches back) |
| `↑↓←→` / `j`/`k` | Move selection in the grid |
| `h` | Browse the selected instance's history (scrollable rendered scrollback; `↑↓` scroll, `u`/`d` page, `g`/`G` top/bottom, `esc` back) |
| `x` (twice) | Kill the selected instance (its worktree is kept) |
| `m` (twice) | Merge the selected instance's worktree branch into the main checkout's branch |
| `a` | Toggle between this project and all projects |
| `q` / `esc` | Quit the manager (instances keep running) |

## Workspaces and git worktrees

At spawn you choose where the agent works:

- **Current directory** — shares files with everything else running there.
- **New git worktree** — pim runs `git worktree add` with a branch named `pim/<name>` (you pick the name), checked out under `~/.pi/agent/pim/worktrees/`. Worktrees share the repo's object database but have their own files, index, and branch, so parallel agents never see each other's uncommitted changes.
- **An existing worktree** — the picker lists every linked worktree of the project so a new agent can join or take over one.

Merging back: `m` on the board or `pi manager merge <id|name>` merges the instance's branch into whatever branch the main checkout is on (refused while the worktree has uncommitted changes). Killing an instance never deletes its worktree or branch.

## CLI API

Everything is available headlessly, for scripts or an orchestrator agent:

```
pi manager status [--all] [--json]   # full state of instances (scoped to this project by default)
pi manager spawn --name a --task "..." [--model m] [--worktree [name]] [--worktree-path p] [--cwd d] [--json]
pi manager send <id|name> <text>     # submit a prompt to a running instance
pi manager peek <id|name>            # the instance's current terminal screen
pi manager log <id|name> [-n N]      # recent activity events (JSONL)
pi manager attach <id|name>          # attach this terminal
pi manager merge <id|name>           # merge the instance's worktree branch back
pi manager kill <id|name>            # kill (worktree kept)
pi manager spinners                  # browse candidate status animations live
```

## Attention states

Every instance has a `pim_set_state` tool the agent can call to flag its card and get your attention:

- **blocked** (red) — the agent cannot proceed without you (missing access, failing environment, destructive decision). The card's indicator becomes a red shade pulse, the note is shown on the card, and the header counts it in red.
- **question** (yellow) — the agent needs an answer or a choice. Same treatment in yellow.
- **clear** — removes the flag.

Flags also clear automatically when you send the agent a new message. Attention states appear in `pi manager status` (and `--json`) so external tooling can react to them. Tell an agent things like "flag the dashboard if you get blocked" — or bake it into the task prompt.

## How telemetry works

Every instance is spawned with `-e <pim-status-extension>` plus `PIM_STATUS_FILE` / `PIM_LOG_FILE` env vars. The extension mirrors agent lifecycle events into:

- `~/.pi/agent/pim/status/<id>.json` — current state, model, context usage, token/cost totals, activity, output tail. The manager watches this directory (fs.watch) so the board updates in near-realtime.
- `~/.pi/agent/pim/logs/<id>.jsonl` — an append-only event log (user prompts, tool calls, assistant messages) for `pi manager log` and programmatic inspection.

The instance registry lives at `~/.pi/agent/pim/instances.json`. Because the extension is loaded at spawn, telemetry changes only apply to newly spawned instances.
