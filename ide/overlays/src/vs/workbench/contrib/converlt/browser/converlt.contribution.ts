/*---------------------------------------------------------------------------------------------
 *  Converlt workbench: Dashboard/Code modes and the title-bar compute + credits controls.
 *  The Converlt extension owns the data and the screens; it pushes a small status snapshot
 *  here through the `converlt.titleBar.setState` command.
 *--------------------------------------------------------------------------------------------*/

import './media/converlt.css';
import * as dom from '../../../../base/browser/dom.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';

// ------------------------------------------------------------------ state from the extension

export interface ConverltTitleState {
	connected: boolean;
	/** Credits, or null when unknown. */
	balance: number | null;
	burnPerHour: number;
	/** The machine runs launch on by default. */
	target: { label: string; detail?: string; status: 'running' | 'starting' | 'stopped' | 'ready' | 'unreachable' | 'none' } | null;
	tooltip?: string;
}

const onDidChangeState = new Emitter<void>();
let titleState: ConverltTitleState | null = null;

function isState(v: unknown): v is ConverltTitleState {
	return !!v && typeof v === 'object' && typeof (v as ConverltTitleState).connected === 'boolean';
}

const ConverltReady = new RawContextKey<boolean>('converlt.ready', false, localize('converlt.ready', "Whether the Converlt extension has reported its status"));
export const ConverltMode = new RawContextKey<'dashboard' | 'code'>('converlt.mode', 'code', localize('converlt.mode', "Whether Converlt shows the dashboard or the code editor"));

const DASHBOARD_COMMAND = 'converge.openDashboard';
const DASHBOARD_VIEW_TYPE = 'converge.dashboard';
const STARTUP_SETTING = 'converlt.startup';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'converlt',
	title: localize('converltConfigurationTitle', "Converlt"),
	type: 'object',
	properties: {
		[STARTUP_SETTING]: {
			type: 'string',
			enum: ['dashboard', 'code'],
			enumDescriptions: [
				localize('converlt.startup.dashboard', "Open new windows on the Converlt dashboard: projects, credits, GPUs and runs."),
				localize('converlt.startup.code', "Open new windows in the code editor."),
			],
			default: 'dashboard',
			description: localize('converlt.startup', "What a new Converlt window shows first."),
		},
	},
});

// ------------------------------------------------------------------ dashboard / code modes

/**
 * Dashboard mode gives the whole window to the Converlt dashboard: side bars, panel, status
 * bar and editor tabs are hidden and restored exactly as they were when switching back.
 */
