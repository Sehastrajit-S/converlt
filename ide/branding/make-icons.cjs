// Renders branding/converge.svg into the icon files Code-OSS ships, under ide/overlays/.
//   electron ide/branding/make-icons.cjs
// Runs inside Electron (offscreen rendering), so no image libraries are needed.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const ideDir = path.resolve(__dirname, "..");
const svg = fs.readFileSync(path.join(__dirname, "converge.svg"), "utf8");
const out = (rel) => {
  const p = path.join(ideDir, "overlays", rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
};

// Draws the SVG onto a canvas in the page and reads the PNG back; no screen capture involved.
async function render(win, size) {
  const src = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
  const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = c.height = ${size};
      const ctx = c.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, ${size}, ${size});
      resolve(c.toDataURL("image/png"));
    };
    img.onerror = () => reject(new Error("svg load failed"));
    img.src = ${JSON.stringify(src)};
  })`);
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

/** ICO container with embedded PNGs (supported since Windows Vista). */
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL("data:text/html,<html><body></body></html>");
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const pngs = [];
  for (const size of sizes) pngs.push({ size, data: await render(win, size) });
  fs.writeFileSync(out("resources/win32/code.ico"), ico(pngs));
  fs.writeFileSync(out("resources/win32/code_70x70.png"), await render(win, 70));
  fs.writeFileSync(out("resources/win32/code_150x150.png"), await render(win, 150));
  fs.writeFileSync(out("resources/linux/code.png"), await render(win, 1024));
  fs.writeFileSync(out("resources/server/code-192.png"), await render(win, 192));
  fs.writeFileSync(out("resources/server/code-512.png"), await render(win, 512));
  console.log("icons written to", path.join(ideDir, "overlays"));
  app.quit();
});
