// Converlt Cloud state for the screens: connection, wallet and pods, refreshed on an interval.
import { useCallback, useEffect, useRef, useState } from "react";
import type { CloudPodView } from "@converge/core/api";
import type { CloudStatus, WalletSummary } from "@converge/core/cloud";
import { api } from "./api.ts";

/** Polls `load` every `ms` while mounted; `reload` forces a refresh. */
function usePolled<T>(load: () => Promise<T>, ms: number, deps: unknown[]): { data: T | null; error: string | null; reload: () => Promise<void> } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void reload();
    const iv = window.setInterval(reload, ms);
    const off = api.onStateChanged(() => void reload());
    return () => {
      clearInterval(iv);
      off();
    };
  }, [reload, ms, ...deps]);
  return { data, error, reload };
}

export function useCloudStatus() {
  return usePolled<CloudStatus>(() => api.cloudStatus(), 60_000, []);
}

export function useWallet(enabled: boolean) {
  return usePolled<WalletSummary | null>(() => (enabled ? api.cloudWallet() : Promise.resolve(null)), 15_000, [enabled]);
}

export function usePods(enabled: boolean) {
  return usePolled<CloudPodView[]>(() => (enabled ? api.gpuPods() : Promise.resolve([])), 8_000, [enabled]);
}

export function formatCredits(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function creditsUsd(n: number | null | undefined, perUsd: number): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const usd = n / perUsd;
  return `$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: usd < 1 ? 3 : 2 })}`;
}

/** "3h 20m", "2d 4h" — how long a balance lasts at a burn rate. */
export function formatHours(h: number): string {
  if (!Number.isFinite(h) || h < 0) return "—";
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `${Math.floor(h)}h ${Math.round((h % 1) * 60)}m`;
  return `${Math.floor(h / 24)}d ${Math.round(h % 24)}h`;
}
