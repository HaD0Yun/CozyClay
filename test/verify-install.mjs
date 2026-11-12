import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { launchCommand, nodeInstaller } from "../src/install.js";

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
assert.match(html, /data-install-step="2" hidden/);
assert.match(html, /id="install-status"[^>]*role="status"/);
assert.match(html, /http:\/\/127\.0\.0\.1:5180\/app\//);
assert.match(html, /Keep (?:this |the )?terminal (?:window )?open/i);
assert.match(html, /class="[^"]*copy" data-copy="[^"]*--via site" data-install-copy/);
assert.ok(html.includes('button.copy[data-copy]:not([data-install-copy])'));
console.log("install guidance: command, installer compatibility and accessible entry checks passed");
