/**
 * Effect particles at a frame, computed from nothing but the frame.
 *
 * Particle k of an emitter belongs to integer frame s when the seeded count
 * for s (rate x take level / fps, stochastically rounded) exceeds k, and only
 * while the emitter is shown at s. It is born a seeded u in [0, 1) frames
 * before s, where the emitter was then: its pose at s, moved back along the
 * step from s - 1 by u (exactly the pose at s for u = 0). Its state at frame
 * f is analytic in its age (f - s + u) / fps: drag toward wind plus
 * gravity, a seeded sway/curl drift, size growth and an opacity fade. No
 * state is carried between frames, so scrubbing, playback, capture and
 * export all draw the same particles. A trail is a ribbon through the
 * emitter's own pose over the last `life` seconds instead.
 */
import { emitterPoseAt, emitterShown, rotate } from "./emitter.js";
import { trackLevel } from "../object-travel.js";
import { EFFECT_KIND, normalizeEffect } from "./effect-record.js";
import { linearRgb } from "../stage-environment.js";

/** Live particles drawn per scene; beyond it every emitter is thinned evenly. */
export const EFFECT_PARTICLE_CAP = 2000;
/** Trail ribbon quads per scene, shared evenly by the trail emitters. */
export const EFFECT_SEGMENT_CAP = 512;
const TRAIL_SUBSTEPS = 4;
/** Edge travel per frame (m) under which a trail stretch counts as still. */
const TRAIL_STILL_M = 0.002;
/** Edge speed (m/s) at which a swoosh is fully opaque; slower motion fades it. */
const TRAIL_FULL_SPEED = 2;

// The shape of each preset that is not authored: drag (1/s), sway/curl/jitter
// drift (m), fades, spread of life/size, spin (rad/s), streak (s of velocity),
// flicker, a lift of the birth point (x start size, so a flame on the deck
// starts above it), a droop of the throw (a share of the speed turned down),
// and whether births fill a volume (rain/snow/dust).
const LOOK = { drag: 1.5, sway: 0, curl: 0, curlRate: 2, jitter: 0, fadeIn: 0.05, fadeOut: 1, lifeVar: 0.2, sizeVar: 0.3, growPow: 1, spin: 0, streak: 0, flicker: 0, twinkle: 0, lift: 0, droop: 0, tint: null, clean: false, volume: false, top: false };
const LOOKS = {
	smoke: { ...LOOK, drag: 1.7, sway: 0.012, curl: 0.01, curlRate: 2.2, jitter: 0.005, fadeIn: 0.04, fadeOut: 1, lifeVar: 0.25, sizeVar: 0.25, growPow: 0.8, spin: 0.6 },
	// a breath leaves the lips forward and a little down (droop: a downward share of the speed), then rises and spreads
	exhale: { ...LOOK, drag: 3.2, sway: 0.02, curl: 0.03, curlRate: 1.6, jitter: 0.03, fadeIn: 0.03, fadeOut: 1.5, lifeVar: 0.3, sizeVar: 0.35, growPow: 0.6, spin: 0.8, droop: 0.25 },
	steam: { ...LOOK, drag: 1.8, sway: 0.03, curl: 0.025, curlRate: 2.5, jitter: 0.015, fadeIn: 0.12, fadeOut: 1.8, lifeVar: 0.3, sizeVar: 0.35, growPow: 0.8, spin: 0.5 },
	fire: { ...LOOK, drag: 3, sway: 0.01, curl: 0.03, curlRate: 5, jitter: 0.03, fadeIn: 0.06, fadeOut: 2.2, lifeVar: 0.35, spin: 1.5, streak: 0.15, flicker: 0.35, lift: 0.5, tint: "fire", clean: true },
	sparks: { ...LOOK, drag: 0.8, jitter: 0.05, fadeIn: 0, fadeOut: 0.7, lifeVar: 0.5, sizeVar: 0.4, streak: 0.035, flicker: 0.5, tint: "spark", clean: true },
	dust: { ...LOOK, drag: 0.8, curl: 0.04, curlRate: 0.7, jitter: 0.04, fadeIn: 0.2, fadeOut: 0.25, lifeVar: 0.3, sizeVar: 0.4, twinkle: 0.4, clean: true, volume: true },
	rain: { ...LOOK, drag: 1.4, fadeIn: 0.04, fadeOut: 0, lifeVar: 0, sizeVar: 0.2, streak: 0.035, clean: true, volume: true, top: true },
	snow: { ...LOOK, drag: 12, curl: 0.08, curlRate: 1.3, jitter: 0.05, fadeIn: 0.04, fadeOut: 0.1, lifeVar: 0, sizeVar: 0.35, spin: 1, clean: true, volume: true, top: true },
	trail: LOOK,
};

