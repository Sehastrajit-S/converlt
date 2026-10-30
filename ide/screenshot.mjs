// Drives a VS Code-based editor over the Chrome DevTools Protocol and captures screenshots.
//   node ide/screenshot.mjs <editor.exe> <folder> <outDir> [extensionDevelopmentPath]
// Uses a throwaway profile under .cache so the user's own editor settings are never touched.
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [exe, folder, outDir, extDev] = process.argv.slice(2);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = path.join(repo, ".cache", "editor-profile", path.basename(exe, ".exe").toLowerCase());
await mkdir(outDir, { recursive: true });

const port = 9340;
const args = [
  `--user-data-dir=${path.join(profile, "user")}`,
  `--extensions-dir=${path.join(profile, "extensions")}`,
  `--remote-debugging-port=${port}`,
  "--disable-workspace-trust",
  "--skip-welcome",
  "--skip-release-notes",
  "--disable-gpu-sandbox",
  "--new-window",
  ...(extDev ? [`--extensionDevelopmentPath=${extDev}`] : []),
  folder,
];
const { ELECTRON_RUN_AS_NODE: _x, ...env } = process.env;
const child = spawn(exe, args, { env, stdio: "ignore", detached: false });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 120 && !target; i++) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    target = list.find((t) => t.type === "page" && /workbench/.test(t.url));
  } catch {}
}
if (!target) throw new Error("workbench page not found");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const cdp = (method, params = {}) =>
  new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
const evaluate = async (expr) => (await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const shot = async (name) => {
  await sleep(1200);
  const { result } = await cdp("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(outDir, `${name}.png`), Buffer.from(result.data, "base64"));
  console.log("saved", name);
};
const key = async (k, code, keyCode, modifiers = 0) => {
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: keyCode, modifiers });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: keyCode, modifiers });
};
const CTRL = 2;
const SHIFT = 8;
const command = async (label) => {
  await key("p", "KeyP", 80, CTRL | SHIFT);
  await sleep(600);
  await cdp("Input.insertText", { text: label });
  await sleep(900);
  await key("Enter", "Enter", 13);
};
// Real mouse events at the element's center: VS Code's lists ignore synthetic DOM clicks.
const click = async (selector, text) => {
  const rect = await evaluate(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = ${text ? `els.find(e => (e.getAttribute("aria-label") || e.textContent || "").includes(${JSON.stringify(text)}))` : "els[0]"};
    if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!rect) return false;
  for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  return true;
};

await cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 960, deviceScaleFactor: 1, mobile: false });
await sleep(9000); // workbench restore + extension activation

await command("Converlt: Focus on Runs View");
await sleep(2000);
await shot("01-sidebar");

await command("Converlt: Open Runs Dashboard");
await sleep(2500);
await shot("02-runs-dashboard");

console.log("run row", await click(".monaco-list-row", "run-003"));
await sleep(2500);
await shot("03-run-nan");

await command("Converlt: Open Compute Dashboard");
await sleep(3000);
await shot("04-compute");

await key("p", "KeyP", 80, CTRL);
await sleep(600);
await cdp("Input.insertText", { text: "train.py" });
await sleep(900);
await key("Enter", "Enter", 13);
await sleep(2500);
await shot("05-editor-codelens");

// Full user flow (CONVERGE_SHOT_LAUNCH=1): add the local GPU through WSL, then launch from the editor.
if (process.env.CONVERGE_SHOT_LAUNCH) {
  const enter = async (text, wait = 900) => {
    if (text) await cdp("Input.insertText", { text });
    await sleep(wait);
    await key("Enter", "Enter", 13);
    await sleep(900);
  };
  await command("Converlt: Add Machine");
  await sleep(1200);
  await enter("Local GPU via WSL"); // machine kind
  await enter(""); // distro: Ubuntu
  await enter(""); // python: python3
  await enter("0.35"); // hourly rate
  await sleep(15000); // install agent + probe
  await shot("06-machine-added");

  await key("p", "KeyP", 80, CTRL);
  await sleep(600);
  await cdp("Input.insertText", { text: "train.py" });
  await sleep(900);
  await key("Enter", "Enter", 13);
  await sleep(1500);
  await command("Converlt: Run on GPU");
  await sleep(1200);
  await enter(""); // machine
  await cdp("Input.insertText", { text: " --steps 600 --sleep 0.03 --lr 0.04" });
  await enter("", 400); // command
  await sleep(14000);
  await shot("07-live-run");
}

ws.close();
child.kill();
await sleep(500);
process.exit(0);
