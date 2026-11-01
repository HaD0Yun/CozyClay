// Two checks on a base + patch compile (deep research 5, 828 compile rounds):
//   PATCH_TOO_BROAD  more than 6 ops, or /anchors or /fix mixed with key edits: a note; the patch is still applied
//                    (patches of 7+ ops made 2.7 new problems per round, against 1-1.6)
//   keepFill         the patch moved channels of one authored key by a little (< 3 cm, < 5 deg, < 0.1 on a pole): the gaps
//                    beside it keep their fill keys instead of running the model again (re-fills beside a patched key made
//                    14-22% of the new problems)
import { isFillKey } from "./bricks/fill-src.js";

const MAX_OPS = 6, POSITION = 0.03, ANGLE = 5, POLE = 0.1, WEIGHT = 0.1;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const head = op => String(op?.path ?? "").split("/")[1] ?? "";

/** The PATCH_TOO_BROAD note for a patch, or null. */
export function patchTooBroad(patch) {
	if (!Array.isArray(patch)) return null;
	const heads = new Set(patch.map(head)), mixed = heads.has("keys") ? ["anchors", "fix"].filter(h => heads.has(h)) : [];
	const why = [...(patch.length > MAX_OPS ? [`${patch.length} ops`] : []), ...(mixed.length ? [`/${mixed.join(" and /")} mixed with key edits`] : [])];
	return why.length ? `PATCH_TOO_BROAD ${why.join("; ")}: applied, but a fix touches only the key and channel the group's cause names, at most 2 ops per round; anchors or fix changes go in their own round` : null;
}

function small(ch, a, b) {
	if (Array.isArray(a) && Array.isArray(b) && a.length === b.length && [...a, ...b].every(Number.isFinite)) return Math.hypot(...a.map((v, i) => v - b[i])) < (/^(knee|elbow)_/.test(ch) ? POLE : POSITION);
	return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < (/^armw_/.test(ch) ? WEIGHT : ANGLE);
}

/** True when after differs from before only in the channels of one authored key, each by a little. */
export function smallKeyPatch(before, after) {
	if (!Array.isArray(before?.keys) || !Array.isArray(after?.keys) || before.keys.length !== after.keys.length || !same({ ...before, keys: 0 }, { ...after, keys: 0 })) return false;
	const changed = before.keys.map((k, i) => [k, after.keys[i]]).filter(([a, b]) => !same(a, b));
	if (changed.length !== 1) return false;
	const [[a, b]] = changed, sa = a?.set ?? {}, sb = b?.set ?? {};
	if (isFillKey(a) || !same({ ...a, set: 0 }, { ...b, set: 0 })) return false;
	return [...new Set([...Object.keys(sa), ...Object.keys(sb)])].every(ch => same(sa[ch], sb[ch]) || (ch in sa && ch in sb && small(ch, sa[ch], sb[ch])));
}

/** The fill a small one-key patch keeps (motion3.js uses it in place of autoFill), or null when the gaps fill again. */
export function keptFill(before, after) {
	if (!after?.keys?.some(isFillKey) || !smallKeyPatch(before, after)) return null;
	return { kept: true, keys: after.keys.filter(isFillKey).length, note: "a small patch on one authored key keeps the fill keys beside it (no re-fill)" };
}
