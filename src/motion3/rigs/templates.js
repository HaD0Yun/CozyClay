// Rig templates (templates/<id>.json): a skeleton naming convention's bone names for each canonical (Mixamo) bone the
// motion3 compiler drives. A template lists, per canonical bone, the source names to try in order ("{Side}" in a key
// and "{s}" / "{S}" in a name are the template's side tokens; a finger lists its joints 1..3 or 1..4, each a name or a
// list of names). Names compare without a namespace ("mixamorig:", "Armature|") and, failing an exact match, in any
// case without spaces, underscores, dots or dashes. A source bone answers one canonical bone at most: Spine2 picks
// before Spine1, so a two-bone spine (VRM's spine + chest) gives the chest to Spine2 and leaves Spine1 to adapt.js.
import mixamo from "./templates/mixamo.json" with { type: "json" };
import ue5 from "./templates/ue5.json" with { type: "json" };
import vrm from "./templates/vrm.json" with { type: "json" };
import unity from "./templates/unity-humanoid.json" with { type: "json" };
import rigify from "./templates/rigify.json" with { type: "json" };
import cc4 from "./templates/cc4.json" with { type: "json" };
import genesis8 from "./templates/daz-genesis8.json" with { type: "json" };
import genesis9 from "./templates/daz-genesis9.json" with { type: "json" };

export const TEMPLATES = Object.fromEntries([mixamo, ue5, vrm, unity, rigify, cc4, genesis8, genesis9].map(t => [t.id, t]));

const SIDES = ["Left", "Right"];
const strip = name => String(name).replace(/^.*[:|]/, "");
const squash = name => strip(name).toLowerCase().replace(/[\s_.-]+/g, "");
const fill = (pattern, tokens) => pattern.replace(/\{(\w+)\}/g, (m, k) => tokens[k] ?? m);

/** Canonical bone -> the source names to try, in order, for template t (prefixes applied). Cached per template. */
const expanded = new Map();
function namesOf(t) {
	if (expanded.has(t.id)) return expanded.get(t.id);
	const out = new Map(), prefixes = t.prefixes ?? [""];
	const put = (canon, names) => out.set(canon, prefixes.flatMap(p => names.map(n => p + n)));
	for (const [key, names] of Object.entries(t.bones)) {
		if (!key.includes("{Side}")) { put(key, names); continue; }
		for (const S of SIDES) put(key.replace("{Side}", S), names.map(n => fill(n, t.sides[S])));
	}
	for (const S of SIDES) for (const [finger, joints] of Object.entries(t.fingers ?? {})) {
		joints.forEach((alts, i) => put(`${S}Hand${finger}${i + 1}`, [alts].flat().map(n => fill(n, t.sides[S]))));
	}
	// Spine2 before Spine1 (see the head of this file); otherwise the template's own order
	const order = [...out.keys()].sort((a, b) => (a === "Spine2" && b === "Spine1" ? -1 : a === "Spine1" && b === "Spine2" ? 1 : 0));
	const list = order.map(canon => [canon, out.get(canon)]);
	expanded.set(t.id, list);
	return list;
}

/**
 * Template t's bones found among source bone names: { mapped: { canonical: source index }, exact } where exact counts
 * the bones whose name matched exactly (case and separators kept, namespace stripped).
 */
export function mapBones(t, names) {
	const byExact = new Map(), bySquash = new Map(), used = new Set(), mapped = {};
	names.forEach((n, i) => {
		if (!byExact.has(strip(n))) byExact.set(strip(n), i);
		const k = squash(n);
		if (!bySquash.has(k)) bySquash.set(k, []);
		bySquash.get(k).push(i);
	});
	let exact = 0;
	for (const [canon, tries] of namesOf(t)) {
		for (const name of tries) {
			const hit = byExact.get(name);
			const i = hit !== undefined && !used.has(hit) ? hit : (bySquash.get(squash(name)) ?? []).find(j => !used.has(j));
			if (i === undefined) continue;
			if (hit === i) exact += 1;
			used.add(i);
			mapped[canon] = i;
			break;
		}
	}
	return { mapped, exact };
}

/**
 * The template whose names best match the source bone names: { id, score }, score in 0..1 = (bones found + bones found
 * with their exact spelling) / (2 x the template's bones). The exact spelling tells camel-case VRM from Unity Humanoid.
 */
export function detectTemplate(names) {
	let best = null, top = -1;
	for (const t of Object.values(TEMPLATES)) {
		const { mapped, exact } = mapBones(t, names), score = (Object.keys(mapped).length + exact) / (2 * namesOf(t).length);
		if (score > top) { top = score; best = t.id; }
	}
	return { id: best, score: Math.round(top * 1000) / 1000 };
}
