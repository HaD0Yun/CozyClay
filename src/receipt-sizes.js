// The size of every object a command added or resized, stated in its receipt (output.worldBoxSizeM): per object
// id, [x, y, z] in metres of its own size as the Studio keeps it (objectSize: footprint width, height, footprint
// depth, times scale; the same however the object is turned); an empty: the world-axis box around its parts'
// footprint-by-height boxes, each turned as its part is (studio-entity-bounds.js); null: nothing there the Studio can
// measure. The readback lists 8 ids; this map lists all of them, and when the 8 KiB receipt cannot hold every entry it
// keeps as many as fit and one warning says how many were left out and where to read them.
import { fitReceipt } from './receipt-fit.js';
import { objectSize } from './object-size.js';
import { isEmptyObject } from './scene-objects.js';

const tooBig = error => error?.code === 'INVALID_RECEIPT' && /8 KiB/.test(error.message);
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
// receipt-fit.js: a receipt whose output list was cut leaves room for the jobId a background job's receipt gains
const CUT_BUDGET = 8192 - 160;
const round = v => Number(v.toFixed(4)) + 0;
// What a record's own size is built from (object-size.js): footprint x height x scale per axis.
const extent = o => JSON.stringify([o.renderer, o.footprint?.width, o.footprint?.depth, o.height, o.scaleX, o.scaleY, o.scaleZ]);

function sizeOf(object, after, readback) {
	if (!isEmptyObject(object)) { const { width, height, depth } = objectSize(object); return [width, height, depth].map(round); }
	const box = readback(object.id, after, false)?.bounds;
	return box ? ['x', 'y', 'z'].map(a => round(box.max[a] - box.min[a])) : null;
}

/** {id: [x, y, z] | null} for every object in `after` that `before` lacks or whose own size changed; null when none. */
export function receiptSizes(before, after, readback) {
	if (!Array.isArray(before?.objects) || !Array.isArray(after?.objects) || typeof readback !== 'function') return null;
	const old = new Map(before.objects.map(o => [o.id, o]));
	const listed = after.objects.filter(o => !old.has(o.id) || extent(old.get(o.id)) !== extent(o));
	return listed.length ? Object.fromEntries(listed.map(o => [o.id, sizeOf(o, after, readback)])) : null;
}

// The line that counts the sizes left out; bare, it keeps only the count.
const note = (kept, of, bare = false) => ({ code: 'SIZES_TRUNCATED', count: of - kept,
	...(bare ? {} : { message: `worldBoxSizeM lists ${kept} of ${of} objects; inspect_studio scope entities with ids has the rest.` }) });

/** fitReceipt(build, output) with output.worldBoxSizeM = sizes. The sizes take only the room left in the receipt
 * fitReceipt makes, at its level (at least 1: readback box and children give way) and with its own output and
 * warnings: as many entries as fit, and one SIZES_TRUNCATED line after the warnings for the rest. When not even that
 * line fits, the line keeps only its count; when that does not fit either, the readback lists fewer affected ids. */
export function fitSized(build, output, sizes) {
	const entries = Object.entries(sizes ?? {});
	if (!entries.length || (output !== undefined && (output === null || typeof output !== 'object' || Array.isArray(output)))) return fitReceipt(build, output);
	const made = new Map(), plain = fitReceipt((...args) => { const r = build(...args); made.set(r, args); return r; }, output);
	const [level, value = output, cut = []] = made.get(plain);
	const attempt = (n, at, reads, bare) => {
		const r = build(at, n ? { ...value, worldBoxSizeM: Object.fromEntries(entries.slice(0, n)) } : value, cut, n < entries.length ? [note(n, entries.length, bare)] : [], reads);
		if (cut.length && bytes(r) > CUT_BUDGET) throw Object.assign(new Error('Receipt exceeds 8 KiB.'), { code: 'INVALID_RECEIPT' });
		return r;
	};
	const fits = (...args) => { try { return attempt(...args); } catch (error) { if (!tooBig(error)) throw error; return null; } };
	const levels = [...new Set([level, Math.max(level, 1)])];
	for (let reads = 8; reads >= 0; reads--) {
		for (const at of levels) {
			let lo = 0, hi = entries.length, best = null;
			while (lo <= hi) {
				const mid = hi === entries.length && !best && lo === 0 ? hi : Math.floor((lo + hi) / 2), r = fits(mid, at, reads, false);
				if (r) { best = r; lo = mid + 1; } else hi = mid - 1;
			}
			if (best) return best;
		}
		for (const at of levels) { const bare = fits(0, at, reads, true); if (bare) return bare; }
	}
	return plain;
}
