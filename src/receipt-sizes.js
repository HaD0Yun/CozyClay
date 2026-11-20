// The size of every object a command created or resized, stated in its receipt (output.worldBoxSizeM):
// per object id, [x, y, z] in metres of the box that bounds it in the world, the same box the readback's
// `bounds` and inspect_studio's entity rows carry (studio-entity-bounds.js; an empty: the box of its parts;
// null: nothing there the Studio can measure). The readback lists 8 ids; this map lists all of them, and
// when the 8 KiB receipt cannot hold every entry it keeps as many as fit and one warning says how many
// were left out and where to read them.
import { fitReceipt } from './receipt-fit.js';

const tooBig = error => error?.code === 'INVALID_RECEIPT' && /8 KiB/.test(error.message);
const round = v => Number(v.toFixed(4)) + 0;
// What a record's own box is built from (studio-agent-commands.js geometry): footprint x height x scale per axis.
const extent = o => JSON.stringify([o.renderer, o.footprint?.width, o.footprint?.depth, o.height, o.scaleX, o.scaleY, o.scaleZ]);

/** {id: [x, y, z] | null} for every object in `after` that `before` lacks or whose own box changed; null when none. */
export function receiptSizes(before, after, readback) {
	if (!Array.isArray(before?.objects) || !Array.isArray(after?.objects) || typeof readback !== 'function') return null;
	const old = new Map(before.objects.map(o => [o.id, o]));
	const ids = after.objects.filter(o => !old.has(o.id) || extent(old.get(o.id)) !== extent(o)).map(o => o.id);
	if (!ids.length) return null;
	return Object.fromEntries(ids.map(id => {
		const box = readback(id, after, false)?.bounds;
		return [id, box ? ['x', 'y', 'z'].map(a => round(box.max[a] - box.min[a])) : null];
	}));
}

const note = (kept, of) => ({ code: 'SIZES_TRUNCATED', count: of - kept,
	message: `worldBoxSizeM lists ${kept} of ${of} objects (8 KiB receipt); inspect_studio scope entities with ids has the rest.` });

/** fitReceipt(build, output) with output.worldBoxSizeM = sizes, keeping as many entries as the receipt holds. */
export function fitSized(build, output, sizes) {
	const entries = Object.entries(sizes ?? {});
	if (!entries.length || (output !== undefined && (output === null || typeof output !== 'object' || Array.isArray(output)))) return fitReceipt(build, output);
	const attempt = n => {
		const sized = { ...output, worldBoxSizeM: Object.fromEntries(entries.slice(0, n)) }, cut = n < entries.length ? [note(n, entries.length)] : [];
		return fitReceipt((level, value = sized, more = []) => build(level, value, [...cut, ...more]), sized);
	};
	try { return attempt(entries.length); } catch (error) { if (!tooBig(error)) throw error; }
	let lo = 0, hi = entries.length - 1, best = null;
	while (lo <= hi) {
		const mid = Math.floor((lo + hi) / 2);
		try { best = attempt(mid); lo = mid + 1; } catch (error) { if (!tooBig(error)) throw error; hi = mid - 1; }
	}
	return best ?? fitReceipt(build, output);
}
