/**
 * The build report object.sculpt answers with: a few gross geometry errors an
 * agent can fix before it spends a render. Every test runs on boxes (each
 * drawn part's declared size, repeat copies included), so it is approximate:
 *
 *   floating  the part's box keeps more than GAP from every other part's box
 *   hidden    every corner of the part sits inside another part's box, shrunk
 *             for round shapes so a blob does not swallow what pokes out of it
 *   below     the part reaches more than GAP under the floor (y = 0)
 *
 * Cutters (op) are not drawn, so they are neither tested nor containers.
 * Pure: no three.js.
 */
import { drawnPartBox, expandSculptParts, SCULPT_MIRROR_SUFFIX } from "./sculpt-recipe.js";
import { applyMatrix, invertRigid, multiply } from "./sculpt-matrix.js";
import { repeatCopies } from "./sculpt-repeat.js";

const GAP = 0.01;
/** Centimetres are enough to spot a gross error, and keep the line short. */
const cm = (value) => Math.round(value * 100) / 100 || 0;
const MAX_IDS = 5;
const MAX_LENGTH = 400;
/** How much of a shape's box counts as solid inside: a box is full, a round shape is not. */
const SOLID = { box: 1, extrude: 0.9, cylinder: 0.7, blob: 0.7, lathe: 0.7, loft: 0.75, convex: 0.6 };

const corners = (part) => {
	const [sx, sy, sz] = part.size.map((value) => value / 2);
	const out = [];
	for (const x of [-sx, sx]) for (const y of [-sy, sy]) for (const z of [-sz, sz]) out.push([x, y, z]);
	return out;
};

const near = (a, b) => [0, 1, 2].every((axis) => a.min[axis] <= b.max[axis] + GAP && b.min[axis] <= a.max[axis] + GAP);

/** Whether every copy of `part` sits inside `other`'s solid box (other is one copy). */
function inside(part, other) {
	const solid = SOLID[other.shape];
	if (!solid || other.repeat || part === other) return false;
	const toOther = invertRigid(other.matrix);
	const limit = other.size.map((value) => (value / 2) * solid);
	return repeatCopies(part).every((copy) => {
		const matrix = multiply(toOther, multiply(part.matrix, copy));
		return corners(part).every((corner) => applyMatrix(matrix, corner).every((value, axis) => Math.abs(value) <= limit[axis]));
	});
}

/** Flagged ids, a mirrored copy folded into its source when both are flagged. */
function list(ids) {
	const set = new Set(ids);
	const shown = ids.filter((id) => !(id.endsWith(SCULPT_MIRROR_SUFFIX) && set.has(id.slice(0, -SCULPT_MIRROR_SUFFIX.length))));
	const more = shown.length - MAX_IDS;
	return shown.slice(0, MAX_IDS).join(", ") + (more > 0 ? ` +${more} more` : "");
}

/** One short line on the recipe's gross errors, flags first, at most `limit` characters (a receipt summary holds 240 in all). */
export function sculptBuildReport(recipe, limit = MAX_LENGTH) {
	const drawn = expandSculptParts(recipe).filter((part) => !part.op);
	const boxes = drawn.map(drawnPartBox);
	const min = [0, 1, 2].map((axis) => cm(Math.min(...boxes.map((box) => box.min[axis]))));
	const max = [0, 1, 2].map((axis) => cm(Math.max(...boxes.map((box) => box.max[axis]))));
	const span = ["x", "y", "z"].map((axis, i) => `${axis} ${min[i]}..${max[i]}`).join(", ");
	const floating = drawn.length < 2 ? [] : drawn.filter((_, i) => !boxes.some((box, j) => j !== i && near(boxes[i], box))).map((part) => part.id);
	const hidden = drawn.filter((part) => drawn.some((other) => inside(part, other))).map((part) => part.id);
	const below = drawn.filter((_, i) => boxes[i].min[1] < -GAP).map((part) => part.id);
	const flags = [["floating (touch nothing)", floating], ["hidden inside another part", hidden], ["below the floor", below]].filter(([, ids]) => ids.length);
	// The whole prop off the floor: its lowest point is the base the object stands on, so a gap there floats in every shot.
	const lifted = min[1] > GAP ? `lowest point is ${min[1]} m above the base (y 0): lower the parts so it stands` : "";
	const listed = flags.map(([label, ids]) => `${label}: ${list(ids)}`).concat(lifted || []).join("; ");
	const verdict = listed || "no floating, hidden or below-floor parts";
	const flagged = `Box check: ${verdict}.`, text = `${flagged} Spans ${span} m.`;
	if (text.length <= limit) return text;
	return flagged.length <= limit ? flagged : `${flagged.slice(0, Math.max(0, limit - 1))}…`;
}
