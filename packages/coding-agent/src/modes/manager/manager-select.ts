/**
 * Filterable select dialog for the pim manager (model / workspace pickers).
 * Wraps the tui SelectList with a typed substring filter.
 */

import { Container, type SelectItem, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import { DynamicBorder } from "../interactive/components/dynamic-border.ts";
import { keyHint, rawKeyHint } from "../interactive/components/keybinding-hints.ts";
import { getSelectListTheme, theme } from "../interactive/theme/theme.ts";

const MAX_VISIBLE_ITEMS = 10;

export class ManagerSelectComponent extends Container {
	private readonly allItems: SelectItem[];
	private readonly listHolder: Container;
	private readonly filterText: Text;
	private list: SelectList;
	private filter = "";
	private readonly onSelectCallback: (item: SelectItem) => void;
	private readonly onCancelCallback: () => void;

	constructor(title: string, items: SelectItem[], onSelect: (item: SelectItem) => void, onCancel: () => void) {
		super();
		this.allItems = items;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		this.filterText = new Text("", 1, 0);
		this.addChild(this.filterText);
		this.addChild(new Spacer(1));
		this.listHolder = new Container();
		this.addChild(this.listHolder);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				`${rawKeyHint("↑↓", "navigate")}  ${rawKeyHint("type", "filter")}  ${keyHint("tui.select.confirm", "select")}  ${keyHint("tui.select.cancel", "cancel")}`,
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.list = this.buildList();
		this.listHolder.addChild(this.list);
	}

	private buildList(): SelectList {
		const query = this.filter.toLowerCase();
		const filtered =
			query.length === 0
				? this.allItems
				: this.allItems.filter(
						(item) =>
							item.value.toLowerCase().includes(query) || (item.label ?? "").toLowerCase().includes(query),
					);
		const list = new SelectList(filtered, MAX_VISIBLE_ITEMS, getSelectListTheme(), { maxPrimaryColumnWidth: 48 });
		list.onSelect = (item) => this.onSelectCallback(item);
		list.onCancel = () => this.onCancelCallback();
		return list;
	}

	private applyFilter(): void {
		this.filterText.setText(this.filter.length > 0 ? theme.fg("muted", `filter: ${this.filter}`) : "");
		this.listHolder.clear();
		this.list = this.buildList();
		this.listHolder.addChild(this.list);
	}

	handleInput(keyData: string): void {
		if (keyData === "\x7f" || keyData === "\b") {
			if (this.filter.length > 0) {
				this.filter = this.filter.slice(0, -1);
				this.applyFilter();
			}
			return;
		}
		if (keyData.length === 1 && keyData >= " " && keyData <= "~") {
			this.filter += keyData;
			this.applyFilter();
			return;
		}
		this.list.handleInput(keyData);
	}
}
