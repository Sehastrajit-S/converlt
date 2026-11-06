// Converlt's color themes. One palette per theme drives both the IDE color theme (generated
// into converge-defaults/themes by scripts/themes.mjs) and the swatches in Settings. Converlt's
// pages take their colors from the active IDE theme, so choosing one restyles everything.

export interface ThemePalette {
  id: string;
  label: string;
  /** Short description for the picker. */
  note: string;
  type: "dark" | "light" | "hc-dark";
  bg: string;
  sunken: string;
  surface: string;
  surface2: string;
  surface3: string;
  border: string;
  borderStrong: string;
  text: string;
  text2: string;
  text3: string;
  accent: string;
  accentHover: string;
  accentText: string;
  onAccent: string;
  ok: string;
  warn: string;
  err: string;
  info: string;
  /** Chart series: purple, blue, orange, red, green, yellow slots. */
  series: [string, string, string, string, string, string];
}

export const THEMES: ThemePalette[] = [
  {
    id: "Converlt Dark", label: "Converlt Dark", note: "The default: graphite with violet", type: "dark",
    bg: "#0b0d12", sunken: "#08090d", surface: "#12151c", surface2: "#171b24", surface3: "#1e2330", border: "#222836", borderStrong: "#2f3646",
    text: "#e7eaf0", text2: "#a4acbd", text3: "#6c7589", accent: "#8b6cff", accentHover: "#9d83ff", accentText: "#b9a6ff", onAccent: "#ffffff",
    ok: "#34c77b", warn: "#f2a93b", err: "#f25767", info: "#4aa8ff", series: ["#8b6cff", "#4aa8ff", "#f2a93b", "#f06fb0", "#34c77b", "#e2c84a"],
  },
  {
    id: "Converlt Midnight", label: "Midnight", note: "Deep navy with cyan, easy on the eyes at night", type: "dark",
    bg: "#060a14", sunken: "#04070f", surface: "#0c1322", surface2: "#111a2d", surface3: "#172238", border: "#1a2540", borderStrong: "#263354",
    text: "#e3ecfa", text2: "#9aabc8", text3: "#62728f", accent: "#22c3e6", accentHover: "#4fd3f0", accentText: "#7fe1f5", onAccent: "#04121a",
    ok: "#2fd39a", warn: "#f5b54a", err: "#ff6b7d", info: "#5aa9ff", series: ["#22c3e6", "#7c8cff", "#f5b54a", "#ff6b9d", "#2fd39a", "#d8e05a"],
  },
  {
    id: "Converlt Ember", label: "Ember", note: "Warm charcoal with amber", type: "dark",
    bg: "#110d0b", sunken: "#0c0908", surface: "#1a1411", surface2: "#211915", surface3: "#2b211b", border: "#2e241e", borderStrong: "#3e3129",
    text: "#f2e9e2", text2: "#bcaa9c", text3: "#806d60", accent: "#ff8a3d", accentHover: "#ff9f5f", accentText: "#ffb27f", onAccent: "#1a0c03",
    ok: "#6fcf6a", warn: "#f6c343", err: "#ff5d5d", info: "#5fb3ff", series: ["#ff8a3d", "#5fb3ff", "#f6c343", "#ff6fa8", "#6fcf6a", "#c59bff"],
  },
  {
    id: "Converlt Forest", label: "Forest", note: "Dark green-black with mint", type: "dark",
    bg: "#090f0c", sunken: "#060b09", surface: "#0f1813", surface2: "#142019", surface3: "#1b2a21", border: "#1d2b23", borderStrong: "#2a3c31",
    text: "#e4efe8", text2: "#9db3a6", text3: "#647a6d", accent: "#3ddc97", accentHover: "#62e6ad", accentText: "#8ff0c4", onAccent: "#04150d",
    ok: "#3ddc97", warn: "#f0b84a", err: "#ff6a6a", info: "#58b4ff", series: ["#3ddc97", "#58b4ff", "#f0b84a", "#ff7aa8", "#b4e05a", "#b49bff"],
  },
  {
    id: "Converlt Light", label: "Light", note: "Clean white with violet", type: "light",
    bg: "#f6f7f9", sunken: "#eef0f3", surface: "#ffffff", surface2: "#f8f9fb", surface3: "#f0f2f5", border: "#e3e6ec", borderStrong: "#d2d7e0",
    text: "#121722", text2: "#4c5567", text3: "#8790a2", accent: "#6d4aff", accentHover: "#5c37f5", accentText: "#5b36f2", onAccent: "#ffffff",
    ok: "#12a05c", warn: "#c47a06", err: "#d92d44", info: "#1677d9", series: ["#6d4aff", "#1677d9", "#d98a0b", "#d93d8a", "#12a05c", "#a68a00"],
  },
  {
    id: "Converlt Paper", label: "Paper", note: "Warm off-white with teal, like a notebook", type: "light",
    bg: "#f7f3ea", sunken: "#efe9dc", surface: "#fdfaf3", surface2: "#f8f3e8", surface3: "#f0e9da", border: "#e4dccb", borderStrong: "#d3c8b2",
    text: "#2b2620", text2: "#62584b", text3: "#958a7a", accent: "#0f8a7e", accentHover: "#0b766c", accentText: "#0b766c", onAccent: "#ffffff",
    ok: "#2f8f3a", warn: "#b5760a", err: "#c23b3b", info: "#2c6fbf", series: ["#0f8a7e", "#2c6fbf", "#c67a12", "#c2457f", "#2f8f3a", "#7a5cc2"],
  },
  {
    id: "Converlt High Contrast", label: "High contrast", note: "Maximum legibility: black, white and yellow", type: "hc-dark",
    bg: "#000000", sunken: "#000000", surface: "#000000", surface2: "#0a0a0a", surface3: "#141414", border: "#6fc3df", borderStrong: "#ffffff",
    text: "#ffffff", text2: "#e8e8e8", text3: "#c8c8c8", accent: "#ffd600", accentHover: "#ffe34d", accentText: "#ffe34d", onAccent: "#000000",
    ok: "#3ff23f", warn: "#ffd600", err: "#ff5c5c", info: "#6fc3df", series: ["#ffd600", "#6fc3df", "#ff9e2c", "#ff6bd6", "#3ff23f", "#c0a0ff"],
  },
];
