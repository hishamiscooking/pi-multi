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
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "../../core/extensions/types.ts";

export type PimInstanceState = "working" | "idle" | "exited";

export type PimAttentionKind = "blocked" | "question";

export interface PimAttention {
	kind: PimAttentionKind;
	note: string;
	at: string;
}

export interface PimStatusFile {
	state: PimInstanceState;
	updatedAt: string;
	pid: number;
	model?: string;
	/** Context window usage of the active model. */
	context?: { tokens: number | null; window: number; percent: number | null };
	/** Cumulative token/cost totals across all assistant messages this process. */
	usage?: { input: number; output: number; cost: number };
	/** Output tokens per second of the most recent assistant message. */
	tps?: number;
	/** What the agent is doing right now (tool call or response streaming). */
	activity?: string;
	/** Tail of the most recent assistant text, for live output previews. */
	outputTail?: string[];
	/** When the last agent run finished; cleared while running. Drives the "done" notifier. */
	finishedAt?: string;
	/** Agent-raised flag (via the pim_set_state tool) asking for the user's attention. */
	attention?: PimAttention;
}

const OUTPUT_TAIL_LINES = 40;
/** Per-line cap; generous because single-line paragraphs wrap to many card rows. */
const OUTPUT_TAIL_MAX_COLS = 2000;
const LOG_TEXT_LIMIT = 600;
const STREAM_WRITE_INTERVAL_MS = 150;

function extractAssistantText(message: AgentMessage): string {
	if (message.role !== "assistant" || !Array.isArray(message.content)) {
		return "";
	}
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function toLines(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0)
		.map((line) => line.slice(0, OUTPUT_TAIL_MAX_COLS));
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
	let finishedAt: string | undefined;
	let attention: PimAttention | undefined;
	const usageTotals = { input: 0, output: 0, cost: 0 };
	let tps: number | undefined;
	let messageStartedAt = 0;
	let lastStreamWrite = 0;

	// The preview accumulates across the whole run. Tool-calling models emit
	// many short assistant messages (one per tool round); rebuilding the tail
	// from only the current message would overwrite the preview each round.
	let runLines: string[] = [];

	const appendRunLines = (lines: string[]) => {
		runLines.push(...lines);
		if (runLines.length > OUTPUT_TAIL_LINES) {
			runLines = runLines.slice(-OUTPUT_TAIL_LINES);
		}
	};

	const tailWith = (partial: string): string[] | undefined => {
		const combined = [...runLines, ...toLines(partial)];
		return combined.length > 0 ? combined.slice(-OUTPUT_TAIL_LINES) : undefined;
	};

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
			tps,
			activity,
			outputTail,
			finishedAt,
			attention,
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
		runLines = [];
		outputTail = undefined;
		finishedAt = undefined;
		write(ctx);
		log("agent_start");
	});

	pi.on("message_start", async (event, ctx) => {
		if (event.message.role === "assistant") {
			messageStartedAt = Date.now();
		}
		if (event.message.role === "user") {
			// The user responded; whatever the agent was waiting on is being handled.
			if (attention) {
				attention = undefined;
				write(ctx);
			}
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
		outputTail = tailWith(text);
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
		const elapsedMs = messageStartedAt > 0 ? Date.now() - messageStartedAt : 0;
		if (elapsedMs > 500 && usage.output > 0) {
			tps = usage.output / (elapsedMs / 1000);
		}
		const text = extractAssistantText(event.message);
		if (text) {
			appendRunLines(toLines(text));
			outputTail = tailWith("");
			log("assistant_message", { text: text.slice(0, LOG_TEXT_LIMIT) });
		}
		write(ctx);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		activity = summarizeToolArgs(event.toolName, event.args);
		appendRunLines([`⚒ ${activity}`.slice(0, OUTPUT_TAIL_MAX_COLS)]);
		outputTail = tailWith("");
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
		finishedAt = new Date().toISOString();
		write(ctx);
		log("agent_end");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		state = "exited";
		activity = undefined;
		write(ctx);
		log("session_shutdown");
	});

	pi.registerTool(
		defineTool({
			name: "pim_set_state",
			label: "pim: flag dashboard state",
			description:
				"Flag this agent's card on the pim manager dashboard to get the user's attention. " +
				"Use state 'blocked' when you cannot proceed without the user (missing access, failing environment, destructive decision), " +
				"'question' when you need an answer or a choice from the user, and 'clear' once the flag no longer applies. " +
				"The note is displayed on the dashboard, so keep it short and specific (what you need, not what you did).",
			parameters: Type.Object({
				state: Type.Union([Type.Literal("blocked"), Type.Literal("question"), Type.Literal("clear")], {
					description: "The dashboard flag to set",
				}),
				note: Type.Optional(
					Type.String({ description: "Short note shown on the dashboard (required for blocked/question)" }),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (params.state === "clear") {
					attention = undefined;
				} else {
					attention = {
						kind: params.state,
						note: params.note?.trim() || "needs your attention",
						at: new Date().toISOString(),
					};
				}
				write(ctx);
				log("attention", { state: params.state, note: params.note });
				return {
					content: [{ type: "text", text: `Dashboard flag set to "${params.state}".` }],
					details: { state: params.state },
				};
			},
		}),
	);
}
