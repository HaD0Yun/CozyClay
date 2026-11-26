// What the writer is told of the measured rows (compile-tool.mjs): which rows, how each reads, and its mark against the
// same instance of the previous compile. Every measured row stays in the clip's stats and the run record (harness.mjs
// final.checks); this decides only what an answer says.
//   told row: the measured row as told, with span (the instance it names), spans (every told instance of its key, for
//   the next compile's marks), more (the other told instances, instances.mjs), moreText, unlisted (true for a row past
//   the cap: counted, not listed) and before (the value a settled instance had when it was last told).
import { badness, inARow, rowId } from "./measure.mjs";
import { overlaps } from "./instances.mjs";

// the rows that are a difference between what the spec asked and what came out (the lean variants)
const ASKED = /^(carryGap|carryIn|gripDrift|gripTurn|cut:|place:|seat:|ride:|balance:|jump:|gap:|body:)/;
/** At most this many rows are listed in one answer, and at most MORE other instances in one row: the rest are counted. */
const MAX_ROWS = 20, MORE = 4;
/** Two values this near each other read as one in an answer (a row prints one decimal): the marks' [same]. */
const SAME = 0.05;
const num = (v, d = 2) => (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d);
const shown = (r, v) => num(v, r.unit === "m/s" ? 2 : 1);
/** No difference: the row reads as the value the engine gives when nothing differs from what the spec asked (its normal,
 *  measure.mjs). */
const none = r => r.normal != null && Math.abs(r.value - r.normal) < SAME;
const inSpan = (r, i) => r.frame != null && r.frame >= i.a && r.frame <= i.b;
const kind = r => r.short ?? r.label;
/** What an instance is of: the action a jump is near (its of), a reach row's action (its tag). */
const nameOf = i => i.of ?? i.tag;

/** The rows a variant tells (features: prompt.mjs), each as told. A lean variant tells no row at its normal. A reach
 *  instance the spec's own order of targets settles (reach-why.mjs settledBy) is told at the first compile that has it
 *  and again when its value has moved from the one last told by more than its `settled` (said: Map of those told ->
 *  that value, which this sets); a reach row whose instances are all such and stay is not told, and one whose worst is
 *  such names its worst other instance. Past MAX_ROWS rows the kind with the most rows leaves out its least bad row,
 *  until MAX_ROWS are left (unlisted: checkLines counts them). */
export function toldRows(rows, feature, said = new Map()) {
	const lean = feature.text === "lean", out = [], id = (r, i) => `${rowId(r)}|${i.tag}`;
	for (const r of rows) {
		const reach = r.key.startsWith("reach:");
		if (!(r.key.startsWith("inside:") ? feature.inside : lean ? ASKED.test(r.key) || (feature.reach && reach && r.value > 10) : !reach) || (lean && none(r))) continue;
		const stays = i => i.settled && said.has(id(r, i)) && Math.abs(said.get(id(r, i)) - i.value) <= i.settled;
		const inst = reach ? (r.inst ?? []).filter(i => !stays(i) && (!lean || i.value > 10)) : r.inst ?? [];
		if (r.inst && !inst.length) continue;
		const main = inst.find(i => inSpan(r, i) && Math.abs(i.value - r.value) < 1e-6) ?? inst.find(i => inSpan(r, i)) ?? inst[0];
		const t = main?.note !== undefined && Math.abs(main.value - r.value) > 1e-6 ? { ...r, value: main.value, frame: main.frame, note: main.note } : { ...r };
		if (main) Object.assign(t, { span: main, spans: inst.map(i => ({ a: i.a, b: i.b, value: i.value, of: nameOf(i) })), more: r.listed ? [] : inst.filter(i => i !== main) });
		t.moreText = !t.more?.length ? "" : `also ${t.more.slice(0, MORE).map(i => `${i.tag}: ${shown(t, i.value)} ${t.unit} @f${i.frame}`).join(", ")}${t.more.length > MORE ? `, and ${t.more.length - MORE} more` : ""}`;
		out.push(t);
	}
	const listed = out.slice();
	while (listed.length > MAX_ROWS) {
		const n = new Map();
		for (const t of listed) n.set(kind(t), (n.get(kind(t)) ?? 0) + 1);
		const most = [...n].reduce((x, y) => (y[1] > x[1] ? y : x))[0], least = listed.filter(t => kind(t) === most).reduce((x, y) => (badness(y) < badness(x) ? y : x));
		least.unlisted = true;
		listed.splice(listed.indexOf(least), 1);
	}
	// said: the settled instances this answer shows, each with the value it shows
	for (const t of listed) for (const i of [t.span, ...(t.more ?? []).slice(0, MORE)]) {
		if (!i?.settled) continue;
		if (i === t.span && said.has(id(t, i))) t.before = said.get(id(t, i));
		said.set(id(t, i), i.value);
	}
	return out;
}

