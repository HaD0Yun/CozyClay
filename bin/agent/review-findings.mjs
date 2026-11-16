// What the turn's review (studio-review.mjs) tells the model, out of what the editor measured: one item per kind and
// subject, so a finding the model was already given (by its own check of the same scene revision, or by an earlier
// review round) can be left out, and one line per distinct finding, so the same failure over many sampled frames is
// one line with its frame ranges and its worst value instead of a line per frame.
const QA_GROUPS = 5;
const pct = v => `${Math.round(v * 100)}%`;
const metres = v => `${Number.isFinite(v) ? Math.round(v * 100) / 100 : "?"} m`;

/** The sampled frames in `frames` as runs over the sampled order: "0–215, 359". */
export function frameRuns(frames, sampled = frames) {
	const at = new Set(frames), runs = [];
	let run = null;
	for (const frame of [...new Set([...sampled, ...frames])].sort((a, b) => a - b)) {
		if (at.has(frame)) run ? (run[1] = frame) : (run = [frame, frame]);
		else if (run) { runs.push(run); run = null; }
	}
	if (run) runs.push(run);
	return runs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(", ");
}

// A subject counts as seen at a sampled frame when part of it is in the picture and not all of it is behind props.
// One that is nowhere in the picture at a frame is not in that shot (a stand-in hidden for another shot, a figure
// waiting to walk in): nothing at that frame cuts it or hides it from a viewer.
const seen = row => row.inFrame > 0 && row.hidden < 1;

function framingItems(f) {
	const issues = f?.issueFrames ?? [];
	if (!issues.length) return !f?.issueFrames && (f?.clipped || f?.occluded || f?.behindCamera) ? [{ kind: "framing-now", id: "", text: `framing: ${["clipped", "occluded", "behindCamera"].filter(k => f[k]).join(", ")} at the current frame` }] : [];
	const sampled = f.sampledFrames?.length ? f.sampledFrames : issues.map(issue => issue.frame);
	// an editor that does not name the subjects: one line per set of codes
	if (!issues.every(issue => Array.isArray(issue.subjects))) {
		const byCodes = new Map();
		for (const issue of issues) byCodes.set(issue.codes.join(", "), [...(byCodes.get(issue.codes.join(", ")) ?? []), issue.frame]);
		return [...byCodes].map(([codes, frames]) => ({ kind: "framing", id: codes, text: `framing: ${codes} at ${frames.length > 1 ? "frames" : "frame"} ${frameRuns(frames, sampled)}` }));
	}
	const bySubject = new Map();
	for (const issue of issues) for (const row of issue.subjects) bySubject.set(row.id, [...(bySubject.get(row.id) ?? []), { ...row, frame: issue.frame }]);
	const items = [];
	for (const [id, rows] of bySubject) {
		if (rows.length >= sampled.length && !rows.some(seen)) { items.push({ kind: "unseen", id, samples: sampled.length }); continue; }
		const cut = rows.filter(row => seen(row) && row.codes.some(code => code === "CLIPPED" || code === "BEHIND_CAMERA")), hid = rows.filter(row => seen(row) && row.codes.includes("OCCLUDED"));
		const at = list => `${list.length > 1 ? "frames" : "frame"} ${frameRuns(list.map(row => row.frame), sampled)}`;
		if (cut.length) items.push({ kind: "clipped", id, text: `framing: ${id} cut by the frame edge at ${at(cut)} (least in the picture: ${pct(Math.min(...cut.map(row => row.inFrame)))} of its body)` });
		if (hid.length) items.push({ kind: "occluded", id, text: `framing: ${id} mostly hidden behind props at ${at(hid)} (most hidden: ${pct(Math.max(...hid.map(row => row.hidden)))})` });
	}
	return items;
}

/** The failures in what the editor measured, as items { kind, id, ... }; nothing that passed is listed. owned (a task's
 * ids): a placement or motion finding about none of them is another task's to fix, and is dropped. */
export function findingItems({ placement, framing, motion = [], lighting, owned = null } = {}) {
	const p = placement?.checks?.placement ?? placement?.checks, items = [];
	const overlap = p?.overlapIds ?? [], floating = (p?.unsupportedIds ?? []).filter(id => !owned || owned.has(id));
	if (!owned || overlap.some(id => owned.has(id))) for (const id of overlap) items.push({ kind: "overlap", id, depth: p.maximumFootprintOverlapM });
	for (const id of floating) items.push({ kind: "floating", id, gap: p?.supportGapM?.[id] });
	items.push(...framingItems(framing?.checks?.framing));
	for (const { id, qa } of motion) if (qa?.total > 0 && (!owned || owned.has(id))) items.push({ kind: "motion", id, text: `motion ${id}: QA ${qa.total} frame issues: ${(qa.groups ?? []).slice(0, QA_GROUPS).map(g => `${g.kind} ${g.subject} x${g.count}`).join("; ")}` });
	const l = lighting?.checks?.lighting, LIGHT_PCT = 10; // an estimate, not calibrated: a picture this share clipped or crushed is worth a look
	if (l?.clippedPct >= LIGHT_PCT) items.push({ kind: "lighting", id: "clipped", text: `lighting: ${l.clippedPct}% of the frame clipped` });
	if (l?.crushedPct >= LIGHT_PCT) items.push({ kind: "lighting", id: "crushed", text: `lighting: ${l.crushedPct}% of the frame pure black` });
	return items;
}

export const itemKey = item => `${item.kind}:${item.id}`;

/** One line per distinct finding: the footprint overlaps, the floating objects and the subjects seen at no sampled frame
 * each in one line with their worst value, every other item its own line. */
export function findingLines(items) {
	const of = kind => items.filter(item => item.kind === kind), lines = [];
	const overlap = of("overlap"), floating = of("floating"), unseen = of("unseen");
	if (overlap.length) lines.push(`placement: footprints overlap for ${overlap.map(i => i.id).join(", ")} (deepest ${metres(overlap[0].depth)})`);
	const gaps = floating.map(i => i.gap).filter(Number.isFinite);
	if (floating.length) lines.push(`placement: floating over 1 cm: ${floating.map(i => i.id).join(", ")}${gaps.length ? ` (highest gap ${metres(Math.max(...gaps))})` : ""}`);
	if (unseen.length) lines.push(`framing: not in the picture at any of the ${unseen[0].samples} sampled frames: ${unseen.map(i => i.id).join(", ")}`);
	return [...lines, ...items.filter(item => item.text).map(item => item.text)];
}
