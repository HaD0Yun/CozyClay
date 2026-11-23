// The drawn parts of a body: per joint of the rig, the box around what a look draws on that joint (its solids,
// src/lowvis/looks/solids.js, read from the look as drawn: the hands left out), in that joint's own frame (the body
// frame at rest, as a {joint, at} target gives an offset) and at the rig's own size (scale 1 of the rig: the engine
// multiplies by a body's scale). A part is named for its joint, so a part of a body is written with the joint names a
// hand target already has: {on: characterId, part: "Head", at?} is the place at from that part's centre, in the joint's
// frame (parts.js resolveParts writes it as {joint, of, at}). No part has a word or a number of its own: every one comes
// from the look, so a look drawn otherwise (a smaller head) changes them with it.
// Pure JS: node, the browser and the sidecar.
import { JOINTS } from "../rig17.js";
import { LOOK_SOLIDS } from "../looks/solids.js";

/** The look whose parts are read: the one named when the looks state its solids, else the block look (as inside.mjs). */
export const bodyLook = name => (LOOK_SOLIDS[name] ? name : "block");

const cache = {};
/** The drawn parts of look `name`: [{ name (its joint's), joint (index), c: centre from the joint, h: half sizes }] in
 *  the rig's joint order, at the rig's size; a joint the look draws nothing on has no part. */
export function bodyParts(name) {
	const look = bodyLook(name);
	if (cache[look]) return cache[look];
	const box = new Map();
	for (const s of LOOK_SOLIDS[look]()) {
		const b = box.get(s.joint) ?? { lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] };
		for (let k = 0; k < 3; k++) { b.lo[k] = Math.min(b.lo[k], s.c[k] - s.h[k]); b.hi[k] = Math.max(b.hi[k], s.c[k] + s.h[k]); }
		box.set(s.joint, b);
	}
	return (cache[look] = [...box].sort(([a], [b]) => a - b).map(([joint, { lo, hi }]) => Object.freeze({ name: JOINTS[joint], joint, c: lo.map((v, k) => (v + hi[k]) / 2), h: lo.map((v, k) => (hi[k] - v) / 2) })));
}

/** The part `name` of a body of look `look` (bodyParts); throws a refusal that names the parts there are. */
export function bodyPartOf(look, name, who, where) {
	const parts = bodyParts(look), part = parts.find(p => p.name === name);
	if (!part) throw new Error(`engine-simple: ${where}: ${who} has no drawn part ${JSON.stringify(name)}; its parts (named for their joints): ${parts.map(p => p.name).join(", ")}`);
	return part;
}
