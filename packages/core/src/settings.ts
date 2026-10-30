import type { Settings } from "./api.ts";

export const DEFAULT_SETTINGS: Settings = {
  sshPath: "ssh",
  remoteRoot: "~/converge",
  defaultCommand: "python train.py",
  syncExclude: [],
  maxFileSizeMB: 20,
  defaultOptions: { stopOnNan: false, telemetryIntervalSec: 10, stallMinutes: 20, cancelGraceSec: 20 },
  theme: "system",
  notifications: true,
};
