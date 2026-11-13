// How the poser goldens are stored and replayed. Network inputs and outputs are kept as exact float32 bytes (base64),
// so a test can stand a recorded network in for the model; solved joints, bones and rig facts are rounded numbers.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MODEL_PATH = fileURLToPath(new URL("../../public/models/cozy-poser-v1.onnx", import.meta.url));
export const GOLDENS_PATH = fileURLToPath(new URL("../fixtures/poser/ybot-goldens.json", import.meta.url));

/**
 * The real network on the backend the app ships (onnxruntime-web, WASM, one thread), run in Node from the local model
 * file; the model check (byte count and SHA-256) runs as in the browser.
 */
export async function wasmNetwork(path = MODEL_PATH) {
	const { createWebNetwork } = await import("../../src/poser/ort-web.js");
	const bytes = readFileSync(path);
	return createWebNetwork({ source: { fetch: async () => new Response(bytes), caches: null } });
}

const pack = (array) => Buffer.from(Float32Array.from(array).buffer).toString("base64");
const unpack = (text) => { const b = Buffer.from(text, "base64"); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4).slice(); };
const round = (array, digits) => Array.from(array, (v) => Number(v.toFixed(digits)));

/** One recorded case: `seen` is the `{ inputs, out }` the network saw, or null when the query was rejected first. */
export function recordCase(name, result, seen) {
	if (!result.ok) return { name, ok: false, reason: result.reason, called: !!seen };
	const { inputs, out } = seen;
	return {
		name,
		ok: true,
		warnings: result.warnings,
		inputs: { val: pack(inputs.val), weights: pack(inputs.weights), cond: pack(inputs.cond), handleJoint: Array.from(inputs.jointId, Number), handleKind: Array.from(inputs.effType, Number) },
		network: { draft: pack(out.draft), rot6d: pack(out.rot6d) },
		joints: round(result.joints, 7),
		bones: result.bones.map((b) => [b.name, ...round(b.quaternion, 7), ...round(b.position, 5)]),
	};
}

/** Rig facts of a prepared character, as stored under the goldens' `rig`. */
export function rigFacts(rig) {
	return {
		written: Array.from(rig.written, Boolean),
		measuredLengths: round(rig.measured, 9),
		networkLengths: round(rig.network, 9),
		toeTipOffsets: rig.toeTips.map((tip) => round(tip, 9)),
		restCorrection: round(rig.C, 9),
		effectiveRest: round(rig.E, 9),
	};
}

/** The network's handle tokens as comparable rows (joint, kind, weight, values), in a fixed order. */
function tokens({ val, weights, jointId, effType }) {
	return Array.from(weights, (w, e) => [Number(jointId[e]), Number(effType[e]), w, ...val.subarray(7 * e, 7 * e + 7)])
		.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[3] - b[3] || a[4] - b[4] || a[5] - b[5]);
}

/**
 * A network that answers with a case's recorded output after checking that the encoder produced the recorded inputs
 * (within `eps`, in any handle order). `calls` counts runs.
 */
export function replayNetwork(record, eps = 1e-5) {
	const want = { val: unpack(record.inputs.val), weights: unpack(record.inputs.weights), jointId: record.inputs.handleJoint, effType: record.inputs.handleKind };
	const cond = unpack(record.inputs.cond), draft = unpack(record.network.draft), rot6d = unpack(record.network.rot6d);
	const replay = {
		calls: 0,
		async run(inputs) {
			replay.calls += 1;
			const got = tokens(inputs), ref = tokens(want);
			if (got.length !== ref.length) throw new Error(`${record.name}: ${got.length} handle tokens, recorded ${ref.length}`);
			got.forEach((row, e) => row.forEach((v, k) => { if (!(Math.abs(v - ref[e][k]) <= eps)) throw new Error(`${record.name}: token ${e} value ${k} is ${v}, recorded ${ref[e][k]}`); }));
			inputs.cond.forEach((v, k) => { if (!(Math.abs(v - cond[k]) <= eps)) throw new Error(`${record.name}: length code ${k} is ${v}, recorded ${cond[k]}`); });
			return { draft: draft.slice(), rot6d: rot6d.slice() };
		},
	};
	return replay;
}

/** Recorded network output of a case (float32). */
export const recordedOutput = (record) => ({ draft: unpack(record.network.draft), rot6d: unpack(record.network.rot6d) });