const mix32 = (h) => {
	h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
	h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
	return (h ^ (h >>> 16)) >>> 0;
};
/** Uniform [0, 1) for (seed, birth frame, particle, channel); pure. */
const rnd = (seed, s, k, c) => mix32(mix32(mix32(seed + Math.imul(s, 0x27d4eb2f)) ^ Math.imul(k + 7, 0x165667b1)) + c) / 4294967296;
const hashText = (text) => {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
	return h >>> 0;
};
const smooth = (x) => (x >= 1 ? 1 : x <= 0 ? 0 : x * x * (3 - 2 * x));

function emitterOf(record, scene) {
	const effect = record.effect?.preset ? record.effect : normalizeEffect(record.effect);
	const seed = mix32(effect.seed ^ hashText(record.id));
	const poses = new Map();
	const hidden = scene.hidden?.has?.(record.id) === true;
	const at = (s) => Math.max(0, s);
	const look = LOOKS[effect.preset] ?? LOOK, fall = effect.gravity / look.drag - effect.wind.y;
	return {
		id: record.id, effect, seed, look, trail: effect.preset === "trail", rgb: linearRgb(effect.color),
		// Rain and snow fall from the box's top at terminal speed: they are gone once they reach its floor.
		fallLife: look.top && fall > 0 ? effect.area.y / fall : Infinity,
		phase: [0, 1, 2, 3].map((c) => 2 * Math.PI * rnd(seed, 0, -1, 90 + c)),
		pose(s) {
			let pose = poses.get(at(s));
			if (!pose) poses.set(at(s), (pose = emitterPoseAt(scene.lookup, record, at(s), scene.take, scene.live)));
			return pose;
		},
		/** Emission strength at frame s: 0 hidden, else the take level (1 without a track). */
		level: (s) => (hidden || !emitterShown(scene.lookup, record, at(s), scene.take) ? 0 : trackLevel(record.id, at(s), scene.take)),
	};
}

/** How many times the births at s are split so a fast emitter still lays a
 * continuous stream (one particle per half a start size of travel, at most 8);
 * the smoke emitted is the same, each part carries a share of the opacity. */
function splitAt(em, s, perFrame) {
	if (em.look.volume || !(em.effect.size > 0)) return 1;
	const [a, b] = [em.pose(s).p, em.pose(s - 1).p];
	const need = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / (0.5 * em.effect.size);
	return Math.min(8, Math.max(1, need / perFrame));
}

/** Every particle alive at `frame`, oldest birth first: visit(s, k, u, age, life, split). */
function forEachLive(em, frame, fps, visit) {
	const { effect, look, seed } = em;
	const last = Math.floor(frame);
	for (let s = Math.floor(frame - effect.life * (1 + look.lifeVar) * fps) - 1; s <= last; s += 1) {
		const perFrame = (effect.rate * em.level(s)) / fps;
		if (!(perFrame > 0)) continue;
		const split = splitAt(em, s, perFrame);
		const count = Math.floor(perFrame * split + rnd(seed, s, -1, 0));
		for (let k = 0; k < count; k += 1) {
			const life = Math.min(em.fallLife, effect.life * (1 + look.lifeVar * (2 * rnd(seed, s, k, 1) - 1)));
			const u = rnd(seed, s, k, 2);
			const age = (frame - s + u) / fps;
			if (age >= 0 && age <= life) visit(s, k, u, age, life, split);
		}
	}
}

const turn = [0, 0, 0];

