// What a motion's draft added and what its install set, one line per object, every number read from the scene (rule 6).
// The draft (motion-draft.mjs) adds the stand-ins of the writer's first compile; the install sets them to the final
// props. Only geometry and ids.
//   standInLines(made, rows)                              the draft's stand-ins as the Studio holds them
//   propsSetOf({ props, placed, done, plan, start, at, now }) what the install changed since the draft, per object
const PLACE = 0.01, TURN = 0.5; // metres, degrees: smaller differences are not told
const r2 = v => Math.round(v * 100) / 100;
const finite = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);
const angle = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);

/** A describe row as the Studio draws it: base, size (its own box times its scale), turn. */
const shapeOf = row => ({ base: [finite(row.x), finite(row.y), finite(row.z)], size: [finite(row.footprint?.width) * finite(row.scaleX, 1), finite(row.height) * finite(row.scaleY, 1), finite(row.footprint?.depth) * finite(row.scaleZ, 1)], turn: finite(row.rot) });
const list = v => `[${v.map(r2).join(", ")}]`;
const box = v => `${v.map(r2).join(" x ")} m`;
const placeOf = shape => `${box(shape.size)}, base ${list(shape.base)}${r2(shape.turn) ? `, turn ${r2(shape.turn)}°` : ""}`;

/** The draft's stand-ins ({ <prop id>: { id } }) as the Studio holds them (rows: Map(id -> describe row)): [text]. */
export const standInLines = (made, rows) => Object.entries(made).filter(([, { id }]) => rows.get(id)).map(([prop, { id }]) => `${prop} (${id}): ${placeOf(shapeOf(rows.get(id)))}`);

/** The differences between an object before and after the install: base, turn, size, as short texts. */
function changes(was, now) {
	const out = [];
	if (Math.hypot(...now.base.map((v, k) => v - was.base[k])) > PLACE) out.push(`base ${list(now.base)} (was ${list(was.base)})`);
	if (angle(now.turn, was.turn) > TURN) out.push(`turn ${r2(now.turn)}° (was ${r2(was.turn)}°)`);
	if (now.size.some((v, k) => Math.abs(v - was.size[k]) > PLACE)) out.push(`size ${box(now.size)} (was ${box(was.size)})`);
	return out;
}

/** Why a prop of the final motion got a new stand-in although a draft was made. */
function whyNew(plan, prop, now) {
	const lost = plan.lost?.[prop], old = plan.replaced?.[prop];
	if (old) return `it replaces the draft's stand-in ${old}, ${now.has(old) ? "which could not be removed" : "removed"}: the final box needs another kind of object`;
	if (lost?.why === "gone") return `the draft's stand-in ${lost.id} is no longer in the scene`;
	if (lost) return `the draft's stand-in ${lost.id} is ${lost.why} and stays as it is`;
	return "the draft did not have it";
}

/**
 * What the install set, one line per object that changed, every number read from the scene: props (the clip's), placed
 * (install.js placed), done (install.js answer: objectIds, moved, moving), plan (motion-draft.mjs: drafted, remove,
 * kept, lost, replaced), start (describe rows the motion started from, by id), at (describe rows just before the install,
 * by id), now (describe rows after it, by id). -> [text], or null when nothing changed.
 */
export function propsSetOf({ props = [], placed = {}, done = {}, plan, start = new Map(), at = new Map(), now = new Map() }) {
	const out = [], made = new Set(done.objectIds ?? []), moved = new Set(done.moved ?? []), moving = new Set(done.moving ?? []);
	for (const prop of props) {
		const id = placed[prop.id], row = now.get(id), draft = plan.drafted?.[prop.id];
		if (!id || !row) continue;
		const shape = shapeOf(row), starts = moving.has(id) ? "; the motion moves it from there" : "";
		if (draft && at.get(id)) {
			const differs = changes(shapeOf(at.get(id)), shape);
			if (differs.length) out.push(`${row.name ?? prop.id} (${id}), the draft's stand-in of ${prop.id}${draft.untouched ? "" : ", changed meanwhile and keeping its look"}: ${differs.join(", ")}${starts}.`);
		} else if (moved.has(id) && start.get(id)) {
			const differs = changes(shapeOf(start.get(id)), shape);
			if (differs.length) out.push(`${row.name ?? prop.id} (${id}): the motion moved it: ${differs.join(", ")}${starts}.`);
		} else if (made.has(id)) out.push(`${prop.id} (${id}): the motion added it as a stand-in, ${placeOf(shape)}${starts}; ${whyNew(plan, prop.id, now)}.`);
	}
	for (const { prop, id, replaced } of plan.remove ?? []) if (!replaced) out.push(`${prop} (${id}): the final motion does not have this prop; the draft's stand-in ${now.has(id) ? "could not be removed" : "was removed"}.`);
	for (const { prop, id } of plan.kept ?? []) if (now.has(id)) out.push(`${now.get(id).name ?? prop} (${id}): the final motion does not have the draft's prop ${prop}; it stays as it was changed meanwhile, and the motion does not use it.`);
	return out.length ? out : null;
}
