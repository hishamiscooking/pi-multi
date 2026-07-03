/**
 * Candidate status animations for pim's working indicator, browsable via
 * `pi manager spinners`.
 *
 * These are dot-matrix animations: each braille character is a 2×4 dot cell,
 * so the 4-character indicator slot forms an 8×4 pixel canvas. Every spinner
 * is a function of time over that canvas (waves, orbits, particles), rendered
 * to braille with per-character intensity coloring — head bright, trail
 * fading. Frames derive from wall-clock time so everything animates in
 * lockstep.
 */

import chalk from "chalk";
import { PIM_COLORS } from "./pim-theme.ts";

export interface SpinnerSpec {
	name: string;
	description: string;
	frameMs: number;
	frames: string[];
}

const violet = chalk.hex(PIM_COLORS.brand);
const pink = chalk.hex(PIM_COLORS.pink);
const green = chalk.hex(PIM_COLORS.green);
const blue = chalk.hex(PIM_COLORS.blue);
const dim = chalk.hex(PIM_COLORS.dim);
const faint = chalk.hex(PIM_COLORS.border);
const bright = chalk.hex(PIM_COLORS.text);

// ---------------------------------------------------------------------------
// Braille pixel canvas: 4 chars wide → 8×4 pixels.
// ---------------------------------------------------------------------------

const CANVAS_CHARS = 4;
const CANVAS_W = CANVAS_CHARS * 2;
const CANVAS_H = 4;

/** Braille dot bit for pixel (col within char, row). */
const BRAILLE_BITS = [
	[0x01, 0x08],
	[0x02, 0x10],
	[0x04, 0x20],
	[0x40, 0x80],
] as const;

/** A lit pixel: intensity 2 = head/bright, 1 = body, 0 = trail/faint. */
interface Pixel {
	x: number;
	y: number;
	intensity: 0 | 1 | 2;
}

type Tint = { bright: (t: string) => string; body: (t: string) => string; trail: (t: string) => string };

function px(x: number, y: number, intensity: 0 | 1 | 2 = 1): Pixel {
	return { x: Math.round(x), y: Math.round(y), intensity };
}

/** Render lit pixels to a row of braille chars, colored per-char by peak intensity. */
function renderPixels(pixels: Pixel[], tint: Tint): string {
	let out = "";
	for (let c = 0; c < CANVAS_CHARS; c++) {
		let bits = 0;
		let peak = -1;
		for (const pixel of pixels) {
			if (pixel.y < 0 || pixel.y >= CANVAS_H) continue;
			const col = pixel.x - c * 2;
			if (col !== 0 && col !== 1) continue;
			bits |= BRAILLE_BITS[pixel.y][col];
			peak = Math.max(peak, pixel.intensity);
		}
		const ch = String.fromCharCode(0x2800 + bits);
		out += peak === 2 ? tint.bright(ch) : peak === 1 ? tint.body(ch) : peak === 0 ? tint.trail(ch) : ch;
	}
	return out;
}

function animate(frameCount: number, plot: (t: number) => Pixel[], tint: Tint): string[] {
	const frames: string[] = [];
	for (let t = 0; t < frameCount; t++) {
		frames.push(renderPixels(plot(t), tint));
	}
	return frames;
}

// ---------------------------------------------------------------------------
// The set.
// ---------------------------------------------------------------------------

/** A sine wave rolling through the canvas. */
function waveFrames(): string[] {
	return animate(
		16,
		(t) => {
			const pixels: Pixel[] = [];
			for (let x = 0; x < CANVAS_W; x++) {
				const y = 1.5 - 1.45 * Math.sin((2 * Math.PI * (x + t * 0.5)) / CANVAS_W);
				pixels.push(px(x, y, 1));
			}
			return pixels;
		},
		{ bright: green, body: green, trail: dim },
	);
}

/**
 * Two strands in antiphase — a double helix scrolling by. The lead strand is
 * a continuous wave; its twin is a sparse ghost (every other column) so the
 * weave stays readable instead of merging into a lattice. Both flare where
 * they cross.
 */
