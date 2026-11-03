// Turns the pristine Code-OSS checkout (ide/vscode) into Converlt. Idempotent:
// it first restores every tracked upstream file, then applies, in order:
//   1. product.overrides.json  -> vscode/product.json   (null deletes a key)
//   2. overlays/**             -> copied over the tree  (icons, watermark)
//   3. patches/*.patch         -> git apply             (core code changes)
//   4. built-in extensions     -> vscode/extensions/    (Converlt + defaults/theme)
//
//   node ide/apply.mjs        (expects ide/extensions/converge to be built)
import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ide = path.dirname(fileURLToPath(import.meta.url));
const vscode = path.join(ide, "vscode");
const git = (...args) => execFileSync("git", ["-C", vscode, ...args], { stdio: ["ignore", "pipe", "inherit"] }).toString();

async function walk(dir, base = dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, base)));
    else out.push(path.relative(base, p));
  }
  return out;
}

// 0. Back to pristine upstream (tracked files only; node_modules and build output stay).
git("checkout", "--", ".");
for (const name of ["converge", "converge-defaults"]) await rm(path.join(vscode, "extensions", name), { recursive: true, force: true });

// 1. Product identity.
const productPath = path.join(vscode, "product.json");
const product = JSON.parse(await readFile(productPath, "utf8"));
const overrides = JSON.parse(await readFile(path.join(ide, "product.overrides.json"), "utf8"));
for (const [k, v] of Object.entries(overrides)) {
  if (v === null) delete product[k];
  else product[k] = v;
}
await writeFile(productPath, JSON.stringify(product, null, "\t") + "\n");
console.log("product.json: branded as", product.nameLong);

// 2. Overlays.
const overlayDir = path.join(ide, "overlays");
const overlays = await walk(overlayDir);
for (const rel of overlays) {
  await mkdir(path.dirname(path.join(vscode, rel)), { recursive: true });
  await cp(path.join(overlayDir, rel), path.join(vscode, rel));
}
console.log(`overlays: ${overlays.length} files`);

// 3. Patches.
const patchDir = path.join(ide, "patches");
const patches = (await readdir(patchDir)).filter((f) => f.endsWith(".patch")).sort();
for (const p of patches) {
  git("apply", "--whitespace=nowarn", path.join(patchDir, p));
  console.log("patch:", p);
}

// 4a. Converlt extension (prebuilt bundle; no dependencies to install).
const extSrc = path.join(ide, "extensions/converge");
const extDst = path.join(vscode, "extensions/converge");
const extPkg = JSON.parse(await readFile(path.join(extSrc, "package.json"), "utf8"));
delete extPkg.devDependencies;
delete extPkg.scripts;
delete extPkg.private;
await mkdir(extDst, { recursive: true });
await writeFile(path.join(extDst, "package.json"), JSON.stringify(extPkg, null, 2) + "\n");
await cp(path.join(extSrc, "media"), path.join(extDst, "media"), { recursive: true });
await cp(path.join(extSrc, "dist"), path.join(extDst, "dist"), { recursive: true, filter: (s) => !s.endsWith(".map") });
await writeFile(path.join(extDst, ".vscodeignore"), "**/*.map\n");

// 4b. Defaults + theme. The themes extend VS Code's Modern themes, copied alongside.
const defSrc = path.join(ide, "extensions/converge-defaults");
const defDst = path.join(vscode, "extensions/converge-defaults");
await cp(defSrc, defDst, { recursive: true });
const upstreamThemes = path.join(vscode, "extensions/theme-defaults/themes");
for (const t of ["dark_modern.json", "dark_plus.json", "dark_vs.json", "light_modern.json", "light_plus.json", "light_vs.json"]) {
  await cp(path.join(upstreamThemes, t), path.join(defDst, "themes", t));
}
console.log("built-in extensions: converge, converge-defaults");
