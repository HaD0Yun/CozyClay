// The verify -> repair loop of a Studio turn (#1030). verify_result ran only when the model chose to, and images came only when it
// asked, so a model could stop on a scene it never looked at. Now when a run edits the scene and the model stops, the editor measures
// what changed and renders the shot frame and the top view, and the model gets those as its next message: it repairs, or says why not.
// Repeats after a repair, at most MAX_REVIEWS times a turn. BlenderGym (CVPR 2025): compute spent on verification is what moves 3D editing.
const MAX_REVIEWS = 3;
// Estimates, not calibrated: a picture this share clipped or crushed is worth a look.
const LIGHT_PCT = 10;
const MAX_TARGETS = 32, QA_GROUPS = 5;
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const changed = r => Number.isSafeInteger(r?.revision?.after) && r.revision.after !== r.revision.before;

/** What a run's frames edited: { edited, ids, motionIds, stage }. A script's nested calls come back as result.calls. */
export function turnEdits(frames) {
	const started = new Map(), ids = new Set(), motionIds = new Set();
	let edited = false, stage = false;
	for (const frame of frames) {
		if (frame?.type === "tool.start") started.set(frame.callId, frame);
		if (frame?.type !== "tool.done" || frame.ok !== true || !isObject(frame.result)) continue;
		const { result } = frame, args = started.get(frame.callId)?.args;
		for (const call of [result, ...(Array.isArray(result.calls) ? result.calls : [])]) {
			if (call.ok === false || !(call.authored === true || changed(call))) continue;
			edited = true;
			for (const id of call.affectedIds ?? []) ids.add(id);
		}
		const action = args?.action ?? "";
		if (edited && /^motion\./.test(action) && args?.args?.characterId) motionIds.add(args.args.characterId);
		if (edited && /^(stage|light)/.test(action)) stage = true;
	}
	return { edited, ids: [...ids].slice(0, MAX_TARGETS), motionIds: [...motionIds], stage };
}

/** Failing numbers out of what the editor measured, one line each. Nothing that passed is listed. */
export function reviewFindings({ placement, framing, motion = [], lighting } = {}) {
	const lines = [], p = placement?.checks?.placement ?? placement?.checks, f = framing?.checks?.framing;
	if (p?.overlapIds?.length) lines.push(`placement: footprints overlap for ${p.overlapIds.join(", ")} (deepest ${p.maximumFootprintOverlapM ?? "?"} m)`);
	if (p?.unsupportedIds?.length) lines.push(`placement: floating over 1 cm: ${p.unsupportedIds.join(", ")}`);
	for (const issue of (f?.issueFrames ?? []).slice(0, 6)) lines.push(`framing: ${issue.codes.join(", ")} at frame ${issue.frame}`);
	if (!f?.issueFrames && (f?.clipped || f?.occluded || f?.behindCamera)) lines.push(`framing: ${["clipped", "occluded", "behindCamera"].filter(k => f[k]).join(", ")} at the current frame`);
	for (const { id, qa } of motion) if (qa?.total > 0) lines.push(`motion ${id}: QA ${qa.total} frame issues: ${(qa.groups ?? []).slice(0, QA_GROUPS).map(g => `${g.kind} ${g.subject} x${g.count}`).join("; ")}`);
	const l = lighting?.checks?.lighting;
	if (l?.clippedPct >= LIGHT_PCT) lines.push(`lighting: ${l.clippedPct}% of the frame clipped`);
	if (l?.crushedPct >= LIGHT_PCT) lines.push(`lighting: ${l.crushedPct}% of the frame pure black`);
	return lines;
}

const imagePart = captured => { const m = /^data:([^;]+);base64,(.*)$/.exec(captured?.dataUrl ?? ""); return m ? { type: "image", data: m[2], mimeType: m[1] } : null; };

/** The next user message of the turn. Its label is OBSERVATION_LABEL's (session-store.mjs): a transcript does not show it as the user's words. */
export function reviewContent({ findings, relations = [], images = [], revision = null }) {
	const asks = findings.length
		? `These checks failed:\n${findings.map(line => `- ${line}`).join("\n")}\nRepair what belongs to this request and stop when they pass. If one should stay or you cannot fix it, say why in one line.`
		: "The checks that ran passed. Look at the pictures: if they do not show what was asked, fix it. If they do, do not repeat your answer; finish in one short line.";
	return [{ type: "text", text: `Studio frame observation after your edits, scene revision ${JSON.stringify(revision)}: the shot camera, then the top view.\n${asks}${relations.length ? `\nRelations:\n${relations.join("\n")}` : ""}` }, ...images];
}

