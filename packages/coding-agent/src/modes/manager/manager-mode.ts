/**
 * pim manager mode: a control surface for spawning and managing multiple pi
 * instances, scoped per project. Instances are full interactive pi processes
 * in detached tmux sessions on a private tmux server, so they keep running
 * while detached and survive manager restarts. Attaching hands the terminal
 * to the instance; ctrl+q detaches back to the manager. Instances can run in
 * isolated git worktrees for conflict-free parallel work.
 *
 * The board refreshes in near-realtime by watching the status directory that
 * instances write telemetry into (a slow interval remains as fallback for
 * tmux liveness and age labels). `h` swaps the board for a scrollable view of
 * the selected instance's rendered history. See docs/manager.md.
 */

import { spawn } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
import { type SelectItem, Text } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { createStartupTui, startStartupTui } from "../../cli/startup-ui.ts";
import { getAgentDir } from "../../config.ts";
import { AuthStorage } from "../../core/auth-storage.ts";
import { ModelRegistry } from "../../core/model-registry.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { ExtensionInputComponent } from "../interactive/components/extension-input.ts";
import { stopThemeWatcher, theme } from "../interactive/theme/theme.ts";
import {
	capturePaneHistory,
	claudeAvailable,
	formatInstanceCwd,
	getInstanceViews,
	getStatusDir,
	gitRepoRoot,
	type InstanceKind,
	type InstanceView,
	listWorktrees,
	markInstanceSeen,
	mergeInstanceBranch,
	projectRootFor,
	removeInstance,
	spawnInstance,
	tmuxAttachArgs,
	tmuxAvailable,
	type WorktreeChoice,
} from "./instances.ts";
import { ManagerComponent } from "./manager-component.ts";
import { ManagerHistoryComponent } from "./manager-history.ts";
import { ManagerSelectComponent } from "./manager-select.ts";

const REFRESH_INTERVAL_MS = 1000;

function attachTerminalSize(): { cols: number; rows: number } {
	return {
		cols: process.stdout.columns || 220,
		rows: process.stdout.rows || 50,
	};
}

async function runTmuxAttach(instanceId: string): Promise<void> {
	// Strip TMUX so attaching works when the manager itself runs inside tmux.
	const env = { ...process.env };
	delete env.TMUX;
	await new Promise<void>((resolve) => {
		const child = spawn("tmux", tmuxAttachArgs(instanceId), { stdio: "inherit", env });
		child.on("error", () => resolve());
		child.on("close", () => resolve());
	});
}

function listAvailableModelItems(): SelectItem[] {
	try {
		const registry = ModelRegistry.create(AuthStorage.create());
		return registry.getAvailable().map((model) => ({
			value: `${model.provider}/${model.id}`,
			label: `${model.provider}/${model.id}`,
			description: model.name,
		}));
	} catch {
		return [];
	}
}

