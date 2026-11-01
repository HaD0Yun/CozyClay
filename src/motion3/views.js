// C11 own views: the cameras of a verify_result contact_sheet with `views`. They are the
// agent's own cameras around the subject, never the user's shot camera. A view stays at one
// place for every frame of the sheet (or rides with the focus when it travels farther than its
// size) and frames what matters over those frames (the focus
// refs, else the whole character, plus any trail), so a small action fills the tile and
// motion reads as change inside one still frame. Pure over a compile result (compileSpec .out).
//   front          in front of the character, 10 degrees up
//   side           from the side the focus is on (the right when centred), 10 degrees up
//   three-quarter  between front and that side, 25 degrees up
//   top            straight down, the character's forward up the image
// depthViews adds a view when the asked ones would hide depth (see APART below).
import { refPoint } from "./refs.js";
import { objectBoxesAt, partsOf } from "./object-pose.js";
import { resolveBone } from "./bones.js";
import { add, sub, scale, dot, cross, norm, apply, quatFromMat } from "./compiler/math.js";

export const VIEW_NAMES = ["front", "side", "three-quarter", "top"];
// FOV is the widest lens; a deep subject (a body seen from above) moves the camera back until
// its far side is at most DEPTH_RATIO times as far as its near side, and the lens narrows (down
// to MIN_FOV) to fill the tile again, so perspective stays mild.
const FOV = 35, MIN_FOV = 12, DEPTH_RATIO = 1.8, MARGIN = 1.12, PAD = 0.06, MIN_HALF = 0.15, MIN_DEPTH = 0.35, UP = [0, 1, 0];
const ELEVATION = { front: 10, side: 10, "three-quarter": 25 };
const BARE_OBJECT = /^object:(.+?)(\.(?:center|top|base))?$/s;
const rad = d => (d * Math.PI) / 180;
const mean = points => scale(points.reduce(add, [0, 0, 0]), 1 / Math.max(1, points.length));

const jointsAt = (out, f) => out.frames?.[f - (out.f0 ?? 0)]?.s.P ?? [];
const corners = b => [-1, 1].flatMap(x => [0, 2].flatMap(y => [-1, 1].map(z => add(b.pos, apply(b.R, [x * b.half[0], y * b.half[1], z * b.half[2]])))));

/** World points of a ref at frame f: a bare object:<id> is its part boxes' corners, any other ref its point. */
function refPoints(out, f, ref) {
	const bare = BARE_OBJECT.exec(ref);
	if (bare && !bare[2]) return (objectBoxesAt(out, bare[1], f) ?? []).flatMap(corners);
	const p = refPoint(out, f, ref);
	return p ? [p] : [];
}

/** The character's horizontal left and forward over the frames (the hip line, summed). */
function facingOf(out, frames) {
	const sk = out.ctx.sk, l = sk.index[resolveBone(sk, "LeftUpLeg").bone], r = sk.index[resolveBone(sk, "RightUpLeg").bone];
	let v = [0, 0, 0];
	for (const f of frames) { const P = jointsAt(out, f); if (P.length) { const d = sub(P[l], P[r]); v = add(v, [d[0], 0, d[2]]); } }
	const left = Math.hypot(v[0], v[2]) > 1e-6 ? norm(v) : [1, 0, 0];
	return { left, forward: cross(left, UP) };
}

/** Path of a ref over absolute frames lo..hi: [{ f, p }] where it is known. */
export function trailPoints(out, ref, [lo, hi]) {
	const points = [];
	for (let f = lo; f <= hi; f++) { const p = refPoint(out, f, ref); if (p) points.push({ f, p }); }
	return points;
}

/** A camera at `back` (unit, target to eye) whose frustum holds every point (with PAD) at MARGIN. */
function fit(name, points, back, upHint, aspect) {
	const right = norm(cross(upHint, back)), up = cross(back, right);
	const c0 = mean(points), rel = points.map(p => sub(p, c0)), xs = rel.map(q => dot(q, right)), ys = rel.map(q => dot(q, up)), zs = rel.map(q => dot(q, back));
	const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
	const target = add(c0, add(scale(right, cx), scale(up, cy)));
	// The vertical half-angle tangent each point needs from distance d (x through the aspect).
	const need = d => Math.max(...rel.map((q, i) => MARGIN * Math.max(Math.max(Math.abs(xs[i] - cx) + PAD, MIN_HALF) / aspect, Math.max(Math.abs(ys[i] - cy) + PAD, MIN_HALF)) / (d - zs[i])));
	const near = Math.max(...zs), far = Math.min(...zs);
	let d = Math.max(near + MIN_DEPTH, near + (near - far) / (DEPTH_RATIO - 1)), tanV = need(d);
	if (tanV > Math.tan(rad(FOV / 2))) {
		// Too close for the widest lens: back off at FOV until every point fits.
		tanV = Math.tan(rad(FOV / 2));
		d = Math.max(d, ...rel.map((q, i) => zs[i] + MARGIN * Math.max(Math.max(Math.abs(xs[i] - cx) + PAD, MIN_HALF) / aspect, Math.max(Math.abs(ys[i] - cy) + PAD, MIN_HALF)) / tanV));
	} else tanV = Math.max(tanV, Math.tan(rad(MIN_FOV / 2)));
	const eye = add(target, scale(back, d)), fovDeg = Math.round((2 * Math.atan(tanV) * 180 / Math.PI) * 100) / 100;
	tanV = Math.tan(rad(fovDeg / 2));
	const quaternion = quatFromMat([0, 1, 2].map(i => [right[i], up[i], back[i]]));
	return { name, eye, target, quaternion, fovDeg, aspect, right, up, back, tanV, tanH: tanV * aspect };
}