/** Particle (s, k) at `frame` into `out`; false when it is gone (under a volume's floor). */
function particleAt(em, s, k, u, age, life, split, frame, fps, out) {
	const { effect, look, seed } = em;
	const r = (c) => rnd(seed, s, k, c);
	const pose = em.pose(s);
	const a = age / life;
	let ox = (r(3) - 0.5) * effect.area.x, oy = (look.top ? effect.area.y : r(4) * effect.area.y) + look.lift * effect.size, oz = (r(5) - 0.5) * effect.area.z;
	if (!look.volume) [ox, oy, oz] = rotate(pose.q, ox, oy, oz, turn);
	// Born u frames before frame s (age counts from there), so on the line the
	// emitter swept from s - 1 to s: a fast hand leaves a stream, not beads.
	const before = em.pose(s - 1).p;
	out.s = s; out.k = k; out.u = u;
	out.bx = pose.p[0] + (before[0] - pose.p[0]) * u + ox; out.by = pose.p[1] + (before[1] - pose.p[1]) * u + oy; out.bz = pose.p[2] + (before[2] - pose.p[2]) * u + oz;
	// A cone of half-angle spread x 90 deg about the emitter's local +Y.
	const cosT = 1 - r(6) * (1 - Math.cos((effect.spread * Math.PI) / 2)), sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT)), phi = 2 * Math.PI * r(7);
	let [dx, dy, dz] = [sinT * Math.cos(phi), cosT, sinT * Math.sin(phi)];
	if (!look.volume) [dx, dy, dz] = rotate(pose.q, dx, dy, dz, turn);
	const speed = effect.speed * (0.75 + 0.5 * r(8)), drag = look.drag;
	// Velocity relaxes to the terminal one: the wind plus gravity / drag.
	const tx = effect.wind.x, ty = effect.wind.y - effect.gravity / drag, tz = effect.wind.z;
	const v0x = dx * speed + (look.volume ? tx : 0), v0y = (dy - look.droop) * speed + (look.volume ? ty : 0), v0z = dz * speed + (look.volume ? tz : 0);
	const e = Math.exp(-drag * age), f1 = (1 - e) / drag;
	let x = out.bx + tx * age + (v0x - tx) * f1, y = out.by + ty * age + (v0y - ty) * f1, z = out.bz + tz * age + (v0z - tz) * f1;
	// Drift: a sway frozen at birth (so the column snakes as it rises), a slow
	// lean of the whole plume, a per-particle curl and a little jitter.
	const tau = (s + u) / fps, time = frame / fps, rise = age * Math.sqrt(age);
	x += look.sway * (rise * Math.sin(1.7 * tau + em.phase[0]) + 0.6 * age * Math.sin(0.45 * time + em.phase[2]));
	z += look.sway * (rise * Math.sin(1.3 * tau + em.phase[1]) + 0.6 * age * Math.cos(0.37 * time + em.phase[3]));
	const curl = look.curlRate * age + 2 * Math.PI * r(9);
	x += look.curl * age * Math.cos(curl) + look.jitter * age * (2 * r(10) - 1);
	y += look.jitter * 0.5 * age * (2 * r(11) - 1);
	z += look.curl * age * Math.sin(curl) + look.jitter * age * (2 * r(12) - 1);
	// Nothing falls through the deck, and a volume's drops end at its floor.
	if (y < 0 || (look.volume && y < pose.p[1])) return false;
	let size = effect.size * (1 + look.sizeVar * (2 * r(13) - 1)) * (1 + (effect.grow - 1) * a ** look.growPow);
	let alpha = (effect.opacity / split) * (look.fadeIn > 0 ? smooth(a / look.fadeIn) : 1) * Math.max(0, 1 - a) ** look.fadeOut;
	if (look.twinkle) alpha *= 1 - look.twinkle * (0.5 + 0.5 * Math.sin(3 * age + 2 * Math.PI * r(17)));
	// Fire: a yellow core that reddens and dims as it rises; sparks cool too.
	let bright = 1, g = 1, b = 1, hot = 0;
	if (look.tint === "fire") [bright, g, b, hot] = [1.2 * (1 - 0.35 * a), 1 - 0.3 * a, 1 - 0.85 * a, (1 - a) ** 3];
	if (look.tint === "spark") [bright, g, b, hot] = [1.6 * (1 - 0.4 * a), 1 - 0.3 * a, 1 - 0.6 * a, 0.5 * (1 - a) ** 2];
	if (look.flicker) {
		const flick = rnd(seed, s, k, 1000 + Math.floor(frame));
		bright *= 1 + look.flicker * (2 * flick - 1);
		size *= 1 + 0.3 * look.flicker * (flick - 0.5);
	}
	const vx = tx + (v0x - tx) * e, vy = ty + (v0y - ty) * e, vz = tz + (v0z - tz) * e;
	Object.assign(out, { x, y, z, size, alpha, angle: 2 * Math.PI * r(14) + look.spin * (2 * r(15) - 1) * age, variant: look.clean ? 0 : 1 + Math.floor(r(16) * 3),
		r: em.rgb[0] * bright, g: (em.rgb[1] * g + 0.45 * hot) * bright, b: (em.rgb[2] * b + 0.12 * hot) * bright, additive: effect.additive, sx: vx * look.streak, sy: vy * look.streak, sz: vz * look.streak });
	return true;
}