export async function runManagerMode(): Promise<void> {
	if (process.platform === "win32") {
		console.error(chalk.red("Error: pi manager requires tmux and is not supported on Windows yet."));
		process.exit(1);
	}
	if (!tmuxAvailable()) {
		console.error(chalk.red("Error: pi manager requires tmux. Install it first (e.g. brew install tmux)."));
		process.exit(1);
	}

	const cwd = process.cwd();
	const projectRoot = projectRootFor(cwd);
	const settingsManager = SettingsManager.create(cwd, getAgentDir());
	const ui = await createStartupTui(settingsManager);
	const statusLine = new Text("", 1, 0);

	let refreshTimer: NodeJS.Timeout | undefined;
	let statusWatcher: FSWatcher | undefined;
	let busy = false;
	let showAll = false;
	let history: { component: ManagerHistoryComponent; instanceId: string } | undefined;

	const refresh = () => {
		if (history) {
			history.component.setLines(capturePaneHistory(history.instanceId));
		} else {
			manager.setInstances(getInstanceViews(showAll ? undefined : { projectRoot }));
		}
		ui.requestRender();
	};

	// Event-driven refresh: instances write status files on every agent event,
	// so watching the status dir makes state changes appear near-instantly.
	// A slower interval remains as fallback (tmux liveness, age labels).
	let lastRefresh = 0;
	let refreshQueued = false;
	const REFRESH_THROTTLE_MS = 80;
	const requestRefresh = () => {
		if (busy) return;
		const elapsed = Date.now() - lastRefresh;
		if (elapsed >= REFRESH_THROTTLE_MS) {
			lastRefresh = Date.now();
			refresh();
		} else if (!refreshQueued) {
			refreshQueued = true;
			setTimeout(() => {
				refreshQueued = false;
				lastRefresh = Date.now();
				refresh();
			}, REFRESH_THROTTLE_MS - elapsed);
		}
	};

	const startPolling = () => {
		refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS);
		try {
			statusWatcher = watch(getStatusDir(), { persistent: false }, () => requestRefresh());
		} catch {
			// fs.watch is best-effort; the interval still refreshes.
		}
	};
	const stopPolling = () => {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = undefined;
		}
		statusWatcher?.close();
		statusWatcher = undefined;
	};

	// The status indicator sweep animates off wall-clock time; while any agent
	// is working (or starting), repaint fast enough for it to look alive.
	const SPINNER_TICK_MS = 140;
	setInterval(() => {
		if (busy || history || !manager.hasAnimatedInstances()) return;
		requestRefresh();
	}, SPINNER_TICK_MS);
	const setStatus = (message: string) => {
		statusLine.setText(message);
		ui.requestRender();
	};

	const promptInput = (title: string): Promise<string | undefined> =>
		new Promise((resolve) => {
			let settled = false;
			const finish = (value: string | undefined) => {
				if (settled) return;
				settled = true;
				input.dispose();
				ui.removeChild(input);
				ui.setFocus(manager);
				ui.requestRender();
				resolve(value);
			};
			const input = new ExtensionInputComponent(
				title,
				undefined,
				(value) => finish(value),
				() => finish(undefined),
				{ tui: ui },
			);
			ui.addChild(input);
			ui.setFocus(input);
			ui.requestRender();
		});

	const promptSelect = (title: string, items: SelectItem[]): Promise<SelectItem | undefined> =>
		new Promise((resolve) => {
			let settled = false;
			const finish = (value: SelectItem | undefined) => {
				if (settled) return;
				settled = true;
				ui.removeChild(select);
				ui.setFocus(manager);
				ui.requestRender();
				resolve(value);
			};
			const select = new ManagerSelectComponent(
				title,
				items,
				(item) => finish(item),
				() => finish(undefined),
			);
			ui.addChild(select);
			ui.setFocus(select);
			ui.requestRender();
		});

	const attach = async (instance: InstanceView) => {
		if (busy || instance.state === "exited") return;
		busy = true;
		stopPolling();
		ui.stop();
		await runTmuxAttach(instance.id);
		markInstanceSeen(instance.id);
		ui.start();
		ui.requestRender(true);
		startPolling();
		refresh();
		busy = false;
	};

	const spawnFlow = async () => {
		if (busy) return;
		busy = true;
		stopPolling();

		const cancel = () => {
			startPolling();
			busy = false;
		};

		let kind: InstanceKind = "pi";
		if (claudeAvailable()) {
			const agentChoice = await promptSelect("Agent", [
				{ value: "pi", label: "π pi", description: "full telemetry, models, pim_set_state tool" },
				{ value: "claude", label: "✻ claude code", description: "telemetry via hooks (state, activity, preview)" },
			]);
			if (agentChoice === undefined) return cancel();
			kind = agentChoice.value as InstanceKind;
		}

		const name = await promptInput("New instance — name (enter for default)");
		if (name === undefined) return cancel();
		const task = await promptInput("Initial task (optional, enter to skip)");
		if (task === undefined) return cancel();

		let model: string | undefined;
		if (kind === "claude") {
			const choice = await promptSelect("Model", [
				{ value: "", label: "(default)", description: "claude code's configured default" },
				{ value: "fable", label: "fable", description: "Claude Fable 5" },
				{ value: "opus", label: "opus", description: "Claude Opus" },
				{ value: "sonnet", label: "sonnet", description: "Claude Sonnet" },
				{ value: "haiku", label: "haiku", description: "Claude Haiku" },
			]);
			if (choice === undefined) return cancel();
			model = choice.value || undefined;
		} else {
			const modelItems = listAvailableModelItems();
			if (modelItems.length > 0) {
				const choice = await promptSelect("Model", [
					{ value: "", label: "(default)", description: "use pi's default model" },
					...modelItems,
				]);
				if (choice === undefined) return cancel();
				model = choice.value || undefined;
			}
		}

		let worktree: WorktreeChoice | undefined;
		if (gitRepoRoot(cwd)) {
			const existing = listWorktrees(projectRoot).map((info) => ({
				value: `wt:${info.path}`,
				label: `⎇ ${info.branch}`,
				description: formatInstanceCwd(info.path),
			}));
			const choice = await promptSelect("Workspace", [
				{ value: "cwd", label: "Current directory", description: "shares files with other agents here" },
				{ value: "new", label: "New git worktree…", description: "isolated branch, merge back later" },
				...existing,
			]);
			if (choice === undefined) return cancel();
			if (choice.value === "new") {
				const worktreeName = await promptInput(`Worktree name (enter for "${name.trim() || "instance name"}")`);
				if (worktreeName === undefined) return cancel();
				worktree = { create: worktreeName.trim() || name };
			} else if (choice.value.startsWith("wt:")) {
				worktree = { existingPath: choice.value.slice(3) };
			}
		}

		startPolling();
		busy = false;
		try {
			const { cols, rows } = attachTerminalSize();
			const record = spawnInstance({
				name,
				cwd,
				initialPrompt: task.trim() || undefined,
				kind,
				model,
				worktree,
				cols,
				rows,
			});
			setStatus("");
			refresh();
			await attach({ ...record, state: "starting" });
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			setStatus(theme.fg("error", message));
		}
	};

	const closeHistory = () => {
		if (!history) return;
		ui.removeChild(history.component);
		history = undefined;
		ui.addChild(manager);
		ui.addChild(statusLine);
		ui.setFocus(manager);
		refresh();
		ui.requestRender(true);
	};

	const openHistory = (instance: InstanceView) => {
		if (busy || history) return;
		markInstanceSeen(instance.id);
		const component = new ManagerHistoryComponent(instance, capturePaneHistory(instance.id), closeHistory);
		history = { component, instanceId: instance.id };
		ui.removeChild(manager);
		ui.removeChild(statusLine);
		ui.addChild(component);
		ui.setFocus(component);
		ui.requestRender(true);
	};

	const merge = (instance: InstanceView) => {
		try {
			const result = mergeInstanceBranch(instance);
			if (result.ok) {
				setStatus(theme.fg("success", `Merged ${result.branch} into ${result.targetBranch}.`));
			} else {
				setStatus(theme.fg("error", `Merge failed: ${result.output.split("\n")[0] ?? "unknown error"}`));
			}
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			setStatus(theme.fg("error", message));
		}
	};

	const quit = () => {
		stopPolling();
		ui.stop();
		stopThemeWatcher();
		const running = getInstanceViews().filter((instance) => instance.state !== "exited").length;
		if (running > 0) {
			console.log(
				`pim: ${running} instance${running === 1 ? "" : "s"} still running. Run pim again to manage them.`,
			);
		}
		process.exit(0);
	};

	const manager = new ManagerComponent(projectRoot, {
		onAttach: (instance) => void attach(instance),
		onNew: () => void spawnFlow(),
		onKill: (instance) => {
			removeInstance(instance.id);
			refresh();
		},
		onMerge: merge,
		onHistory: (instance) => openHistory(instance),
		onToggleScope: () => {
			showAll = !showAll;
			manager.setScope(showAll);
			refresh();
		},
		onQuit: quit,
	});

	ui.addChild(manager);
	ui.addChild(statusLine);
	ui.setFocus(manager);
	startStartupTui(ui, settingsManager);
	refresh();
	startPolling();

	// Keep the process alive; quit() exits explicitly.
	await new Promise<never>(() => {});
}
