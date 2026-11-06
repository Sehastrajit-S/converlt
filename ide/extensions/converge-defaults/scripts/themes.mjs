// Writes the IDE color themes (themes/*.json) and the extension's theme list from the palettes
// in packages/ui/src/themes.ts, so the IDE and Converlt's pages share one definition.
//   node --experimental-strip-types ide/extensions/converge-defaults/scripts/themes.mjs
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(ext, "../../..");
const { THEMES } = await import(pathToFileURL(path.join(repo, "packages/ui/src/themes.ts")).href);

const a = (hex, alpha) => hex + alpha; // #rrggbb + 2-digit alpha
const file = (t) => `converge-${t.id.replace(/^Converlt /, "").toLowerCase().replace(/\s+/g, "-")}.json`;

function colors(t) {
  const dark = t.type !== "light";
  const hc = t.type === "hc-dark";
  return {
    focusBorder: t.accent,
    foreground: t.text2 === t.text ? t.text : dark ? mix(t.text, t.text2) : t.text,
    descriptionForeground: t.text2,
    "widget.border": t.border,
    "selection.background": a(t.accent, "44"),
    "textLink.foreground": t.accentText,
    "textLink.activeForeground": t.accentHover,
    "button.background": t.accent,
    "button.hoverBackground": t.accentHover,
    "button.foreground": t.onAccent,
    "button.secondaryBackground": t.surface3,
    "button.secondaryHoverBackground": t.borderStrong,
    "button.secondaryForeground": t.text,
    "badge.background": t.accent,
    "badge.foreground": t.onAccent,
    "progressBar.background": t.accent,
    "editor.background": t.bg,
    "editor.foreground": t.text,
    "editor.lineHighlightBackground": hc ? "#00000000" : a(dark ? "#ffffff" : "#000000", "08"),
    "editor.lineHighlightBorder": hc ? t.border : "#00000000",
    "editor.selectionBackground": a(t.accent, "40"),
    "editor.inactiveSelectionBackground": a(t.accent, "26"),
    "editor.findMatchBackground": a(t.warn, "55"),
    "editorCursor.foreground": t.accentText,
    "editorLineNumber.foreground": t.text3,
    "editorLineNumber.activeForeground": t.text2,
    "editorIndentGuide.background1": t.border,
    "editorIndentGuide.activeBackground1": t.borderStrong,
    "editorGutter.background": t.bg,
    "editorWidget.background": t.surface,
    "editorWidget.border": t.border,
    "editorGroupHeader.tabsBackground": t.bg,
    "editorGroupHeader.tabsBorder": t.border,
    "editorGroup.border": t.border,
    "editorError.foreground": t.err,
    "editorWarning.foreground": t.warn,
    "tab.activeBackground": t.bg,
    "tab.inactiveBackground": t.bg,
    "tab.activeForeground": t.text,
    "tab.inactiveForeground": t.text3,
    "tab.border": t.bg,
    "tab.activeBorderTop": t.accent,
    "tab.activeBorder": t.bg,
    "tab.hoverBackground": t.surface,
    "titleBar.activeBackground": t.sunken,
    "titleBar.inactiveBackground": t.sunken,
    "titleBar.activeForeground": t.text,
    "titleBar.border": t.border,
    "commandCenter.background": t.surface,
    "commandCenter.border": t.border,
    "commandCenter.activeBackground": t.surface2,
    "activityBar.background": t.sunken,
    "activityBar.foreground": t.text,
    "activityBar.inactiveForeground": t.text3,
    "activityBar.activeBorder": t.accent,
    "activityBar.border": t.border,
    "activityBarBadge.background": t.accent,
    "activityBarBadge.foreground": t.onAccent,
    "sideBar.background": t.bg,
    "sideBar.foreground": t.text2,
    "sideBar.border": t.border,
    "sideBarTitle.foreground": t.text,
    "sideBarSectionHeader.background": t.bg,
    "sideBarSectionHeader.border": t.border,
    "list.activeSelectionBackground": a(t.accent, "2e"),
    "list.activeSelectionForeground": t.text,
    "list.inactiveSelectionBackground": a(dark ? "#ffffff" : "#000000", "0d"),
    "list.hoverBackground": a(dark ? "#ffffff" : "#000000", "0a"),
    "list.focusOutline": t.accent,
    "list.highlightForeground": t.accentText,
    "panel.background": t.bg,
    "panel.border": t.border,
    "panelTitle.activeBorder": t.accent,
    "panelTitle.activeForeground": t.text,
    "terminal.background": t.bg,
    "terminal.foreground": t.text,
    "statusBar.background": t.sunken,
    "statusBar.foreground": t.text2,
    "statusBar.border": t.border,
    "statusBar.noFolderBackground": t.sunken,
    "statusBar.debuggingBackground": t.accent,
    "statusBar.debuggingForeground": t.onAccent,
    "statusBarItem.remoteBackground": t.accent,
    "statusBarItem.remoteForeground": t.onAccent,
    "input.background": t.surface,
    "input.border": t.borderStrong,
    "input.foreground": t.text,
    "input.placeholderForeground": t.text3,
    "inputOption.activeBorder": t.accent,
    "dropdown.background": t.surface,
    "dropdown.border": t.borderStrong,
    "dropdown.foreground": t.text,
    "quickInput.background": t.surface,
    "quickInputList.focusBackground": a(t.accent, "2e"),
    "notifications.background": t.surface,
    "notifications.border": t.border,
    "menu.background": t.surface,
    "menu.border": t.border,
    "menu.selectionBackground": a(t.accent, "2e"),
    "scrollbarSlider.background": a(dark ? "#ffffff" : "#000000", "14"),
    "scrollbarSlider.hoverBackground": a(dark ? "#ffffff" : "#000000", "22"),
    "errorForeground": t.err,
    // Converlt pages read their status colors from these (green = ok, yellow = warning, blue = info).
    "charts.purple": t.series[0],
    "charts.blue": t.info,
    "charts.orange": t.series[2],
    "charts.red": t.err,
    "charts.green": t.ok,
    "charts.yellow": t.warn,
    "testing.iconPassed": t.ok,
    "testing.iconFailed": t.err,
    ...(hc ? { contrastBorder: t.border, contrastActiveBorder: t.accent } : {}),
  };
}

function mix(x, y) {
  const n = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  return "#" + n(x).map((v, i) => Math.round(v * 0.82 + n(y)[i] * 0.18).toString(16).padStart(2, "0")).join("");
}

const include = { dark: "./dark_modern.json", light: "./light_modern.json", "hc-dark": "./hc_black.json" };
for (const t of THEMES) {
  const json = { $schema: "vscode://schemas/color-theme", name: t.id, type: t.type === "hc-dark" ? "hc" : t.type, include: include[t.type], colors: colors(t) };
  await writeFile(path.join(ext, "themes", file(t)), JSON.stringify(json, null, 2) + "\n");
}
const pkgPath = path.join(ext, "package.json");
const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
pkg.contributes.themes = THEMES.map((t) => ({ id: t.id, label: t.id, uiTheme: t.type === "light" ? "vs" : t.type === "hc-dark" ? "hc-black" : "vs-dark", path: `./themes/${file(t)}` }));
await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`wrote ${THEMES.length} themes: ${THEMES.map((t) => t.id).join(", ")}`);
