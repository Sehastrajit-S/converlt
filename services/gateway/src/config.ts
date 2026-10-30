// Gateway configuration, all from the environment. Provider keys never leave this process.
import path from "node:path";

export interface Config {
  port: number;
  dataDir: string;
  /** Bearer token for /admin endpoints. Admin routes are disabled when empty. */
  adminToken: string;
  runpodApiKey: string;
  openrouterApiKey: string;
  runpodRestUrl: string;
  runpodGraphqlUrl: string;
  openrouterUrl: string;
  /** Credits one US dollar buys. */
  creditsPerUsd: number;
  /** Multipliers on provider cost: Converlt's margin. */
  gpuMarkup: number;
  modelMarkup: number;
  /** Provider storage prices, USD per GB-month. */
  storageRunningUsdPerGbMonth: number;
  storageStoppedUsdPerGbMonth: number;
  /** A pod only launches if the balance covers this many hours of it. */
  minLaunchHours: number;
  meterIntervalMs: number;
  publicUrl: string;
}

const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = num(env.PORT, 8787);
  return {
    port,
    dataDir: path.resolve(env.CONVERLT_DATA_DIR ?? "data"),
    adminToken: env.CONVERLT_ADMIN_TOKEN ?? "",
    runpodApiKey: env.RUNPOD_API_KEY ?? "",
    openrouterApiKey: env.OPENROUTER_API_KEY ?? "",
    runpodRestUrl: env.RUNPOD_REST_URL ?? "https://rest.runpod.io/v1",
    runpodGraphqlUrl: env.RUNPOD_GRAPHQL_URL ?? "https://api.runpod.io/graphql",
    openrouterUrl: env.OPENROUTER_URL ?? "https://openrouter.ai/api/v1",
    creditsPerUsd: num(env.CREDITS_PER_USD, 100),
    gpuMarkup: num(env.GPU_MARKUP, 1.1),
    modelMarkup: num(env.MODEL_MARKUP, 1.05),
    storageRunningUsdPerGbMonth: num(env.STORAGE_RUNNING_USD_PER_GB_MONTH, 0.1),
    storageStoppedUsdPerGbMonth: num(env.STORAGE_STOPPED_USD_PER_GB_MONTH, 0.2),
    minLaunchHours: num(env.MIN_LAUNCH_HOURS, 1),
    meterIntervalMs: num(env.METER_INTERVAL_MS, 30_000),
    publicUrl: env.CONVERLT_PUBLIC_URL ?? `http://localhost:${port}`,
  };
}