/** Measures one run's edits through the turn's own tools. A check that cannot run is left out: the review never fails a turn. */
export function createTurnReview({ invoke, hub, workspaceHandle }) {
	const quiet = async work => { try { return await work(); } catch (error) { console.warn(`[agent] review check skipped: ${error.message}`); return null; } };
	return async edits => {
		const seen = await quiet(() => hub.command("inspect_studio", { scope: "relations" }, workspaceHandle));
		const characters = (seen?.characters ?? []).map(c => c.id), verify = args => quiet(() => invoke("verify_result", args));
		const placement = edits.ids.length ? await verify({ targets: edits.ids, checks: ["placement"] }) : null;
		const framing = characters.length && seen?.camera ? await verify({ targets: characters.slice(0, MAX_TARGETS), checks: ["framing"], range: "whole_clip" }) : null;
		const lighting = edits.stage && characters.length ? await verify({ targets: characters.slice(0, MAX_TARGETS), checks: ["lighting"] }) : null;
		const motion = [];
		for (const id of edits.motionIds) { const r = await quiet(() => invoke("run_action", { action: "motion.qa", args: { characterId: id } })); if (r?.output?.qa) motion.push({ id, qa: r.output.qa }); }
		const images = [];
		for (const name of ["capture_framing_png", "capture_plan_png"]) { const part = imagePart(await quiet(() => hub.command(name, {}, workspaceHandle))); if (part) images.push(part); }
		const findings = reviewFindings({ placement, framing, motion, lighting });
		return { findings, content: reviewContent({ findings, relations: seen?.relations, images, revision: seen?.revision?.scene ?? null }), images: images.length };
	};
}

/** The relation rows a turn's context carries, or null when the editor cannot answer. */
export async function turnRelations(hub, workspaceHandle) {
	try { const seen = await hub.command("inspect_studio", { scope: "relations" }, workspaceHandle); return seen?.relations?.length ? { rows: seen.relations, camera: seen.camera ?? null, characters: seen.characters ?? [] } : null; }
	catch { return null; }
}

const addUp = (a = {}, b = {}) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(k => [k, typeof a[k] === "number" || typeof b[k] === "number" ? (a[k] ?? 0) + (b[k] ?? 0) : b[k] ?? a[k]]));
const addDone = (a, b) => (a ? { ...a, ...b, ...(a.usage || b.usage ? { usage: addUp(a.usage, b.usage) } : {}), ...(a.cost !== undefined || b.cost !== undefined ? { cost: (a.cost ?? 0) + (b.cost ?? 0) } : {}) } : b);

/** start, wrapped: the model's runs and the reviews between them read as one run with one done frame. A failed or stopped run is not reviewed. */
export function reviewedStart({ start, review, signal, now = Date.now }) {
	return async function* (input) {
		let next = input, done = null;
		for (let round = 0; ; round++) {
			const frames = [];
			let failed = false;
			for await (const frame of start(next)) {
				if (frame.type === "done") { done = addDone(done, frame); continue; }
				if (frame.type === "error") failed = true;
				if (frame.type === "tool.start" || frame.type === "tool.done") frames.push(frame);
				yield frame;
			}
			const edits = turnEdits(frames);
			if (failed || signal?.aborted || !edits.edited || round >= MAX_REVIEWS) break;
			const callId = `review-${round + 1}`, started = now();
			yield { type: "tool.start", callId, name: "verify_result", label: "Check the result", args: { review: round + 1 } };
			let result = null;
			try { result = await review(edits); } catch (error) { console.warn(`[agent] review skipped: ${error.message}`); }
			yield { type: "tool.done", callId, ok: Boolean(result), elapsedMs: Math.round(now() - started), ...(result ? { result: { findings: result.findings, images: result.images } } : { error: "The review could not run." }) };
			if (!result || signal?.aborted) break;
			next = { ...input, text: "", attachments: [], frameObservation: undefined, review: result.content };
		}
		if (done) yield done;
	};
}