class ConverltModes extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.converltModes';
	static instance: ConverltModes | undefined;

	private readonly modeKey: IContextKey<'dashboard' | 'code'>;
	private saved: Map<Parts, boolean> | undefined;
	private switching = false;

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
		@IEditorService editorService: IEditorService,
	) {
		super();
		ConverltModes.instance = this;
		this.modeKey = ConverltMode.bindTo(contextKeyService);
		const readyKey = ConverltReady.bindTo(contextKeyService);

		this._register(CommandsRegistry.registerCommand('converlt.titleBar.setState', (_accessor, state: unknown) => {
			if (!isState(state)) {
				return;
			}
			titleState = state;
			readyKey.set(true);
			onDidChangeState.fire();
		}));

		// Opening a file (quick open, search, a run's failing line...) means coding: leave the dashboard.
		this._register(editorService.onDidActiveEditorChange(() => {
			if (this.mode !== 'dashboard' || this.switching) {
				return;
			}
			const active = editorService.activeEditor as { viewType?: string } | undefined;
			if (active && !(active.viewType ?? '').endsWith(DASHBOARD_VIEW_TYPE)) {
				this.showCode();
			}
		}));

		if (this.configurationService.getValue<string>(STARTUP_SETTING) !== 'code') {
			void this.showDashboard();
		}
	}

	get mode(): 'dashboard' | 'code' {
		return this.modeKey.get() ?? 'code';
	}

	private static readonly HIDDEN_PARTS = [Parts.SIDEBAR_PART, Parts.PANEL_PART, Parts.AUXILIARYBAR_PART] as const;

	/** In-memory overrides while the dashboard is up; never written to the user's settings. */
	private static readonly DASHBOARD_SETTINGS: ReadonlyArray<[string, unknown]> = [
		['workbench.editor.showTabs', 'none'],
		['workbench.editor.editorActionsLocation', 'hidden'],
		['workbench.statusBar.visible', false],
	];

	async showDashboard(): Promise<void> {
		if (this.mode === 'dashboard') {
			await this.commandService.executeCommand(DASHBOARD_COMMAND);
			return;
		}
		this.switching = true;
		try {
			this.saved = new Map(ConverltModes.HIDDEN_PARTS.map(p => [p, this.layoutService.isVisible(p, mainWindow)]));
			this.modeKey.set('dashboard');
			this.layoutService.mainContainer.classList.add('converlt-dashboard');
			for (const [key, value] of ConverltModes.DASHBOARD_SETTINGS) {
				await this.configurationService.updateValue(key, value, ConfigurationTarget.MEMORY);
			}
			for (const part of ConverltModes.HIDDEN_PARTS) {
				this.layoutService.setPartHidden(true, part);
			}
			await this.commandService.executeCommand(DASHBOARD_COMMAND);
		} finally {
			this.switching = false;
		}
	}

	async showCode(): Promise<void> {
		if (this.mode === 'code') {
			return;
		}
		this.modeKey.set('code');
		this.layoutService.mainContainer.classList.remove('converlt-dashboard');
		for (const [key] of ConverltModes.DASHBOARD_SETTINGS) {
			await this.configurationService.updateValue(key, undefined, ConfigurationTarget.MEMORY);
		}
		const saved = this.saved;
		this.saved = undefined;
		for (const part of ConverltModes.HIDDEN_PARTS) {
			// Parts that were never visible stay hidden; the side bar comes back by default.
			const wasVisible = saved?.get(part) ?? part === Parts.SIDEBAR_PART;
			this.layoutService.setPartHidden(!wasVisible, part);
		}
	}
}

registerWorkbenchContribution2(ConverltModes.ID, ConverltModes, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'converlt.showDashboard',
			title: localize2('converlt.showDashboard', "Show Dashboard"),
			category: localize2('converlt', "Converlt"),
			icon: Codicon.layoutPanelLeft,
			f1: true,
		});
	}
	run(): Promise<void> | undefined {
		return ConverltModes.instance?.showDashboard();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'converlt.showCode',
			title: localize2('converlt.showCode', "Show Code Editor"),
			category: localize2('converlt', "Converlt"),
			f1: true,
		});
	}
	run(): Promise<void> | undefined {
		return ConverltModes.instance?.showCode();
	}
});

// ------------------------------------------------------------------ title bar

const TITLE_ACTION_ID = 'converlt.titleBar';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: TITLE_ACTION_ID,
			title: localize2('converlt.titleBar', "Converlt"),
			f1: false,
			menu: [{ id: MenuId.TitleBarAdjacentCenter, order: -10 }],
		});
	}
	run(accessor: ServicesAccessor): Promise<unknown> {
		return accessor.get(ICommandService).executeCommand('converge.computeMenu');
	}
});

const fmtCredits = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** [Dashboard | Code]  [● RTX 4090 pod ⌄]  [◎ 2,499.62] */
class ConverltTitleBarItem extends BaseActionViewItem {

