/**
 * TUI component for the pim manager: live instance cards with
 * spawn / attach / kill / merge actions, scoped per project.
 */

import { Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import { InstanceGrid } from "./instance-grid.ts";
import { formatInstanceCwd, type InstanceView } from "./instances.ts";
import { pim } from "./pim-theme.ts";

export interface ManagerCallbacks {
	onAttach(instance: InstanceView): void;
	onNew(): void;
	onKill(instance: InstanceView): void;
	onMerge(instance: InstanceView): void;
	onHistory(instance: InstanceView): void;
	onToggleScope(): void;
	onQuit(): void;
}

type ArmedAction = { key: "x" | "m"; instanceId: string } | undefined;

export class ManagerComponent extends Container {
	private instances: InstanceView[] = [];
	private selectedId: string | undefined;
	private armed: ArmedAction;
	private showingAll = false;
	private readonly callbacks: ManagerCallbacks;
	private readonly headerText: Text;
	private readonly listContainer: Container;
	private readonly grid = new InstanceGrid();
	private readonly footerText: Text;
	private readonly projectRoot: string;

	constructor(projectRoot: string, callbacks: ManagerCallbacks) {
		super();
		this.callbacks = callbacks;
		this.projectRoot = projectRoot;

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

		this.updateList();
	}

	private setHeader(): void {
		const working = this.instances.filter((instance) => instance.state === "working").length;
		const attention = this.instances.filter((instance) => instance.status?.attention).length;
		const scope = this.showingAll ? pim.yellow("all projects") : pim.muted(formatInstanceCwd(this.projectRoot));
		const counts =
			this.instances.length === 0
				? ""
				: pim.sep() +
					pim.dim(`${this.instances.length} agent${this.instances.length === 1 ? "" : "s"} · ${working} working`);
		const needsYou =
			attention === 0
				? ""
				: pim.sep() +
					(this.instances.some((instance) => instance.status?.attention?.kind === "blocked")
						? pim.red
						: pim.yellow)(`${attention} need${attention === 1 ? "s" : ""} you`);
		this.headerText.setText(`${pim.logo()}  ${scope}${counts}${needsYou}`);
	}

	setScope(showingAll: boolean): void {
		this.showingAll = showingAll;
		this.setHeader();
		this.updateFooter();
	}

	/** Whether any visible instance has an animated status indicator. */
	hasAnimatedInstances(): boolean {
		return this.instances.some(
			(instance) =>
				instance.state === "working" || instance.state === "starting" || instance.status?.attention !== undefined,
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
			this.listContainer.addChild(new Text(pim.muted("nothing running here yet"), 1, 0));
			this.listContainer.addChild(
				new Text(
					pim.dim(`spawn an agent with n${this.showingAll ? "" : " · press a to see other projects"}`),
					1,
					0,
				),
			);
			this.updateFooter();
			return;
		}

		this.grid.setData(this.instances, this.selectedId);
		this.listContainer.addChild(this.grid);
		this.updateFooter();
	}

	private updateFooter(): void {
		if (this.armed !== undefined) {
			const instance = this.instances.find((entry) => entry.id === this.armed?.instanceId);
			const action = this.armed.key === "x" ? "kill" : `merge ${instance?.worktree?.branch ?? "branch"} back for`;
			this.footerText.setText(
				pim.yellow(
					`press ${this.armed.key} again to ${action} "${instance?.name ?? this.armed.instanceId}" · any other key cancels`,
				),
			);
			return;
		}
		const selected = this.selectedInstance();
		const hints = [pim.key("n", "new"), pim.key("↵", "attach"), pim.key("↑↓←→", "move")];
		if (selected) {
			hints.push(pim.key("h", "history"));
		}
		hints.push(pim.key("x", "kill"));
		if (selected?.worktree) {
			hints.push(pim.key("m", "merge"));
		}
		hints.push(pim.key("a", this.showingAll ? "this project" : "all projects"));
		hints.push(pim.key("q", "quit"));
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
			this.moveSelection(-this.grid.getCols());
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.moveSelection(this.grid.getCols());
		} else if (kb.matches(keyData, "tui.editor.cursorLeft")) {
			this.moveSelection(-1);
		} else if (kb.matches(keyData, "tui.editor.cursorRight")) {
			this.moveSelection(1);
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const instance = this.selectedInstance();
			if (instance) this.callbacks.onAttach(instance);
		} else if (keyData === "n") {
			this.callbacks.onNew();
		} else if (keyData === "a") {
			this.callbacks.onToggleScope();
		} else if (keyData === "h") {
			const instance = this.selectedInstance();
			if (instance) this.callbacks.onHistory(instance);
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
