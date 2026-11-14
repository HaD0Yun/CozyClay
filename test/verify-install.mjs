import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FIRST_LAUNCH_SOURCES } from "../bin/telemetry-state.mjs";
import { installSource, launchCommand, nodeInstaller } from "../src/install.js";
import { ctaTarget } from "../src/site/landing-analytics.js";

const fallback = "https://nodejs.org/en/download";
const release = (version, files, lts = "LTS") => ({ version, files, lts });
const releases = [
	release("v25.0.0", ["osx-x64-pkg", "win-x64-msi"], false),
	release("v24.2.0", ["osx-x64-pkg", "win-x64-msi"]),
	release("v22.19.0", ["osx-x64-pkg", "win-x64-msi", "win-arm64-msi"]),
];
assert.equal(launchCommand("win"), "npx.cmd --yes cozyclay@latest --via site");
assert.equal(launchCommand("mac"), "npx --yes cozyclay@latest --via site");
assert.equal(launchCommand("linux"), launchCommand("mac"));
// #1183: the hosted Studio links to the page with ?from=studio, and only then the command says --via playground
assert.equal(installSource("?from=studio"), "playground");
assert.equal(installSource("?utm_source=x&from=studio"), "playground");
for (const search of ["", "?from=", "?from=site", "?from=Studio", "?studio"]) assert.equal(installSource(search), "site", `${search || "no query"} stays the landing page's own source`);
assert.equal(launchCommand("mac", installSource("?from=studio")), "npx --yes cozyclay@latest --via playground");
assert.equal(launchCommand("win", installSource("?from=studio")), "npx.cmd --yes cozyclay@latest --via playground");
const copyButton = (copy) => ({ closest: (selector) => (selector === "button.copy[data-copy]" ? { dataset: { copy } } : null) });
for (const search of ["", "?from=studio"]) {
	assert.ok(FIRST_LAUNCH_SOURCES.includes(installSource(search)), "the launcher records the source the page copies");
	assert.equal(ctaTarget(copyButton(launchCommand("mac", installSource(search)))), "copy_npx", "either command counts as the same copy button");
}
assert.equal(nodeInstaller(releases, "mac"), "https://nodejs.org/dist/v24.2.0/node-v24.2.0.pkg");
assert.equal(nodeInstaller(releases, "win", "x64"), "https://nodejs.org/dist/v24.2.0/node-v24.2.0-x64.msi");
assert.equal(nodeInstaller(releases, "win", "arm64"), "https://nodejs.org/dist/v22.19.0/node-v22.19.0-arm64.msi");
assert.equal(nodeInstaller(releases.slice(0, 2), "win", "arm64"), fallback);
assert.equal(nodeInstaller(releases, "win", null), fallback);
assert.equal(nodeInstaller(releases, "linux"), fallback);
assert.equal(nodeInstaller([release("v22.18.0", ["osx-x64-pkg"])], "mac"), fallback);
assert.equal(nodeInstaller([release("v24.0.0/unsafe", ["osx-x64-pkg"])], "mac"), fallback);
assert.equal(nodeInstaller([null, {}, release("v24.0.0", null)], "mac"), fallback);
assert.equal(nodeInstaller(null, "mac"), fallback);

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
assert.match(html, /import \{ setupInstall \} from "\.\/src\/install\.js"/);
assert.match(html, /data-install-step="1"/);
// Windows leads with the installer download; the Node.js steps stay behind one button
assert.match(html, /data-installer-download href="https:\/\/github\.com\/HaD0Yun\/CozyClay\/releases\/download\/windows-installer\/CozyClay-Setup\.exe"/);
assert.match(html, /data-install-manual/);
// macOS leads with the signed, notarized app download
assert.match(html, /data-install-direct="mac"[\s\S]*data-installer-download href="https:\/\/github\.com\/HaD0Yun\/cozyclay-releases\/releases\/latest\/download\/CozyClay\.dmg"/);
const script = readFileSync(new URL("../public/install.sh", import.meta.url), "utf8");
assert.match(script, /SHASUMS256\.txt/);
assert.match(script, /npx --yes cozyclay@latest --via installer/);
assert.match(script, /Applications\/CozyClay\.app/);
// phones cannot install: Install is hidden there, the rest of the page stays
assert.match(html, /\[data-touch\] :is\(\[data-install-open\]/);
assert.match(html, /Run anyway/);
assert.match(html, /data-install-step="2" hidden/);
assert.match(html, /id="install-status"[^>]*role="status"/);
assert.match(html, /http:\/\/127\.0\.0\.1:5180\/app\//);
assert.match(html, /Keep (?:this |the )?terminal (?:window )?open/i);
assert.match(html, /class="[^"]*copy" data-copy="[^"]*--via site" data-install-copy/);
assert.ok(html.includes('button.copy[data-copy]:not([data-install-copy])'));
console.log("install guidance: command, installer compatibility and accessible entry checks passed");
