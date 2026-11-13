import { createHash, createPublicKey, verify } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const PACKAGE_SIGNATURE_PUBLIC_KEY = "MCowBQYDK2VwAyEAiDLutMZ8CX/NzpuQF/juhT8v9QwPBUvIOHFRqEZoG3U=";

const CONTENT_ROOTS = [
	"bin",
	"dist",
	"src",
	"tools",
	"mcp/runtime",
	"mcp/server.mjs",
	"mcp/tool-handlers.mjs",
	"mcp/live-hub.mjs",
	"mcp/package.json",
	"mcp/README.md",
	"mcp/LIVE-PROTOCOL.md",
	"package.json",
	"README.md",
	"CHANGELOG.md",
	"LICENSE",
	"LICENSES",
	"LICENSING.md",
	"THIRD_PARTY_NOTICES.md",
];

function ignored(relativePath) {
	return relativePath === "dist/cozyclay-package.json"
		|| (/^dist\/media\/[^/]+\.mp4$/i.test(relativePath))
		|| /^tools\/qa-[^/]+\.mjs$/i.test(relativePath);
}

function collectFiles(path, packageRoot, output) {
	let entries;
	try {
		entries = readdirSync(path, { withFileTypes: true });
	} catch (error) {
		if (error?.code === "ENOTDIR") {
			const relativePath = relative(packageRoot, path).split(sep).join("/");
			if (!ignored(relativePath)) output.push({ path, relativePath });
			return;
		}
		if (error?.code === "ENOENT") return;
		throw error;
	}
	for (const entry of entries) {
		const child = join(path, entry.name);
		const relativePath = relative(packageRoot, child).split(sep).join("/");
		if (ignored(relativePath)) continue;
		if (entry.isDirectory()) collectFiles(child, packageRoot, output);
		if (entry.isFile()) output.push({ path: child, relativePath });
	}
}

export function computePackageDigest(packageRoot) {
	const absoluteRoot = resolve(packageRoot);
	const files = [];
	for (const entry of CONTENT_ROOTS) collectFiles(join(absoluteRoot, entry), absoluteRoot, files);
	files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(file.relativePath);
		hash.update("\0");
		hash.update(readFileSync(file.path));
		hash.update("\0");
	}
	return hash.digest("hex");
}

export function verifyPackageMarker(
	markerFile,
	packageRoot,
	packageMetadata,
	publicKeyBase64 = PACKAGE_SIGNATURE_PUBLIC_KEY,
) {
	try {
		const marker = JSON.parse(readFileSync(markerFile, "utf8"));
		const payload = JSON.parse(marker.payload);
		if (payload.distribution !== "npm") return false;
		if (payload.package !== "cozyclay") return false;
		if (payload.version !== packageMetadata.version) return false;
		if (payload.repository !== "HaD0Yun/CozyClay") return false;
		if (payload.content_sha256 !== computePackageDigest(packageRoot)) return false;
		const publicKey = createPublicKey({
			key: Buffer.from(publicKeyBase64, "base64"),
			format: "der",
			type: "spki",
		});
		return verify(null, Buffer.from(marker.payload), publicKey, Buffer.from(marker.signature, "base64"));
	} catch {
		return false;
	}
}
