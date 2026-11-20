// The size of every object a command added or resized, stated in its receipt (output.sizeM): per object id,
// [x, y, z] in metres of the object's own size as the Studio keeps it (object-size.js: footprint width, height,
// footprint depth, times scale; the same however the object is turned; zeros for a record with no body). The
// readback lists 8 ids; this map lists every one the receipt has room for.
import { fitReceipt } from './receipt-fit.js';
import { objectSize } from './object-size.js';

const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
// Sizes never take a receipt's last 160 bytes: receipt-fit.js keeps them for the jobId a background job's receipt gains.
const BUDGET = 8192 - 160;
const size = o => { const { width, height, depth } = objectSize(o); return [width, height, depth]; };
const round = v => Number(v.toFixed(4)) + 0;

/** {id: [x, y, z]} for every object in `after` whose id `before` lacks or whose size changed; null when none. */
export function receiptSizes(before, after) {
	if (!Array.isArray(before?.objects) || !Array.isArray(after?.objects)) return null;
	const old = new Map(before.objects.map(o => [o.id, String(size(o))]));
	const listed = after.objects.filter(o => old.get(o.id) !== String(size(o)));
	return listed.length ? Object.fromEntries(listed.map(o => [o.id, size(o).map(round)])) : null;
}

// The line that counts the sizes left out (a warning's message holds 120 characters).
const cutLine = (kept, of) => ({ code: 'SIZES_TRUNCATED', count: of - kept, message: `sizeM lists ${kept} of ${of} objects; inspect_studio scope entities with ids reads the others.` });

/** fitReceipt(build, output), then output.sizeM = sizes in the room that receipt leaves. Nothing fitReceipt kept
 * gives way for a size except the readback's box and children (fitReceipt's own first cut): every size at the
 * receipt's level, else every size at level 1, else as many as fit there with one SIZES_TRUNCATED line after the
 * warnings. When that line has no room either (the bytes, or twelve warnings), the receipt is fitReceipt's own. */
export function fitSized(build, output, sizes) {
	const entries = Object.entries(sizes ?? {});
	if (!entries.length || (output !== undefined && (output === null || typeof output !== 'object' || Array.isArray(output)))) return fitReceipt(build, output);
	const made = new Map(), plain = fitReceipt((...args) => { const r = build(...args); made.set(r, args); return r; }, output);
	const [level, value = output, cut = []] = made.get(plain);
	// A receipt the validation refuses with the sizes in it (too large, or anything else) is not built: the plain one stands.
	const fits = (n, at) => {
		try {
			const r = build(at, n ? { ...value, sizeM: Object.fromEntries(entries.slice(0, n)) } : value, cut, n < entries.length ? [cutLine(n, entries.length)] : []);
			return bytes(r) <= BUDGET ? r : null;
		} catch { return null; }
	};
	const all = fits(entries.length, level) ?? (level < 1 ? fits(entries.length, 1) : null);
	if (all || plain.warnings.length >= 12) return all ?? plain;
	let lo = 0, hi = entries.length - 1, best = null;
	while (lo <= hi) { const mid = (lo + hi) >> 1, r = fits(mid, Math.max(level, 1)); if (r) { best = r; lo = mid + 1; } else hi = mid - 1; }
	return best ?? plain;
}

/** A "partial" receipt has no output field: the sizes its completed form stated ride in one warning, whole when they
 * fit a warning's 120 characters (SIZES_INLINE), else their count and where to read them (SIZES_OMITTED). The line
 * takes no other warning's place and none of the receipt's last bytes: without room, no line. */
export function sizesInWarning(receipt, sizes) {
	const cut = receipt.warnings.find(warning => warning.code === 'SIZES_TRUNCATED');
	const plain = cut ? { ...receipt, warnings: receipt.warnings.filter(warning => warning !== cut) } : receipt;
	const count = Object.keys(sizes ?? {}).length + (cut?.count ?? 0), inline = `sizeM ${JSON.stringify(sizes)}`;
	if (!count || plain.warnings.length >= 12) return plain;
	const told = { ...plain, warnings: [...plain.warnings, !cut && inline.length <= 120 ? { code: 'SIZES_INLINE', count, message: inline }
		: { code: 'SIZES_OMITTED', count, message: `A partial receipt has no sizeM: inspect_studio scope entities with ids reads the ${count} objects.` }] };
	return bytes(told) <= BUDGET ? told : plain;
}
