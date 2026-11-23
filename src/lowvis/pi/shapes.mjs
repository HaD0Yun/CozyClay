// The Studio's drawn shapes in the motion tool (compile-tool.mjs). shapes: { <prop id>: { h, parts } }, each the parts
// of the object the Studio draws for that prop, from the base of a box h tall (src/lowvis/studio/scene.js ids.shapes);
// the install stands the object on the base of the box the writer's scene gives the prop, so on a box of another height
// the same parts lie as far from that base, and from its centre by half that height.
import { atCentre } from "../studio/parts.js";

const heightOf = p => (p.shape === "sphere" ? p.size?.[0] : p.size?.[1]);
const known = (shapes, p) => Array.isArray(shapes?.[p?.id]?.parts) && shapes[p.id].parts.length && Number.isFinite(heightOf(p));

/** The scene with the parts of every prop whose drawn shape the Studio has set on it (at that prop's height), in place of
 *  any the scene gives; the scene itself when no prop has one. */
export function withShapes(scene, shapes) {
	if (!scene?.props?.some(p => known(shapes, p))) return scene;
	return { ...scene, props: scene.props.map(p => (known(shapes, p) ? { ...p, parts: atCentre(shapes[p.id].parts, heightOf(p)) } : p)) };
}

/** What the writer has been told of each shape: the parts of each at the height the Studio gives its box (the request's scene). */
export const toldOf = shapes => Object.fromEntries(Object.entries(shapes ?? {}).filter(([, s]) => Array.isArray(s?.parts)).map(([id, s]) => [id, JSON.stringify(atCentre(s.parts, s.h))]));

/** The lines that tell the parts the tool set on a prop of the compiled scene `def` that differ from what the writer was
 *  told of that prop (said: { <id>: JSON of parts }, kept up to date here): one line per prop, none when all are as told. */
export function shapeLines(def, shapes, said) {
	const lines = [];
	for (const p of def?.props ?? []) {
		if (!known(shapes, p)) continue;
		const text = JSON.stringify(p.parts);
		if (said[p.id] === text) continue;
		said[p.id] = text;
		lines.push(`parts of ${p.id} (the shape the Studio draws for it now, from the centre of the box you give it, in its own frame; set on your scene by the tool): ${text}`);
	}
	return lines;
}
