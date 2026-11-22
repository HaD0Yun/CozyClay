// The other people in a compile: every other character with an installed take v3, sampled once per take frame into
// world joint positions (the take's local rotations by FK, at the character's stage placement and scale, as playback draws it).
// scene.people[id] = { name, rig, frames, names, P: Float64Array(frames * names.length * 3) } (scene.js motionScene
// leaves it out; commands/motion3.js adds it). QA measures the compiled body against theirs (qa/people-checks.js,
// PERSON), an anchor can sit on one of their bones ({ kind: "person" }, compiler/anchors.js) and a ref can name one
// (person:<id>.<Bone>, refs.js). Frames are timeline frames; past a take's end its last frame holds.
import { skeletonFor } from "./rigs/index.js";
import { fk } from "./compiler/skeleton.js";
import { add, apply, ry } from "./compiler/math.js";
import { resolveBone } from "./bones.js";
import { CAPSULES } from "./qa/geometry.js";
import { APART } from "./qa/people-checks.js";

const sampled = new WeakMap();
// joints are kept to 1e-5 m: what a saved take keeps of them (keptPeople) is then exactly what its compile read
const keep = v => Math.round(v * 1e5) / 1e5;

/** World joints of an installed take at a placement { position, yaw, scale? } (scale: the character's, 1 when left
 *  out; the body is drawn that many times the take's skeleton about its place), every frame (cached per take and placement). */
function sampleTake(take, placement) {
	const key = JSON.stringify(placement), hit = sampled.get(take);
	if (hit?.key === key) return hit.value;
	const sk = skeletonFor(take.rig), B = take.bones.length, n = take.frameCount, names = sk.names, J = names.length, size = placement.scale ?? 1;
	const order = names.map(name => take.bones.indexOf(name)), R = ry(placement.yaw), P = new Float64Array(n * J * 3);
	for (let f = 0; f < n; f++) {
		const quats = order.map(b => (b < 0 ? [0, 0, 0, 1] : Array.from(take.rot.subarray((f * B + b) * 4, (f * B + b) * 4 + 4))));
		const s = fk(sk, quats, Array.from(take.hips.subarray(f * 3, f * 3 + 3)));
		for (let j = 0; j < J; j++) P.set(add(placement.position, apply(R, size === 1 ? s.P[j] : s.P[j].map(v => v * size))).map(keep), (f * J + j) * 3);
	}
	const value = { rig: take.rig, frames: n, names, P };
	sampled.set(take, { key, value });
	return value;
}

/**
 * scene.people for a compile of character `selfId`: characters = the cast ({ id, subject, model, x, y, z, rot, hidden }),
 * takeOf(id) = its installed take v3 or nothing. Hidden characters and ones without a take are left out.
 */
export function peopleOf(characters, selfId, takeOf) {
	const out = {};
	for (const c of characters ?? []) {
		if (!c || c.id === selfId || c.hidden) continue;
		const take = takeOf(c.id);
		if (take?.schema !== "cozyclay.take.v3" || !take.frameCount || !skeletonFor(take.rig)) continue;
		const scale = c.scale ?? 1; // a scaled character is drawn at its scale: so are its joints here
		out[c.id] = { name: c.subject || c.name || c.id, ...sampleTake(take, { position: [c.x ?? 0, c.y ?? 0, c.z ?? 0], yaw: c.rot ?? 0, ...(scale === 1 ? {} : { scale }) }) };
	}
	return out;
}

/** The person's joint `bone` at timeline frame f as [x, y, z], or null (unknown person or bone). */
export function personJoint(scene, id, bone, f) {
	const p = scene?.people?.[id];
	if (!p) return null;
	const j = p.names.indexOf(resolveBone(skeletonFor(p.rig), bone).bone ?? "");
	if (j < 0) return null;
	const at = (Math.max(0, Math.min(p.frames - 1, Math.round(f))) * p.names.length + j) * 3;
	return [p.P[at], p.P[at + 1], p.P[at + 2]];
}

/** The ids and names a person ref or anchor may name, for an error. */
export const peopleList = scene => Object.entries(scene?.people ?? {}).map(([id, p]) => `${id} (${p.name})`).join(", ") || "none: no other character has an installed take";

/**
 * What a take keeps of the people so that its saved source compiles the same again without the others' takes
 * (take-source.js): only the joints its person anchors and refs name (anywhere in the spec: anchors, a skill's
 * define, goals, probes; a bare person:<id> in a skill's from is that person's Hips), as plain arrays (a saved project is JSON), or null.
 * When fix.person moved an arm (out.fixed.person.frames), every capsule joint (qa/geometry.js CAPSULES) of each person whose
 * hips came within APART of mine is kept too, so the saved source pushes the same arm out again (fix/person.js).
 */
export function keptPeople(scene, spec, out) {
	const want = new Map(), keep = (id, b) => {
		const p = scene?.people?.[id], bone = p && resolveBone(skeletonFor(p.rig), b).bone;
		if (bone) want.set(id, new Set([...(want.get(id) ?? []), bone]));
	};
	const walk = (v, key) => {
		if (typeof v === "string") { const m = /^person:([^.]+)(?:\.(.+))?$/.exec(v); if (m && (m[2] || key === "from")) keep(m[1], m[2] ?? "Hips"); }
		else if (Array.isArray(v)) v.forEach(x => walk(x));
		else if (v && typeof v === "object") { if (v.kind === "person") keep(v.person, v.bone); for (const [k, x] of Object.entries(v)) walk(x, k); }
	};
	walk(spec);
	if (out?.fixed?.person?.frames > 0) {
		const H = out.ctx.sk.index.Hips, f0 = out.f0 ?? 0, joints = CAPSULES.flatMap(([, a, b]) => [a, b]);
		for (const [id, p] of Object.entries(scene?.people ?? {})) {
			const j = p.names.indexOf(CAPSULES.find(c => c[0] === "hips")[1]), J = p.names.length;
			const near = j >= 0 && out.frames.some(({ s }, i) => {
				const at = (Math.max(0, Math.min(p.frames - 1, i + f0)) * J + j) * 3, h = s.P[H];
				return Math.hypot(h[0] - p.P[at], h[1] - p.P[at + 1], h[2] - p.P[at + 2]) <= APART;
			});
			if (near) for (const b of joints) if (p.names.includes(b)) keep(id, b);
		}
	}
	if (!want.size) return null;
	return Object.fromEntries([...want].map(([id, bones]) => {
		const p = scene.people[id], names = [...bones], J = p.names.length, P = [];
		for (let f = 0; f < p.frames; f++) for (const b of names) { const i = (f * J + p.names.indexOf(b)) * 3; P.push(p.P[i], p.P[i + 1], p.P[i + 2]); }
		return [id, { name: p.name, rig: p.rig, frames: p.frames, names, P }];
	}));
}
