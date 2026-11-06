/*---------------------------------------------------------------------------------------------
 *  Converlt workbench: Dashboard/Code modes, the ML menu, and the title-bar run, compute and
 *  credits controls. The Converlt extension owns the data and the screens; it pushes a small
 *  status snapshot here through the `converlt.titleBar.setState` command.
 *--------------------------------------------------------------------------------------------*/

import './media/converlt.css';
import * as dom from '../../../../base/browser/dom.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
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
	/** The run to show: the newest live one, else one that ended in the last few minutes. */
	run?: ConverltTitleRun | null;
}

export interface ConverltTitleRun {
	id: string;
	name: string;
	status: string;
	/** 0–1, when the run's length is known. */
	progress: number | null;
	etaSec: number | null;
	metric: { key: string; value: number | null } | null;
	/** The most serious diagnostic, in a few words. */
	problem: { severity: 'error' | 'warning'; text: string } | null;
	/** Other runs still going. */
	others: number;
}

const onDidChangeState = new Emitter<void>();
let titleState: ConverltTitleState | null = null;

function isState(v: unknown): v is ConverltTitleState {
	return !!v && typeof v === 'object' && typeof (v as ConverltTitleState).connected === 'boolean';
}

const ConverltReady = new RawContextKey<boolean>('converlt.ready', false, localize('converlt.ready', "Whether the Converlt extension has reported its status"));
const ConverltHasRun = new RawContextKey<boolean>('converlt.hasRun', false, localize('converlt.hasRun', "Whether there is a current or recent Converlt run"));
const ConverltRunActive = new RawContextKey<boolean>('converlt.runActive', false, localize('converlt.runActive', "Whether a Converlt training run is in progress"));
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
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
		const hasRunKey = ConverltHasRun.bindTo(contextKeyService);
		const runActiveKey = ConverltRunActive.bindTo(contextKeyService);

		this._register(CommandsRegistry.registerCommand('converlt.titleBar.setState', (_accessor, state: unknown) => {
			if (!isState(state)) {
				return;
			}
			titleState = state;
			readyKey.set(true);
			hasRunKey.set(!!state.run);
			runActiveKey.set(!!state.run && !TERMINAL_STATUSES.has(state.run.status));
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

// ------------------------------------------------------------------ the current run

/** Commands on the run the title bar shows, so menus and keys need no run picker. */
for (const [id, title, target, precondition] of [
	['converlt.openActiveRun', localize2('converlt.openActiveRun', "Show Current Run"), 'converge.openRun', ConverltHasRun],
	['converlt.stopActiveRun', localize2('converlt.stopActiveRun', "Stop Current Run"), 'converge.cancelRun', ConverltRunActive],
	['converlt.reproduceActiveRun', localize2('converlt.reproduceActiveRun', "Reproduce Current Run"), 'converge.reproduceRun', ConverltHasRun],
] as const) {
	registerAction2(class extends Action2 {
		constructor() {
			super({ id, title, category: localize2('converlt', "Converlt"), f1: true, precondition: precondition.isEqualTo(true) });
		}
		run(accessor: ServicesAccessor): Promise<unknown> | undefined {
			const run = titleState?.run;
			return run ? accessor.get(ICommandService).executeCommand(target, run.id) : undefined;
		}
	});
}

// Start a run from anywhere: Ctrl+Alt+T (train).
KeybindingsRegistry.registerKeybindingRule({
	id: 'converge.runTraining',
	weight: KeybindingWeight.WorkbenchContrib,
	primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyT,
	mac: { primary: KeyMod.WinCtrl | KeyMod.CtrlCmd | KeyCode.KeyT },
});

// ------------------------------------------------------------------ the ML menu

/**
 * A top-level menu for the whole ML workflow, in order: data, model, training, runs, compute.
 * Extensions can't add top-level menus, so it lives here; the items run the Converlt
 * extension's commands.
 */
const MenubarMlMenu = new MenuId('ConverltMenubarMlMenu');

MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
	submenu: MenubarMlMenu,
	title: {
		...localize2('converlt.mlMenu', "ML"),
		mnemonicTitle: localize({ key: 'converlt.mMl', comment: ['&& denotes a mnemonic'] }, "&&ML"),
	},
	order: 6.5,
});

const mlItems: [group: string, id: string, title: string, when?: RawContextKey<boolean>][] = [
	['0_data', 'converge.openData', localize({ key: 'converlt.miData', comment: ['&& denotes a mnemonic'] }, "&&Data: Load, Explore, Preprocess")],
	['0_data', 'converge.openHub', localize({ key: 'converlt.miHub', comment: ['&& denotes a mnemonic'] }, "Download Datasets && Models...")],
	['0_model', 'converge.openModelBuilder', localize({ key: 'converlt.miBuilder', comment: ['&& denotes a mnemonic'] }, "&&Model Builder")],
	['1_run', 'converge.runTraining', localize({ key: 'converlt.miRunTraining', comment: ['&& denotes a mnemonic'] }, "&&Run Training on GPU...")],
	['1_run', 'converlt.stopActiveRun', localize({ key: 'converlt.miStopRun', comment: ['&& denotes a mnemonic'] }, "&&Stop Current Run"), ConverltRunActive],
	['1_run', 'converlt.reproduceActiveRun', localize({ key: 'converlt.miReproduce', comment: ['&& denotes a mnemonic'] }, "Re&&produce Current Run..."), ConverltHasRun],
	['2_runs', 'converlt.openActiveRun', localize({ key: 'converlt.miShowRun', comment: ['&& denotes a mnemonic'] }, "Show &&Current Run"), ConverltHasRun],
	['2_runs', 'converge.openRuns', localize({ key: 'converlt.miRuns', comment: ['&& denotes a mnemonic'] }, "&&All Runs")],
	['2_runs', 'converge.compareRuns', localize({ key: 'converlt.miCompare', comment: ['&& denotes a mnemonic'] }, "C&&ompare Runs")],
	['3_env', 'converge.openEnvironments', localize({ key: 'converlt.miEnvs', comment: ['&& denotes a mnemonic'] }, "&&Environments")],
	['4_compute', 'converge.computeMenu', localize({ key: 'converlt.miTarget', comment: ['&& denotes a mnemonic'] }, "Choose &&GPU Machine...")],
	['4_compute', 'converge.openGpus', localize({ key: 'converlt.miGpus', comment: ['&& denotes a mnemonic'] }, "Rent a C&&loud GPU")],
	['4_compute', 'converge.openCompute', localize({ key: 'converlt.miCompute', comment: ['&& denotes a mnemonic'] }, "&&Machines")],
	['5_account', 'converge.setupPhoneAlerts', localize({ key: 'converlt.miAlerts', comment: ['&& denotes a mnemonic'] }, "P&&hone Alerts")],
	['5_account', 'converge.openWallet', localize({ key: 'converlt.miWallet', comment: ['&& denotes a mnemonic'] }, "&&Wallet")],
	['5_account', 'converlt.showDashboard', localize({ key: 'converlt.miDashboard', comment: ['&& denotes a mnemonic'] }, "Das&&hboard")],
	['5_account', 'converge.openThemes', localize({ key: 'converlt.miThemes', comment: ['&& denotes a mnemonic'] }, "&&Themes")],
];
mlItems.forEach(([group, id, title, when], order) => {
	MenuRegistry.appendMenuItem(MenubarMlMenu, { group, order, command: { id, title, precondition: when?.isEqualTo(true) } });
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

/** "<1m", "18m", "2h 05m": an estimate, so whole minutes. */
function fmtEta(sec: number): string {
	const m = Math.round(sec / 60);
	if (m < 1) {
		return '<1m';
	}
	return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

const fmtMetric = (v: number) => (Math.abs(v) >= 1000 || (Math.abs(v) < 0.001 && v !== 0) ? v.toExponential(2) : v.toPrecision(3));

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

		// The current run: status, progress, time left, loss, and what's wrong if anything is.
		const r = s.run;
		if (r) {
			const live = !TERMINAL_STATUSES.has(r.status);
			const tooltip = [
				`${r.name}: ${r.status}`,
				r.progress !== null ? localize('converlt.runProgress', "{0}% done", Math.round(r.progress * 100)) + (r.etaSec !== null ? localize('converlt.runEta', ", about {0} left", fmtEta(r.etaSec)) : '') : undefined,
				r.metric && r.metric.value !== null ? `${r.metric.key} ${fmtMetric(r.metric.value)}` : undefined,
				r.problem?.text,
				r.others > 0 ? localize('converlt.runOthers', "{0} more running", r.others) : undefined,
				localize('converlt.runOpen', "Click to open the run."),
			].filter(Boolean).join('\n');
			const seg = this.button(this.root, `run.${r.status}${r.problem ? `.${r.problem.severity}` : ''}`, tooltip, () => this.commandService.executeCommand('converge.openRun', r.id));
			dom.append(seg, dom.$(`span.converlt-dot.${live ? 'running' : r.status === 'completed' ? 'ready' : 'unreachable'}`));
			dom.append(seg, dom.$('span.converlt-label', undefined, r.name));
			if (live && r.progress !== null) {
				const bar = dom.append(seg, dom.$('span.converlt-progress'));
				dom.append(bar, dom.$('span')).style.width = `${Math.round(Math.min(1, Math.max(0, r.progress)) * 100)}%`;
				dom.append(seg, dom.$('span.converlt-sub', undefined, r.etaSec !== null ? fmtEta(r.etaSec) : `${Math.round(r.progress * 100)}%`));
			} else if (!live) {
				dom.append(seg, dom.$('span.converlt-sub', undefined, r.status));
			}
			if (r.metric && r.metric.value !== null) {
				dom.append(seg, dom.$('span.converlt-sub.metric', undefined, `${r.metric.key.split('/').pop()} ${fmtMetric(r.metric.value)}`));
			}
			if (r.problem) {
				dom.append(seg, renderIcon(r.problem.severity === 'error' ? Codicon.error : Codicon.warning));
			}
			if (r.others > 0) {
				dom.append(seg, dom.$('span.converlt-badge', undefined, `+${r.others}`));
			}
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