	private readonly renderDisposables = this._register(new DisposableStore());
	private root: HTMLElement | undefined;

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions,
		@ICommandService private readonly commandService: ICommandService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
	) {
		super(undefined, action, options);
		this._register(onDidChangeState.event(() => this.refresh()));
		this._register(this.contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(new Set([ConverltMode.key]))) {
				this.refresh();
			}
		}));
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('converlt-titlebar-item');
		this.root = dom.append(container, dom.$('.converlt-title'));
		this.refresh();
	}

	// The segments handle their own clicks.
	override onClick(): void { }

	private button(parent: HTMLElement, className: string, label: string, onClick: () => void): HTMLElement {
		const el = dom.append(parent, dom.$(`button.converlt-seg.${className}`));
		el.setAttribute('type', 'button');
		el.setAttribute('aria-label', label);
		el.title = label;
		this.renderDisposables.add(dom.addDisposableListener(el, dom.EventType.CLICK, e => {
			dom.EventHelper.stop(e, true);
			onClick();
		}));
		this.renderDisposables.add(dom.addDisposableListener(el, dom.EventType.MOUSE_DOWN, e => e.stopPropagation()));
		return el;
	}

	private refresh(): void {
		if (!this.root) {
			return;
		}
		this.renderDisposables.clear();
		dom.clearNode(this.root);
		const mode = ConverltMode.getValue(this.contextKeyService) ?? 'code';

		// Mode switch
		const modes = dom.append(this.root, dom.$('.converlt-modes'));
		const dash = this.button(modes, `mode${mode === 'dashboard' ? '.on' : ''}`, localize('converlt.dashboard', "Dashboard"), () => this.commandService.executeCommand('converlt.showDashboard'));
		dom.append(dash, renderIcon(Codicon.dashboard));
		dom.append(dash, dom.$('span', undefined, localize('converlt.dashboardLabel', "Dashboard")));
		const code = this.button(modes, `mode${mode === 'code' ? '.on' : ''}`, localize('converlt.code', "Code"), () => this.commandService.executeCommand('converlt.showCode'));
		dom.append(code, renderIcon(Codicon.code));
		dom.append(code, dom.$('span', undefined, localize('converlt.codeLabel', "Code")));

		const s = titleState;
		if (!s) {
			return;
		}

		// Compute target
		const t = s.target;
		const target = this.button(this.root, 'target', t ? `${t.label}${t.detail ? ` · ${t.detail}` : ''}` : localize('converlt.noGpu', "No GPU selected"), () => this.commandService.executeCommand('converge.computeMenu'));
		dom.append(target, dom.$(`span.converlt-dot.${t?.status ?? 'none'}`));
		dom.append(target, renderIcon(Codicon.serverEnvironment));
		dom.append(target, dom.$('span.converlt-label', undefined, t?.label ?? localize('converlt.launchGpu', "Launch GPU")));
		dom.append(target, renderIcon(Codicon.chevronDown));

		// Credits
		const credits = this.button(this.root, `credits${s.balance !== null && s.balance <= 0 ? '.empty' : ''}`, s.tooltip ?? localize('converlt.wallet', "Converlt wallet"), () => this.commandService.executeCommand(s.connected ? 'converge.openWallet' : 'converge.cloudSignIn'));
		dom.append(credits, renderIcon(s.connected ? Codicon.creditCard : Codicon.cloud));
		dom.append(credits, dom.$('span.converlt-label', undefined, s.connected && s.balance !== null ? fmtCredits(s.balance) : localize('converlt.signIn', "Sign in")));
		if (s.connected && s.burnPerHour > 0) {
			dom.append(credits, dom.$('span.converlt-burn', undefined, `−${fmtCredits(s.burnPerHour)}/h`));
		}
	}
}

class ConverltTitleBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.converltTitleBar';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._register(actionViewItemService.register(MenuId.TitleBarAdjacentCenter, TITLE_ACTION_ID, (action, options) => instantiationService.createInstance(ConverltTitleBarItem, action, options)));
	}
}

registerWorkbenchContribution2(ConverltTitleBarContribution.ID, ConverltTitleBarContribution, WorkbenchPhase.BlockStartup);