function helixFrames(): string[] {
	return animate(
		16,
		(t) => {
			const pixels: Pixel[] = [];
			for (let x = 0; x < CANVAS_W; x++) {
				const phase = (2 * Math.PI * (x + t * 0.5)) / CANVAS_W;
				const y1 = 1.5 - 1.45 * Math.sin(phase);
				const y2 = 1.5 + 1.45 * Math.sin(phase);
				const crossing = Math.abs(y1 - y2) < 0.8;
				pixels.push(px(x, y1, crossing ? 2 : 1));
				if (x % 2 === 1 && !crossing) {
					pixels.push(px(x, y2, 0));
				}
			}
			return pixels;
		},
		{ bright: pink, body: violet, trail: dim },
	);
}

/** A particle on an elliptical orbit, trailing light. */
function orbitFrames(): string[] {
	const count = 16;
	return animate(
		count,
		(t) => {
			const pixels: Pixel[] = [];
			for (let back = 5; back >= 0; back--) {
				const angle = (2 * Math.PI * (t - back)) / count;
				const x = 3.5 + 3.4 * Math.cos(angle);
				const y = 1.5 + 1.6 * Math.sin(angle);
				pixels.push(px(x, y, back === 0 ? 2 : back <= 2 ? 1 : 0));
			}
			return pixels;
		},
		{ bright: bright, body: violet, trail: faint },
	);
}

/** A particle tracing a figure-eight (lissajous), trailing light. */
function infinityFrames(tint: Tint = { bright: pink, body: violet, trail: faint }): string[] {
	const count = 24;
	return animate(
		count,
		(t) => {
			const pixels: Pixel[] = [];
			for (let back = 6; back >= 0; back--) {
				const angle = (2 * Math.PI * (t - back)) / count;
				const x = 3.5 + 3.4 * Math.cos(angle);
				const y = 1.5 + 1.6 * Math.sin(2 * angle);
				pixels.push(px(x, y, back === 0 ? 2 : back <= 3 ? 1 : 0));
			}
			return pixels;
		},
		tint,
	);
}

/** Drops falling at different speeds down the columns. */
function rainFrames(): string[] {
	const columns = [
		{ x: 0, speed: 1, offset: 0 },
		{ x: 2, speed: 0.5, offset: 3 },
		{ x: 3, speed: 1, offset: 5 },
		{ x: 5, speed: 0.5, offset: 1 },
		{ x: 6, speed: 1, offset: 4 },
		{ x: 7, speed: 0.5, offset: 2 },
	];
	return animate(
		12,
		(t) => {
			const pixels: Pixel[] = [];
			for (const column of columns) {
				const y = Math.floor(column.offset + t * column.speed) % (CANVAS_H + 2);
				if (y < CANVAS_H) pixels.push(px(column.x, y, 1));
				if (y - 1 >= 0 && y - 1 < CANVAS_H) pixels.push(px(column.x, y - 1, 0));
			}
			return pixels;
		},
		{ bright: green, body: green, trail: dim },
	);
}

/** A snake slithering around the edge of the canvas. */
function snakeFrames(): string[] {
	const path: Array<[number, number]> = [];
	for (let x = 0; x < CANVAS_W; x++) path.push([x, 0]);
	for (let y = 1; y < CANVAS_H; y++) path.push([CANVAS_W - 1, y]);
	for (let x = CANVAS_W - 2; x >= 0; x--) path.push([x, CANVAS_H - 1]);
	for (let y = CANVAS_H - 2; y >= 1; y--) path.push([0, y]);
	return animate(
		path.length,
		(t) => {
			const pixels: Pixel[] = [];
			for (let back = 6; back >= 0; back--) {
				const [x, y] = path[(t - back + path.length * 2) % path.length];
				pixels.push(px(x, y, back === 0 ? 2 : back <= 3 ? 1 : 0));
			}
			return pixels;
		},
		{ bright: pink, body: violet, trail: faint },
	);
}

