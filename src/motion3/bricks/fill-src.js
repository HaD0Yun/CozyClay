// How a MotionBricks fill key is marked: src "fill#<key>.<gap>", two short content hashes. <key> is the hash of the key's
// own set, so a fill key someone edited (its set no longer hashes to it) is the author's from then on; <gap> is the hash of
// the authored keys at both ends of its gap, so a gap whose ends did not change keeps its fill instead of running again.
// A bare "fill" (older specs) counts as a fill key with no hashes.
export const isFillKey = k => typeof k?.src === "string" && /^fill(#|$)/.test(k.src);

/** FNV-1a, 8 hex digits: enough to tell an edit, not a security property. */
export function shortHash(value) {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
	return (h >>> 0).toString(16).padStart(8, "0");
}

export const fillSrc = (set, gap) => `fill#${shortHash(set)}.${gap}`;
const parts = k => (/^fill#([0-9a-f]{8})\.([0-9a-f]{8})$/.exec(k.src ?? "") ?? []).slice(1);
/** A fill key whose set is no longer the one the fill wrote. */
export const editedFill = k => { const [key] = parts(k); return Boolean(key) && shortHash(k.set) !== key; };
export const fillGapOf = k => parts(k)[1] ?? null;
