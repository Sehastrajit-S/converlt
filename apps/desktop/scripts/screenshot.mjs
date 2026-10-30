// Launches the built app with remote debugging and captures screenshots of key screens via CDP.
//   node scripts/screenshot.mjs <userDataDir> <outDir> [dark|light]
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

const [userData, outDir, theme = "dark"] = process.argv.slice(2);
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(outDir, { recursive: true });

const port = 9333;
const { ELECTRON_RUN_AS_NODE: _ignored, ...baseEnv } = process.env;
const child = spawn(electronPath, [".", `--remote-debugging-port=${port}`, `--force-color-profile=srgb`], {
  cwd: app,
  env: { ...baseEnv, CONVERGE_USER_DATA: userData },
  stdio: "ignore",
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 60 && !target; i++) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    target = list.find((t) => t.type === "page");
  } catch {}
}
if (!target) throw new Error("no page target");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.method === "Runtime.exceptionThrown") console.error("EXCEPTION", msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") console.error("CONSOLE", msg.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 2000));
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
  await sleep(700);
  const { result } = await cdp("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(outDir, `${name}.png`), Buffer.from(result.data, "base64"));
  console.log("saved", name);
};
// Exact text match first, then substring, so "Runs" doesn't hit "Completed"-style partials.
const click = (text, selector = "button, tr, a") =>
  evaluate(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(selector)})]; const t = ${JSON.stringify(text)};
    const el = els.find(e => e.textContent.trim() === t) ?? els.find(e => e.textContent.trim().startsWith(t));
    if (el) { el.click(); return true } return false })()`);

await cdp("Runtime.enable");
await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
await sleep(2500);
await evaluate(`document.fonts.ready.then(() => true)`);

const key = async (k, code, keyCode, modifiers = 0) => {
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: keyCode, modifiers });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: keyCode, modifiers });
};
const CTRL = 2;
const SHIFT = 8;
const step = async (text, selector) => console.log("click", text, selector, await click(text, selector));

// IDE shell: explorer + Runs tab on open.
await shot("01-ide-runs");
await step("train.py", "button.tree-row");
await sleep(1500);
await shot("02-editor");
await step("Run on GPU", "button.tab-action");
await sleep(1200);
await shot("03-run-from-editor");
await key("Escape", "Escape", 27);
await sleep(400);
await evaluate(`document.querySelector('button.side-tab[title="Runs"]').click()`);
await step("run-003", "button.tree-row");
await sleep(1200);
await shot("04-run-nan-tab");
await step("Runs", ".tab");
await sleep(400);
await evaluate(`(() => { const boxes = [...document.querySelectorAll("tbody .checkbox")]; [boxes[3], boxes[4], boxes[5]].forEach(b => b && b.click()); return boxes.length })()`);
await step("Compare", ".floating-bar button");
await shot("05-compare-tab");
await evaluate(`document.querySelector('button.side-tab[title="Compute"]').click()`);
await sleep(300);
await step("Local GPU", "button.tree-row");
await sleep(1500);
await shot("06-compute");
await key("p", "KeyP", 80, CTRL);
await sleep(500);
await cdp("Input.insertText", { text: "tr" });
await shot("07-quick-open");
await key("Escape", "Escape", 27);
await sleep(300);

// Terminal: open the panel and run a command in the real shell.
await key("`", "Backquote", 192, CTRL);
await sleep(2500);
await cdp("Input.insertText", { text: "git log --oneline -3" });
await key("Enter", "Enter", 13);
await sleep(2000);
await shot("08-terminal");

// Search across files.
await key("F", "KeyF", 70, CTRL | SHIFT);
await sleep(400);
await cdp("Input.insertText", { text: "add_argument" });
await sleep(1500);
await shot("09-search");
console.log("click hit", await click("p.add_argument(\"--lr\"", "button.search-hit"));
await sleep(1200);
await shot("10-search-open");

// Source control: the demo repo has uncommitted changes; open one as a diff.
await key("G", "KeyG", 71, CTRL | SHIFT);
await sleep(1500);
await shot("11-git");
console.log("click change", await click("train.py", "button.git-open"));
await sleep(2000);
await shot("12-git-diff");

// Assistant: with no API key it should explain how to add one.
await key("l", "KeyL", 76, CTRL);
await sleep(400);
await cdp("Input.insertText", { text: "Why did run-003 fail?" });
await key("Enter", "Enter", 13);
await sleep(4000);
await shot("13-assistant");

ws.close();
child.kill();
process.exit(0);
