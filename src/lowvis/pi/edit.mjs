// The edit argument of the motion tool: a change to the kept spec stated by its actions, so a change costs the
// writer the actions it changes, not the whole spec again.
//   applyEdit(spec, { <id>: [[frame, verb, options | null], ...] }) -> { spec, did, said } | { error }
// An action is named by its id, frame and verb. When an id has more than one action with the same frame and verb
// (two pose layers on one frame), the edit's first entry with that frame and verb names the first of them, its second
// the second, and so on, in list order. A named action is replaced in place; an entry that names none is added at the
// end of the id's list; options null removes the named action. Every action the edit does not name stays byte-equal and
// in its place. An id the edit leaves with no action is taken out of the spec (the engine reads an id with an empty list
// as it reads an id that is not there), so a character or prop taken out of the scene can be taken out by an edit.
// An entry that does not read as [frame, verb, options], or a removal that names no action, refuses the whole edit:
// nothing of it is applied, and the message names the entry.
const isObject = v => v !== null && typeof v === "object" && !Array.isArray(v);

export function applyEdit(spec, edit) {
	if (!isObject(spec)) return { error: "edit: there is no spec yet. Send spec first" };
	if (!isObject(edit)) return { error: `edit: want { <id>: [[frame, verb, options], ...] }, got ${JSON.stringify(edit)}` };
	const out = structuredClone(spec), did = { replaced: 0, added: 0, removed: 0 };
	for (const [id, entries] of Object.entries(edit)) {
		if (!Array.isArray(entries)) return { error: `edit.${id}: want a list of [frame, verb, options], got ${JSON.stringify(entries)}` };
		const list = Array.isArray(out[id]) ? out[id] : [], named = list.slice(), taken = new Map(), gone = new Set();
		for (const e of entries) {
			if (!Array.isArray(e) || e.length < 2 || e.length > 3 || !Number.isInteger(e[0]) || typeof e[1] !== "string" || (e.length === 3 && e[2] !== null && !isObject(e[2]))) return { error: `edit.${id}: want [frame, verb, options] (options an object, or null to remove), got ${JSON.stringify(e)}` };
			const key = `${e[0]}\u0000${e[1]}`, nth = taken.get(key) ?? 0;
			taken.set(key, nth + 1);
			const such = named.filter(a => Array.isArray(a) && a[0] === e[0] && a[1] === e[1]), target = such[nth]; // the nth action of the spec as it was before this edit
			if (e[2] === null) {
				if (!target) return { error: `edit.${id}: ${JSON.stringify(e)} removes an action that is not there: ${id} has ${such.length ? `only ${such.length}` : "no"} action${such.length === 1 ? "" : "s"} at frame ${e[0]} with verb "${e[1]}"` };
				gone.add(target); did.removed++;
			} else if (!target) { list.push(e); did.added++; }
			else { list[list.indexOf(target)] = e; did.replaced++; }
		}
		const left = gone.size ? list.filter(a => !gone.has(a)) : list;
		if (left.length) out[id] = left; else delete out[id];
	}
	const count = Object.values(out).reduce((n, acts) => n + (Array.isArray(acts) ? acts.length : 0), 0);
	return { spec: out, did, said: `edit: ${did.replaced} replaced, ${did.added} added, ${did.removed} removed; the spec now has ${count} actions` };
}
