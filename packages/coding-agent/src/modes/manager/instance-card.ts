/**
 * Bordered live card for one pim instance: state, model, context usage,
 * token/cost totals, workspace (worktree or directory), current activity,
 * and a tail of the latest output.
 */

import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../interactive/theme/theme.ts";
import { formatInstanceCwd, type InstanceView } from "./instances.ts";

const STATE_GLYPHS: Record<InstanceView["state"], { glyph: string; color: "success" | "text" | "warning" | "dim" }> = {
	working: { glyph: "●", color: "success" },
	idle: { glyph: "○", color: "text" },
	starting: { glyph: "◌", color: "warning" },
	exited: { glyph: "✖", color: "dim" },
};

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

export class InstanceCard implements Component {
	private readonly view: InstanceView;
	private readonly selected: boolean;

	constructor(view: InstanceView, selected: boolean) {
		this.view = view;
		this.selected = selected;
	}

	invalidate(): void {
		// Cards are rebuilt on every refresh; nothing cached to invalidate.
	}

	private border(text: string): string {
		return this.selected ? theme.fg("accent", text) : theme.fg("border", text);
	}

	private boxLine(content: string, width: number): string {
		const innerWidth = Math.max(1, width - 4);
		const truncated = truncateToWidth(content, innerWidth, theme.fg("dim", "…"));
		const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
		return ` ${this.border("│")} ${truncated}${padding}${this.border("│")}`;
	}

	render(width: number): string[] {
		const view = this.view;
		const { glyph, color } = STATE_GLYPHS[view.state];
		const innerWidth = Math.max(1, width - 4);
		const lines: string[] = [];

		// Top border with title: ╭ ● name · state · age ────╮
		const stateText = view.state === "working" ? theme.fg("success", view.state) : theme.fg("muted", view.state);
		const age = formatAge(view.status?.updatedAt ?? view.createdAt);
		const title =
			`${theme.fg(color, glyph)} ` +
			(this.selected ? theme.fg("accent", theme.bold(view.name)) : theme.fg("text", theme.bold(view.name))) +
			theme.fg("dim", " · ") +
			stateText +
			theme.fg("dim", ` · ${age} `);
		const titleWidth = visibleWidth(title);
		const fill = Math.max(0, innerWidth - titleWidth - 1);
		lines.push(` ${this.border("╭─")} ${title}${this.border(`${"─".repeat(fill)}╮`)}`);

		// Info: model · ctx usage · tokens · cost
		const status = view.status;
		const infoParts: string[] = [];
		infoParts.push(theme.fg("text", status?.model ?? view.model ?? "default model"));
		if (status?.context && status.context.percent !== null) {
			infoParts.push(
				theme.fg("muted", `ctx ${status.context.percent.toFixed(1)}% of ${formatTokens(status.context.window)}`),
			);
		}
		if (status?.usage) {
			infoParts.push(
				theme.fg("muted", `↑${formatTokens(status.usage.input)} ↓${formatTokens(status.usage.output)}`) +
					theme.fg("dim", ` ${formatCost(status.usage.cost)}`),
			);
		}
		lines.push(this.boxLine(infoParts.join(theme.fg("dim", " · ")), width));

		// Workspace: worktree branch or plain directory
		if (view.worktree) {
			lines.push(
				this.boxLine(
					theme.fg("warning", `⎇ ${view.worktree.branch}`) +
						theme.fg("dim", ` (from ${view.worktree.baseBranch}) · ${formatInstanceCwd(view.worktree.path)}`),
					width,
				),
			);
		} else {
			lines.push(this.boxLine(theme.fg("dim", `dir ${formatInstanceCwd(view.cwd)}`), width));
		}

		// Current activity while working
		if (view.state === "working" && status?.activity) {
			lines.push(this.boxLine(theme.fg("warning", "⚒ ") + theme.fg("text", status.activity), width));
		}

		// Output tail
		const tail = status?.outputTail ?? [];
		if (tail.length > 0) {
			for (const line of tail) {
				lines.push(this.boxLine(theme.fg("dim", "▏") + theme.fg("muted", line), width));
			}
		} else if (view.state !== "exited") {
			lines.push(this.boxLine(theme.fg("dim", "no output yet"), width));
		}

		lines.push(` ${this.border(`╰${"─".repeat(Math.max(0, innerWidth + 1))}╯`)}`);
		return lines;
	}
}
