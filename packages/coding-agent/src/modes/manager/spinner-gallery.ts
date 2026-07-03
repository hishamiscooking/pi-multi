/**
 * `pi manager spinners`: a live sheet of pim's dot-matrix animations — the
 * candidate library plus the state language the board actually uses. Kept as
 * a browsing/tuning tool: animations are frame functions in spinners.ts, so
 * new candidates are cheap to add and audition here.
 */

import { type Component, getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";
import { createStartupTui, startStartupTui } from "../../cli/startup-ui.ts";
import { getAgentDir } from "../../config.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { stopThemeWatcher } from "../interactive/theme/theme.ts";
import { pim } from "./pim-theme.ts";
import { SPINNER_SPECS, STATE_DEMOS, spinnerFrame } from "./spinners.ts";

const TICK_MS = 60;

class SpinnerGalleryComponent implements Component {
	private readonly onClose: () => void;

	constructor(onClose: () => void) {
		this.onClose = onClose;
	}

	invalidate(): void {
		// Frames derive from wall-clock time; nothing cached.
	}

	render(width: number): string[] {
		const now = Date.now();
		const nameWidth = Math.max(...[...SPINNER_SPECS, ...STATE_DEMOS].map((spec) => spec.name.length)) + 2;
		const lines: string[] = [];
		const row = (spec: (typeof SPINNER_SPECS)[number]) => {
			const sample = spinnerFrame(spec, now);
			return truncateToWidth(
				`   ${sample}   ${pim.text(spec.name.padEnd(nameWidth))}${pim.dim(spec.description)}`,
				width - 1,
				pim.dim("…"),
			);
		};
		lines.push("");
		lines.push(
			` ${pim.logo()}  ${pim.textBold("spinner gallery")}${pim.sep()}${pim.dim("pim's dot-matrix animation library")}`,
		);
		lines.push(` ${pim.border("─".repeat(Math.max(0, width - 2)))}`);
		lines.push("");
		for (const spec of SPINNER_SPECS) {
			lines.push(row(spec));
			lines.push("");
		}
		lines.push(` ${pim.border("─".repeat(Math.max(0, width - 2)))}`);
		lines.push(
			` ${pim.textBold("state language")}${pim.sep()}${pim.dim("how color maps to agent state on the board")}`,
		);
		lines.push("");
		for (const spec of STATE_DEMOS) {
			lines.push(row(spec));
			lines.push("");
		}
		lines.push(` ${pim.border("─".repeat(Math.max(0, width - 2)))}`);
		lines.push(
			`  ${pim.key("q/esc", "close")}  ${pim.dim("the board uses the state language above; candidates are kept for future use")}`,
		);
		lines.push("");
		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (keyData === "q" || kb.matches(keyData, "tui.select.cancel") || kb.matches(keyData, "tui.select.confirm")) {
			this.onClose();
		}
	}
}

export async function runSpinnerGallery(): Promise<void> {
	const settingsManager = SettingsManager.create(process.cwd(), getAgentDir());
	const ui = await createStartupTui(settingsManager);

	const close = () => {
		clearInterval(ticker);
		ui.stop();
		stopThemeWatcher();
		process.exit(0);
	};

	const gallery = new SpinnerGalleryComponent(close);
	ui.addChild(gallery);
	ui.setFocus(gallery);
	startStartupTui(ui, settingsManager);

	const ticker = setInterval(() => {
		ui.invalidate();
		ui.requestRender();
	}, TICK_MS);

	await new Promise<never>(() => {});
}