/** A full-height beam sweeping back and forth, fading behind itself. */
function scanFrames(): string[] {
	const sweep = [0, 1, 2, 3, 4, 5, 6, 7, 6, 5, 4, 3, 2, 1];
	return animate(
		sweep.length,
		(t) => {
			const pixels: Pixel[] = [];
			const head = sweep[t];
			const prev = sweep[(t - 1 + sweep.length) % sweep.length];
			for (let y = 0; y < CANVAS_H; y++) {
				pixels.push(px(head, y, 2));
				pixels.push(px(prev, y, 0));
			}
			return pixels;
		},
		{ bright: green, body: green, trail: dim },
	);
}

/** Pixels flickering in and out — static, synapses firing. */
function sparksFrames(): string[] {
	const lit = (x: number, y: number, t: number) => (x * 7 + y * 13 + t * 11) % 19 < 2;
	return animate(
		12,
		(t) => {
			const pixels: Pixel[] = [];
			for (let x = 0; x < CANVAS_W; x++) {
				for (let y = 0; y < CANVAS_H; y++) {
					if (lit(x, y, t)) pixels.push(px(x, y, 2));
					else if (lit(x, y, t - 1)) pixels.push(px(x, y, 0));
				}
			}
			return pixels;
		},
		{ bright: pink, body: violet, trail: faint },
	);
}

/** A ripple expanding outward from the center, fading as it goes. */
function ringsFrames(): string[] {
	// Phase 0: 2×2 core. 1: middle box outline. 2: outer edge outline. 3: gone.
	const ring = (level: number): Array<[number, number]> => {
		if (level === 0) {
			return [
				[3, 1],
				[4, 1],
				[3, 2],
				[4, 2],
			];
		}
		const left = level === 1 ? 2 : 0;
		const right = level === 1 ? 5 : 7;
		const points: Array<[number, number]> = [];
		for (let x = left; x <= right; x++) {
			points.push([x, 0], [x, 3]);
		}
		points.push([left, 1], [left, 2], [right, 1], [right, 2]);
		return points;
	};
	return animate(
		4,
		(t) => {
			const pixels: Pixel[] = [];
			if (t <= 2) {
				for (const [x, y] of ring(t)) pixels.push(px(x, y, t === 0 ? 2 : 1));
			}
			if (t >= 1 && t <= 3) {
				for (const [x, y] of ring(t - 1)) pixels.push(px(x, y, 0));
			}
			return pixels;
		},
		{ bright: bright, body: violet, trail: faint },
	);
}

export const SPINNER_SPECS: SpinnerSpec[] = [
	{ name: "wave", description: "a sine wave rolling through the matrix", frameMs: 90, frames: waveFrames() },
	{
		name: "helix",
		description: "a double helix scrolling by, flaring at crossings",
		frameMs: 100,
		frames: helixFrames(),
	},
	{ name: "orbit", description: "a particle on an orbit, trailing light", frameMs: 80, frames: orbitFrames() },
	{ name: "infinity", description: "a particle tracing a figure-eight", frameMs: 70, frames: infinityFrames() },
	{ name: "rain", description: "drops falling at different speeds", frameMs: 120, frames: rainFrames() },
	{ name: "snake", description: "slithering around the edge of the matrix", frameMs: 70, frames: snakeFrames() },
	{ name: "scan", description: "a beam sweeping back and forth", frameMs: 90, frames: scanFrames() },
	{ name: "sparks", description: "pixels firing like static", frameMs: 130, frames: sparksFrames() },
	{ name: "rings", description: "a ripple expanding from the center", frameMs: 170, frames: ringsFrames() },
];

// ---------------------------------------------------------------------------
// The board's state indicators (what the cards actually render).
// ---------------------------------------------------------------------------

const red = chalk.hex(PIM_COLORS.red);
const yellow = chalk.hex(PIM_COLORS.yellow);

/** A big X slashing in stroke by stroke, then pulsing. */
function blockedFrames(): string[] {
	const strokeA: Array<[number, number]> = [];
	const strokeB: Array<[number, number]> = [];
	for (let x = 0; x < CANVAS_W; x++) {
		strokeA.push([x, Math.round((3 * x) / 7)]);
		strokeB.push([x, 3 - Math.round((3 * x) / 7)]);
	}
	const draw = (a: number, b: number, intensity: 0 | 1 | 2): Pixel[] => [
		...strokeA.slice(0, a).map(([x, y]) => px(x, y, intensity)),
		...strokeB.slice(0, b).map(([x, y]) => px(x, y, intensity)),
	];
	return animate(
		8,
		(t) => {
			if (t === 0) return draw(4, 0, 2);
			if (t === 1) return draw(8, 0, 2);
			if (t === 2) return draw(8, 4, 2);
			if (t === 3) return draw(8, 8, 2);
			// Pulse the completed X.
			return draw(8, 8, t % 2 === 0 ? 2 : 1);
		},
		{ bright: red, body: dim, trail: faint },
	);
}

