/**
 * TUI component for the pim manager: live instance cards with
 * spawn / attach / kill / merge actions, scoped per project.
 */

import { Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import { WheelSwipeDetector } from "./gesture.ts";
import { InstanceGrid } from "./instance-grid.ts";
import { capturePaneHistory, formatInstanceCwd, type InstanceView } from "./instances.ts";
import { pim } from "./pim-theme.ts";

export interface ManagerCallbacks {
	onAttach(instance: InstanceView): void;
	onNew(): void;
	onKill(instance: InstanceView): void;
	onMerge(instance: InstanceView): void;
	onHistory(instance: InstanceView): void;
	onToggleScope(): void;
	onQuit(): void;
	/** Rendered content height of the TUI, for mapping mouse rows to content lines. */
	getContentHeight(): number;
}

/** SGR mouse events: ESC [ < button ; col ; row (M=press/wheel, m=release). */
const MOUSE_EVENT_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const WHEEL_STEP = 3;
const SCROLLBACK_CACHE_TTL_MS = 1500;

type ArmedAction = { key: "x" | "m"; instanceId: string } | undefined;

export class ManagerComponent extends Container {
	private instances: InstanceView[] = [];
	private selectedId: string | undefined;
	private armed: ArmedAction;
	private showingAll = false;
	/**
	 * Per-instance scrollback anchors while the user wheel-browses a card:
	 * the absolute line index just below the visible window, so appended
	 * output never drags the view.
	 */
	private readonly scrollAnchors = new Map<string, number>();
	private readonly scrollbackCache = new Map<string, { lines: string[]; at: number }>();
	/** Two-finger swipe = back (axis-locked; see gesture.ts). */
	private readonly swipe = new WheelSwipeDetector();
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
		for (const id of this.scrollAnchors.keys()) {
			if (!instances.some((instance) => instance.id === id)) {
				this.scrollAnchors.delete(id);
				this.scrollbackCache.delete(id);
			}
		}
		this.setHeader();
		this.updateList();
	}

	/** Where the user is browsing an instance's scrollback, if they are. */
	browsePositionFor(id: string): number | undefined {
		return this.scrollAnchors.get(id);
	}

	/** Scrollback lines for a card being wheel-browsed (briefly cached). */
	private scrollbackFor(id: string): string[] {
		const cached = this.scrollbackCache.get(id);
		if (cached && Date.now() - cached.at < SCROLLBACK_CACHE_TTL_MS) {
			return cached.lines;
		}
		const lines = capturePaneHistory(id) ?? [];
		this.scrollbackCache.set(id, { lines, at: Date.now() });
		return lines;
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

		const decorated = this.instances.map((instance) => {
			const anchor = this.scrollAnchors.get(instance.id);
			if (anchor === undefined) return instance;
			const lines = this.scrollbackFor(instance.id);
			return { ...instance, scrollback: { lines, bottomIndex: Math.max(1, Math.min(anchor, lines.length)) } };
		});
		this.grid.setData(decorated, this.selectedId);
		this.listContainer.addChild(this.grid);
		this.updateFooter();
	}

	/** Handle SGR mouse events; returns true when the chunk contained any. */
	private handleMouse(data: string): boolean {
		let handled = false;
		MOUSE_EVENT_RE.lastIndex = 0;
		for (const match of data.matchAll(MOUSE_EVENT_RE)) {
			handled = true;
			const button = Number.parseInt(match[1], 10);
			const col = Number.parseInt(match[2], 10) - 1;
			const row = Number.parseInt(match[3], 10) - 1;
			const isPress = match[4] === "M";

			if (button >= 64 && button <= 67) {
				const isHorizontal = button === 66 || button === 67;
				if (this.swipe.feed(isHorizontal ? "h" : "v") && this.scrollAnchors.size > 0) {
					// Swipe = back: snap all browsed cards to their live tail.
					this.scrollAnchors.clear();
					this.scrollbackCache.clear();
					this.updateList();
				}
				if (isHorizontal) {
					continue;
				}
			}

			// Map the screen row to a content line: the renderer shows the last
			// terminal-height lines of the content. The grid sits below a
			// spacer, the header (which may wrap), and another spacer.
			const terminalRows = process.stdout.rows || 40;
			const terminalCols = process.stdout.columns || 80;
			const viewportTop = Math.max(0, this.callbacks.getContentHeight() - terminalRows);
			const gridTop = 2 + this.headerText.render(terminalCols).length;
			const gridLine = viewportTop + row - gridTop;
			const hit = this.grid.hitTest(col, gridLine);
			if (!hit) continue;

			if (button === 64 || button === 65) {
				// Wheel: browse the card's scrollback. The anchor is an
				// absolute line index, so live output never drags the view.
				const lines = this.scrollbackFor(hit.id);
				const current = this.scrollAnchors.get(hit.id) ?? lines.length;
				const next = button === 64 ? Math.max(1, current - WHEEL_STEP) : current + WHEEL_STEP;
				if (next < lines.length) {
					this.scrollAnchors.set(hit.id, next);
				} else {
					this.scrollAnchors.delete(hit.id);
					this.scrollbackCache.delete(hit.id);
				}
				this.updateList();
			} else if (button === 0 && isPress) {
				// Click: select; clicking the selected card attaches.
				if (this.selectedId === hit.id) {
					this.callbacks.onAttach(hit);
				} else {
					this.selectedId = hit.id;
					this.armed = undefined;
					this.updateList();
				}
			}
		}
		return handled;
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
		if (this.handleMouse(keyData)) {
			return;
		}
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
