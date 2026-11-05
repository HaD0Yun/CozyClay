// The MotionBricks fill as a request the dev server answers (POST /agent/motion-fill, tools/dev-full.mjs):
// { spec, at?, model?, auto?, objects?, timing?, gate? } -> { spec (the filled spec, fill keys src: "fill"), gaps, calls, ms }. The Studio's motion.fill
// action sends the authored spec here because the model runs on onnxruntime-node, not in the browser. One runner per process.
import { Worker } from "node:worker_threads";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { runCompileJob } from "../../src/motion3/compile-job.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { motionScene } from "../../src/motion3/scene.js";
import { fillSpec } from "../../src/motion3/bricks/fill.js";
import { fillSpecNative } from "../../src/motion3/bricks/fill-native.js";
import { createRunner } from "./model.mjs";
import { expandPoses } from "../../src/motion3/poses.js";

let runner;

const TIMINGS = ["exact", "free", "retime", "playground"];

// timing (motion.fill's argument) picks the native fill per call; without it COZYCLAY_MB_MODE / _TIMING / _GATE decide, as before
export async function fillRequest({ spec, at, model = "x-bot-tpose", auto = false, objects = [], timing, gate, mode = timing ? "native" : process.env.COZYCLAY_MB_MODE } = {}) {
	if (timing !== undefined && !TIMINGS.includes(timing)) throw Object.assign(new Error(`timing must be one of ${TIMINGS.join(", ")}`), { code: "INVALID_ARGUMENT" });
	if (!spec || typeof spec !== "object" || !Array.isArray(spec.keys)) throw Object.assign(new Error("spec must be a motion spec with keys"), { code: "INVALID_ARGUMENT" });
	if (at !== undefined && !Number.isInteger(at)) throw Object.assign(new Error("at must be a whole frame"), { code: "INVALID_ARGUMENT" });
	const sk = skeletonFor(model);
	if (!sk) throw Object.assign(new Error(`${model} is not a rig the fill can drive`), { code: "TARGET_NOT_READY" });
	spec = expandPoses(spec, sk);
	const t0 = performance.now();
	const run = await (runner ??= createRunner().catch(error => { runner = undefined; throw error; }));
	// the editor's scene objects (motion3-fill.js sends them): an anchor or a check naming a wall, a table or a door handle compiles here too
	const scene = motionScene(Array.isArray(objects) ? objects : []);
	if (mode === "native") {
		// the unfilled spec as motion.compile installs it (repair, no thinning): the naturalness bar of the fill's guard
		const reference = async () => { const j = runCompileJob({ model, scene, spec: { fps: 24, ...spec }, repair: { rounds: 2 }, installing: true, thin: false, hintLimitMs: 0 }); return compileSpec(j.stored, { sk, scene }).observations?.life; };
		const filled = await fillSpecNative(spec, { sk, compile: s => compileSpec(s, { sk, scene }), run, reference }, { at, timing: timing ?? (TIMINGS.includes(process.env.COZYCLAY_MB_TIMING) ? process.env.COZYCLAY_MB_TIMING : "exact"), gate: typeof gate === "boolean" ? gate : process.env.COZYCLAY_MB_GATE !== "0" });
		return { ...filled, ms: Math.round(performance.now() - t0) };
	}
	const filled = await fillSpec(spec, { sk, compile: s => compileSpec(s, { sk, scene }), run }, { at, auto: auto === true, targets: Number(process.env.COZYCLAY_MB_TARGETS) === 4 ? 4 : 1, footLock: process.env.COZYCLAY_MB_FOOTLOCK === "speed" ? "speed" : "channel" });
	return { ...filled, ms: Math.round(performance.now() - t0) };
}

let worker, nextId = 0;
const waiting = new Map();
/** fillRequest on the fill worker (fill-worker.mjs), so the dev server's event loop (and the live hub on it) stays free. */
export function fillInWorker(args) {
	if (!worker) {
		worker = new Worker(new URL("./fill-worker.mjs", import.meta.url));
		worker.unref();
		worker.on("message", ({ id, ok, value, error }) => {
			const w = waiting.get(id);
			if (!w) return;
			waiting.delete(id);
			ok ? w.resolve(value) : w.reject(Object.assign(new Error(error.message), error.code ? { code: error.code } : {}));
		});
		const fail = error => { for (const w of waiting.values()) w.reject(error); waiting.clear(); worker = undefined; };
		worker.on("error", fail);
		worker.on("exit", code => fail(Object.assign(new Error(`the fill worker stopped (${code})`), { code: "FILL_FAILED" })));
	}
	const id = ++nextId;
	return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); worker.postMessage({ id, args }); });
}

const BODY_LIMIT = 16 * 1024 * 1024; // the spec and the scene's objects

/** POST /agent/motion-fill on the dev server (tools/dev-full.mjs): JSON { spec, at?, model? } in, fillRequest's answer or { error: { code, message } } out. */
export async function handleFillRoute(req, res) {
	const send = (status, value) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value)); };
	try {
		let size = 0;
		const chunks = [];
		for await (const chunk of req) {
			size += chunk.length;
			if (size > BODY_LIMIT) throw Object.assign(new Error("request body is over 16 MB"), { code: "INVALID_ARGUMENT" });
			chunks.push(chunk);
		}
		const args = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
		send(200, await (process.env.COZYCLAY_MB_INLINE === "1" ? fillRequest(args) : fillInWorker(args)));
	} catch (error) {
		const bad = error.code === "INVALID_ARGUMENT" || error instanceof SyntaxError || /^(FILL_GAP_TOO_LONG|MOTION_SPEC_INVALID)/.test(error.message);
		send(bad ? 400 : 500, { error: { code: bad ? "INVALID_ARGUMENT" : error.code === "TARGET_NOT_READY" ? error.code : "FILL_FAILED", message: error.message.replace(/^MOTION_SPEC_INVALID:\s*/, "") } });
	}
}
