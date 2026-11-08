#!/usr/bin/env node
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computePackageDigest, verifyPackageMarker } from "../bin/package-signature.mjs";

const directory = mkdtempSync(join(tmpdir(), "cozyclay-package-signature-"));
mkdirSync(join(directory, "dist"));
mkdirSync(join(directory, "dist", "media"));
mkdirSync(join(directory, "tools"));
writeFileSync(join(directory, "README.md"), "signed package\n");
writeFileSync(join(directory, "dist", "media", "demo.mp4"), "demo video\n");
writeFileSync(join(directory, "tools", "qa-check.mjs"), "qa script\n");
const marker = join(directory, "dist", "cozyclay-package.json");
const metadata = { version: "1.5.0" };
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicDer = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const payload = JSON.stringify({
	distribution: "npm",
	package: "cozyclay",
	version: "1.5.0",
	repository: "HaD0Yun/CozyClay",
	content_sha256: computePackageDigest(directory),
});

try {
	writeFileSync(marker, JSON.stringify({
		payload,
		signature: sign(null, Buffer.from(payload), privateKey).toString("base64"),
	}));
	assert.equal(verifyPackageMarker(marker, directory, metadata, publicDer), true);

	writeFileSync(join(directory, "dist", "media", "demo.mp4"), "re-encoded demo video\n");
	writeFileSync(join(directory, "tools", "qa-check.mjs"), "edited qa script\n");
	assert.equal(
		verifyPackageMarker(marker, directory, metadata, publicDer),
		true,
		"files excluded by package.json#files do not invalidate the package marker",
	);

	writeFileSync(join(directory, "README.md"), "forked package\n");
	assert.equal(verifyPackageMarker(marker, directory, metadata, publicDer), false, "modified package content is rejected");
	assert.equal(verifyPackageMarker(join(directory, "missing.json"), directory, metadata, publicDer), false);

	console.log("all official package signature checks PASS");
} finally {
	rmSync(directory, { recursive: true, force: true });
}
