// The Studio's drawn shapes in the motion tool (compile-tool.mjs). shapes: { <prop id>: { h, parts } | null }: the parts
// of the object the Studio draws for a prop, from the base of a box h tall (src/lowvis/studio/scene.js ids.shapes), or
// null for a prop it draws as its box; the install stands the object on the base of the box the writer's scene gives the
// prop, so on a box of another height the same parts lie as far from that base, and from its centre by half that height.
// With shapes (a Studio is behind the tool) they are the only parts a prop has: what a scene itself gives as parts is not
// read. Without (shapes null: no Studio) a scene's own parts stand.
import { atCentre } from "../studio/parts.js";

const heightOf = p => (p.shape === "sphere" ? p.size?.[0] : p.size?.[1]);
const known = (shapes, p) => Array.isArray(shapes?.[p?.id]?.parts) && shapes[p.id].parts.length && Number.isFinite(heightOf(p));

/** The scene with the parts of every prop whose drawn shape is known (at that prop's height) and no parts on any other
 *  prop; the scene itself when nothing changes, or with no shapes (null). */
export function withShapes(scene, shapes) {
	if (!shapes || !scene?.props?.some(p => p.parts !== undefined || known(shapes, p))) return scene;
	return { ...scene, props: scene.props.map(({ parts, ...p }) => (known(shapes, p) ? { ...p, parts: atCentre(shapes[p.id].parts, heightOf(p)) } : p)) };
}

/** The shapes the props of a scene carry (a kept motion's scene, as the tool compiled it): each from its box's base. */
export const sceneShapes = scene => Object.fromEntries((scene?.props ?? []).filter(p => Array.isArray(p.parts) && p.parts.length && Number.isFinite(heightOf(p))).map(p => [p.id, { h: heightOf(p), parts: atCentre(p.parts, -heightOf(p)) }]));

/** The ids of the props a shape is known for. */
export const shapedIds = shapes => Object.entries(shapes ?? {}).filter(([, s]) => Array.isArray(s?.parts) && s.parts.length).map(([id]) => id);

/** What the writer has been told of each shape: the parts of each at the height its box has in the request's scene. */
export const toldOf = shapes => Object.fromEntries(shapedIds(shapes).map(id => [id, JSON.stringify(atCentre(shapes[id].parts, shapes[id].h))]));

/** The lines that tell the parts the tool set on a prop of the compiled scene `def` that differ from what the writer was
 *  told of that prop (said: { <id>: JSON of parts }, kept up to date here): one line per prop, none when all are as told;
 *  a prop that was told with parts and has none now is told so. */
export function shapeLines(def, shapes, said) {
	const lines = [];
	for (const p of def?.props ?? []) {
		if (!known(shapes, p)) {
			if (said[p.id] !== undefined) { delete said[p.id]; lines.push(`parts of ${p.id}: none now (the Studio draws it as its box)`); }
			continue;
		}
		const text = JSON.stringify(p.parts);
		if (said[p.id] === text) continue;
		said[p.id] = text;
		lines.push(`parts of ${p.id} (the shape the Studio draws for it now, from the centre of the box you give it, in its own frame; set on your scene by the tool): ${text}`);
	}
	return lines;
}
