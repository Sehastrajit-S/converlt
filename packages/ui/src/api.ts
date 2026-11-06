import { useCallback, useEffect, useRef, useState } from "react";
import type { AppState, ConvergeApi, RunListItem, RunView } from "@converge/core/api";

/**
 * The backend the screens talk to. Each shell injects its own transport before rendering:
 * the Electron preload bridge, or postMessage RPC inside a VS Code webview.
 */
export let api: ConvergeApi = new Proxy({} as ConvergeApi, {
  get(_t, prop) {
    throw new Error(`Converlt API not initialised (accessed ${String(prop)}). Call setApi() first.`);
  },
});

export function setApi(impl: ConvergeApi): void {
  api = impl;
}

/**
 * Asks before something destructive. Uses the host's native dialog: inside a VS Code webview
 * window.confirm returns false without showing anything, which would silently cancel the action.
 */
export async function ask(message: string, confirmLabel: string): Promise<boolean> {
  try {
    return await api.confirmAction(message, confirmLabel);
  } catch {
    return window.confirm(message);
  }
}

export function useAppState(): [AppState | null, () => Promise<void>] {
  const [state, setState] = useState<AppState | null>(null);
  const refresh = useCallback(async () => setState(await api.getState()), []);
  useEffect(() => {
    void refresh();
    return api.onStateChanged(() => void refresh());
  }, [refresh]);
  return [state, refresh];
}

/** Calls `fn` at most once per `ms`, always running the trailing call. */
function useThrottled(fn: () => void, ms: number): () => void {
  const last = useRef(0);
  const timer = useRef<number | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return useCallback(() => {
    const wait = last.current + ms - Date.now();
    if (wait <= 0) {
      last.current = Date.now();
      fnRef.current();
    } else if (!timer.current) {
      timer.current = window.setTimeout(() => {
        timer.current = null;
        last.current = Date.now();
        fnRef.current();
      }, wait);
    }
  }, [ms]);
}

export function useRuns(projectPath: string | undefined): RunListItem[] {
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const load = useThrottled(() => void api.listRuns().then(setRuns), 400);
  useEffect(() => {
    setRuns([]);
    if (!projectPath) return;
    load();
    const off = api.onRunsChanged(() => load());
    // Durations and costs of live runs advance even without new events.
    const tick = window.setInterval(load, 5000);
    return () => {
      off();
      clearInterval(tick);
    };
  }, [projectPath, load]);
  return runs;
}

export function useRun(runId: string | null): RunView | null | undefined {
  const [run, setRun] = useState<RunView | null | undefined>(undefined);
  const idRef = useRef(runId);
  idRef.current = runId;
  const load = useThrottled(() => {
    const id = idRef.current;
    if (id) void api.getRun(id).then((r) => idRef.current === id && setRun(r));
  }, 500);
  useEffect(() => {
    setRun(undefined);
    if (!runId) return;
    load();
    const off = api.onRunsChanged((ids) => ids.includes(runId) && load());
    const tick = window.setInterval(load, 5000);
    return () => {
      off();
      clearInterval(tick);
    };
  }, [runId, load]);
  return run;
}

export function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // Strip Electron's "Error invoking remote method 'x': Error: " prefix.
  return msg.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}
