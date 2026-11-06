#!/usr/bin/env node
// PR 2 check (docs/qa/physics-bench.md): a CozyClay take moved into Blender and exported again gives the same
// landmarks within 1 mm.
//   node test/bench/physics/check-take.mjs [--out dir] [--blender path] [--fbx path]
// A test-only spec (standIdle, a back tuck, a cartwheel: every joint turns a lot, the root leaves the floor and rolls)
// is installed on set 10's document and exported with export-cozyclay.mjs. The crate gets a made-up slide, yaw and
// tilt so object tracks are covered too. The take is keyed onto the set's .blend (import_take.py), exported again
// (export_take.py), and every landmark, bone origin and object matrix is compared frame by frame. Keyed in Blender,
// no bone below the hips may need a translation or a scale (the round trip alone would not catch a wrong bone map).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cozyclayDoc } from "./build-cozyclay.mjs";
import { takeFromDoc } from "./export-cozyclay.mjs";
import { loadSets } from "./sets.mjs";
import { landmarksAt, mat4, objectMatrixAt, readTake, unmat4, writeTake } from "./take.mjs";

const HERE = new URL(".", import.meta.url).pathname, REPO = join(HERE, "../../..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const out = arg("out") ?? mkdtempSync(join(tmpdir(), "physics-take-"));
const blender = arg("blender", process.env.BLENDER ?? "/opt/blender-5.2.0-linux-x64/blender"), fbx = arg("fbx", join(REPO, "public/models/y-bot-tpose.fbx"));
mkdirSync(out, { recursive: true });
const TOL = 0.001;

const SPEC = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 132, use: [
	{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } },
	{ skill: "flip", f0: 6, args: { kind: "back" } },
	{ skill: "flip", f0: 60, args: { kind: "cartwheel" } },
] };

// rest axes: with nothing moving them, every exported object of every set is a pure translation to its set centre
// (a turned cylinder must not carry its build turn into the take)
const IDLE = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 4, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } }] };
for (const s of loadSets()) {
	const d = cozyclayDoc(s), c = s.character;
	d.scenes.scenes[0].stage.characters[0].motionTake = { schema: "cozyclay.take.v3", rig: "y-bot-tpose", spec: { ...IDLE, use: [{ ...IDLE.use[0], args: { at: [c.position[0], c.position[2]], heading: 0 } }] } };
	const t = takeFromDoc(d, s, { run: 0 });
	for (const o of s.objects) {
		const m = t.objects[o.id].matrix[0], want = mat4([[1, 0, 0], [0, 1, 0], [0, 0, 1]], o.center);
		if (m.some((v, i) => Math.abs(v - want[i]) > 1e-6)) throw new Error(`${s.id} ${o.id}: rest matrix ${JSON.stringify(m)} is not the set centre with the set's axes`);
	}
}
console.log("rest axes: every object of the ten sets exports as its set centre with the set's axes");

const [set] = loadSets(["10-push-crate"]);
const doc = cozyclayDoc(set);
doc.scenes.scenes[0].stage.characters[0].motionTake = { schema: "cozyclay.take.v3", rig: "y-bot-tpose", spec: SPEC };
const a = takeFromDoc(doc, set, { run: 0 });
const ry = d => { const t = (d * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t); return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; };
const rx = d => { const t = (d * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t); return [[1, 0, 0], [0, c, -s], [0, s, c]]; };
const mul = (A, B) => A.map(r => [0, 1, 2].map(j => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
const crate = set.objects.find(o => o.id === "crate");
a.objects.crate.matrix = Array.from({ length: a.frames }, (_, f) => { const u = f / (a.frames - 1); return mat4(mul(ry(35 * u), rx(12 * Math.sin(3 * u))), [crate.center[0], crate.center[1] + 0.05 * u, crate.center[2] + 3 * u]); });
writeTake(join(out, "a.take.json"), a);

const py = (script, file, args) => execFileSync(blender, ["-b", ...(file ? [file] : ["--factory-startup"]), "--python", join(HERE, "blender", script), "--", ...args], { encoding: "utf8", timeout: 600_000, maxBuffer: 1 << 26 });
py("build_scene.py", null, [join(HERE, "sets", `${set.id}.json`), fbx, join(out, "built.blend")]);
const imported = py("import_take.py", join(out, "built.blend"), [join(out, "a.take.json"), join(out, "imported.blend")]);
const stats = JSON.parse(/import_take stats (\{.*\})/.exec(imported)?.[1] ?? "null");
if (!stats) throw new Error(`import_take.py printed no stats:\n${imported.slice(-2000)}`);
py("export_take.py", join(out, "imported.blend"), [join(HERE, "sets", `${set.id}.json`), join(out, "b.take.json"), JSON.stringify({ run: 0 })]);
const b = readTake(join(out, "b.take.json"));

const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
let lm = 0, lmAt = null, joint = 0, rot = 0, obj = 0;
if (b.frames !== a.frames) throw new Error(`frames ${a.frames} -> ${b.frames}`);
for (let f = 0; f < a.frames; f++) {
	const la = landmarksAt(a, "char-a", f), lb = landmarksAt(b, "char-a", f);
	for (const k of Object.keys(la)) { const d = dist(la[k], lb[k]); if (d > lm) { lm = d; lmAt = `${k} f${f}`; } }
	a.characters["char-a"].bones[f].forEach((m, i) => {
		const x = unmat4(m), y = unmat4(b.characters["char-a"].bones[f][i]);
		joint = Math.max(joint, dist(x.p, y.p));
		rot = Math.max(rot, ...x.R.flatMap((r, ri) => r.map((v, ci) => Math.abs(v - y.R[ri][ci]))));
	});
	const ma = unmat4(objectMatrixAt(a, "crate", f)), mb = unmat4(objectMatrixAt(b, "crate", f));
	obj = Math.max(obj, dist(ma.p, mb.p), ...[0, 1, 2].map(i => dist(ma.R[i], mb.R[i])));
}
const ok = lm <= TOL && joint <= TOL && obj <= TOL && stats.stretch <= TOL && stats.scale <= 1e-3;
console.log(`frames ${a.frames}, landmarks ${Object.keys(landmarksAt(a, "char-a", 0)).length}: landmark max ${(lm * 1000).toFixed(4)} mm (${lmAt}), bone origin max ${(joint * 1000).toFixed(4)} mm, bone axis max ${rot.toExponential(2)}, crate max ${(obj * 1000).toFixed(4)} mm`);
console.log(`keyed in Blender: largest bone translation below the hips ${(stats.stretch * 1000).toFixed(4)} mm, largest scale change ${stats.scale.toExponential(2)} (a rigid take maps onto the bind)`);
console.log(`Blender rest heads vs the rig: ${(b.source.restHeadError * 1000).toFixed(4)} mm (information)`);
console.log(`tolerance ${TOL * 1000} mm: ${ok ? "PASS" : "FAIL"} (${out})`);
process.exit(ok ? 0 : 1);
