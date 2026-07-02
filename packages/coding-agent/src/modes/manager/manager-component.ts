/**
 * TUI component for the pim manager: live instance cards with
 * spawn / attach / kill / merge actions.
 */

import { Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import { DynamicBorder } from "../interactive/components/dynamic-border.ts";
import { keyHint, rawKeyHint } from "../interactive/components/keybinding-hints.ts";
import { theme } from "../interactive/theme/theme.ts";
import { InstanceCard } from "./instance-card.ts";
import { formatInstanceCwd, type InstanceView } from "./instances.ts";

export interface ManagerCallbacks {
	onAttach(instance: InstanceView): void;
	onNew(): void;
	onKill(instance: InstanceView): void;
	onMerge(instance: InstanceView): void;
	onQuit(): void;
}

type ArmedAction = { key: "x" | "m"; instanceId: string } | undefined;

export class ManagerComponent extends Container {
	private instances: InstanceView[] = [];
	private selectedId: string | undefined;
	private armed: ArmedAction;
	private readonly callbacks: ManagerCallbacks;
	private readonly headerText: Text;
	private readonly listContainer: Container;
	private readonly footerText: Text;
	private readonly cwd: string;

	constructor(cwd: string, callbacks: ManagerCallbacks) {
		super();
		this.callbacks = callbacks;
		this.cwd = cwd;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.headerText = new Text("", 1, 0);
		this.setHeader();
		this.addChild(this.headerText);
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));
		this.footerText = new Text("", 1, 0);
		this.addChild(this.footerText);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.updateList();
	}

	private setHeader(): void {
		const counts = {
			working: this.instances.filter((instance) => instance.state === "working").length,
			total: this.instances.length,
		};
		const summary =
			counts.total === 0
				? ""
				: theme.fg(
						"dim",
						` · ${counts.total} instance${counts.total === 1 ? "" : "s"} · ${counts.working} working`,
					);
		this.headerText.setText(
			theme.fg("accent", theme.bold("pim — agent manager")) +
				theme.fg("dim", `  ${formatInstanceCwd(this.cwd)}`) +
				summary,
		);
	}

	setInstances(instances: InstanceView[]): void {
		this.instances = instances;
		if (this.selectedId === undefined || !instances.some((instance) => instance.id === this.selectedId)) {
			this.selectedId = instances[0]?.id;
		}
		if (this.armed !== undefined && !instances.some((instance) => instance.id === this.armed?.instanceId)) {
			this.armed = undefined;
		}
		this.setHeader();
		this.updateList();
	}

	private selectedInstance(): InstanceView | undefined {
		return this.instances.find((instance) => instance.id === this.selectedId);
	}

	private moveSelection(delta: number): void {
		if (this.instances.length === 0) return;
		const currentIndex = this.instances.findIndex((instance) => instance.id === this.selectedId);
		const nextIndex = Math.min(
			this.instances.length - 1,
			Math.max(0, (currentIndex === -1 ? 0 : currentIndex) + delta),
		);
		this.selectedId = this.instances[nextIndex].id;
		this.armed = undefined;
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		if (this.instances.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "No agent instances. Press n to spawn one."), 1, 0));
			this.updateFooter();
			return;
		}

		let first = true;
		for (const instance of this.instances) {
			if (!first) {
				this.listContainer.addChild(new Spacer(1));
			}
			first = false;
			this.listContainer.addChild(new InstanceCard(instance, instance.id === this.selectedId));
		}
		this.updateFooter();
	}

	private updateFooter(): void {
		if (this.armed !== undefined) {
			const instance = this.instances.find((entry) => entry.id === this.armed?.instanceId);
			const action =
				this.armed.key === "x"
					? "kill"
					: `merge ${instance?.worktree?.branch ?? "branch"} into ${instance?.worktree?.baseBranch ?? "base"} for`;
			this.footerText.setText(
				theme.fg(
					"warning",
					`Press ${this.armed.key} again to ${action} "${instance?.name ?? this.armed.instanceId}", any other key to cancel`,
				),
			);
			return;
		}
		const selected = this.selectedInstance();
		const hints = [
			rawKeyHint("n", "new"),
			rawKeyHint("enter", "attach"),
			rawKeyHint("↑↓", "navigate"),
			rawKeyHint("x", "kill"),
		];
		if (selected?.worktree) {
			hints.push(rawKeyHint("m", "merge"));
		}
		hints.push(keyHint("tui.select.cancel", "quit"));
		this.footerText.setText(hints.join("  "));
	}

	private handleArmedKey(key: "x" | "m", instance: InstanceView, action: (instance: InstanceView) => void): void {
		if (this.armed?.key === key && this.armed.instanceId === instance.id) {
			this.armed = undefined;
			action(instance);
		} else {
			this.armed = { key, instanceId: instance.id };
		}
		this.updateList();
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		const armedBefore = this.armed;
		this.armed = undefined;

		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.moveSelection(-1);
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.moveSelection(1);
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const instance = this.selectedInstance();
			if (instance) this.callbacks.onAttach(instance);
		} else if (keyData === "n") {
			this.callbacks.onNew();
		} else if (keyData === "x") {
			const instance = this.selectedInstance();
			if (instance) {
				this.armed = armedBefore;
				this.handleArmedKey("x", instance, this.callbacks.onKill.bind(this.callbacks));
			}
		} else if (keyData === "m") {
			const instance = this.selectedInstance();
			if (instance?.worktree) {
				this.armed = armedBefore;
				this.handleArmedKey("m", instance, this.callbacks.onMerge.bind(this.callbacks));
			} else {
				this.updateList();
			}
		} else if (keyData === "q" || kb.matches(keyData, "tui.select.cancel")) {
			this.callbacks.onQuit();
		} else {
			this.updateList();
		}
	}
}
