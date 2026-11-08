#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { computePackageDigest } from "../bin/package-signature.mjs";

const marker = new URL("../dist/cozyclay-package.json", import.meta.url);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const checkOnly = process.argv.includes("--check-key");
if (process.argv.includes("--clean")) {
	rmSync(marker, { force: true });
} else {
	let privateKeyBase64 = process.env.COZYCLAY_PACKAGE_SIGNING_KEY?.trim();
	if (!privateKeyBase64 && process.platform === "darwin") {
		try {
			privateKeyBase64 = execFileSync("security", [
				"find-generic-password",
				"-a", process.env.USER,
				"-s", "cozyclay-package-signing-key",
				"-w",
			], { encoding: "utf8" }).trim();
		} catch {
			// The explicit error below names the release prerequisite.
		}
	}
	if (!privateKeyBase64) {
		rmSync(marker, { force: true });
		if (checkOnly) throw new Error("COZYCLAY_PACKAGE_SIGNING_KEY is required to publish the official npm package");
		console.warn("package signing key unavailable; building an unsigned package with telemetry disabled");
		process.exit(0);
	}
	if (checkOnly) process.exit(0);
	const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	const payload = JSON.stringify({
		distribution: "npm",
		package: "cozyclay",
		version: packageMetadata.version,
		repository: "HaD0Yun/CozyClay",
		content_sha256: computePackageDigest(packageRoot),
	});
	const privateKey = createPrivateKey({
		key: Buffer.from(privateKeyBase64, "base64"),
		format: "der",
		type: "pkcs8",
	});
	const signature = sign(null, Buffer.from(payload), privateKey).toString("base64");
	writeFileSync(marker, JSON.stringify({ payload, signature }) + "\n");
}
