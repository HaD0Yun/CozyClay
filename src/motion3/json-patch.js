// JSON Patch (RFC 6902) on a motion spec: add, remove, replace, move and test, with "-" to append to
// an array in add. Used for motion.compile { base, patch } (C7) and by repair (C6). Errors are
// MOTION_SPEC_INVALID (INVALID_ARGUMENT to the agent) and name the op and what is there:
//   patch[1] (replace /keys/12/f): /keys/12 does not exist (keys has 9 entries; by frame: /keys/@f=<f>, f 0, 24, 40, ...)
// With a notes list (motion.compile, lenient.js), replace on a member an existing object lacks adds it
// and says so, and add on a keys frame that is keyed already (/keys/@f=44, the agent's "set these at f44")
// merges into that key, its set channel by channel, as the bake merges two keys at one frame; repair (no
// notes) stays strict, and so does a move onto a keyed frame (a chain of moves can mean either order).
//
// Stable addressing: an array step may be a selector "@field=value" ("&" joins more), the element whose
// field reads value, instead of an index. An index edit goes wrong silently when an earlier entry is
// added or removed, and the agent's own logs show index paths are most of what it patches, so:
//   /keys/@f=120/set/hand_l          the key at frame 120 (several there: the last, the one that wins the bake)
//   /objects/cup/keys/@f=40/pos      an object key by frame
//   /use/@skill=reach&f0=40/args/at  a skill by name and first frame; /goals/@name=cup lifted; /fits/@anchor=cupHandle
// add (and a lenient replace) through a selector that matches nothing creates the element ({ f: 120, set: {} }):
// one op sets a channel on a key whether the key exists or not. remove /keys/@f=120 removes every key at 120;
// a key moves with { op: "move", from: "/keys/@f=120", path: "/keys/@f=132" } (its f becomes 132; refused when
// 132 is keyed). A selector that matches nothing lists the values there, nearest frames first, so a retry lands.

