/**
 * Responsive grid of instance cards. Column count scales with terminal width
 * (one column on narrow terminals, up to four on very wide ones); cards in a
 * row are rendered side by side and padded to equal height.
 */

import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { CARD_CHROME_ROWS, renderInstanceCard } from "./instance-card.ts";
import type { InstanceView } from "./instances.ts";

const MIN_CARD_WIDTH = 52;
const MAX_COLS = 4;
const GAP = 2;
const MARGIN = 1;
/** Rows the manager uses around the grid (header, footer, spacers, shell line). */
const SCREEN_CHROME_ROWS = 8;
const MIN_PREVIEW_LINES = 4;
const MAX_PREVIEW_LINES = 40;

export class InstanceGrid implements Component {
	private views: InstanceView[] = [];
	private selectedId: string | undefined;
	private lastCols = 1;

	setData(views: InstanceView[], selectedId: string | undefined): void {
		this.views = views;
		this.selectedId = selectedId;
	}

	/** Columns used by the last render; the manager uses this for ↑↓ navigation. */
	getCols(): number {
		return this.lastCols;
	}

	invalidate(): void {
		// Content is replaced wholesale via setData; nothing cached.
	}

	render(width: number): string[] {
		if (this.views.length === 0) {
			return [];
		}
		const usable = Math.max(MIN_CARD_WIDTH / 2, width - MARGIN);
		const cols = Math.max(
			1,
			Math.min(MAX_COLS, Math.floor((usable + GAP) / (MIN_CARD_WIDTH + GAP)), this.views.length),
		);
		const colWidth = Math.floor((usable - GAP * (cols - 1)) / cols);
		this.lastCols = cols;

		// Size cards to fill the terminal with at most two rows of cards:
		// a single row gets the full height, two or more rows split it.
		const cardRows = Math.min(2, Math.ceil(this.views.length / cols));
		const availableRows = Math.max(
			CARD_CHROME_ROWS + MIN_PREVIEW_LINES,
			(process.stdout.rows || 40) - SCREEN_CHROME_ROWS,
		);
		const cardHeight = Math.floor((availableRows - (cardRows - 1)) / cardRows);
		const previewLines = Math.max(MIN_PREVIEW_LINES, Math.min(MAX_PREVIEW_LINES, cardHeight - CARD_CHROME_ROWS));

		const margin = " ".repeat(MARGIN);
		const gap = " ".repeat(GAP);
		const blank = " ".repeat(colWidth);
		const lines: string[] = [];

		for (let rowStart = 0; rowStart < this.views.length; rowStart += cols) {
			const row = this.views.slice(rowStart, rowStart + cols);
			const rendered = row.map((view) => {
				const card = renderInstanceCard(view, view.id === this.selectedId, colWidth, previewLines);
				// Normalize every line to exactly colWidth so columns stay aligned.
				return card.map((line) => line + " ".repeat(Math.max(0, colWidth - visibleWidth(line))));
			});
			const rowHeight = Math.max(...rendered.map((card) => card.length));
			for (let i = 0; i < rowHeight; i++) {
				lines.push(margin + rendered.map((card) => card[i] ?? blank).join(gap));
			}
			if (rowStart + cols < this.views.length) {
				lines.push("");
			}
		}
		return lines;
	}
}