/**
 * One camera per view name over `frames`: framed on the focus refs' points at those frames
 * (none, or none known there: every joint of the character) and every trail point. Answers
 * [{ name, eye, target, quaternion [x,y,z,w], fovDeg, aspect, right, up, back, tanV, tanH }].
 * Deterministic: the same compile, frames and arguments give the same cameras.
 */
export function viewCameras(out, { views, frames, focus = [], trails = [], aspect = 1 }) {
	const ride = rideOf(out, frames, focus);
	let points = frames.flatMap(f => focus.flatMap(ref => refPoints(out, f, ref)).map(p => (ride ? sub(p, ride[f]) : p)));
	const body = frames.flatMap(f => jointsAt(out, f));
	if (!points.length) points = body;
	points = [...points, ...trails.flatMap(t => t.points.map(q => q.p))];
	if (!points.length) return [];
	const { left, forward } = facingOf(out, frames), hips = mean(frames.map(f => jointsAt(out, f)[out.ctx.sk.index.Hips]).filter(Boolean));
	const side = focus.length && dot(sub(mean(points), hips), left) > 0.02 ? left : scale(left, -1);
	return views.map(name => {
		const cam = name === "top" ? fit(name, points, UP, forward, aspect)
			: (e => fit(name, points, add(scale(name === "front" ? forward : name === "side" ? side : norm(add(forward, side)), Math.cos(e)), scale(UP, Math.sin(e))), UP, aspect))(rad(ELEVATION[name]));
		return ride ? { ...cam, ride } : cam;
	});
}

/**
 * The focus's travel over the frames: { [frame]: its centre there less its mean centre } when it moves farther than its
 * own size (a wheel in a driving truck, session 2ad2760a: one camera for the whole drive framed the road and showed the
 * hands too small to read), else null. A riding view keeps its place relative to the focus (cameraAt).
 */
function rideOf(out, frames, focus) {
	if (!focus.length) return null;
	const at = frames.map(f => ({ f, points: focus.flatMap(ref => refPoints(out, f, ref)) })).filter(x => x.points.length);
	if (at.length < 2) return null;
	const centres = at.map(x => mean(x.points)), mid = mean(centres);
	const size = Math.max(MIN_HALF, ...at.map((x, i) => Math.max(...x.points.map(p => Math.hypot(...sub(p, centres[i]))))));
	if (Math.max(...centres.map(c => Math.hypot(...sub(c, mid)))) <= size) return null;
	return Object.fromEntries(at.map((x, i) => [x.f, sub(centres[i], mid)]));
}

/** View camera `cam` at `frame`: a riding view moved by the focus's travel there (rideOf), else cam itself. */
export function cameraAt(cam, frame) {
	const d = cam.ride?.[frame];
	return d ? { ...cam, eye: add(cam.eye, d), target: add(cam.target, d) } : cam;
}

// A picture hides distance along its own line of sight, so a sheet holds two views at least APART
// degrees apart. Front and three-quarter (45 degrees apart) look along nearly one line: the
// guitarist's right hand 20 cm in front of the guitar (session df388a9b) showed in neither.
// LOOK is each view's nominal direction: azimuth from the character's forward, elevation.
const LOOK = { front: [0, 10], side: [90, 10], "three-quarter": [45, 25], top: [0, 90] }, APART = 60;
const lookDir = name => { const [a, e] = LOOK[name].map(rad); return [Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)]; };
const apartDeg = (a, b) => Math.round(Math.acos(Math.min(1, dot(lookDir(a), lookDir(b)))) * 180 / Math.PI);
const spread = views => views.some((a, i) => views.slice(i + 1).some(b => apartDeg(a, b) >= APART));

/**
 * The views a sheet renders: the asked ones when two of them are APART degrees apart, else the
 * asked ones plus the first of side, front and top that makes it so. Answers { views, added }:
 * added is null, or { view, reason } for visualRefs.
 */
export function depthViews(views) {
	if (spread(views)) return { views, added: null };
	const view = ["side", "front", "top"].find(name => !views.includes(name) && spread([...views, name]));
	const line = views.length > 1 ? `${views.join(" and ")} look along nearly one line (${apartDeg(views[0], views[1])} degrees apart)` : `${views[0]} alone looks along one line`;
	return { views: [...views, view], added: { view, reason: `${line}, so a gap along it (toward or away from the camera) does not show; ${view} looks across it` } };
}

/** The focus refs' middles at frame f, for sightlines: [{ p, own }], own the bodies of the object a bare object:<id> ref is (a group's parts). */
export function focusPoints(out, f, focus) {
	return focus.flatMap(ref => {
		const points = refPoints(out, f, ref), own = BARE_OBJECT.exec(ref);
		return points.length ? [{ p: mean(points), own: own && !own[2] ? partsOf(out.ctx.scene, own[1]) : [] }] : [];
	});
}

/** Pixel [x, y] of world point p in a width x height image of cam, y counted from the bottom row; null behind it. */
export function projectPoint(cam, p, width, height) {
	const rel = sub(p, cam.eye), depth = -dot(rel, cam.back);
	if (depth < 0.05) return null;
	return [((dot(rel, cam.right) / (depth * cam.tanH) + 1) / 2) * width, ((dot(rel, cam.up) / (depth * cam.tanV) + 1) / 2) * height];
}
