/**
 * `pi manager mouse-debug`: raw mouse-event capture for tuning gesture
 * detection against real hardware. Prints every SGR mouse event with
 * timestamps and runs the live WheelSwipeDetector so you can see exactly
 * when (and why) a swipe fires. Scroll and swipe, then paste the output.
 */

import { WheelSwipeDetector } from "./gesture.ts";

const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
const MOUSE_DISABLE = "\x1b[?1006l\x1b[?1000l";
const EVENT_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

const BUTTON_NAMES: Record<number, string> = {
	0: "left",
	1: "middle",
	2: "right",
	64: "wheel-up",
	65: "wheel-down",
	66: "wheel-left",
	67: "wheel-right",
};

export async function runMouseDebug(): Promise<void> {
	const swipe = new WheelSwipeDetector();
	const startedAt = Date.now();
	let lastAt = startedAt;

	console.log("pim mouse-debug — scroll vertically, then swipe horizontally. q to quit.\n");
	process.stdin.setRawMode?.(true);
	process.stdin.resume();
	process.stdin.setEncoding("utf8");
	process.stdout.write(MOUSE_ENABLE);

	const cleanup = () => {
		process.stdout.write(MOUSE_DISABLE);
		process.stdin.setRawMode?.(false);
		process.stdin.pause();
	};

	await new Promise<void>((resolve) => {
		process.stdin.on("data", (chunk: string) => {
			if (chunk.includes("q") || chunk.includes("\x03")) {
				cleanup();
				resolve();
				return;
			}
			EVENT_RE.lastIndex = 0;
			let sawMouse = false;
			for (const match of chunk.matchAll(EVENT_RE)) {
				sawMouse = true;
				const now = Date.now();
				const button = Number.parseInt(match[1], 10);
				const name = BUTTON_NAMES[button] ?? `button-${button}`;
				const gap = now - lastAt;
				lastAt = now;
				let verdict = "";
				if (button >= 64 && button <= 67) {
					const fired = swipe.feed(button === 66 || button === 67 ? "h" : "v", now);
					if (fired) verdict = "   → SWIPE FIRED";
				}
				console.log(
					`+${String(now - startedAt).padStart(6)}ms  Δ${String(gap).padStart(4)}ms  ${name.padEnd(12)} (${match[1]}) at ${match[2]},${match[3]} ${match[4] === "m" ? "release" : ""}${verdict}`,
				);
			}
			if (!sawMouse && chunk.trim().length > 0) {
				console.log(`non-mouse input: ${JSON.stringify(chunk)}`);
			}
		});
	});
}
