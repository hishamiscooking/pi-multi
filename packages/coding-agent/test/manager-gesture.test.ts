import { describe, expect, it } from "vitest";
import { WheelSwipeDetector } from "../src/modes/manager/gesture.ts";

type Ev = [number, "h" | "v"];

/**
 * Event sequences transcribed from a real macOS trackpad capture
 * (Ghostty, `pi manager mouse-debug`, 2026-07-06). Vertical scrolling carries
 * isolated horizontal jitter; swipes are unbroken horizontal streams.
 */
const REAL_VERTICAL_SCROLL: Ev[] = [
	[1185, "v"],
	[1193, "h"],
	[1252, "v"],
	[1910, "v"],
	[1935, "v"],
	[1969, "v"],
	[1985, "v"],
	[2002, "v"],
	[2018, "v"],
	[2035, "v"],
	[2052, "v"],
	[2068, "v"],
	[2093, "v"],
	[2118, "v"],
	[2143, "v"],
	[2168, "v"],
	[2202, "v"],
	[2293, "v"],
	[2318, "h"],
	[2352, "v"],
	[2410, "v"],
	[2460, "v"],
	[2518, "v"],
	[2585, "v"],
	[2689, "v"],
];

const REAL_SWIPE: Ev[] = [
	[3383, "h"],
	[3418, "h"],
	[3439, "h"],
	[3452, "h"],
	[3469, "h"],
	[3485, "h"],
	[3493, "h"],
	[3501, "h"],
	[3510, "h"],
	[3518, "h"],
	[3526, "h"],
	[3543, "h"],
	[3543, "h"],
	[3560, "h"],
	[3568, "h"],
	[3585, "h"],
	[3593, "v"],
	[3593, "h"],
	[3602, "h"],
	[3618, "h"],
	[3618, "h"],
	[3626, "h"],
	[3635, "h"],
	[3643, "h"],
	[3651, "h"],
	[3660, "h"],
	[3668, "h"],
	[3676, "h"],
	[3685, "h"],
	[3693, "h"],
];

function fires(events: Ev[]): number {
	const detector = new WheelSwipeDetector();
	let count = 0;
	for (const [t, axis] of events) {
		if (detector.feed(axis, t)) count++;
	}
	return count;
}

describe("WheelSwipeDetector", () => {
	it("does not fire on real vertical scrolling with jitter", () => {
		expect(fires(REAL_VERTICAL_SCROLL)).toBe(0);
	});

	it("fires exactly once on a real swipe", () => {
		expect(fires(REAL_SWIPE)).toBe(1);
	});

	it("fires when a swipe follows scrolling with no quiet gap (momentum tail)", () => {
		const scrollEnd = REAL_VERTICAL_SCROLL[REAL_VERTICAL_SCROLL.length - 1][0];
		const rebased = REAL_SWIPE.map(([t, axis]): Ev => [t - REAL_SWIPE[0][0] + scrollEnd + 120, axis]);
		expect(fires([...REAL_VERTICAL_SCROLL, ...rebased])).toBe(1);
	});

	it("does not fire on scrolling with dense isolated jitter", () => {
		const dense: Ev[] = Array.from({ length: 40 }, (_, i): Ev => [1000 + i * 20, i % 4 === 3 ? "h" : "v"]);
		expect(fires(dense)).toBe(0);
	});

	it("treats gestures separated by quiet gaps independently", () => {
		const twoSwipes: Ev[] = [
			[1000, "h"],
			[1010, "h"],
			[1020, "h"],
			[1030, "h"],
			[1040, "h"],
			[1050, "h"],
			[2000, "h"],
			[2010, "h"],
			[2020, "h"],
			[2030, "h"],
			[2040, "h"],
			[2050, "h"],
		];
		expect(fires(twoSwipes)).toBe(2);
	});
});
