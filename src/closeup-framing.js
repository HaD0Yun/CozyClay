// verify_result visual "closeup": which objects it frames and where its three cameras stand. Pure (node-tested);
// studio-closeup.js measures the drawn meshes and renders. The agent looks at one thing it just made, so the
// views are fixed (three-quarter, the longer of front and side, top), never the shot camera or the user's view.
import { StudioProtocolError } from "./studio-agent-protocol.js";
import { descendantsOf } from "./scene-objects.js";
import { add, sub, scale, dot, cross, norm, quatFromMat } from "./motion3/compiler/math.js";

const CLOSEUP_MAX_TARGETS = 4;
// Three panes side by side, about 1280 x 480 in all: ~820 image tokens.
export const CLOSEUP_PANE = { width: 420, height: 480 };
const FOV = 30, MARGIN = 1.1, PAD = 0.02, MIN_HALF = 0.08, UP = [0, 1, 0];
// The stand-in is 1.8 m; GAP keeps its arm clear of the object's corner.
export const FIGURE_HEIGHT = 1.8;
const FIGURE_HALF = 0.28, GAP = 0.12;
const rad = d => (d * Math.PI) / 180;
const fail = message => { throw new StudioProtocolError("INVALID_ARGUMENT", message); };

/**
 * The objects a closeup draws: the named ones (args.targets, else a receipt's objects) and every descendant, so a
 * group root shows its parts. Answers { targets, ids }. Refuses characters, unknown ids and more than 4 targets.
 */
export function closeupTargets(args, { objects, characters = [] }, receipt = null) {
	const asked = args.targets ?? (receipt?.affectedIds ?? []).filter(id => objects.some(o => o.id === id)).slice(0, CLOSEUP_MAX_TARGETS);
	if (!asked.length) fail('visual "closeup" frames objects: send targets with 1 to 4 object ids.');
	if (asked.length > CLOSEUP_MAX_TARGETS) fail(`visual "closeup" frames at most ${CLOSEUP_MAX_TARGETS} objects at once; ${asked.length} were sent.`);
	for (const id of asked) {
		if (characters.some(c => c.id === id)) fail(`visual "closeup" frames objects; ${id} is a character (a contact_sheet with views frames a character).`);
		if (!objects.some(o => o.id === id)) throw new StudioProtocolError("STALE_TARGET", `visual "closeup": no object ${id} in this scene.`);
	}
	return { targets: asked, ids: [...new Set(asked.flatMap(id => [id, ...descendantsOf(objects, id).map(o => o.id)]))] };
}

/**
 * Where the 1.8 m stand-in stands in a view, clear of the box: off its front-left corner (-x, +z) for the
 * three-quarter, which no box hides; level with its middle in depth for front and side, so it reads at the box's scale.
 */
export function figureSpot(box, view = "three-quarter") {
	const mid = i => (box.min[i] + box.max[i]) / 2, off = GAP + FIGURE_HALF;
	if (view === "front") return [box.min[0] - off, 0, mid(2)];
	if (view === "side") return [mid(0), 0, box.max[2] + off];
	return [box.min[0] - off, 0, box.max[2] + off];
}

const corners = ({ min, max }) => [0, 1].flatMap(i => [0, 1].flatMap(j => [0, 1].map(k => [[min, max][i][0], [min, max][j][1], [min, max][k][2]])));

/** A camera looking along -back whose frustum holds every point at MARGIN (the far side of a deep box included). */
function fit(name, points, back, upHint, aspect) {
	const right = norm(cross(upHint, back)), up = cross(back, right);
	const c0 = scale(points.reduce(add, [0, 0, 0]), 1 / points.length), rel = points.map(p => sub(p, c0));
	const xs = rel.map(q => dot(q, right)), ys = rel.map(q => dot(q, up)), zs = rel.map(q => dot(q, back));
	const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2, tan = Math.tan(rad(FOV / 2));
	// each point needs this much distance from the target plane to sit inside the lens
	const d = Math.max(...rel.map((q, i) => zs[i] + MARGIN * Math.max(Math.max(Math.abs(xs[i] - cx) + PAD, MIN_HALF) / aspect, Math.max(Math.abs(ys[i] - cy) + PAD, MIN_HALF)) / tan));
	const target = add(c0, add(scale(right, cx), scale(up, cy))), eye = add(target, scale(back, d));
	const depth = Math.max(...zs) - Math.min(...zs), radius = Math.max(...rel.map(q => Math.hypot(...q)));
	return { name, eye, target, quaternion: quatFromMat([0, 1, 2].map(i => [right[i], up[i], back[i]])), fovDeg: FOV,
		near: Math.max(0.01, Math.min(0.1, (d - Math.max(...zs)) * 0.5)), far: Math.max(100, d + depth + radius * 4) };
}

const look = (yaw, elevation) => [Math.sin(rad(yaw)) * Math.cos(rad(elevation)), Math.sin(rad(elevation)), Math.cos(rad(yaw)) * Math.cos(rad(elevation))];

/**
 * The closeup's three cameras over a world box { min: [x,y,z], max }: three-quarter (front-right, 20 degrees up),
 * front (or side from +x when the box is deeper than wide: the longer silhouette), top (front down the image). Answers [{ name, eye, target, quaternion, fovDeg, near, far }].
 */
export function closeupCameras(box, { aspect = CLOSEUP_PANE.width / CLOSEUP_PANE.height } = {}) {
	// Of the figure, the frame holds the side toward the box (all of it once the box is a metre or more across) and up
	// to the box's height: a small thing stands by an arm and a shin, not lost beside a whole person.
	const size = Math.max(...box.max.map((v, i) => v - box.min[i])), strip = Math.min(2 * FIGURE_HALF, Math.max(0.2, size / 2));
	const top = Math.min(FIGURE_HEIGHT, Math.max(box.max[1], 0.25));
	const seen = view => {
		const [x, , z] = figureSpot(box, view), toward = view === "side" ? [0, -1] : [1, view === "front" ? 0 : -1];
		const span = (c, k) => (toward[k] ? [c + toward[k] * (FIGURE_HALF - strip), c + toward[k] * FIGURE_HALF].sort((a, b) => a - b) : [c - FIGURE_HALF, c + FIGURE_HALF]);
		const [x0, x1] = span(x, 0), [z0, z1] = span(z, 1);
		return [...corners(box), ...corners({ min: [x0, 0, z0], max: [x1, top, z1] })];
	};
	const second = box.max[0] - box.min[0] >= box.max[2] - box.min[2] ? "front" : "side";
	return [
		fit("three-quarter", seen("three-quarter"), look(35, 20), UP, aspect),
		fit(second, seen(second), second === "front" ? look(0, 8) : look(90, 8), UP, aspect),
		fit("top", corners(box), UP, [0, 0, -1], aspect),
	];
}
