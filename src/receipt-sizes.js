// The size of every object a command added or resized, stated in its receipt (output.worldBoxSizeM): per object
// id, [x, y, z] in metres of its own size as the Studio keeps it (objectSize: footprint width, height, footprint
// depth, times scale; the same however the object is turned); an empty: the world box of its parts together
// (studio-entity-bounds.js); null: nothing there the Studio can measure. The readback lists 8 ids; this map lists all
// of them, and when the 8 KiB receipt cannot hold every entry it keeps as many as fit and one warning says how many
// were left out and where to read them.
import { fitReceipt } from './receipt-fit.js';
import { objectSize } from './object-size.js';
import { isEmptyObject } from './scene-objects.js';

const tooBig = error => error?.code === 'INVALID_RECEIPT' && /8 KiB/.test(error.message);
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

const note = (kept, of) => ({ code: 'SIZES_TRUNCATED', count: of - kept,
	message: `worldBoxSizeM lists ${kept} of ${of} objects (8 KiB receipt); inspect_studio scope entities with ids has the rest.` });

/** fitReceipt(build, output) with output.worldBoxSizeM = sizes, keeping as many entries as the receipt holds. The
 * sizes take only the room the readback's box and children free (level 1): they are cut before the warnings or the
 * output's own list are, and when not even the line that counts them fits, the receipt is fitReceipt's own. */
export function fitSized(build, output, sizes) {
	const entries = Object.entries(sizes ?? {});
	if (!entries.length || (output !== undefined && (output === null || typeof output !== 'object' || Array.isArray(output)))) return fitReceipt(build, output);
	const attempt = n => {
		const sized = { ...output, worldBoxSizeM: Object.fromEntries(entries.slice(0, n)) }, cut = n < entries.length ? [note(n, entries.length)] : [];
		return fitReceipt((level, value = sized, more = []) => {
			if (level > 1) throw Object.assign(new Error('Receipt exceeds 8 KiB at this level.'), { code: 'INVALID_RECEIPT' });
			return build(level, value, [...cut, ...more]);
		}, sized);
	};
	let lo = 0, hi = entries.length, best = null;
	while (lo <= hi) {
		const mid = hi === entries.length && !best && lo === 0 ? hi : Math.floor((lo + hi) / 2);
		try { best = attempt(mid); lo = mid + 1; } catch (error) { if (!tooBig(error)) throw error; hi = mid - 1; }
	}
	return best ?? fitReceipt(build, output);
}
