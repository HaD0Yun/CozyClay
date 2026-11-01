// MotionBricks Smart Primitives on a scene block (POST /agent/motion-primitive, tools/dev-full.mjs): the runner in
// tools/motionbricks/vault.mjs plays an upstream Smart Primitive (Entry -> Action -> Exit target windows) over the block and
// answers the dense spec it installs as is. Opt-in (COZYCLAY_MB_PRIMITIVES=1): the target poses come from the upstream
// sample clips, which are under the NVIDIA Sample Data Evaluation License, downloaded to the user's cache, never shipped.
// { kind: "vault" | "jump", objectId, objects, lane?, hand?: "left" | "right" (the clips plant the left: right mirrors the run) } -> { spec, report } or { error }.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER = fileURLToPath(new URL("../../tools/motionbricks/vault.mjs", import.meta.url));
// one-handed vault (the take approved on 2026-10-30) and the no-hands jump; blocks up to 0.6 m use the 0.5 m primitive
export const KINDS = { vault: "OneHandedJump0", jump: "NoHandsJump" };
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

/** The block's box from the editor's object row (base pivot: y is the bottom, x/z the footprint centre; unrotated). */
export function blockOf(o) {
	if (!o) fail("INVALID_ARGUMENT", "objectId is not an object of this scene");
	if (Math.abs(o.rot ?? 0) > 1) fail("INVALID_ARGUMENT", "the block must not be turned (rot 0): the primitive crosses it along +Z");
	const w = (o.scaleX ?? 1) * (o.footprint?.width ?? 1), d = (o.scaleZ ?? 1) * (o.footprint?.depth ?? 1), h = (o.scaleY ?? 1) * (o.height ?? 1);
	return { x: o.x ?? 0, z: o.z ?? 0, w, d, h, y: o.y ?? 0 };
}

export async function primitiveRequest({ kind = "vault", objectId, objects = [], lane, hand = "left" } = {}) {
	if (process.env.COZYCLAY_MB_PRIMITIVES !== "1") fail("CAPABILITY_MISSING", "Smart Primitives are opt-in on this server (COZYCLAY_MB_PRIMITIVES=1): their target poses come from evaluation-licensed sample clips");
	if (!KINDS[kind]) fail("INVALID_ARGUMENT", `kind must be one of ${Object.keys(KINDS).join(", ")}`);
	const b = blockOf(objects.find(o => o.id === objectId));
	if (b.y > 0.01 || b.h < 0.3 || b.h > 1) fail("INVALID_ARGUMENT", `the block must stand on the floor and be 0.3-1 m tall (it is ${b.h.toFixed(2)} m, base at ${b.y.toFixed(2)} m)`);
	const dir = mkdtempSync(join(tmpdir(), "mb-prim-")), out = join(dir, "spec.json"), objs = join(dir, "objects.json");
	writeFileSync(objs, JSON.stringify(objects));
	const args = [RUNNER, "--block", [b.x, b.z, b.w, b.d, b.h].join(","), "--doc", b.h <= 0.6 ? "jump_0_5m" : "jump_0_75m", "--seq", KINDS[kind], "--lane", String(lane ?? b.x), "--hand", hand === "right" ? "right" : "left", "--object", objectId, "--objects", objs, "--out", out];
	try {
		// onnxruntime-node can abort at process exit (a mutex torn down twice) after the runner wrote its answer: the answer counts
		const stdout = await new Promise((ok, no) => execFile(process.execPath, args, { timeout: 60000, maxBuffer: 4 << 20 }, (error, so, se) => (error && !(existsSync(out) && so.includes("{")) ? no(Object.assign(error, { stderr: se })) : ok(so))));
		const report = JSON.parse(stdout.slice(stdout.indexOf("{")));
		return { spec: JSON.parse(readFileSync(out, "utf8")), report: { seq: report.seq, frames: report.frames, keys: report.keys, actionAtFrame: report.actionAtFrame, collideAfter: report.collideAfter } };
	} catch (error) {
		fail(error.code ?? "PRIMITIVE_FAILED", `the Smart Primitive runner failed: ${String(error.stderr || error.message).split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300)}`);
	} finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function handlePrimitiveRoute(req, res) {
	const send = (status, value) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value)); };
	try {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		send(200, await primitiveRequest(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")));
	} catch (error) {
		const code = ["INVALID_ARGUMENT", "CAPABILITY_MISSING"].includes(error.code) ? error.code : "PRIMITIVE_FAILED";
		send(code === "INVALID_ARGUMENT" ? 400 : code === "CAPABILITY_MISSING" ? 503 : 500, { error: { code, message: error.message } });
	}
}
