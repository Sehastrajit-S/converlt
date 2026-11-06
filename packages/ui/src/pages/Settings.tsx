import { useEffect, useState, type ReactNode } from "react";
import type { AppState, Settings as SettingsT, ThemePref, UiThemeState } from "@converge/core/api";
import { api } from "../api.ts";
import { Switch, useToast } from "../components/ui.tsx";
import { THEMES, type ThemePalette } from "../themes.ts";

function Setting({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting">
      <div className="text">
        <div className="title">{title}</div>
        {hint && <div className="hint">{hint}</div>}
      </div>
      <div className="control">{children}</div>
    </div>
  );
}

/** Text input that saves on blur/Enter instead of on every keystroke. */
function TextSetting({ value, onSave, mono, placeholder }: { value: string; onSave: (v: string) => void; mono?: boolean; placeholder?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => {
    setV(value);
  }, [value]);
  const commit = () => v !== value && onSave(v);
  return <input className={`input ${mono ? "mono" : ""}`} value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />;
}

/** A tiny preview of a theme: sidebar, a card with text lines, an accent button and chart colors. */
function ThemePreview({ t }: { t: ThemePalette }) {
  return (
    <svg viewBox="0 0 160 92" className="theme-preview" aria-hidden>
      <rect width="160" height="92" fill={t.bg} />
      <rect width="28" height="92" fill={t.sunken} />
      <rect x="0" y="0" width="160" height="10" fill={t.sunken} />
      {[20, 30, 40].map((y) => (
        <rect key={y} x="7" y={y} width="14" height="3" rx="1.5" fill={y === 20 ? t.accent : t.text3} />
      ))}
      <rect x="36" y="18" width="116" height="66" rx="5" fill={t.surface} stroke={t.border} />
      <rect x="44" y="26" width="52" height="5" rx="2.5" fill={t.text} />
      <rect x="44" y="35" width="76" height="3" rx="1.5" fill={t.text3} />
      <polyline points="44,70 58,62 72,66 86,52 100,56 114,44" fill="none" stroke={t.series[0]} strokeWidth="2" />
      <polyline points="44,74 58,72 72,70 86,66 100,64 114,60" fill="none" stroke={t.series[1]} strokeWidth="2" />
      <rect x="118" y="26" width="26" height="9" rx="3" fill={t.accent} />
      <circle cx="139" cy="72" r="3" fill={t.ok} />
      <circle cx="131" cy="72" r="3" fill={t.warn} />
      <circle cx="123" cy="72" r="3" fill={t.err} />
    </svg>
  );
}

/** The IDE color theme: Converlt's pages, editor and sidebars all follow it. */
export function ThemeGallery({ fallback }: { fallback: ThemePref }) {
  const toast = useToast();
  const [state, setState] = useState<UiThemeState | null>(null);
  useEffect(() => {
    api.uiTheme().then(setState, () => setState(null));
  }, []);
  const choose = async (change: { theme?: string; followSystem?: boolean }) => {
    try {
      setState(await api.setUiTheme(change));
    } catch {
      // Outside the Converlt IDE there's no color theme to set; keep the old light/dark preference.
      if (change.theme) await api.updateSettings({ theme: THEMES.find((t) => t.id === change.theme)?.type === "light" ? "light" : "dark" });
      toast("info", "Theme saved", "It applies the next time this window opens.");
    }
  };
  const current = state?.current ?? (fallback === "light" ? "Converlt Light" : "Converlt Dark");
  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">Theme</div>
        <div className="spacer" />
        <span className="faint" style={{ fontSize: 12 }}>Match the OS light / dark</span>
        <Switch on={!!state?.followSystem} onChange={(followSystem) => void choose({ followSystem })} label="Match the OS light or dark mode" />
      </div>
      <div className="theme-grid">
        {THEMES.map((t) => (
          <button key={t.id} className={`theme-card ${current === t.id ? "on" : ""}`} onClick={() => void choose({ theme: t.id })} aria-pressed={current === t.id}>
            <ThemePreview t={t} />
            <span className="theme-name">
              <b>{t.label}</b>
              {current === t.id && <span className="tag ok">In use</span>}
            </span>
            <span className="faint">{t.note}</span>
          </button>
        ))}
      </div>
      {state?.followSystem && <div className="faint" style={{ fontSize: 12, padding: "0 16px 14px" }}>The last dark and light themes you picked are used when the OS switches.</div>}
    </div>
  );
}

