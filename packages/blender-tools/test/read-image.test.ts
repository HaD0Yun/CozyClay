import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createReadImageTool } from "../src/read-image.ts";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const POSIX = process.platform !== "win32";

describe("read_image", () => {
	const projectDir = mkdtempSync(path.join(tmpdir(), "cclay-read-image-project-"));
	const scratchDir = mkdtempSync(path.join(tmpdir(), "cclay-read-image-scratch-"));
	const cleanups: string[] = [projectDir, scratchDir];
	after(() => {
		for (const target of cleanups) rmSync(target, { recursive: true, force: true });
	});
	const tool = createReadImageTool(projectDir);
	const execute = (imagePath: string) =>
		tool.execute("test", { path: imagePath }, undefined, undefined, undefined as never);

	it("reads an image created under os.tmpdir()", async () => {
		const imagePath = path.join(scratchDir, "clipboard.png");
		writeFileSync(imagePath, PNG);
		const result = await execute(imagePath);
		assert.equal(result.content[0]?.type, "image");
		assert.equal(result.details.mimeType, "image/png");
		assert.equal(result.details.bytes, PNG.length);
	});

	it("reads a /tmp-prefixed path even when /tmp is a symlink (macOS /private/tmp)", { skip: !POSIX }, async () => {
		const imagePath = `/tmp/cclay-read-image-${process.pid}-${Date.now()}.png`;
		writeFileSync(imagePath, PNG);
		cleanups.push(imagePath);
		const result = await execute(imagePath);
		assert.equal(result.content[0]?.type, "image");
		assert.equal(result.details.bytes, PNG.length);
	});

	it("rejects a path outside the project, home, and temp roots", async () => {
		await assert.rejects(
			execute(path.join(path.parse(projectDir).root, "cclay-definitely-not-allowed", "x.png")),
			/IMAGE_PATH_NOT_ALLOWED/,
		);
	});

	it("rejects a symlink inside an allowed root that escapes every root", { skip: !POSIX }, async () => {
		const linkPath = path.join(scratchDir, "escape.png");
		symlinkSync("/etc/hosts", linkPath);
		await assert.rejects(execute(linkPath), /IMAGE_PATH_NOT_ALLOWED/);
	});
});
