# Operator & Minions: Orchestration Plan (Proposal)

Status: **design proposal — not yet built.** This document describes how pim grows from a manual control surface into an orchestrated system where one large "operator" agent per project creates, directs, and reviews smaller "minion" agents — all observable on the pim board.

## Vision

- **One operator per project.** A large, capable model (Claude Fable 5, GPT-5.5-Pro class) running as a long-lived pim instance. Its job is not to write most of the code — it decomposes work, spawns minions, reviews their output, runs multi-agent loops, and reports progress to the user.
- **Minions are ordinary pim instances.** Any agent kind (pi or Claude Code), any model, each in an isolated git worktree. They are *not* black boxes: every minion has a live card, full history, an activity log, and attachable terminal — exactly like today.
- **The kanban board is the coordination substrate** (Hermes-style). Work items, assignments, review loops, questions, and merge proposals all live on a persistent, observable board. The operator writes its own loops against the board ("minionA implement → minionB critique → minionC review the critique → minionA revise").
- **The user stays sovereign.** You watch everything in the manager, can attach to any instance (operator included), answer questions, and gate merges.

## Why a board, not just subagents

Classic subagents are ephemeral and invisible: a parent prompt spawns a child, the child returns text, the transcript disappears into the parent's context. That fails every requirement here (observability, resumability, parallel review loops, user intervention). A board gives us:

- **Durable state outside any context window.** The operator can be restarted (or compacted) and re-derive the world from the board.
- **Observability for free.** Columns and task threads are the audit trail; the manager can render them.
- **A shared protocol.** Any agent that can run a CLI can participate — which is exactly how we make pi and Claude Code minions equal citizens.

## Architecture overview

```
                       ┌──────────────────────────────┐
        reports        │   Board (per project)        │
   user ◄──────────┐   │   tasks · threads · flows    │
    │              │   │   ~/.pi/agent/pim/board/     │
    │ attach/answer│   └──────▲──────────────▲────────┘
    ▼              │          │ board CLI /  │ board CLI /
 ┌─────────┐  directs   ┌─────┴────┐  tools  ┌┴─────────┐
 │ manager │◄───────────│ operator │────────►│ minions  │
 │  (pim)  │  observes  │ (1/proj) │  spawn/ │ (N, wt-  │
 └─────────┘            └──────────┘  send   │ isolated)│
                                             └──────────┘
```

Everything below decomposes into five components: the board store, the board CLI (universal protocol), the minion protocol, the operator, and the flow runner.

## 1. The board

Per-project store under `~/.pi/agent/pim/board/<project-slug>/`:

- `board.json` — current state (atomic rename writes, like the instance registry).
- `events.jsonl` — append-only audit log of every mutation (who, what, when).

Data model:

```ts
interface Task {
  id: string;                 // t-3f9a
  title: string;
  spec: string;               // markdown: requirements, acceptance criteria
  column: "backlog" | "ready" | "in_progress" | "review" | "blocked" | "done" | "cancelled";
  assignee?: string;          // instance id
  deps: string[];             // task ids that must be done first
  flow?: { flowId: string; stepId: string; iteration: number };
  artifacts: {
    worktreePath?: string;
    branch?: string;
    mergeProposal?: {         // set by task_submit
      branch: string;
      baseBranch: string;
      summary: string;        // minion's description of the change
      diffStat: string;       // computed by pim, not trusted from the minion
      commits: string[];
    };
  };
  budget?: { maxCostUsd?: number; maxTokens?: number };
  thread: Message[];
  createdAt: string;
  updatedAt: string;
}

interface Message {
  id: string;
  ts: string;
  from: { instance: string; role: "user" | "operator" | "minion" | "system" };
  type: "instruction" | "progress" | "result" | "critique" | "review"
      | "question" | "answer" | "system";
  body: string;               // markdown
  refs?: string[];            // task ids / message ids / commit shas
}
```

## 2. Inter-agent communication standard

The rules that keep this debuggable:

