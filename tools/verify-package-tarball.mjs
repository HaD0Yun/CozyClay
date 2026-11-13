#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
// CI has no signing key: --imports-only stops after the import check.
const importsOnly = process.argv.includes("--imports-only");
const temporaryRoot = mkdtempSync(join(tmpdir(), "cozyclay-package-check-"));
const extractionRoot = join(temporaryRoot, "extracted");
// Static, side-effect and dynamic imports with a relative specifier.
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.\.?\/[^"']+)["']/g;

function* modulesUnder(dir) {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* modulesUnder(path);
		else if (entry.name.endsWith(".mjs")) yield path;
	}
}

// Every relative import of a shipped bin/ or mcp/ module must resolve inside the
// tarball: a dev checkout has every file, an npm install only what `files` lists.
function missingImports(packedRoot) {
	const missing = [];
	for (const file of [...modulesUnder(join(packedRoot, "bin")), ...modulesUnder(join(packedRoot, "mcp"))]) {
		for (const [, specifier] of readFileSync(file, "utf8").matchAll(RELATIVE_IMPORT)) {
			const target = resolve(dirname(file), specifier);
			if (!existsSync(target)) missing.push(`${relative(packedRoot, file)} imports ${specifier} (${relative(packedRoot, target)} is not in the tarball)`);
		}
	}
	return missing;
}

// The npm package is the one build that ships the Auto Pose model (git and the hosted site do not). A release
// without it, or with another file under its name, must not go out: check the bytes against src/poser/config.js.
async function verifyPoserModel(packedRoot) {
	const { POSER_MODEL } = await import(pathToFileURL(join(packageRoot, "src", "poser", "config.js")).href);
	const relativePath = join("dist", ...POSER_MODEL.url.split("/").filter(Boolean)), path = join(packedRoot, relativePath);
	const where = `copy the model to public/models/${POSER_MODEL.url.split("/").pop()} (git-ignored) and run npm run build before packing`;
	if (!existsSync(path)) throw new Error(`npm tarball has no Auto Pose model at ${relativePath}: ${where}`);
	const bytes = statSync(path).size, sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
	if (bytes !== POSER_MODEL.bytes || sha256 !== POSER_MODEL.sha256) {
		throw new Error(`npm tarball's ${relativePath} is not the configured model (${bytes} bytes, sha256 ${sha256.slice(0, 12)}…; expected ${POSER_MODEL.bytes} bytes, ${POSER_MODEL.sha256.slice(0, 12)}…): ${where}`);
	}
	console.log(`package Auto Pose model PASS (${relativePath}, ${bytes} bytes, sha256 matches src/poser/config.js)`);
}

async function verifySignature(packedRoot) {
	const metadataPath = join(packedRoot, "package.json");
	const markerPath = join(packedRoot, "dist", "cozyclay-package.json");
	const signatureModulePath = join(packedRoot, "bin", "package-signature.mjs");
	if (!existsSync(metadataPath) || !existsSync(markerPath) || !existsSync(signatureModulePath)) {
		throw new Error("npm tarball is missing package metadata or its signature marker");
	}
	const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
	const { verifyPackageMarker } = await import(pathToFileURL(signatureModulePath).href);
	if (!verifyPackageMarker(markerPath, packedRoot, metadata)) {
		throw new Error("npm tarball signature digest does not match the files npm ships");
	}
	console.log(`package tarball signature PASS (${metadata.name}@${metadata.version})`);
}

try {
	mkdirSync(extractionRoot);
	execFileSync("npm", [
		"pack",
		"--ignore-scripts",
		"--pack-destination", temporaryRoot,
	], { cwd: packageRoot, stdio: "pipe" });

	const tarball = readdirSync(temporaryRoot)
		.filter((entry) => entry.endsWith(".tgz"))
		.map((entry) => join(temporaryRoot, entry))[0];
	if (!tarball) throw new Error("npm pack did not produce a tarball");
	execFileSync("tar", ["-xzf", tarball, "-C", extractionRoot]);

	const packedRoot = join(extractionRoot, "package");
	const missing = missingImports(packedRoot);
	if (missing.length > 0) throw new Error(`npm tarball is missing modules its bin/ and mcp/ code imports:\n  ${missing.join("\n  ")}`);
	console.log("package tarball imports PASS (every relative import in bin/ and mcp/ resolves inside the tarball)");
	if (!importsOnly) await verifyPoserModel(packedRoot);
	if (!importsOnly) await verifySignature(packedRoot);
} finally {
	rmSync(temporaryRoot, { recursive: true, force: true });
}
