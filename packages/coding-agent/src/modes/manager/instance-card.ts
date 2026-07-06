/**
 * Live card for one pim instance, sized for a multi-column grid: tall and
 * narrow, with a fixed-height output preview so every card in a row lines up.
 * Shows state, model, context usage bar, token/cost totals, the branch the
 * agent is on, its workspace path, current activity, and recent output.
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatInstanceCwd, type InstanceView, instanceKind } from "./instances.ts";
import { pim, usageBar } from "./pim-theme.ts";
import { INDICATORS, indicatorFrame } from "./spinners.ts";

/** Rows of card chrome besides the preview: 2 borders + 6 info rows + divider. */
export const CARD_CHROME_ROWS = 9;

/**
 * The 4-slot dot-matrix status indicator. Attention flags raised by the agent
 * override everything (a red X for blocked, a drawing-in ? for question);
 * an unseen finished response shows a pink checkmark; otherwise the state:
 * the infinity particle while running (yellow while booting), a dotted
 * baseline at rest, a flat line when gone.
 */
function statusIndicator(view: InstanceView): string {
	const attention = view.status?.attention;
	if (attention) {
		return indicatorFrame(attention.kind === "blocked" ? INDICATORS.blocked : INDICATORS.question);
	}
	if (view.unseenDone) {
		return INDICATORS.done;
	}
	switch (view.state) {
		case "working":
			return indicatorFrame(INDICATORS.working);
		case "starting":
			return indicatorFrame(INDICATORS.starting);
		case "idle":
			return INDICATORS.idle;
		case "exited":
			return INDICATORS.exited;
	}
}

function formatAge(iso: string | undefined): string {
	if (!iso) return "";
	const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
	return `${Math.floor(seconds / 86400)}d`;
}

function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return String(count);
}

function formatCost(cost: number): string {
	return cost >= 1 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(3)}`;
}

/**
 * Render one instance card at the given width, with `previewLines` rows of
 * output preview. Plain function (not a Component): the grid renders cards
 * itself so it can lay them out in columns.
 */
export function renderInstanceCard(
	view: InstanceView,
	selected: boolean,
	width: number,
	previewLines: number,
): string[] {
	const status = view.status;
	const border = selected ? pim.brand : pim.border;
	const lines: string[] = [];

	const boxLine = (left: string, right = ""): string => {
		const innerWidth = Math.max(1, width - 4);
		const rightWidth = visibleWidth(right);
		const leftMax = Math.max(1, innerWidth - rightWidth - (rightWidth > 0 ? 1 : 0));
		const leftTruncated = truncateToWidth(left, leftMax, pim.dim("…"));
		const gap = " ".repeat(Math.max(0, innerWidth - visibleWidth(leftTruncated) - rightWidth));
		return `${border("│")} ${leftTruncated}${gap}${right} ${border("│")}`;
	};

	lines.push(border(`╭${"─".repeat(Math.max(0, width - 2))}╮`));

	// Name row: <indicator> <kind tag> name   [⚠ blocked | ? question | ✦ done] · age
	const age = pim.dim(formatAge(status?.updatedAt ?? view.createdAt));
	const attention = status?.attention;
	const titleBadge = attention
		? `${attention.kind === "blocked" ? pim.red("⚠ blocked") : pim.yellow("? question")} ${age}`
		: view.unseenDone
			? `${pim.pink("✦ done")} ${age}`
			: age;
	const kindTag = instanceKind(view) === "claude" ? pim.claude("✻") : pim.brand("π");
	lines.push(
		boxLine(
			`${statusIndicator(view)} ${kindTag} ${selected ? pim.brandBold(view.name) : pim.textBold(view.name)}`,
			titleBadge,
		),
	);

	// Model row: model                                     $cost
	const fallbackModel = instanceKind(view) === "claude" ? "claude code" : "default model";
	lines.push(
		boxLine(
			pim.muted(status?.model ?? view.model ?? fallbackModel),
			status?.usage ? pim.dim(formatCost(status.usage.cost)) : "",
		),
	);

	// Usage row: ctx bar                       ↑in ↓out · tok/s
	const ctx =
		status?.context && status.context.percent !== null
			? `${usageBar(status.context.percent)} ${pim.dim(`${status.context.percent.toFixed(0)}% ctx`)}`
			: pim.dim("ctx –");
	const throughput =
		status?.tps !== undefined ? ` · ${status.tps >= 10 ? status.tps.toFixed(0) : status.tps.toFixed(1)} t/s` : "";
	lines.push(
		boxLine(
			ctx,
			status?.usage
				? pim.dim(`↑${formatTokens(status.usage.input)} ↓${formatTokens(status.usage.output)}${throughput}`)
				: "",
		),
	);

	// Branch row: worktree branches in pink with their base; plain checkouts
	// show whatever branch the agent is currently on.
	if (view.worktree) {
		const base = view.worktree.baseBranch ? pim.dim(` ← ${view.worktree.baseBranch}`) : "";
		lines.push(boxLine(`${pim.pink(`⎇ ${view.liveBranch ?? view.worktree.branch}`)}${base}`));
	} else if (view.liveBranch) {
		lines.push(boxLine(pim.blue(`⎇ ${view.liveBranch}`)));
	} else {
		lines.push(boxLine(pim.dim("⎇ (no git branch)")));
	}

	// Workspace row
	lines.push(boxLine(pim.dim(`◆ ${formatInstanceCwd(view.worktree?.path ?? view.cwd)}`)));

	// Activity row: an agent-raised attention note beats everything, then the
	// current tool while working, then the original task.
	if (attention) {
		const color = attention.kind === "blocked" ? pim.red : pim.yellow;
		lines.push(boxLine(color(`${attention.kind === "blocked" ? "⚠" : "?"} ${attention.note.replaceAll("\n", " ")}`)));
	} else if (view.state === "working" && status?.activity) {
		lines.push(boxLine(`${pim.yellow("⚒ ")}${pim.text(status.activity)}`));
	} else if (view.initialTask) {
		lines.push(boxLine(pim.dim(`task: ${view.initialTask.replaceAll("\n", " ")}`)));
	} else {
		lines.push(boxLine(""));
	}

	// Fixed-height output preview (height chosen by the grid from terminal
	// size). Source lines are wrapped to the card width so tall cards fill
	// with text instead of truncating one row per source line.
	lines.push(boxLine(pim.dim("┈".repeat(Math.max(1, width - 6)))));
	const previewTextWidth = Math.max(8, width - 7);
	const wrapped = (status?.outputTail ?? []).flatMap((line) => wrapTextWithAnsi(line, previewTextWidth));
	const tail = wrapped.slice(-previewLines);
	for (let i = 0; i < previewLines; i++) {
		const line = tail[i];
		if (line !== undefined) {
			lines.push(boxLine(`${pim.brand("▏ ")}${pim.text(line)}`));
		} else if (i === 0 && tail.length === 0) {
			lines.push(boxLine(pim.dim(view.state === "exited" ? "instance exited" : "no output yet")));
		} else {
			lines.push(boxLine(""));
		}
	}

	lines.push(border(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
	return lines;
}
