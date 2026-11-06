// Packages the built IDE (ide/out/Converlt-win32-x64) as an MSIX for the Microsoft Store.
//   node ide/msix/build-msix.mjs            # ide/out/Converlt-<version>-x64.msix
//   node ide/msix/build-msix.mjs --register # also install it on this PC to try it (needs Developer Mode)
//
// The Store signs packages it distributes, so the package itself is left unsigned. Its identity must
// match the app reserved in Partner Center (Product identity page); set these before a Store build:
//   CONVERLT_MSIX_NAME            Package/Identity/Name, e.g. 12345Sehastrajit.Converlt
//   CONVERLT_MSIX_PUBLISHER       Package/Identity/Publisher, e.g. CN=1A2B3C4D-...
//   CONVERLT_MSIX_PUBLISHER_NAME  Package/Properties/PublisherDisplayName, e.g. Sehastrajit
// Without them, a local test identity is used (fine for --register, rejected by the Store).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ide = path.resolve(here, "..");
const app = path.join(ide, "out", "Converlt-win32-x64");
const stage = path.join(ide, "out", "msix-stage");
const register = process.argv.includes("--register");

if (!existsSync(path.join(app, "Converlt.exe"))) {
  console.error(`No built IDE at ${app}. Run pnpm build first.`);
  process.exit(1);
}
const product = JSON.parse(await readFile(path.join(app, "resources", "app", "product.json"), "utf8"));
const version = product.converltVersion;
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("The build has no Converlt version (product.json converltVersion). Rebuild with the current ide/apply.mjs.");
  process.exit(1);
}

const identity = {
  name: process.env.CONVERLT_MSIX_NAME ?? "Converlt.Local",
  publisher: process.env.CONVERLT_MSIX_PUBLISHER ?? "CN=Converlt Local Test",
  publisherName: process.env.CONVERLT_MSIX_PUBLISHER_NAME ?? "Converlt",
};
const forStore = !!process.env.CONVERLT_MSIX_NAME;
const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The Store wants the fourth version part to be 0.
const manifest = `<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">
  <Identity Name="${xml(identity.name)}" Publisher="${xml(identity.publisher)}" Version="${version}.0" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>Converlt</DisplayName>
    <PublisherDisplayName>${xml(identity.publisherName)}</PublisherDisplayName>
    <Description>The ML-native IDE: train on any GPU, see why runs fail, and reproduce anyone's run exactly.</Description>
    <Logo>assets\\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Resources>
    <Resource Language="en-us" />
  </Resources>
  <Applications>
    <Application Id="Converlt" Executable="Converlt.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="Converlt" Description="The ML-native IDE" BackgroundColor="transparent"
        Square150x150Logo="assets\\Square150x150Logo.png" Square44x44Logo="assets\\Square44x44Logo.png">
        <uap:DefaultTile Wide310x150Logo="assets\\Wide310x150Logo.png" ShortName="Converlt" />
      </uap:VisualElements>
      <Extensions>
        <!-- Browser sign-in returns to the app through this link scheme (product.json urlProtocol). -->
        <uap:Extension Category="windows.protocol">
          <uap:Protocol Name="${xml(product.urlProtocol ?? "converge")}">
            <uap:DisplayName>Converlt</uap:DisplayName>
          </uap:Protocol>
        </uap:Extension>
      </Extensions>
    </Application>
  </Applications>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
`;

console.log(`==> Staging Converlt ${version} (${forStore ? "Store identity" : "local test identity"})`);
await rm(stage, { recursive: true, force: true });
await cp(app, stage, { recursive: true });
await cp(path.join(here, "assets"), path.join(stage, "assets"), { recursive: true });
await writeFile(path.join(stage, "AppxManifest.xml"), manifest);

/** makeappx.exe from the newest installed Windows 10/11 SDK. */
function sdkTool(name) {
  const root = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
  const versions = existsSync(root) ? readdirSync(root).filter((v) => /^10\./.test(v) && existsSync(path.join(root, v, "x64", name))) : [];
  versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!versions.length) throw new Error(`${name} not found: install the Windows SDK (winget install Microsoft.WindowsSDK.10.0.26100).`);
  return path.join(root, versions.at(-1), "x64", name);
}

if (register) {
  console.log("==> Installing on this PC from the staged files (Developer Mode)");
  execFileSync("powershell", ["-NoProfile", "-Command", `Add-AppxPackage -Register '${path.join(stage, "AppxManifest.xml")}' -ForceApplicationShutdown`], { stdio: "inherit" });
  console.log("Installed. Start Converlt from the Start menu; remove it from Settings → Apps.");
} else {
  const out = path.join(ide, "out", `Converlt-${version}-x64.msix`);
  // resources.pri lets Windows pick the right size of each logo (scale-100/200, target sizes).
  console.log("==> makepri (logo index)");
  const priConfig = path.join(ide, "out", "msix-priconfig.xml");
  const quiet = { stdio: ["ignore", "ignore", "pipe"] };
  execFileSync(sdkTool("makepri.exe"), ["createconfig", "/cf", priConfig, "/dq", "en-US", "/o"], quiet);
  execFileSync(sdkTool("makepri.exe"), ["new", "/pr", stage, "/cf", priConfig, "/of", path.join(stage, "resources.pri"), "/o"], quiet);
  await rm(priConfig, { force: true });
  console.log("==> makeappx pack");
  try {
    execFileSync(sdkTool("makeappx.exe"), ["pack", "/d", stage, "/p", out, "/o"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const text = `${e.stdout ?? ""}${e.stderr ?? ""}`.split(/\r?\n/).filter((l) => /error/i.test(l)).join("\n");
    console.error(text || String(e));
    process.exit(1);
  }
  await rm(stage, { recursive: true, force: true });
  console.log(`==> Done: ${out}${forStore ? "" : "\n    (local test identity: set CONVERLT_MSIX_NAME/PUBLISHER/PUBLISHER_NAME from Partner Center for the Store)"}`);
}
