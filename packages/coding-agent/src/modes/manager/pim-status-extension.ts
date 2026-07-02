/**
 * Telemetry extension loaded into pim-managed pi instances.
 *
 * The pim manager spawns each instance with PIM_STATUS_FILE (and optionally
 * PIM_LOG_FILE) set and loads this file via `-e`. It mirrors the agent
 * lifecycle into a small JSON status file the manager polls for its live
 * instance cards, and appends a JSONL event log that gives external tooling
 * (pi manager log / a future orchestrator agent) deep visibility into what
 * each instance did.
 */

import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";

export type PimInstanceState = "working" | "idle" | "exited";

export interface PimStatusFile {
	state: PimInstanceState;
	updatedAt: string;
	pid: number;
	model?: string;
	/** Context window usage of the active model. */
	context?: { tokens: number | null; window: number; percent: number | null };
	/** Cumulative token/cost totals across all assistant messages this process. */
	usage?: { input: number; output: number; cost: number };
	/** What the agent is doing right now (tool call or response streaming). */
	activity?: string;
	/** Tail of the most recent assistant text, for live output previews. */
	outputTail?: string[];
}

const OUTPUT_TAIL_LINES = 3;
const OUTPUT_TAIL_MAX_COLS = 200;
const LOG_TEXT_LIMIT = 600;
const STREAM_WRITE_INTERVAL_MS = 400;

function extractAssistantText(message: AgentMessage): string {
	if (message.role !== "assistant" || !Array.isArray(message.content)) {
		return "";
	}
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function toOutputTail(text: string): string[] | undefined {
	const lines = text
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
	if (lines.length === 0) {
		return undefined;
	}
	return lines.slice(-OUTPUT_TAIL_LINES).map((line) => line.slice(0, OUTPUT_TAIL_MAX_COLS));
}

function summarizeToolArgs(toolName: string, args: unknown): string {
	if (args && typeof args === "object") {
		const record = args as Record<string, unknown>;
		const preferred = ["command", "path", "file_path", "pattern", "url", "name"];
		for (const key of preferred) {
			if (typeof record[key] === "string" && record[key].length > 0) {
				return `${toolName}: ${(record[key] as string).replaceAll("\n", " ")}`;
			}
		}
	}
	try {
		return `${toolName}: ${JSON.stringify(args)}`;
	} catch {
		return toolName;
	}
}

export default function pimStatusExtension(pi: ExtensionAPI) {
	const statusFile = process.env.PIM_STATUS_FILE;
	if (!statusFile) {
		return;
	}
	const logFile = process.env.PIM_LOG_FILE;

	let state: PimInstanceState = "idle";
	let activity: string | undefined;
	let outputTail: string[] | undefined;
	const usageTotals = { input: 0, output: 0, cost: 0 };
	let lastStreamWrite = 0;

	const write = (ctx: ExtensionContext | undefined) => {
		const contextUsage = ctx?.getContextUsage();
		const status: PimStatusFile = {
			state,
			updatedAt: new Date().toISOString(),
			pid: process.pid,
			model: ctx?.model?.id,
			context: contextUsage
				? { tokens: contextUsage.tokens, window: contextUsage.contextWindow, percent: contextUsage.percent }
				: undefined,
			usage: usageTotals.input > 0 || usageTotals.output > 0 ? { ...usageTotals } : undefined,
			activity,
			outputTail,
		};
		try {
			mkdirSync(dirname(statusFile), { recursive: true });
			// Write via rename so readers never see a torn file.
			const tmpFile = `${statusFile}.${process.pid}.tmp`;
			writeFileSync(tmpFile, JSON.stringify(status), "utf8");
			renameSync(tmpFile, statusFile);
		} catch {
			// Telemetry must never break the instance.
		}
	};

	const log = (event: string, fields: Record<string, unknown> = {}) => {
		if (!logFile) {
			return;
		}
		try {
			mkdirSync(dirname(logFile), { recursive: true });
			appendFileSync(logFile, `${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`, "utf8");
		} catch {
			// Telemetry must never break the instance.
		}
	};

	pi.on("session_start", async (event, ctx) => {
		state = "idle";
		write(ctx);
		log("session_start", { reason: event.reason });
	});

	pi.on("agent_start", async (_event, ctx) => {
		state = "working";
		activity = "thinking";
		outputTail = undefined;
		write(ctx);
		log("agent_start");
	});

	pi.on("message_start", async (event, _ctx) => {
		if (event.message.role === "user") {
			const content = event.message.content;
			const text =
				typeof content === "string"
					? content
					: content
							.filter((block): block is { type: "text"; text: string } => block.type === "text")
							.map((block) => block.text)
							.join("\n");
			log("user_message", { text: text.slice(0, LOG_TEXT_LIMIT) });
		}
	});

	pi.on("message_update", async (event, ctx) => {
		const text = extractAssistantText(event.message);
		if (!text) {
			return;
		}
		activity = "responding";
		outputTail = toOutputTail(text);
		const now = Date.now();
		if (now - lastStreamWrite >= STREAM_WRITE_INTERVAL_MS) {
			lastStreamWrite = now;
			write(ctx);
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") {
			return;
		}
		const usage = event.message.usage;
		usageTotals.input += usage.input + usage.cacheRead + usage.cacheWrite;
		usageTotals.output += usage.output;
		usageTotals.cost += usage.cost.total;
		const text = extractAssistantText(event.message);
		if (text) {
			outputTail = toOutputTail(text);
			log("assistant_message", { text: text.slice(0, LOG_TEXT_LIMIT) });
		}
		write(ctx);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		activity = summarizeToolArgs(event.toolName, event.args);
		write(ctx);
		log("tool_start", { tool: event.toolName, summary: activity.slice(0, LOG_TEXT_LIMIT) });
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		activity = "thinking";
		write(ctx);
		log("tool_end", { tool: event.toolName, isError: event.isError });
	});

	pi.on("agent_end", async (_event, ctx) => {
		state = "idle";
		activity = undefined;
		write(ctx);
		log("agent_end");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		state = "exited";
		activity = undefined;
		write(ctx);
		log("session_shutdown");
	});
}