// the row as the branch point told it, then its other instances after the note: "...(note); also <tag>: <value> @f.., ..."
const rowText = t => `${t.label}: ${shown(t, t.value)} ${t.unit}${t.frame != null ? ` @f${t.frame}` : ""}${t.who ? ` ${t.who}` : ""}${t.note ? ` (${t.note})` : ""}${t.moreText ? `; ${t.moreText}` : ""}`;
/** Whether two instances are one difference: of the same action, or with a shared frame. */
const sameInstance = (x, y) => (nameOf(x) != null && nameOf(x) === nameOf(y)) || overlaps(x, y);

/** The previous compile's told row a told row is the same difference as: the row of its key; where both name instances,
 *  only the instance of it that is of the same action (nameOf), else the one that shares the most frames with it
 *  (none when no instance of it shares a frame). A settled instance told again: the value it was last told with. */
function previous(t, prev) {
	const p = prev?.[t.key];
	let best = (t.span && p?.spans?.find(i => i.of != null && i.of === nameOf(t.span))) || null, most = 0;
	if (p && (!t.span || !p.spans)) return p;
	if (p && !best) for (const i of p.spans) if (overlaps(t.span, i)) { const n = Math.min(t.span.b, i.b) - Math.max(t.span.a, i.a) + 1; if (n > most) [best, most] = [i, n]; }
	return best ? { ...p, value: best.value } : t.before != null ? { ...t, value: t.before } : null;
}

/** " [was X]" and whether the row got worse, against the same difference of the previous compile. */
function against(row, prev) {
	if (!prev) return { text: " [new]", worse: false };
	if (Math.abs(row.value - prev.value) < SAME) return { text: " [same]", worse: false };
	const worse = badness(row) - badness(prev) > Math.max(0.05, 0.05 * badness(prev));
	return { text: ` [was ${shown(row, prev.value)}${worse ? `, ${row.word ?? "worse"}` : ""}]`, worse };
}

/** For how many changed compiles in a row each told row has been past its spike (measure.mjs inARow), counted on only
 *  while it names the instance it named before (sameInstance). before: { counts, spans } or null. */
export function streakOf(told, before) {
	const kept = {};
	for (const t of told) { const id = rowId(t), s = before?.spans?.[id]; if (before?.counts?.[id] && (!t.span || !s || sameInstance(t.span, s))) kept[id] = before.counts[id]; }
	const counts = inARow(told, kept);
	return { counts, spans: Object.fromEntries(told.filter(t => t.span && counts[rowId(t)]).map(t => [rowId(t), { a: t.span.a, b: t.span.b, of: nameOf(t.span) }])) };
}

/** The checks block of an answer: { lines, same, told: the record's told lines (the listed rows) }. prevTold: the told
 *  rows of the previous compile (null at the first); counts: streakOf's counts. */
export function checkLines(told, prevTold, counts) {
	const prev = prevTold && Object.fromEntries(prevTold.map(r => [r.key, r])), row = told.map(r => counts[rowId(r)]), many = row.filter(k => k > 1);
	const was = told.map(r => (prev ? previous(r, prev) : null)), marks = told.map((r, k) => (prev ? against(r, was[k]) : { text: "", worse: false }));
	const same = !!prev && marks.every(m => m.text === " [same]") && told.length === prevTold.length && told.every(t => t.moreText === prev[t.key]?.moreText), worse = marks.filter(m => m.worse).length;
	marks.forEach((m, k) => { if (row[k] > 1) m.text = m.text.replace(/\]$/, `; spike ${row[k]} compiles in a row]`); });
	const line = k => `- ${rowText(told[k])}${marks[k].text}`, at = told.map((_, k) => k), listed = at.filter(k => !told[k].unlisted), rest = at.filter(k => told[k].unlisted).map(k => told[k]), kinds = new Map();
	for (const r of rest) { const e = kinds.get(kind(r)) ?? kinds.set(kind(r), { n: 0, top: r }).get(kind(r)); e.n++; if (badness(r) > badness(e.top)) e.top = r; }
	const lines = !told.length ? [] : same ? [`checks: every number is the same as in the previous compile${many.length ? `; ${many.length} past ${many.length === 1 ? "its" : "their"} spike for ${Math.min(...many) === Math.max(...many) ? many[0] : `${Math.min(...many)} to ${Math.max(...many)}`} compiles in a row` : ""}`]
		: [`checks, each at its worst frame${prev ? `; [was ..] is the previous compile${worse ? `, ${worse} got worse` : ""}` : ""}:`, ...listed.map(line),
			...(rest.length ? [`and ${rest.length} more row${rest.length === 1 ? "" : "s"} not listed, the least of their kind: ${[...kinds].map(([k, e]) => `${k} x${e.n} up to ${shown(e.top, e.top.value)} ${e.top.unit}`).join(", ")}`] : [])];
	return { lines, same, told: listed.map(k => ({ key: told[k].key, line: line(k), was: Boolean(was[k]), worse: marks[k].worse })) };
}
