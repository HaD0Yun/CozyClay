// The body a limb must stay out of, fitted from the rig's skin (tools/motion3/extract-body.mjs):
// a signed distance grid per skinned bone in that bone's bind frame (the bone carries it rigidly;
// outside positive, metres) and, for the limbs, the skin radius along the bone. A limb collides as
// spheres on its bone axis (limbProbes); bodyDistance is the nearest skin of every other bone but
// the limb's own neighbours (SKIP), so an arm reads the torso, the head, the legs and the other arm.
import { add, sub, scale, apply, T, len, dot, clamp } from "./compiler/math.js";

// The fits are ~0.5 MB of base64 grids, most of the editor's first-load JavaScript were they imported: each
// is an asset file instead, read the first time a compile needs it. Node reads it from disk; a worker (or the
// editor, should a compile run before preloadBodies has it) reads it synchronously over HTTP, so bodyFor
// stays synchronous everywhere. The editor fetches both in the background after its first paint (main.jsx).
const BODIES = {
	"y-bot-tpose": new URL("./rigs/y-bot-tpose-body.json", import.meta.url),
	"x-bot-tpose": new URL("./rigs/x-bot-tpose-body.json", import.meta.url),
};
const fits = new Map();

function readFit(url) {
	const fs = url.protocol === "file:" ? globalThis.process?.getBuiltinModule?.("node:fs") : null;
	if (fs) return JSON.parse(fs.readFileSync(url, "utf8"));
	const xhr = new XMLHttpRequest();
	xhr.open("GET", url.href, false);
	xhr.send();
	if (xhr.status !== 200) throw new Error(`motion body fit ${url.pathname}: HTTP ${xhr.status}`);
	return JSON.parse(xhr.responseText);
}

// Fits made in memory for registered rigs (rigs/index.js registerRig), per skeleton: a skeleton registerRig retires keeps
// its own (a compile in flight on it reads its own rig, as the floor, foot and pose caches do). sk -> make(fileFit), called on
// first use with a reader of the shipped fits (make reads the X Bot's to refit it; one already loaded is not read again).
const made = new WeakMap(), madeFits = new WeakMap();
const fileFit = model => {
	if (!fits.has(model)) fits.set(model, readFit(BODIES[model]));
	return fits.get(model);
};

function fitOf(sk) {
	if (!made.has(sk)) return fileFit(sk.model);
	if (!madeFits.has(sk)) madeFits.set(sk, made.get(sk)(fileFit));
	return madeFits.get(sk);
}

/** Gives skeleton sk the fit make(fileFit) returns (body.js's shape), made on first use. */
export function registerBody(sk, make) {
	made.set(sk, make);
}

/** Fetches every rig's fit in the background, so a compile on this thread never waits on one. */
export function preloadBodies() {
	return Promise.all(Object.entries(BODIES).map(async ([model, url]) => {
		if (fits.has(model)) return;
		const response = await fetch(url);
		if (!response.ok) throw new Error(`motion body fit ${url.pathname}: HTTP ${response.status}`);
		const fit = await response.json();
		if (!fits.has(model) && !made.has(model)) fits.set(model, fit);
	}));
}
/** Distance read outside a grid: far enough that no probe counts it as touching. */
const FAR = 0.1;
const cache = new WeakMap();

