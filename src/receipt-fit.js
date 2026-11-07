// A command's receipt that does not fit 8 KiB sheds detail instead of failing a command that ran (#1126; a
// script's motion.sample of 39 frames x 13 bones failed with "Receipt exceeds 8 KiB" after it had answered):
//   level 0 the full receipt, level 1 the readback without box and children, level 2 four warnings
//   (command-bus.js receipt builds each), then the end of the output's longest list is cut, as many entries
//   kept as fit, and an OUTPUT_TRUNCATED warning says how many and how to get the rest.
// Any other refusal, or an output with no list to cut, throws as before.
const tooBig = error => error?.code === "INVALID_RECEIPT" && /8 KiB/.test(error.message);
const bytes = v => new TextEncoder().encode(JSON.stringify(v)).byteLength;
// a cut receipt leaves room for the jobId a background job's receipt gains (command-bus.js remember)
const CUT_BUDGET = 8192 - 160;

/** The output field holding the largest non-empty list, or null. */
function longestList(output) {
	if (!output || typeof output !== "object" || Array.isArray(output)) return null;
	const lists = Object.entries(output).filter(([, v]) => Array.isArray(v) && v.length);
	return lists.length ? lists.reduce((a, b) => (bytes(b[1]) > bytes(a[1]) ? b : a))[0] : null;
}

const cutWarning = (field, kept, of) => ({ code: "OUTPUT_TRUNCATED", count: of - kept,
	message: `output.${field} lists ${kept} of ${of} entries (8 KiB receipt); ask for the other ${of - kept} in another call.`.slice(0, 120) });

/**
 * fitReceipt(build, output) -> the first receipt that fits: build(level) for level 0..2, then
 * build(2, output with its longest list cut, [OUTPUT_TRUNCATED warning]) with the most entries that fit.
 */
export function fitReceipt(build, output) {
	let refusal;
	for (let level = 0; level <= 2; level++) {
		try { return build(level); } catch (error) { if (!tooBig(error)) throw error; refusal = error; }
	}
	const field = longestList(output);
	if (!field) throw refusal;
	const list = output[field], tried = new Map();
	const fits = n => {
		if (!tried.has(n)) try { const r = build(2, { ...output, [field]: list.slice(0, n) }, [cutWarning(field, n, list.length)]); tried.set(n, bytes(r) <= CUT_BUDGET ? r : null); }
		catch (error) { if (!tooBig(error)) throw error; tried.set(n, null); }
		return tried.get(n);
	};
	if (!fits(0)) throw refusal;
	let lo = 0, hi = list.length - 1;
	while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(mid)) lo = mid; else hi = mid - 1; }
	return fits(lo);
}
