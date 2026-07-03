/**
 * Scrollable history browser for one pim instance, shown inside the manager.
 * Displays the instance's actual rendered terminal scrollback (captured from
 * tmux with colors), so it reads exactly like the attached TUI.
 */

import { type Component, getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";
import type { InstanceView } from "./instances.ts";
import { pim } from "./pim-theme.ts";

export class ManagerHistoryComponent implements Component {
	private lines: string[] = [];
	private offset = 0;
	private followBottom = true;
	private readonly viewportRows: number;
	private readonly view: InstanceView;
	private readonly onClose: () => void;

	constructor(view: InstanceView, lines: string[] | undefined, onClose: () => void) {
		this.view = view;
		this.onClose = onClose;
		this.viewportRows = Math.max(10, (process.stdout.rows || 40) - 8);
		this.setLines(lines);
	}

	invalidate(): void {
		// Lines are replaced wholesale via setLines; nothing cached.
	}

	/** Replace content (called on refresh ticks); sticks to the bottom unless scrolled up. */
	setLines(lines: string[] | undefined): void {
		this.lines = lines ?? [];
		const maxOffset = this.maxOffset();
		if (this.followBottom || this.offset > maxOffset) {
			this.offset = maxOffset;
		}
	}

	private maxOffset(): number {
		return Math.max(0, this.lines.length - this.viewportRows);
	}

	private scrollTo(offset: number): void {
		this.offset = Math.max(0, Math.min(offset, this.maxOffset()));
		this.followBottom = this.offset >= this.maxOffset();
	}

	render(width: number): string[] {
		const out: string[] = [];
		const branch = this.view.worktree ? pim.pink(`  ⎇ ${this.view.worktree.branch}`) : "";
		const end = Math.min(this.lines.length, this.offset + this.viewportRows);
		const position =
			this.lines.length === 0
				? ""
				: pim.dim(`${this.offset + 1}-${end} / ${this.lines.length}${this.followBottom ? " · live" : ""}`);
		out.push("");
		out.push(` ${pim.logo()}  ${pim.textBold(this.view.name)}${branch}  ${position}`);
		out.push(` ${pim.border("─".repeat(Math.max(0, width - 2)))}`);

		if (this.lines.length === 0) {
			out.push(` ${pim.dim("no history to show (instance not running?)")}`);
		} else {
			for (let i = this.offset; i < end; i++) {
				out.push(truncateToWidth(this.lines[i], width - 1, pim.dim("…")));
			}
		}

		out.push(` ${pim.border("─".repeat(Math.max(0, width - 2)))}`);
		out.push(
			`  ${pim.key("↑↓", "scroll")}  ${pim.key("u/d", "page")}  ${pim.key("g/G", "top/bottom")}  ${pim.key("esc", "back")}`,
		);
		out.push("");
		return out;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.scrollTo(this.offset - 1);
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.scrollTo(this.offset + 1);
		} else if (keyData === "u" || keyData === "\x1b[5~") {
			this.scrollTo(this.offset - this.viewportRows);
		} else if (keyData === "d" || keyData === " " || keyData === "\x1b[6~") {
			this.scrollTo(this.offset + this.viewportRows);
		} else if (keyData === "g") {
			this.scrollTo(0);
		} else if (keyData === "G") {
			this.scrollTo(this.maxOffset());
		} else if (keyData === "q" || keyData === "h" || kb.matches(keyData, "tui.select.cancel")) {
			this.onClose();
		}
	}
}