/** A fit's grid data: base64 text as signed bytes (a refitted fit already holds them). */
export function decode(text) {
	if (typeof text !== "string") return text;
	const bytes = typeof Buffer !== "undefined" ? Buffer.from(text, "base64") : Uint8Array.from(atob(text), c => c.charCodeAt(0));
	return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The neighbours a limb bone may touch without colliding: itself, its parent, its children, and for
 * an upper arm the collarbone and chest it hangs from (only near the shoulder: see limbProbes). */
function skipOf(sk, b) {
	const out = new Set([b, sk.parent[b], ...sk.children[b]]);
	if (/^(Left|Right)Arm$/.test(sk.names[b])) out.add(sk.parent[sk.parent[b]]);
	if (/^(Left|Right)UpLeg$/.test(sk.names[b])) out.add(sk.index.Spine);
	return out;
}

/** The fitted body of skeleton sk, or null for a rig without one. */
export function bodyFor(sk) {
	if (!BODIES[sk.model] && !made.has(sk)) return null;
	if (cache.has(sk)) return cache.get(sk);
	const fit = fitOf(sk);
	const grids = Object.entries(fit.grids).map(([name, g]) => {
		const half = g.dims.map(d => ((d - 1) * fit.step) / 2), centre = g.min.map((m, k) => m + half[k]);
		return { b: sk.index[name], min: g.min, dims: g.dims, data: decode(g.data), centre, reach: len(half) };
	});
	const radii = Object.fromEntries(Object.entries(fit.radii).map(([name, r]) => [sk.index[name], r]));
	const body = { step: fit.step, grids, radii, skip: new Map(Object.keys(radii).map(b => [+b, skipOf(sk, +b)])) };
	cache.set(sk, body);
	return body;
}

/** Trilinear signed distance (m) of a point in grid g's bone frame. */
function sample(body, g, q) {
	const [nx, ny, nz] = g.dims, step = body.step;
	const fx = (q[0] - g.min[0]) / step, fy = (q[1] - g.min[1]) / step, fz = (q[2] - g.min[2]) / step;
	if (fx < 0 || fy < 0 || fz < 0 || fx > nx - 1 || fy > ny - 1 || fz > nz - 1) return FAR;
	const x = Math.min(nx - 2, Math.floor(fx)), y = Math.min(ny - 2, Math.floor(fy)), z = Math.min(nz - 2, Math.floor(fz));
	const u = fx - x, v = fy - y, w = fz - z, at = (i, j, k) => g.data[((x + i) * ny + y + j) * nz + z + k];
	const c00 = at(0, 0, 0) * (1 - u) + at(1, 0, 0) * u, c01 = at(0, 0, 1) * (1 - u) + at(1, 0, 1) * u;
	const c10 = at(0, 1, 0) * (1 - u) + at(1, 1, 0) * u, c11 = at(0, 1, 1) * (1 - u) + at(1, 1, 1) * u;
	return ((c00 * (1 - v) + c10 * v) * (1 - w) + (c01 * (1 - v) + c11 * v) * w) / 1000;
}

/** Each grid's centre in the world at state s (cached per state: a planner asks thousands of points of one pose). */
const centres = new WeakMap();
function centresAt(body, s) {
	let c = centres.get(s);
	if (!c) { c = body.grids.map(g => add(s.P[g.b], apply(s.R[g.b], g.centre))); centres.set(s, c); }
	return c;
}

/** Signed distance (m) from p to the skin of every bone not in `skip`, with the bone it came from. */
export function bodyDistance(body, s, p, skip = null) {
	let best = FAR, bone = -1;
	const c = centresAt(body, s);
	body.grids.forEach((g, i) => {
		if (skip?.has(g.b) || len(sub(p, c[i])) - g.reach > best) return;
		const d = sample(body, g, apply(T(s.R[g.b]), sub(p, s.P[g.b])));
		if (d < best) { best = d; bone = g.b; }
	});
	return { d: best, bone };
}

/** Unit direction out of the skin at p (central differences of bodyDistance). */
export function bodyNormal(body, s, p, skip = null, h = 0.01) {
	const g = [0, 1, 2].map(k => {
		const e = [0, 0, 0]; e[k] = h;
		return bodyDistance(body, s, add(p, e), skip).d - bodyDistance(body, s, sub(p, e), skip).d;
	});
	const l = len(g);
	return l > 1e-9 ? scale(g, 1 / l) : null;
}

/** Spheres { p, r, t } on limb bone b's axis (to its first child), from the fitted skin radius. Near an
 * upper arm's shoulder (its armpit half: arm and chest skin are one there) or a thigh's hip the trunk is
 * its neighbour, so those stations are left out. */
const rootOf = name => (/^(Left|Right)Arm$/.test(name) ? 0.5 : /^(Left|Right)UpLeg$/.test(name) ? 0.3 : 0);
/** Where limb bone b's axis ends: its child joint, for a hand the middle finger's knuckle (the first
 * child is a thumb or a ring finger, rig by rig). */
export const axisEnd = (sk, b) => (/Hand$/.test(sk.names[b]) ? sk.index[sk.names[b].replace(/Hand$/, "HandMiddle1")] : sk.children[b][0]);
function limbProbes(body, sk, s, b) {
	const prof = body.radii[b], child = axisEnd(sk, b);
	if (!prof || child === undefined) return [];
	const A = s.P[b], axis = sub(s.P[child], A), root = rootOf(sk.names[b]);
	return prof.filter(([t]) => t >= root).map(([t, r]) => ({ p: add(A, scale(axis, t)), r, t }));
}

/** The trunk runs Hips-Spine-Spine1-Spine2-Neck: a trunk bone's axis goes to its trunk child, a limb's to axisEnd. */
const TRUNK = /^(Spine\d?|Neck|Head)$/;
const axisOf = (sk, b) => sk.children[b].find(j => TRUNK.test(sk.names[j])) ?? axisEnd(sk, b);

/**
 * Point p moved out of the body (bones not in `skip`) until its skin distance is at least `clear`, along
 * the line from the axis of the bone it is in: deep inside, the skin's normal turns with every millimetre,
 * the way out from the bone does not, so a target sliding through a thigh slides out of it smoothly.
 * The distance along that line is found by bisection. p itself when it is clear already.
 */
const OUT_MAX = 0.25;
export function keepOut(body, sk, s, p, clear, skip = null) {
	const hit = bodyDistance(body, s, p, skip);
	if (hit.d >= clear || hit.bone < 0) return p;
	const A = s.P[hit.bone], end = axisOf(sk, hit.bone), B = end === undefined ? A : s.P[end], ab = sub(B, A);
	const t = dot(ab, ab) > 1e-9 ? clamp(dot(sub(p, A), ab) / dot(ab, ab), 0, 1) : 0, off = sub(p, add(A, scale(ab, t)));
	const dir = len(off) > 1e-4 ? scale(off, 1 / len(off)) : bodyNormal(body, s, p, skip);
	if (!dir) return p;
	// clear of the bone it is in (another bone on the way out is the next call's: one bone at a time stays bounded)
	const only = new Set(body.grids.map(g => g.b).filter(b => b !== hit.bone)), clearAt = k => bodyDistance(body, s, add(p, scale(dir, k)), only).d >= clear;
	let lo = 0, hi = 0.02;
	while (!clearAt(hi) && hi < OUT_MAX) { lo = hi; hi = Math.min(OUT_MAX, hi * 2); }
	for (let i = 0; i < 10; i++) { const mid = (lo + hi) / 2; if (clearAt(mid)) hi = mid; else lo = mid; }
	return add(p, scale(dir, hi));
}

/** How far (m) a wrist target stays off the skin (the hand's radius at the wrist, and a little). */
export const HAND_CLEAR = 0.03;
/** What a wrist target keeps out of: the body but the arms (they move with it) and the head and neck (a hand
 * comes to the mouth or the face on purpose: QA's BODY and FACE report what goes too deep). null without a body. */
export function wristBody(sk) {
	const body = bodyFor(sk);
	return body && { body, skip: new Set(sk.names.map((n, b) => (/(Arm|ForeArm|Hand|Neck|Head.*)$/.test(n) ? b : -1)).filter(b => b >= 0)) };
}

/** How deep (m) limb bone b goes into the rest of the body were its axis A-B (its own pose may differ:
 * a planner trying an elbow), 0 when clear. */
export function segmentDepth(body, sk, s, b, A, B) {
	let worst = 0;
	const root = rootOf(sk.names[b]);
	for (const [t, r] of body.radii[b] ?? []) {
		if (t < root) continue;
		const { d, bone } = bodyDistance(body, s, add(A, scale(sub(B, A), t)), body.skip.get(b));
		if (bone >= 0) worst = Math.max(worst, r - d);
	}
	return worst;
}

/** How far (m) limb bone b's skin goes into the rest of the body at state s (0 when clear), where, and into which bone. */
export function limbDepth(body, sk, s, b) {
	let worst = { depth: 0, p: null, into: -1 };
	for (const probe of limbProbes(body, sk, s, b)) {
		const { d, bone } = bodyDistance(body, s, probe.p, body.skip.get(b));
		const depth = probe.r - d;
		if (bone >= 0 && depth > worst.depth) worst = { depth, p: probe.p, into: bone, r: probe.r };
	}
	return worst;
}

