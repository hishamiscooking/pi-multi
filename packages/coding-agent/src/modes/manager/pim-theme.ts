/**
 * pim's visual identity: a charm/lipgloss-inspired truecolor palette and small
 * styling helpers, layered on chalk (which degrades gracefully on non-truecolor
 * terminals). The rest of pi keeps its theme; pim gets its own look.
 */

import chalk from "chalk";

export const PIM_COLORS = {
	brand: "#9D7CFF",
	brandDark: "#14101F",
	pink: "#FF6AC1",
	green: "#3FDCA0",
	yellow: "#F2C94C",
	red: "#FF5F87",
	blue: "#6CB2FF",
	text: "#E6E8F2",
	muted: "#9BA0B8",
	dim: "#6A6F87",
	border: "#444962",
	surface: "#2A2E42",
} as const;

export const pim = {
	brand: (text: string) => chalk.hex(PIM_COLORS.brand)(text),
	brandBold: (text: string) => chalk.hex(PIM_COLORS.brand).bold(text),
	pink: (text: string) => chalk.hex(PIM_COLORS.pink)(text),
	green: (text: string) => chalk.hex(PIM_COLORS.green)(text),
	yellow: (text: string) => chalk.hex(PIM_COLORS.yellow)(text),
	red: (text: string) => chalk.hex(PIM_COLORS.red)(text),
	blue: (text: string) => chalk.hex(PIM_COLORS.blue)(text),
	text: (text: string) => chalk.hex(PIM_COLORS.text)(text),
	textBold: (text: string) => chalk.hex(PIM_COLORS.text).bold(text),
	muted: (text: string) => chalk.hex(PIM_COLORS.muted)(text),
	dim: (text: string) => chalk.hex(PIM_COLORS.dim)(text),
	border: (text: string) => chalk.hex(PIM_COLORS.border)(text),
	/** The " pim " logo badge. */
	logo: () => chalk.bgHex(PIM_COLORS.brand).hex(PIM_COLORS.brandDark).bold(" pim "),
	/** A keycap-styled key hint: [ n ] new */
	key: (key: string, label: string) =>
		chalk.bgHex(PIM_COLORS.surface).hex(PIM_COLORS.text)(` ${key} `) + chalk.hex(PIM_COLORS.dim)(` ${label}`),
	/** Dot separator used between metadata segments. */
	sep: () => chalk.hex(PIM_COLORS.dim)("  ·  "),
} as const;

/** A compact usage bar like ▰▰▰▱▱▱▱▱ colored by fullness. */
export function usageBar(percent: number, segments = 8): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * segments);
	const color = clamped >= 80 ? PIM_COLORS.red : clamped >= 60 ? PIM_COLORS.yellow : PIM_COLORS.green;
	return (
		chalk.hex(color)("▰".repeat(filled)) + chalk.hex(PIM_COLORS.border)("▱".repeat(Math.max(0, segments - filled)))
	);
}