const OPS = ["add", "remove", "replace", "move", "test"];
const bad = msg => { throw new Error(`MOTION_SPEC_INVALID: ${msg}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** "/keys/0/set" -> ["keys", "0", "set"] (~1 is "/", ~0 is "~"). */
const tokens = path => path.split("/").slice(1).map(t => t.replaceAll("~1", "/").replaceAll("~0", "~"));
const pointer = parts => parts.map(t => `/${String(t).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");

const SELECTOR = /^@[A-Za-z_]\w*=[^&]*(&[A-Za-z_]\w*=[^&]*)*$/;
/** "@skill=reach&f0=40" -> [["skill", "reach"], ["f0", "40"]], or null for any other step. */
const conditions = t => (SELECTOR.test(t) ? t.slice(1).split("&").map(c => [c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1)]) : null);
const matches = (el, conds) => el !== null && typeof el === "object" && conds.every(([k, v]) => Object.hasOwn(el, k) && String(el[k]) === v);
const isMap = v => v !== null && typeof v === "object" && !Array.isArray(v);
const numeric = v => (/^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v);
// the fields that tell entries apart, in the order an error offers them
const NAMES = ["name", "skill", "anchor", "f", "f0", "side", "type"];

/** What an array holds, for an error: its length, and how to address it by a field its entries carry. */
function what(container, name, want) {
	if (!Array.isArray(container)) {
		const keys = Object.keys(container);
		return keys.length ? `${name} has ${keys.slice(0, 8).join(", ")}${keys.length > 8 ? ", ..." : ""}` : `${name} is empty`;
	}
	const field = want?.[0] ?? NAMES.find(k => container.some(el => el && typeof el === "object" && Object.hasOwn(el, k)));
	if (!field) return `${name} has ${container.length} entries`;
	const all = [...new Set(container.filter(el => el && Object.hasOwn(el, field)).map(el => el[field]))];
	// frames: the nearest to the one asked for, shown in order
	const target = Number(want?.[1]);
	const values = all.every(v => typeof v === "number")
		? (Number.isFinite(target) ? [...all].sort((a, b) => Math.abs(a - target) - Math.abs(b - target)) : all).slice(0, 8).sort((a, b) => a - b) : all.slice(0, 8);
	return `${name} has ${container.length} entries; by ${field}: /${name}/@${field}=<${field}>, ${field} ${values.join(", ")}${all.length > values.length ? ", ..." : ""}`;
}

/** Two keys at one frame as one, b winning (as in the bake): set (any map) merged field by field, step joined. */
const mergeKey = (a, b) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(f => [f,
	isMap(a[f]) && isMap(b[f]) ? { ...a[f], ...b[f] } : Array.isArray(a[f]) && Array.isArray(b[f]) && f === "step" ? [...new Set([...a[f], ...b[f]])] : Object.hasOwn(b, f) ? b[f] : a[f]]));

/** Index (as a string) of the element of arr that step t selects; creates it when `create`, else -1 when none. */
function select(arr, t, rest, tag, name, create) {
	const conds = conditions(t), hits = [];
	arr.forEach((el, i) => matches(el, conds) && hits.push(i));
	const frameOnly = conds.length === 1 && conds[0][0] === "f";
	if (hits.length > 1 && !frameOnly) {
		const field = NAMES.find(k => !conds.some(c => c[0] === k) && new Set(hits.map(i => arr[i]?.[k])).size === hits.length);
		bad(`${tag}: ${hits.length} ${name} entries have ${t.slice(1)}${field ? ` (${field} ${hits.map(i => arr[i][field]).join(", ")}; add &${field}=<${field}>)` : ` (indices ${hits.join(", ")})`}`);
	}
	if (hits.length) {
		// keys at one frame merge, the last winning: prefer the last that holds the rest of the path, then its parent
		const has = (i, path) => { let n = arr[i]; for (const p of path) { if (n === null || typeof n !== "object" || !Object.hasOwn(n, p)) return false; n = n[p]; } return true; };
		return String(hits.findLast(i => has(i, rest)) ?? hits.findLast(i => has(i, rest.slice(0, -1))) ?? hits.at(-1));
	}
	if (!create) return -1;
	const el = Object.fromEntries(conds.map(([k, v]) => [k, numeric(v)]));
	if (rest.length > 1) el[rest[0]] = {};
	arr.push(el);
	return String(arr.length - 1);
}

/** parts with every selector step but the last turned into an index; creates elements when `create`. */
function resolve(doc, parts, tag, create, notes) {
	let node = doc;
	const out = [];
	for (let i = 0; i < parts.length; i++) {
		let t = parts[i];
		if (Array.isArray(node) && conditions(t) && i < parts.length - 1) {
			const name = i ? out[i - 1] : "the spec", k = select(node, t, parts.slice(i + 1), tag, name, false);
			if (k === -1 && !create) bad(`${tag}: ${pointer([...out, t])} matches nothing (${what(node, name, conditions(t)[0])})`);
			t = k === -1 ? select(node, t, parts.slice(i + 1), tag, name, true) : k;
			if (k === -1) { out.created = true; notes?.push(`${tag}: created ${pointer(out)}/${t} (${parts[i].slice(1)})`); }
		}
		out.push(t);
		if (i < parts.length - 1) node = node !== null && typeof node === "object" ? node[Array.isArray(node) ? Number(t) : t] : undefined;
	}
	return out;
}

/** The container holding the last token, walking every token before it. */
function parentOf(doc, parts, tag) {
	let node = doc;
	for (let i = 0; i < parts.length - 1; i++) {
		const t = parts[i], name = i ? parts[i - 1] : "the spec";
		if (node === null || typeof node !== "object" || !Object.hasOwn(node, Array.isArray(node) ? Number(t) : t) || (Array.isArray(node) && !/^\d+$/.test(t)))
			bad(`${tag}: ${pointer(parts.slice(0, i + 1))} does not exist${node && typeof node === "object" ? ` (${what(node, name)})` : ""}`);
		node = node[Array.isArray(node) ? Number(t) : t];
	}
	if (node === null || typeof node !== "object") bad(`${tag}: ${pointer(parts.slice(0, -1))} is not an object or array`);
	return node;
}

/** The last step on an array, a selector: add appends (its fields set), remove drops every match, the rest take the one match. */
function bySelector(node, last, op, value, tag, name, merge) {
	const conds = conditions(last), hits = node.flatMap((el, i) => (matches(el, conds) ? [i] : []));
	if (op === "add") {
		if (hits.length && merge && name === "keys" && conds.length === 1 && conds[0][0] === "f" && isMap(value) && isMap(node[hits.at(-1)])) {
			const at = hits.at(-1), was = node[at], set = isMap(value.set) && isMap(was.set) ? Object.keys(value.set) : [];
			const replaced = set.filter(ch => Object.hasOwn(was.set, ch)), added = set.filter(ch => !Object.hasOwn(was.set, ch));
			node[at] = mergeKey(was, { ...structuredClone(value), f: was.f });
			merge.push(`corrected: ${tag}: ${name} already had a key at ${last.slice(1)}; merged into it${added.length ? `, set adds ${added.join(", ")}` : ""}${replaced.length ? `, set replaces ${replaced.join(", ")}` : ""}`);
			return null;
		}
		if (hits.length) bad(`${tag}: ${name} already has an entry with ${last.slice(1)}; replace its fields or remove it first`);
		if (value === null || typeof value !== "object" || Array.isArray(value)) bad(`${tag}: add through a selector takes an object value`);
		node.push({ ...structuredClone(value), ...Object.fromEntries(conds.map(([k, v]) => [k, numeric(v)])) });
		return null;
	}
	if (!hits.length) bad(`${tag}: ${name} has no entry with ${last.slice(1)} (${what(node, name, conds[0])})`);
	if (op === "remove") { for (const i of hits.reverse()) node.splice(i, 1); return null; }
	return select(node, last, [], tag, name, false);
}

function applyOne(doc, op, i, notes, merge = true) {
	if (!op || typeof op !== "object" || !OPS.includes(op.op)) bad(`patch[${i}]: op must be ${OPS.join(", ")}, got ${JSON.stringify(op?.op)}`);
	const tag = `patch[${i}] (${op.op} ${op.path})`;
	if (typeof op.path !== "string" || (op.path !== "" && !op.path.startsWith("/"))) bad(`${tag}: path must be a JSON Pointer such as "/keys/0/f" or "/keys/@f=24/set/hand_l"`);
	if (op.op === "move") {
		if (typeof op.from !== "string" || !op.from.startsWith("/")) bad(`${tag}: move needs from, a JSON Pointer such as "/keys/@f=120"`);
		const parts = resolve(doc, tokens(op.from), tag, false), last = parts.at(-1), node = parentOf(doc, parts, tag), name = parts.at(-2) ?? "the spec";
		let value;
		if (Array.isArray(node) && conditions(last)) {
			// every key at that frame moves, merged into one (later entries win, as in the bake)
			const hits = node.flatMap((el, j) => (matches(el, conditions(last)) ? [j] : []));
			if (!hits.length) bad(`${tag}: ${name} has no entry with ${last.slice(1)} (${what(node, name, conditions(last)[0])})`);
			value = hits.map(j => node[j]).reduce(mergeKey);
			for (const j of hits.reverse()) node.splice(j, 1);
		} else {
			if (!Object.hasOwn(node, Array.isArray(node) ? Number(last) : last)) bad(`${tag}: ${op.from} does not exist (${what(node, name)})`);
			value = node[Array.isArray(node) ? Number(last) : last];
			if (Array.isArray(node)) node.splice(Number(last), 1); else delete node[last];
		}
		return applyOne(doc, { op: "add", path: op.path, value }, i, notes, false);
	}
	if (op.op !== "remove" && !Object.hasOwn(op, "value")) bad(`${tag}: needs a value`);
	if (op.path === "") {
		if (op.op === "replace") return structuredClone(op.value);
		if (op.op === "test") { if (!same(doc, op.value)) bad(`${tag}: the spec differs from the test value`); return doc; }
		bad(`${tag}: ${op.op} needs a path below the spec`);
	}
	const create = op.op === "add" || (op.op === "replace" && Boolean(notes));
	const parts = resolve(doc, tokens(op.path), tag, create, notes), node = parentOf(doc, parts, tag);
	let last = parts[parts.length - 1];
	const name = parts.length > 1 ? parts[parts.length - 2] : "the spec";
	if (Array.isArray(node) && conditions(last)) {
		if (op.op === "replace" && notes && !node.some(el => matches(el, conditions(last)))) { notes.push(`${tag}: nothing had ${last.slice(1)}; added`); return applyOne(doc, { ...op, op: "add" }, i); }
		last = bySelector(node, last, op.op, op.value, tag, name, merge ? notes : undefined);
		if (last === null) return doc;
	}
	if (Array.isArray(node)) {
		if (last === "-") { if (op.op !== "add") bad(`${tag}: "-" (append) works with add only`); node.push(structuredClone(op.value)); return doc; }
		const k = /^\d+$/.test(last) ? Number(last) : NaN;
		const max = op.op === "add" ? node.length : node.length - 1;
		if (!(k >= 0 && k <= max)) bad(`${tag}: ${op.path} does not exist (${what(node, name)})`);
		if (op.op === "add") node.splice(k, 0, structuredClone(op.value));
		else if (op.op === "remove") node.splice(k, 1);
		else if (op.op === "replace") node[k] = structuredClone(op.value);
		else if (!same(node[k], op.value)) bad(`${tag}: value is ${JSON.stringify(node[k])?.slice(0, 60)}, not ${JSON.stringify(op.value)?.slice(0, 60)}`);
		return doc;
	}
	if (op.op === "replace" && notes && !Object.hasOwn(node, last)) { if (!parts.created) notes.push(`${tag}: ${op.path} did not exist (${what(node, name)}); added`); }
	else if (op.op !== "add" && !Object.hasOwn(node, last)) bad(`${tag}: ${op.path} does not exist (${what(node, name)})`);
	if (op.op === "remove") delete node[last];
	else if (op.op === "test") { if (!same(node[last], op.value)) bad(`${tag}: value is ${JSON.stringify(node[last])?.slice(0, 60)}, not ${JSON.stringify(op.value)?.slice(0, 60)}`); }
	else node[last] = structuredClone(op.value);
	return doc;
}

/**
 * Applies ops in order to a copy of doc (doc is never changed) and returns the copy; the first
 * failing op throws MOTION_SPEC_INVALID and nothing is applied. notes (optional) turns a replace on a
 * missing object member (or a selector that matches nothing) into an add and collects a line for it.
 * @param {object} doc
 * @param {{ op: "add" | "remove" | "replace" | "move" | "test", path: string, from?: string, value?: any }[]} ops
 * @param {string[]} [notes]
 */
export function applyPatch(doc, ops, notes) {
	if (!Array.isArray(ops)) bad("patch must be an array of { op, path, value }");
	return ops.reduce((d, op, i) => applyOne(d, op, i, notes), structuredClone(doc));
}
