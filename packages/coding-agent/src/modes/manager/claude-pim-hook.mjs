/**
 * Claude Code → pim telemetry adapter.
 *
 * pim spawns Claude Code instances with a generated --settings file that
 * routes every lifecycle hook through this script. It translates hook events
 * into the same status-file contract the pi telemetry extension writes, so
 * Claude agents get live cards on the pim board (state, activity, transcript
 * preview, done notifier, and question attention via Notification hooks).
 *
 * Plain .mjs: hooks run it directly with node, outside pi's loader.
 * State that must survive between hook invocations lives in the status file.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const OUTPUT_TAIL_LINES = 40;
const NOTE_LIMIT = 300;
const LOG_TEXT_LIMIT = 600;

const statusFile = process.env.PIM_STATUS_FILE;
if (!statusFile) {
	process.exit(0);
}
const logFile = process.env.PIM_LOG_FILE;

function readStdin() {
	try {
		return JSON.parse(readFileSync(0, "utf8"));
	} catch {
		return {};
	}
}

function readStatus() {
	try {
		return JSON.parse(readFileSync(statusFile, "utf8"));
	} catch {
		return { state: "idle", pid: process.pid };
	}
}

function writeStatus(status) {
	status.updatedAt = new Date().toISOString();
	try {
		mkdirSync(dirname(statusFile), { recursive: true });
		const tmpFile = `${statusFile}.${process.pid}.tmp`;
		writeFileSync(tmpFile, JSON.stringify(status), "utf8");
		renameSync(tmpFile, statusFile);
	} catch {
		// Telemetry must never break the instance.
	}
}

function log(event, fields = {}) {
	if (!logFile) return;
	try {
		mkdirSync(dirname(logFile), { recursive: true });
		appendFileSync(logFile, `${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`, "utf8");
	} catch {
		// Telemetry must never break the instance.
	}
}

function appendTail(status, line) {
	const tail = Array.isArray(status.outputTail) ? status.outputTail : [];
	tail.push(line);
	status.outputTail = tail.slice(-OUTPUT_TAIL_LINES);
}

function summarizeToolInput(toolName, toolInput) {
	if (toolInput && typeof toolInput === "object") {
		for (const key of ["command", "path", "file_path", "pattern", "url", "prompt", "description"]) {
			if (typeof toolInput[key] === "string" && toolInput[key].length > 0) {
				return `${toolName}: ${toolInput[key].replaceAll("\n", " ").slice(0, 200)}`;
			}
		}
	}
	return toolName;
}

/**
 * Last assistant text of the current run from a Claude Code transcript.
 * Parsed line by line so a partially flushed trailing line never aborts the
 * scan; entries older than the run are ignored so a slow flush can't serve a
 * previous response.
 */
function lastAssistantText(transcriptPath, sinceIso) {
	let lines;
	try {
		lines = readFileSync(transcriptPath, "utf8").trimEnd().split("\n");
	} catch {
		return undefined;
	}
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const entry = JSON.parse(lines[i]);
			if (entry.type !== "assistant" || !Array.isArray(entry.message?.content)) continue;
			if (sinceIso && typeof entry.timestamp === "string" && entry.timestamp < sinceIso) continue;
			const text = entry.message.content
				.filter((block) => block.type === "text" && typeof block.text === "string")
				.map((block) => block.text)
				.join("\n")
				.trim();
			if (text) return text;
		} catch {
			// Skip malformed/partial lines and keep scanning.
		}
	}
	return undefined;
}

/** The final transcript flush can land after the Stop hook fires; retry briefly. */
async function awaitAssistantText(transcriptPath, sinceIso) {
	for (let attempt = 0; attempt < 4; attempt++) {
		const text = lastAssistantText(transcriptPath, sinceIso);
		if (text) return text;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return undefined;
}

const input = readStdin();
const event = input.hook_event_name ?? process.argv[2] ?? "";
const status = readStatus();
status.pid = process.pid;

switch (event) {
	case "SessionStart": {
		status.state = "idle";
		log("session_start", { source: input.source });
		break;
	}
	case "UserPromptSubmit": {
		status.state = "working";
		status.activity = "thinking";
		status.attention = undefined;
		status.finishedAt = undefined;
		status.outputTail = [];
		status.runStartedAt = new Date().toISOString();
		log("user_message", { text: String(input.prompt ?? "").slice(0, LOG_TEXT_LIMIT) });
		break;
	}
	case "PreToolUse": {
		status.state = "working";
		status.activity = summarizeToolInput(input.tool_name ?? "tool", input.tool_input);
		appendTail(status, `⚒ ${status.activity}`);
		log("tool_start", { tool: input.tool_name, summary: status.activity });
		break;
	}
	case "PostToolUse": {
		status.state = "working";
		status.activity = "thinking";
		log("tool_end", { tool: input.tool_name });
		break;
	}
	case "Notification": {
		// Claude Code notifies when it needs permission or input — surface it
		// as a question flag so the board pulls the user in.
		const note = String(input.message ?? "needs your attention").slice(0, NOTE_LIMIT);
		status.attention = { kind: "question", note, at: new Date().toISOString() };
		log("attention", { state: "question", note });
		break;
	}
	case "Stop":
	case "SubagentStop": {
		if (event === "Stop") {
			status.state = "idle";
			status.activity = undefined;
			status.finishedAt = new Date().toISOString();
			const text = input.transcript_path
				? await awaitAssistantText(input.transcript_path, status.runStartedAt)
				: undefined;
			if (text) {
				const lines = text
					.split("\n")
					.map((line) => line.trimEnd())
					.filter((line) => line.length > 0);
				for (const line of lines.slice(-OUTPUT_TAIL_LINES)) appendTail(status, line);
				log("assistant_message", { text: text.slice(0, LOG_TEXT_LIMIT) });
			}
			log("agent_end");
		}
		break;
	}
	case "SessionEnd": {
		status.state = "exited";
		status.activity = undefined;
		log("session_shutdown");
		break;
	}
	default:
		process.exit(0);
}

writeStatus(status);
