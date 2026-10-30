import { useEffect, useState, type ReactNode } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import type { AppState, Settings as SettingsT, ThemePref } from "@converge/core/api";
import { api } from "../api.ts";
import { Segmented, Switch, useToast } from "../components/ui.tsx";

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
      <div className="card">
        <Setting title="Theme">
          <Segmented<ThemePref>
            value={s.theme}
            onChange={(theme) => void api.updateSettings({ theme })}
            options={[
              { value: "system", label: <><Monitor size={13} /> System</> },
              { value: "dark", label: <><Moon size={13} /> Dark</> },
              { value: "light", label: <><Sun size={13} /> Light</> },
            ]}
          />
        </Setting>
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