const catmull = (p0, p1, p2, p3, t, out) => {
	for (let i = 0; i < 3; i += 1) out[i] = 0.5 * (2 * p1[i] + (p2[i] - p0[i]) * t + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t * t + (3 * p1[i] - p0[i] - 3 * p2[i] + p3[i]) * t * t * t);
	return out;
};
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The trail ribbon at `frame` as quads: visit({ a0, b0, a1, b1, alpha0, alpha1 }) older end first. */
function forEachSegment(em, frame, fps, cap, visit) {
	const { effect } = em;
	const half = effect.width / 2, span = effect.life * fps, last = Math.floor(frame), first = Math.floor(frame - span);
	const edges = new Map();
	const edge = (s) => {
		const at = Math.min(last, s);
		if (!edges.has(at)) {
			const { p, q } = em.pose(at), off = rotate(q, 0, half, 0, [0, 0, 0]);
			edges.set(at, { a: [p[0] - off[0], p[1] - off[1], p[2] - off[2]], b: [p[0] + off[0], p[1] + off[1], p[2] + off[2]] });
		}
		return edges.get(at);
	};
	const alphaAt = (s, t, level) => effect.opacity * level * Math.max(0, 1 - (frame - s - t) / span) ** 1.5;
	let drawn = 0, clamped = 0;
	for (let s = first; s < last; s += 1) {
		const level = Math.min(em.level(s), em.level(s + 1));
		const e0 = edge(s), e1 = edge(s + 1);
		const move = Math.max(dist(e0.a, e1.a), dist(e0.b, e1.b));
		if (!(level > 0) || move < TRAIL_STILL_M) continue;
		const fast = Math.min(1, (move * fps) / TRAIL_FULL_SPEED), before = edge(s - 1), after = edge(s + 2);
		for (let j = 0; j < TRAIL_SUBSTEPS; j += 1) {
			const t0 = j / TRAIL_SUBSTEPS, t1 = (j + 1) / TRAIL_SUBSTEPS;
			const alpha0 = alphaAt(s, t0, level) * fast, alpha1 = alphaAt(s, t1, level) * fast;
			if (alpha0 <= 0 && alpha1 <= 0) continue;
			if (drawn >= cap) { clamped += 1; continue; }
			drawn += 1;
			visit({ a0: catmull(before.a, e0.a, e1.a, after.a, t0, [0, 0, 0]), b0: catmull(before.b, e0.b, e1.b, after.b, t0, [0, 0, 0]),
				a1: catmull(before.a, e0.a, e1.a, after.a, t1, [0, 0, 0]), b1: catmull(before.b, e0.b, e1.b, after.b, t1, [0, 0, 0]), alpha0, alpha1 });
		}
	}
	return clamped;
}

/**
 * Every effect record's particles and ribbons at `frame`.
 *
 * `scene`: { lookup: Map of AUTHORED records by id, take: { fps, objectTracks },
 * live?: (id, out) => world matrix of an attached record, hidden?: Set of ids
 * that emit nothing }. `particle(p, em)` / `segment(sg, em)` receive what is
 * drawn (p is reused between calls); `only` limits the work to one emitter
 * while keeping the scene-wide cap the renderer applies.
 *
 * @returns {Map<string, { alive: number, clamped: number, emitter: number[], min: number[], max: number[] }>}
 */
export function evaluateEffects(records, scene, frame, { only = null, particle = null, segment = null } = {}) {
	const fps = scene.take?.fps > 0 ? scene.take.fps : 24;
	const emitters = records.filter((record) => record?.renderer === EFFECT_KIND).map((record) => emitterOf(record, scene));
	const counts = emitters.map((em) => {
		let count = 0;
		if (!em.trail) forEachLive(em, frame, fps, () => { count += 1; });
		return count;
	});
	const total = counts.reduce((sum, count) => sum + count, 0);
	const trailCap = Math.floor(EFFECT_SEGMENT_CAP / Math.max(1, emitters.filter((em) => em.trail).length));
	const stats = new Map();
	const scratch = {};
	emitters.forEach((em, index) => {
		const st = { alive: 0, clamped: 0, emitter: em.pose(Math.floor(frame)).p, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
		stats.set(em.id, st);
		if (only && em.id !== only) return;
		const grow = (x, y, z, pad) => {
			const { min, max } = st;
			min[0] = Math.min(min[0], x - pad); min[1] = Math.min(min[1], y - pad); min[2] = Math.min(min[2], z - pad);
			max[0] = Math.max(max[0], x + pad); max[1] = Math.max(max[1], y + pad); max[2] = Math.max(max[2], z + pad);
		};
		if (em.trail) {
			st.clamped = forEachSegment(em, frame, fps, trailCap, (sg) => {
				st.alive += 1;
				for (const point of [sg.a0, sg.b0, sg.a1, sg.b1]) grow(point[0], point[1], point[2], 0);
				segment?.(sg, em);
			});
			return;
		}
		const n = counts[index], keep = total > EFFECT_PARTICLE_CAP ? Math.floor((n * EFFECT_PARTICLE_CAP) / total) : n;
		st.clamped = n - keep;
		let order = 0;
		forEachLive(em, frame, fps, (s, k, u, age, life, split) => {
			const i = order++;
			if (keep < n && Math.floor(((i + 1) * keep) / n) === Math.floor((i * keep) / n)) return;
			if (!particleAt(em, s, k, u, age, life, split, frame, fps, scratch) || scratch.alpha < 5e-4) return;
			st.alive += 1;
			grow(scratch.x, scratch.y, scratch.z, scratch.size / 2);
			particle?.(scratch, em);
		});
	});
	return stats;
}
