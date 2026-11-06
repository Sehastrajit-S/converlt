// Renders branding/converge.svg into the logo images an MSIX package needs, under ide/msix/assets/.
//   electron ide/msix/make-assets.cjs
// Runs inside Electron (offscreen canvas), like branding/make-icons.cjs, so no image libraries are needed.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const svg = fs.readFileSync(path.join(__dirname, "..", "branding", "converge.svg"), "utf8");
const outDir = path.join(__dirname, "assets");
fs.mkdirSync(outDir, { recursive: true });

/** The logo drawn at `logo` px, centered on a transparent w×h canvas. */
async function render(win, w, h, logo) {
  const src = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
  const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = ${w};
      c.height = ${h};
      const ctx = c.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, (${w} - ${logo}) / 2, (${h} - ${logo}) / 2, ${logo}, ${logo});
      resolve(c.toDataURL("image/png"));
    };
    img.onerror = () => reject(new Error("svg load failed"));
    img.src = ${JSON.stringify(src)};
  })`);
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

// [file, width, height, logo size]. scale-100 and scale-200 of each tile; the taskbar and Start
// list icon (Square44x44) also in the target sizes Windows asks for, unplated (no tile behind it).
const assets = [];
for (const [base, w, h, logo] of [
  ["Square44x44Logo", 44, 44, 44],
  ["Square150x150Logo", 150, 150, 104],
  ["Wide310x150Logo", 310, 150, 104],
  ["StoreLogo", 50, 50, 50],
]) {
  assets.push([`${base}.scale-100.png`, w, h, logo]);
  assets.push([`${base}.scale-200.png`, w * 2, h * 2, logo * 2]);
}
for (const t of [16, 24, 32, 48, 256]) {
  assets.push([`Square44x44Logo.targetsize-${t}.png`, t, t, t]);
  assets.push([`Square44x44Logo.targetsize-${t}_altform-unplated.png`, t, t, t]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL("data:text/html,<html><body></body></html>");
  for (const [file, w, h, logo] of assets) fs.writeFileSync(path.join(outDir, file), await render(win, w, h, logo));
  console.log(`${assets.length} images written to`, outDir);
  app.quit();
});
