import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { CircleCheck, CircleX, Info, LoaderCircle, X } from "lucide-react";
import type { ConnectionState, RunStatus } from "@converge/run-protocol";

const STATUS_LABEL: Record<RunStatus, string> = {
  created: "Created",
  preparing: "Preparing",
  running: "Running",
  cancelling: "Cancelling",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  unknown: "Unknown",
};

export function StatusPill({ status, connection }: { status: RunStatus; connection?: ConnectionState }) {
  const reconnecting = status === "running" && connection === "reconnecting";
  return (
    <span className={`pill ${status}`} title={reconnecting ? "Reconnecting to the machine. Training continues." : undefined}>
      {status === "preparing" || status === "cancelling" ? <LoaderCircle size={11} className="spin" /> : <span className="dot" />}
      {STATUS_LABEL[status]}
      {reconnecting && <span style={{ opacity: 0.7, fontWeight: 500 }}>· reconnecting</span>}
    </span>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? "on" : ""}`} onClick={() => onChange(!on)} />;
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={o.value === value} className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Dialog({ title, icon, onClose, children, footer, wide }: { title: ReactNode; icon?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog ${wide ? "wide" : ""}`} role="dialog" aria-modal="true">
        <div className="dialog-head">
          {icon}
          <div className="dialog-title">{title}</div>
          <div className="spacer" />
          <button className="btn ghost icon sm" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div>
        <div className="empty-icon">{icon}</div>
        <h3>{title}</h3>
        {children && <p>{children}</p>}
        {action}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- toasts

type ToastKind = "success" | "error" | "info";
interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
}

const ToastCtx = createContext<(kind: ToastKind, title: string, body?: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: ToastKind, title: string, body?: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, title, body }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 9000 : 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.kind === "success" ? <CircleCheck size={17} /> : t.kind === "error" ? <CircleX size={17} /> : <Info size={17} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 620 }}>{t.title}</div>
              {t.body && <div className="muted selectable" style={{ marginTop: 2, overflowWrap: "anywhere" }}>{t.body}</div>}
            </div>
            <button className="btn ghost icon sm" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))} aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}

export function Meter({ value, max }: { value: number | null | undefined; max: number | null | undefined }) {
  const pct = value != null && max ? Math.min(100, (100 * value) / max) : 0;
  return (
    <div className={`meter ${pct > 95 ? "err" : pct > 85 ? "warn" : ""}`}>
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}