export function Settings({ state }: { state: AppState }) {
  const s = state.settings;
  const toast = useToast();
  const update = async (patch: Partial<SettingsT>) => {
    await api.updateSettings(patch);
    toast("success", "Settings saved");
  };
  const [excludes, setExcludes] = useState(s.syncExclude.join("\n"));
  useEffect(() => {
    setExcludes(s.syncExclude.join("\n"));
  }, [s.syncExclude]);

  return (
    <div className="page settings">
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
      </div>

      <div className="section-title" style={{ marginTop: 0 }}>Appearance</div>
      <ThemeGallery fallback={s.theme} />
      <div className="card" style={{ marginTop: 12 }}>
        <Setting title="Desktop notifications" hint="Notify when a run completes, fails, or is cancelled.">
          <Switch on={s.notifications} onChange={(notifications) => void update({ notifications })} label="Notifications" />
        </Setting>
      </div>

      <div className="section-title">Runs</div>
      <div className="card">
        <Setting title="Default command" hint="Prefilled in the New run dialog.">
          <TextSetting mono value={s.defaultCommand} onSave={(defaultCommand) => void update({ defaultCommand })} />
        </Setting>
        <Setting title="Stop on NaN by default">
          <Switch on={s.defaultOptions.stopOnNan} onChange={(stopOnNan) => void update({ defaultOptions: { ...s.defaultOptions, stopOnNan } })} label="Stop on NaN" />
        </Setting>
        <Setting title="Stall alert (minutes)" hint="0 disables the alert.">
          <TextSetting mono value={String(s.defaultOptions.stallMinutes)} onSave={(v) => void update({ defaultOptions: { ...s.defaultOptions, stallMinutes: Math.max(0, Number(v) || 0) } })} />
        </Setting>
        <Setting title="Cancel grace period (seconds)" hint="Time between SIGTERM and SIGKILL when stopping a run, so it can save a checkpoint.">
          <TextSetting mono value={String(s.defaultOptions.cancelGraceSec)} onSave={(v) => void update({ defaultOptions: { ...s.defaultOptions, cancelGraceSec: Math.max(1, Number(v) || 20) } })} />
        </Setting>
      </div>

      <div className="section-title">Remote machines</div>
      <div className="card">
        <Setting title="SSH executable" hint="Uses your OpenSSH config, keys, and agent.">
          <TextSetting mono value={s.sshPath} onSave={(sshPath) => void update({ sshPath: sshPath.trim() || "ssh" })} />
        </Setting>
        <Setting title="Remote project root" hint={<>Code syncs to <span className="mono">{s.remoteRoot}/&lt;project&gt;</span>.</>}>
          <TextSetting mono value={s.remoteRoot} onSave={(remoteRoot) => void update({ remoteRoot: remoteRoot.trim() || "~/converge" })} />
        </Setting>
      </div>

      <div className="section-title">Code sync</div>
      <div className="card">
        <Setting title="Max file size (MB)" hint="Larger files are skipped. Keep datasets on the machine or in object storage.">
          <TextSetting mono value={String(s.maxFileSizeMB)} onSave={(v) => void update({ maxFileSizeMB: Math.max(1, Number(v) || 20) })} />
        </Setting>
        <div className="setting" style={{ alignItems: "flex-start" }}>
          <div className="text">
            <div className="title">Extra exclude patterns</div>
            <div className="hint">
              One glob per line, e.g. <span className="mono">data/**</span> or <span className="mono">**/*.csv</span>. Checkpoints, datasets, virtualenvs and
              credentials (.env, keys) are always excluded.
            </div>
          </div>
          <div className="control" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
            <textarea className="textarea mono" rows={5} value={excludes} onChange={(e) => setExcludes(e.target.value)} />
            <button
              className="btn sm"
              style={{ alignSelf: "flex-end" }}
              onClick={() => void update({ syncExclude: excludes.split("\n").map((l) => l.trim()).filter(Boolean) })}
            >
              Save patterns
            </button>
          </div>
        </div>
      </div>
      <p className="faint" style={{ fontSize: 12, marginTop: 20 }}>
        Converlt {state.version} · local-first: run history lives in each project's <span className="mono">.converge/</span> folder.
      </p>
    </div>
  );
}
