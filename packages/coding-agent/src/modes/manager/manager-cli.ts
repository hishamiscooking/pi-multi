/**
 * Headless CLI API for the pim manager. Everything the TUI can do is exposed
 * as `pi manager <command>` so scripts and orchestrator agents can inspect
 * and drive the instance board:
 *
 *   pi manager status --json          full state of every instance
 *   pi manager spawn --name a --task "..." [--model m] [--worktree]
 *   pi manager send <id|name> "..."   submit a prompt to a running instance
 *   pi manager peek <id|name>         current terminal screen of an instance
 *   pi manager log <id|name> [-n N]   recent activity events (JSONL)
 *   pi manager merge <id|name>        merge the instance worktree branch back
 *   pi manager kill <id|name>
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import chalk from "chalk";
import {
	capturePane,
	findInstance,
	formatInstanceCwd,
	getInstanceViews,
	getLogFilePath,
	type InstanceRecord,
	type InstanceView,
	markInstanceSeen,
	mergeInstanceBranch,
	projectRootFor,
	removeInstance,
	sendPrompt,
	spawnInstance,
	tmuxAttachArgs,
	tmuxAvailable,
	type WorktreeChoice,
} from "./instances.ts";
import { runSpinnerGallery } from "./spinner-gallery.ts";

const HELP = `pi manager — multi-instance agent manager

Usage:
  pi manager                          Open the manager TUI
  pi manager status [--all] [--json]  Show instances for this project (--all: every project)
  pi manager spawn [options]          Spawn a detached instance
      --name <name>                   Instance name
      --task <text>                   Initial task prompt
      --model <pattern>               Model pattern (e.g. sonnet, openai/gpt-5)
      --worktree [name]               Run in a new isolated git worktree (branch pim/<name>)
      --worktree-path <path>          Run in an existing worktree checkout
      --cwd <dir>                     Working directory (default: current)
      --json                          Print the created instance as JSON
  pi manager send <id|name> <text>    Submit a prompt to an instance
  pi manager peek <id|name>           Print the instance's current screen
  pi manager log <id|name> [-n N]     Print recent activity events (default 20)
  pi manager attach <id|name>         Attach this terminal to an instance
  pi manager merge <id|name>          Merge the instance's worktree branch into
                                      the branch checked out in the main repo
  pi manager kill <id|name>           Kill an instance (worktree is kept)
  pi manager spinners                 Browse candidate status animations (live)
`;

function fail(message: string): never {
	console.error(chalk.red(`Error: ${message}`));
	process.exit(1);
}

function requireInstance(idOrName: string | undefined): InstanceRecord {
	if (!idOrName) {
		fail("Missing instance id or name.");
	}
	const record = findInstance(idOrName);
	if (!record) {
		fail(`No instance matching "${idOrName}". Run: pi manager status`);
	}
	return record;
}

function describeView(view: InstanceView): string {
	const parts = [
		view.id,
		view.name.padEnd(20),
		view.state.padEnd(8),
		(view.status?.model ?? view.model ?? "-").padEnd(28),
		view.worktree ? `⎇ ${view.worktree.branch}` : formatInstanceCwd(view.cwd),
	];
	const attention = view.status?.attention;
	if (attention) {
		parts.push(`| ${attention.kind === "blocked" ? "BLOCKED" : "QUESTION"}: ${attention.note}`);
	} else if (view.state === "working" && view.status?.activity) {
		parts.push(`| ${view.status.activity}`);
	}
	return parts.join("  ");
}

function commandStatus(flags: Set<string>): void {
	const views = getInstanceViews(flags.has("--all") ? undefined : { projectRoot: projectRootFor(process.cwd()) });
	if (flags.has("--json")) {
		console.log(JSON.stringify(views, undefined, 2));
		return;
	}
	if (views.length === 0) {
		console.log(
			"No instances in this project. Spawn one with: pi manager spawn --name my-agent --task '...' (or use --all)",
		);
		return;
	}
	for (const view of views) {
		console.log(describeView(view));
	}
}

interface SpawnCliOptions {
	name?: string;
	task?: string;
	model?: string;
	cwd: string;
	worktree?: WorktreeChoice;
	json: boolean;
}

function parseSpawnArgs(args: string[]): SpawnCliOptions {
	const result: SpawnCliOptions = { cwd: process.cwd(), json: false };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--name" && i + 1 < args.length) result.name = args[++i];
		else if (arg === "--task" && i + 1 < args.length) result.task = args[++i];
		else if (arg === "--model" && i + 1 < args.length) result.model = args[++i];
		else if (arg === "--cwd" && i + 1 < args.length) result.cwd = args[++i];
		else if (arg === "--worktree") {
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				result.worktree = { create: next };
				i++;
			} else {
				result.worktree = { create: "" };
			}
		} else if (arg === "--worktree-path" && i + 1 < args.length) result.worktree = { existingPath: args[++i] };
		else if (arg === "--json") result.json = true;
		else fail(`Unknown spawn option: ${arg}`);
	}
	return result;
}

function commandSpawn(args: string[]): void {
	const options = parseSpawnArgs(args);
	const record = spawnInstance({
		name: options.name,
		cwd: options.cwd,
		initialPrompt: options.task,
		model: options.model,
		worktree: options.worktree,
	});
	if (options.json) {
		console.log(JSON.stringify(record, undefined, 2));
	} else {
		const where = record.worktree ? `worktree ${record.worktree.branch}` : formatInstanceCwd(record.cwd);
		console.log(`Spawned ${record.name} (${record.id}) in ${where}.`);
	}
}

function commandLog(idOrName: string | undefined, args: string[]): void {
	const record = requireInstance(idOrName);
	let count = 20;
	const nIndex = args.indexOf("-n");
	if (nIndex !== -1 && nIndex + 1 < args.length) {
		count = Number.parseInt(args[nIndex + 1], 10) || count;
	}
	const logFile = getLogFilePath(record.id);
	if (!existsSync(logFile)) {
		console.log("(no activity logged yet)");
		return;
	}
	const lines = readFileSync(logFile, "utf8").trimEnd().split("\n");
	for (const line of lines.slice(-count)) {
		console.log(line);
	}
}

async function commandAttach(idOrName: string | undefined): Promise<void> {
	const record = requireInstance(idOrName);
	const env = { ...process.env };
	delete env.TMUX;
	await new Promise<void>((resolve) => {
		const child = spawn("tmux", tmuxAttachArgs(record.id), { stdio: "inherit", env });
		child.on("error", () => resolve());
		child.on("close", () => resolve());
	});
	markInstanceSeen(record.id);
}

function commandMerge(idOrName: string | undefined): void {
	const record = requireInstance(idOrName);
	const result = mergeInstanceBranch(record);
	if (result.output) {
		console.log(result.output);
	}
	if (!result.ok) {
		fail(`Merge of ${result.branch} into ${result.targetBranch} failed (see output above).`);
	}
	console.log(`Merged ${result.branch} into ${result.targetBranch}.`);
}

/** Handle `pi manager <subcommand>`. `args` excludes the leading "manager". */
export async function runManagerCli(args: string[]): Promise<void> {
	if (!tmuxAvailable()) {
		fail("pi manager requires tmux. Install it first (e.g. brew install tmux).");
	}
	const [command, ...rest] = args;
	switch (command) {
		case "status":
			commandStatus(new Set(rest));
			return;
		case "spawn":
			commandSpawn(rest);
			return;
		case "send": {
			const record = requireInstance(rest[0]);
			const text = rest.slice(1).join(" ").trim();
			if (!text) {
				fail("Missing prompt text: pi manager send <id|name> <text>");
			}
			sendPrompt(record.id, text);
			console.log(`Sent to ${record.name} (${record.id}).`);
			return;
		}
		case "peek": {
			const record = requireInstance(rest[0]);
			console.log(capturePane(record.id));
			return;
		}
		case "log":
			commandLog(rest[0], rest.slice(1));
			return;
		case "attach":
			await commandAttach(rest[0]);
			return;
		case "merge":
			commandMerge(rest[0]);
			return;
		case "kill": {
			const record = requireInstance(rest[0]);
			removeInstance(record.id);
			console.log(
				`Killed ${record.name} (${record.id}).${record.worktree ? ` Worktree kept at ${record.worktree.path}.` : ""}`,
			);
			return;
		}
		case "spinners":
			await runSpinnerGallery();
			return;
		case "help":
		case "--help":
		case "-h":
			console.log(HELP);
			return;
		default:
			fail(`Unknown manager command: ${command ?? ""}\n\n${HELP}`);
	}
}
