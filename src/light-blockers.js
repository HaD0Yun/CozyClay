/**
 * A practical light inside a record that casts shadows lights almost nothing.
 *
 * A shadow-casting light renders the set's depth from where it sits. Inside a
 * solid record (a lamp light placed in its pole or in an unglowing bulb) the
 * record's own faces fill that depth map in every direction, so the light only
 * reaches the set through shadow-map leaks: thin streaks on the ground, and a
 * brighter light changes nothing the agent can measure (session 1e3d1adc).
 *
 * `blockedLights` finds each point or spot light that renders a shadow and sits inside such
 * a record, from the authored records, and `withLightWarnings` reports it in
 * the receipt of the edit that placed, switched or moved either of them, beside
 * the shadow-cap warning. A record with `glow` is self-lit and casts no shadow
 * (object-glow.js), so a light inside a glowing bulb is not blocked.
 *
 * Pure: no three.js, so the command bus and Node tests read the same rule.
 */

import { practicalShadows, withShadowCapWarnings } from "./object-look.js";
import { isEffectivelyHidden } from "./object-hidden.js";

/** Renderers whose meshes cast shadows (props.jsx primitives, sculpts, imported meshes).
 * A plane and a cutout are cards: nothing can be inside them. */
const CASTERS = new Set(["cube", "sphere", "capsule", "cylinder", "cone", "sculpt", "mesh"]);
const DEG = Math.PI / 180;
const EPS = 1e-6;
const MAX_WARNINGS = 4;

/** `p` (world) in the record's own unscaled frame: the inverse of T · Rx · Ry · Rz · S
 * (three.js "XYZ" Euler, the order SceneObject draws a record with). */
function toLocal(object, p) {
	let x = p.x - (object.x ?? 0), y = p.y - (object.y ?? 0), z = p.z - (object.z ?? 0);
	const turn = (angle, a, b) => {
		const c = Math.cos(angle * DEG), s = Math.sin(angle * DEG);
		return [a * c + b * s, b * c - a * s];
	};
	[y, z] = turn(object.rotX ?? 0, y, z);
	[z, x] = turn(object.rot ?? 0, z, x);
	[x, y] = turn(object.rotZ ?? 0, x, y);
	return { x: x / (object.scaleX || 1), y: y / (object.scaleY || 1), z: z / (object.scaleZ || 1) };
}

/** True when the local point is inside the record's drawn shape: the primitives
 * exactly (built base on the floor, centred on x/z), anything else by its box. */
function insideShape(object, { x, y, z }) {
	const halfW = (object.footprint?.width ?? 0) / 2, halfD = (object.footprint?.depth ?? 0) / 2, height = object.height ?? 0;
	if (!(halfW > EPS && halfD > EPS && height > EPS) || y <= EPS || y >= height - EPS) return false;
	const u = x / halfW, w = z / halfD, ring = u * u + w * w;
	if (object.renderer === "sphere") return ring + ((2 * y) / height - 1) ** 2 < 1 - EPS;
	if (object.renderer === "cylinder") return ring < 1 - EPS;
	if (object.renderer === "cone") return ring < (1 - y / height) ** 2 - EPS;
	if (object.renderer === "capsule") {
		const off = Math.max(0, halfW - y, y - (height - halfW)) / halfW;
		return ring + off * off < 1 - EPS;
	}
	return Math.abs(u) < 1 - EPS && Math.abs(w) < 1 - EPS;
}

/** Records drawn with shadow-casting meshes where their numbers say: shown, not
 * glowing, not riding a character (an attached record's numbers are in its bone's frame). */
function casters(objects) {
	return objects.filter((object) => CASTERS.has(object?.renderer) && !object.glow && !object.attach && !isEffectivelyHidden(object, objects));
}

/** [{ light, by }] for every light that renders a shadow from inside a shadow-casting record. */
export function blockedLights(objects = []) {
	const casting = new Set(practicalShadows(objects).casting);
	const solids = casters(objects);
	const out = [];
	for (const light of objects) {
		// A directional light's place only starts its shadow box: a solid around it shades what lies behind it, no more.
		if (!casting.has(light?.id) || light.attach || light.light?.type === "directional") continue;
		const at = { x: light.x ?? 0, y: light.y ?? 0, z: light.z ?? 0 };
		const by = solids.find((object) => object.id !== light.id && insideShape(object, toLocal(object, at)));
		if (by) out.push({ light, by });
	}
	return out;
}

const label = (object) => (object.name && object.name !== object.id ? `${object.name.slice(0, 24)} (${object.id})` : object.id);

function blockedWarning({ light, by }) {
	const message = [...`Blocked: inside ${label(by)}, which casts shadows, so it lights almost nothing. Move it out or set shadow false.`];
	return { code: "LIGHT_BLOCKED", id: light.id, message: message.length > 120 ? `${message.slice(0, 119).join("")}…` : message.join("") };
}

/** A command result with the shadow-cap warnings and a LIGHT_BLOCKED warning
 * per blocked light whose light or blocker the edit touched (`affectedIds`). */
export function withLightWarnings(result, objects) {
	const capped = withShadowCapWarnings(result, objects);
	const ids = result?.affectedIds ?? [];
	const blocked = blockedLights(objects).filter(({ light, by }) => ids.includes(light.id) || ids.includes(by.id)).slice(0, MAX_WARNINGS).map(blockedWarning);
	return blocked.length ? { ...capped, warnings: [...(capped.warnings ?? []), ...blocked] } : capped;
}
