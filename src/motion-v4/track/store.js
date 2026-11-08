// The v4 track store (design 2.5): the conversation's dense per-bone track, held by the host because it is too big
// for the js sandbox (123-486 KB per take). It is a RawTrack: a take v3 in the world frame, 65 local quaternions and
// the world hips per frame, plus world tracks of the records the character moves. takeOut caches by the take object,
// so set, patch and clear always make a NEW RawTrack with new typed arrays for what changed; an array already handed
// out never changes. commit encodes the track (codec.js) and installs it through the editor action motion.v4.install.
import { encodeRawTrack } from "./codec.js";
import { rawOut } from "./literal.js";

const TAKE_SCHEMA = "cozyclay.take.v3";
const SPEC_SCHEMA = "cozyclay.motion-spec.v1";
const FPS = 24;
const MAX_FRAMES = 2400;
const MAX_NAMES = 40;

const fail = (op, message) => { throw new Error(`track ${op}: ${message}`); };
const isList = value => Array.isArray(value) || ArrayBuffer.isView(value);
const plain = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const listed = names => (names.length > MAX_NAMES ? `${names.slice(0, MAX_NAMES).join(", ")}, ... ${names.length - MAX_NAMES} more` : names.join(", ") || "none");
const now = () => globalThis.performance?.now?.() ?? Date.now();
const ms = t => Math.round(t * 10) / 10;

function checkLength(op, values, count, label, how) {
	if (!isList(values)) fail(op, `${label} must be an array of numbers (${how} = ${count}).`);
	if (values.length !== count) fail(op, `${label} has ${values.length} numbers; ${how} = ${count}.`);
}

/** Finite numbers -> Float32Array, after a length check. */
function floats(op, values, count, label, how) {
	checkLength(op, values, count, label, how);
	const out = new Float32Array(count);
	for (let i = 0; i < count; i++) {
		if (!Number.isFinite(values[i])) fail(op, `${label}[${i}] is not a finite number.`);
		out[i] = values[i];
	}
	return out;
}

/** `count` quaternions [x,y,z,w] -> normalized Float32Array; where(k) names quaternion k in an error. */
function quats(op, values, count, label, how, where) {
	checkLength(op, values, count * 4, label, how);
	const out = new Float32Array(count * 4);
	for (let k = 0; k < count; k++) {
		const x = values[k * 4], y = values[k * 4 + 1], z = values[k * 4 + 2], w = values[k * 4 + 3];
		if (![x, y, z, w].every(Number.isFinite)) fail(op, `${label} has a value that is not a finite number at ${where(k)}.`);
		const l = Math.hypot(x, y, z, w);
		if (l < 1e-6) fail(op, `${label} has a zero quaternion at ${where(k)}.`);
		out[k * 4] = x / l; out[k * 4 + 1] = y / l; out[k * 4 + 2] = z / l; out[k * 4 + 3] = w / l;
	}
	return out;
}

/** objects.<id> = { pos: n * 3, quat: n * 4 } over n frames. */
function objectTrack(op, id, track, n, range) {
	if (!plain(track)) fail(op, `objects.${id} must be { pos, quat }.`);
	return { pos: floats(op, track.pos, n * 3, `objects.${id}.pos`, `${range} x 3`), quat: quats(op, track.quat, n, `objects.${id}.quat`, `${range} x 4`, k => `frame ${k}`) };
}

function checkIds(op, ids, records) {
	const known = new Set((records ?? []).map(record => record?.id).filter(id => typeof id === "string"));
	const unknown = ids.filter(id => !known.has(id));
	if (unknown.length) fail(op, `unknown object ${unknown.join(", ")}; the scene records are ${listed([...known])}.`);
}