/** A question mark drawing itself in, then its dot blinking. */
function questionFrames(): string[] {
	const strokes: Array<[number, number]> = [
		[3, 0],
		[4, 0],
		[5, 0],
		[5, 1],
		[4, 2],
	];
	const dot: [number, number] = [4, 3];
	return animate(
		10,
		(t) => {
			const drawn = Math.min(strokes.length, t + 1);
			const pixels = strokes.slice(0, drawn).map(([x, y]) => px(x, y, 1));
			if (t >= strokes.length && t % 2 === 1) {
				pixels.push(px(dot[0], dot[1], 2));
			}
			return pixels;
		},
		{ bright: bright, body: yellow, trail: dim },
	);
}

/** A full-slot checkmark (static — done is a state, not an activity). */
function doneIndicatorFrame(): string {
	const pixels: Pixel[] = [px(1, 1, 1), px(2, 2, 1), px(3, 3, 1), px(4, 2, 1), px(5, 1, 1), px(6, 0, 2)];
	return renderPixels(pixels, { bright: pink, body: pink, trail: faint });
}

/** A calm dotted baseline (static). */
function idleIndicatorFrame(): string {
	const pixels: Pixel[] = [px(0, 2, 1), px(2, 2, 1), px(4, 2, 1), px(6, 2, 1)];
	return renderPixels(pixels, { bright: blue, body: blue, trail: faint });
}

export interface IndicatorAnimation {
	frames: string[];
	frameMs: number;
}

/** Everything the instance cards render in the indicator slot. */
export const INDICATORS = {
	working: { frames: infinityFrames(), frameMs: 70 } as IndicatorAnimation,
	starting: { frames: infinityFrames({ bright: yellow, body: dim, trail: faint }), frameMs: 90 } as IndicatorAnimation,
	blocked: { frames: blockedFrames(), frameMs: 150 } as IndicatorAnimation,
	question: { frames: questionFrames(), frameMs: 150 } as IndicatorAnimation,
	done: doneIndicatorFrame(),
	idle: idleIndicatorFrame(),
	exited: dim("────"),
} as const;

export function indicatorFrame(animation: IndicatorAnimation, now = Date.now()): string {
	return animation.frames[Math.floor(now / animation.frameMs) % animation.frames.length];
}

/** The state-color language shown under the candidates in the gallery. */
export const STATE_DEMOS: SpinnerSpec[] = [
	{
		name: "working",
		description: "infinity, brand colors — intelligence running",
		frameMs: INDICATORS.working.frameMs,
		frames: INDICATORS.working.frames,
	},
	{
		name: "starting",
		description: "infinity in yellow — booting up",
		frameMs: INDICATORS.starting.frameMs,
		frames: INDICATORS.starting.frames,
	},
	{
		name: "blocked",
		description: "a red X slashing in, then pulsing",
		frameMs: INDICATORS.blocked.frameMs,
		frames: INDICATORS.blocked.frames,
	},
	{
		name: "question",
		description: "a ? drawing in, its dot blinking",
		frameMs: INDICATORS.question.frameMs,
		frames: INDICATORS.question.frames,
	},
	{ name: "done", description: "finished, unseen — a pink checkmark", frameMs: 1000, frames: [INDICATORS.done] },
	{ name: "idle", description: "waiting for you — a calm dotted baseline", frameMs: 1000, frames: [INDICATORS.idle] },
];

/** The spec's frame for a wall-clock instant. */
export function spinnerFrame(spec: SpinnerSpec, now: number): string {
	return spec.frames[Math.floor(now / spec.frameMs) % spec.frames.length];
}