1. **All agent-to-agent communication goes through task threads.** No minion ever prompts another minion directly. A critique from minionB to minionA is a `critique` message on the task; the delivery nudge is separate (below).
2. **Messages are typed envelopes with markdown bodies.** The `type` field is the contract (a `result` closes a step; a `question` blocks it); the body stays human-readable in the manager.
3. **Delivery is a nudge, not the payload.** When a message needs someone's attention, the writer sends a short `pim send` to that instance: `"[pim board] task t-3f9a: new critique — run: pi manager board show t-3f9a"`. The recipient reads the board for the actual content. This keeps prompts small, makes redelivery trivial, and means a restarted agent loses nothing.
4. **The board is the only shared memory.** Minions must not rely on having seen previous prompts; every instruction embeds the task id and the expectation to read/write the board.
5. **Facts are computed, not claimed.** Diff stats, commit lists, test results attached to merge proposals are produced by pim running git/commands — a minion's summary is opinion, the artifacts are ground truth.

## 3. The board CLI — the universal adapter

`pi manager board …` (alias `pim board …`), usable by humans, operators, and minions of *any* agent kind (this is how Claude Code minions participate without pi's extension API):

```
pim board show [task-id] [--json]        # board or single task with thread
pim board create --title ... --spec ...  # operator/user
pim board move <task> <column>
pim board comment <task> --type critique --body "..."
pim board assign <task> <instance>
pim board submit <task> --summary "..."  # minion: commit + propose merge (computes diffStat)
pim board question <task> --body "..."   # minion: blocks task + raises attention flag
```

pi minions additionally get ergonomic **tools** (`task_progress`, `task_question`, `task_submit`) via an extended telemetry extension — same operations, no shell round-trip. Claude minions call the CLI through their Bash tool; their `CLAUDE.md`-style task instruction tells them how.

## 4. Minion protocol

A minion's lifecycle, all visible on its card and the board:

1. **Spawned by the operator** with `--worktree`, a task-scoped instruction (task id, spec, acceptance criteria, "communicate via the board"), and a budget.
2. **Works** — normal agent loop; card streams activity/preview as today. Progress notes via `task_progress` land on the thread.
3. **Raises questions** — `task_question` moves the task to `blocked`, posts the question, and raises the existing attention flag (yellow `?` on the card, "needs you" in the header). Questions can be answered by the operator *or* the user; the answer message plus a nudge unblocks it.
4. **Submits** — `task_submit` requires a clean worktree (committed work), records a merge proposal artifact (branch, computed diff stat, commits, summary), and moves the task to `review`. **Minions never merge.**
5. **Gets reviewed** — operator (or a reviewer minion, per flow) posts `critique`/`review` messages; the task either returns to `in_progress` (revise) or is accepted.
6. **Merged & retired** — the operator merges the branch (existing `pim merge` machinery: refuses dirty trees, no force), moves the task to `done`, and kills or reassigns the minion.

## 5. The operator

A pim instance with `role: operator` (new registry field), distinct card styling (badge + color), spawned per project with a large model. It gets an **operator extension** whose tools wrap existing pim/board capabilities:

- Board: `board_read`, `task_create`, `task_move`, `task_comment`, `task_assign`
- Fleet: `minion_spawn` (kind/model/worktree/budget), `minion_send`, `minion_status`, `minion_log`, `minion_kill`
- Review: `merge_inspect` (full diff of a proposal), `merge_apply`, `merge_reject`
- Flows: `flow_define`, `flow_start`, `flow_cancel` (section 6)
- User channel: `report` — posts to a per-project report thread and raises the operator's done-notifier so progress summaries surface in the manager without the user asking.

The operator's system prompt encodes the management doctrine: decompose into reviewable tasks, one concern per minion, always through the board, respect budgets, escalate to the user (attention flag) rather than guess on product decisions.

**Wakeups without a daemon:** every board mutation made through the CLI/tools delivers the nudge to whoever must act next (operator for `review`/`question`/flow gates; minion for `answer`/`instruction`). The nudge sender is the process already performing the mutation — no background watcher required. The manager's existing fs.watch keeps the *user's* view realtime.

## 6. Flows — operator-authored loops

Two layers, shipped in order:

**Layer 1 (LLM-as-scheduler).** The operator improvises: creates tasks, assigns, waits for nudges, sequences the next step. No new machinery — good enough for "A implements, B reviews" and validates the protocol.

**Layer 2 (declarative flows).** For repeatable loops, the operator *writes a flow spec onto the board* and a deterministic **flow runner** (plain code inside the board CLI, not an LLM) turns the crank:

```ts
interface Flow {
  id: string;
  title: string;
  steps: FlowStep[];
  maxIterations: number;          // hard loop guard
  onExhausted: "escalate_user" | "escalate_operator";
}

interface FlowStep {
  id: string;                     // "implement", "critique", "revise"
  assignee: { existing?: string; spawn?: { kind: "pi" | "claude"; model?: string } };
  instruction: string;            // template; may reference {{steps.implement.artifacts}} etc.
  gate: "none" | "operator" | "user";
  next: string | { when: "approved": string; when "changes_requested": string };  // edges, incl. back-edges
}
```

The user's example expressed as a flow: `implement (minionA) → critique (minionB) → review-critique (minionC) → revise (minionA, back-edge to critique) …` looping until the critique step returns `approved` or `maxIterations` trips and the flow escalates. Each step materializes as a normal task — so the whole loop is watchable column-by-column, and any step can be answered/overridden by the user.

Why deterministic rather than letting the operator run every edge: loop bookkeeping is exactly what LLMs drop under context pressure. The operator *designs* the loop and handles gates/exceptions; the runner guarantees the mechanical parts (materialize next task, deliver nudge, count iterations, trip guards).

## 7. Observability in the manager

- Operator card: distinct badge/color, current flow + queue depth in place of the task line.
- Minion cards: task id + column chip (e.g. `t-3f9a · review`), plus everything they show today.
- Board view (`b` in the manager): kanban columns rendered like the card grid; enter on a task shows the thread; the review column shows diff stats.
- `pim board show --json` gives external tooling the same view.

## 8. Guardrails

- **Git:** minions never merge; merges only through the existing merge path (clean-tree check, no force push — same rules as today). Optional per-flow user gate before anything lands.
- **Budgets:** per-task `maxCostUsd`/`maxTokens` checked by the flow runner against existing telemetry totals; breach → task blocked + operator nudged (operator may kill or re-scope).
- **Runaway loops:** `maxIterations` is mandatory on flows; the runner, not a model, enforces it.
- **Auditability:** `events.jsonl` records every mutation with actor identity; threads are immutable (append-only).
- **User override:** any task can be reassigned/answered/cancelled by the user via CLI or board view; attaching to a minion is always allowed.

## 9. Delivery phases

| Phase | Scope | Notes |
|---|---|---|
| **P1** | Board substrate: store + `pim board` CLI + task chips on cards | No operator yet — the *user* is the operator; validates the protocol day-1 |
| **P2** | Minion protocol: extension tools (progress/question/submit), merge-proposal pipeline | Claude minions via board CLI from the start |
| **P3** | Operator: role field + operator extension + nudge delivery + reports | Layer-1 flows (improvised) |
| **P4** | Flow runner: declarative flows, budgets, loop guards | The Hermes-style loops |
| **P5** | Board view in the manager TUI | Kanban columns, thread viewer |

Each phase is independently useful; P1+P2 alone already give "minions propose, human reviews on a board".

## Open questions

1. **Operator model routing** — operator on a metered API (Fable/GPT-5.5-Pro class) can get expensive as a long-lived instance; do we want an idle-timeout + board-rehydration pattern (kill when quiet, respawn on nudge)?
2. **Board location** — pim dir (proposed) keeps it out of the repo; do we ever want it versioned/shared with teammates (`.pim/` in-repo, gitignored worktrees)? Leaning pim-dir until multi-user matters.
3. **Cross-minion file conflicts** — flows that touch overlapping files serialize via deps for now; do we need worktree-level lock hints later?
4. **Claude minion question-raising** — Notification hooks already raise attention, but `task_question` via Bash needs the minion to *decide* to call it; prompt discipline vs. an MCP server exposing board tools natively (cleaner, more moving parts).
5. **Report channel UX** — reports as a pinned board thread + done-notifier (proposed) vs. a dedicated manager pane.