/** TrackStore over V4Context ctx (design 2.2): ctx.sk, ctx.character, ctx.records() and ctx.studio, read at call time. */
export function createTrackStore(ctx) {
	let raw = null, revision = 0, committed = 0, records = null, queue = Promise.resolve();
	const loadRecords = async () => (records = await ctx.records());
	const boneSlots = (op, bones) => {
		const { names, index } = ctx.sk;
		if (bones === undefined) return names.map((_, i) => i);
		if (!Array.isArray(bones)) fail(op, "bones must be a list of bone names.");
		const unknown = bones.filter(name => index[name] === undefined);
		if (unknown.length) fail(op, `unknown bone ${unknown.join(", ")}; valid bones: ${names.join(", ")}.`);
		if (new Set(bones).size !== bones.length) fail(op, "bones lists a bone twice.");
		return bones.map(name => index[name]);
	};
	const range = (op, args, F) => {
		const from = args.from ?? 0, to = args.to ?? F - 1;
		if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0) fail(op, "from and to must be frame numbers (integers from 0).");
		if (from > to) fail(op, `from ${from} is after to ${to}.`);
		if (to >= F) fail(op, `to ${to} is past the last frame ${F - 1}.`);
		return { from, to, n: to - from + 1 };
	};
	const need = op => raw ?? fail(op, "no track yet: call track set first.");
	const next = track => { raw = track; revision += 1; return revision; };
	const blank = F => ({ schema: TAKE_SCHEMA, fps: FPS, frameCount: F, rig: ctx.sk.model, bones: ctx.sk.names.slice(),
		placement: { position: [0, 0, 0], yaw: 0 }, spec: { schema: SPEC_SCHEMA, fps: FPS, frames: F } });

	function set(args = {}) {
		const { names } = ctx.sk, B = names.length, F = args.frames ?? (isList(args.hips) ? args.hips.length / 3 : undefined);
		if (!Number.isInteger(F) || F < 1 || F > MAX_FRAMES) fail("set", `frames must be an integer from 1 to ${MAX_FRAMES}.`);
		if (args.objects !== undefined && !plain(args.objects)) fail("set", "objects must be { recordId: { pos, quat } }.");
		const rot = quats("set", args.rot, F * B, "rot", `${F} frames x ${B} bones x 4`, k => `frame ${Math.floor(k / B)} ${names[k % B]}`);
		const hips = floats("set", args.hips, F * 3, "hips", `${F} frames x 3`), objects = {};
		for (const [id, track] of Object.entries(args.objects ?? {})) objects[id] = objectTrack("set", id, track, F, `${F} frames`);
		if (records) checkIds("set", Object.keys(objects), records);
		return { revision: next({ ...blank(F), rot, hips, objects }), frames: F };
	}

	function patch(args = {}) {
		const track = need("patch"), F = track.frameCount, B = ctx.sk.names.length;
		if (args.from === undefined || args.to === undefined) fail("patch", "send from and to (the frame range, both included).");
		const { from, to, n } = range("patch", args, F), size = `${n} frames (f${from}-f${to})`;
		if (args.rot === undefined && args.hips === undefined && args.objects === undefined) fail("patch", "nothing to change: send rot, hips or objects.");
		if (args.rot === undefined && args.bones !== undefined) fail("patch", "bones names the bones of rot; send rot with it.");
		if (args.objects !== undefined && !plain(args.objects)) fail("patch", "objects must be { recordId: { pos, quat } }.");
		const slots = args.rot === undefined ? [] : boneSlots("patch", args.bones), names = slots.map(i => ctx.sk.names[i]);
		let rot = track.rot, hips = track.hips;
		if (args.rot !== undefined) {
			const q = quats("patch", args.rot, n * slots.length, "rot", `${size} x ${slots.length} bones x 4`, k => `frame ${from + Math.floor(k / slots.length)} ${names[k % slots.length]}`);
			rot = new Float32Array(track.rot);
			for (let f = 0; f < n; f++) slots.forEach((b, j) => rot.set(q.subarray((f * slots.length + j) * 4, (f * slots.length + j) * 4 + 4), ((from + f) * B + b) * 4));
		}
		if (args.hips !== undefined) { hips = new Float32Array(track.hips); hips.set(floats("patch", args.hips, n * 3, "hips", `${size} x 3`), from * 3); }
		const objects = { ...track.objects };
		for (const [id, given] of Object.entries(args.objects ?? {})) {
			const part = objectTrack("patch", id, given, n, size), old = track.objects[id];
			if (!old && n !== F) fail("patch", `objects.${id} has no track yet: send it for every frame (from 0 to ${F - 1}) or with set.`);
			const pos = old ? new Float32Array(old.pos) : new Float32Array(F * 3), quat = old ? new Float32Array(old.quat) : new Float32Array(F * 4);
			pos.set(part.pos, from * 3); quat.set(part.quat, from * 4);
			objects[id] = { pos, quat };
		}
		if (records) checkIds("patch", Object.keys(objects), records);
		return { revision: next({ ...track, rot, hips, objects }), from, to, bones: names };
	}

	function get(args = {}) {
		const track = need("get"), B = ctx.sk.names.length, { from, to } = range("get", args, track.frameCount), slots = boneSlots("get", args.bones);
		const rot = [], slice = (values, size) => Array.from(values.subarray(from * size, (to + 1) * size)), objects = {};
		for (let f = from; f <= to; f++) for (const b of slots) for (let k = 0; k < 4; k++) rot.push(track.rot[(f * B + b) * 4 + k]);
		for (const [id, o] of Object.entries(track.objects)) objects[id] = { pos: slice(o.pos, 3), quat: slice(o.quat, 4) };
		return { from, to, bones: slots.map(i => ctx.sk.names[i]), rot, hips: slice(track.hips, 3), objects };
	}

	async function install({ label } = {}) {
		const track = need("commit"), at = revision;
		checkIds("commit", Object.keys(track.objects), await loadRecords());
		const t0 = now(), encoded = encodeRawTrack(track), t1 = now();
		const args = { characterId: ctx.character.id, raw: encoded, ...(typeof label === "string" && label ? { label: label.slice(0, 80) } : {}) };
		const receipt = await ctx.studio.runAction("motion.v4.install", args);
		// a refusal that comes back as a receipt instead of a throw is still a failed install
		if (receipt?.ok === false) fail("commit", receipt.message ?? receipt.error?.message ?? "motion.v4.install was refused.");
		committed = at;
		return { revision: at, frames: track.frameCount, receiptId: receipt?.receiptId ?? null, ms: { encode: ms(t1 - t0), install: ms(now() - t1) } };
	}

	return {
		get revision() { return revision; },
		get dirty() { return revision !== committed; },
		current: () => raw,
		async out() { const list = await loadRecords(); return raw ? rawOut(raw, list) : null; },
		set, patch, get,
		clear() { next(null); return { revision }; },
		info: () => ({ revision, committed, dirty: revision !== committed, frames: raw?.frameCount ?? 0, fps: FPS, bones: ctx.sk.names.length, objects: Object.keys(raw?.objects ?? {}) }),
		// one install at a time, in call order, so the last commit is the take on the character
		commit(args) { const run = queue.then(() => install(args)); queue = run.catch(() => {}); return run; },
	};
}
