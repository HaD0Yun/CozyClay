import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, normalize, resolve, sep } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const IMAGE_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

/**
 * Resolve a user-supplied image path and verify it is inside one of the
 * allowed roots: the project working directory, the OS temp directory, or the
 * user home directory. This keeps the director from reading arbitrary files.
 */
function resolveAllowedImage(path: string, projectDir: string): string {
	const target = isAbsolute(path) ? normalize(path) : resolve(projectDir, path);
	const normalized = resolve(target);
	const allowedRoots = [
		resolve(projectDir),
		resolve(homedir()),
		resolve(normalize(sep === "\\" ? (process.env.TEMP ?? "/tmp") : "/tmp")),
	];
	const within = (candidate: string, root: string): boolean => {
		const r = root.endsWith(sep) ? root : root + sep;
		return candidate === root || candidate.startsWith(r);
	};
	if (!allowedRoots.some((root) => within(normalized, resolve(root)))) {
		throw new Error(`IMAGE_PATH_NOT_ALLOWED: ${path} is outside the project, home, or temp directory`);
	}
	return normalized;
}

export function createReadImageTool(projectDir: string) {
	return defineTool({
		name: "read_image",
		label: "read_image",
		description:
			"Read an image file from the local filesystem into the conversation as an image content block. Use this when the user pastes a screenshot or references an image by path (e.g. a pi-clipboard-* file) and you need to see it for visual QA. Allowed roots: the project directory, the user home directory, and the OS temp directory.",
		parameters: Type.Object({
			path: Type.String({ minLength: 1, maxLength: 4096 }),
		}),
		execute: async (_toolCallId, params) => {
			const resolved = resolveAllowedImage(params.path, projectDir);
			const lower = resolved.toLowerCase();
			const ext = lower.slice(lower.lastIndexOf("."));
			const mimeType = IMAGE_MIME[ext];
			if (!mimeType) {
				throw new Error(`UNSUPPORTED_IMAGE_TYPE: ${ext || "(no extension)"} is not a recognized image type`);
			}
			const bytes = readFileSync(resolved);
			const data = bytes.toString("base64");
			return {
				content: [
					{ type: "image" as const, data, mimeType },
					{ type: "text" as const, text: `Loaded image ${params.path} (${bytes.length} bytes, ${mimeType}).` },
				],
				details: { path: params.path, bytes: bytes.length, mimeType },
			};
		},
	});
}
