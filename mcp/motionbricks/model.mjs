// The MotionBricks SOMA model (FP32 ONNX, 758 MB; mixed FP16 380 MB with COZYCLAY_MB_PRECISION=fp16) on onnxruntime-node, CPU. The weights are never committed:
// the first use downloads them from the upstream repository's Git LFS store into a cache directory and checks SHA-256.
// Licensed by NVIDIA Corporation under the NVIDIA Open Model Agreement (see NOTICE.md next to this file).
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// fp32 by default (CPU 15-16 ms per call against fp16's 26-30 ms, and fp16 drifts up to 3.4 cm); COZYCLAY_MB_PRECISION=fp16 picks the half-size file
const MODELS = {
	fp32: { file: "mmm_v6_soma_fp32.onnx", sha256: "856419dc72aeb14e591eebf4dd0ea05734a2506ddb00bcd39dd6dac2ad60f4fb", bytes: 757864273 },
	fp16: { file: "mmm_v6_soma_fp16.onnx", sha256: "6c9f78e23decbda8e1cfd1b0cc96980ea4b24b3ca2c808d03b058f48f82fc9ef", bytes: 380327058 },
};
const precision = () => (process.env.COZYCLAY_MB_PRECISION === "fp16" ? "fp16" : "fp32");
const MODEL_DIR = "https://media.githubusercontent.com/media/NVlabs/motionbricks/main/motionbricks/assets/onnx/soma/";
const model = () => ({ ...MODELS[precision()], url: MODEL_DIR + MODELS[precision()].file });

const modelPath = () => process.env.COZYCLAY_MOTIONBRICKS_MODEL
	?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "cozyclay", "motionbricks", model().file);

async function sha256(path) {
	const h = createHash("sha256");
	await pipeline(createReadStream(path), h);
	return h.digest("hex");
}

/** The model file, downloaded and verified on first use. */
async function ensureModel(log = () => {}) {
	const path = modelPath(), MODEL = model();
	if (existsSync(path)) return path;
	mkdirSync(dirname(path), { recursive: true });
	log(`downloading the MotionBricks SOMA model (${precision()}, ${Math.round(MODEL.bytes / 1e6)} MB) to ${path}`);
	const res = await fetch(MODEL.url);
	if (!res.ok) throw new Error(`MOTIONBRICKS_DOWNLOAD_FAILED: ${res.status} ${MODEL.url}`);
	const part = `${path}.part`;
	await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
	const got = await sha256(part);
	if (got !== MODEL.sha256) throw new Error(`MOTIONBRICKS_CHECKSUM_MISMATCH: got ${got}, want ${MODEL.sha256} (${part} kept)`);
	renameSync(part, path);
	return path;
}

/** run(feed) -> { out: Float32Array [64 x 366], tokens } for one request (feed from src/motion3/bricks/model-io.js). */
export async function createRunner(log) {
	// not an MCP dependency (the server stays free of a native runtime): install it next to the server to use this tool
	const ort = await import("onnxruntime-node").catch(() => {
		throw new Error("MOTIONBRICKS_RUNTIME_MISSING: run `npm install --no-save onnxruntime-node@1.23` in mcp/ first");
	});
	const session = await ort.InferenceSession.create(await ensureModel(log), { executionProviders: ["cpu"] });
	return async feed => {
		const inputs = Object.fromEntries(Object.entries(feed).map(([k, { data, dims, type }]) => [k, new ort.Tensor(type, data, dims)]));
		const res = await session.run(inputs);
		return { out: res.pred_global_motions.data, tokens: Number(res.pred_num_tokens.data[0]) };
	};
}
