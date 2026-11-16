// The verify -> repair loop of a Studio turn (#1030). verify_result ran only when the model chose to, and images came only when it
// asked, so a model could stop on a scene it never looked at. Now when a run edits the scene and the model stops, the editor measures
// what changed; failed checks go to the model as its next message (a stage change also gets the shot frame): it repairs, or says why not.
// Repeats after a repair, at most MAX_REVIEWS times a turn. BlenderGym (CVPR 2025): compute spent on verification is what moves 3D editing.
import { layerOf } from "../../src/bus-task-scopes.js";
import { findingItems, findingLines, itemKey } from "./review-findings.mjs";

const MAX_REVIEWS = 3;
const MAX_TARGETS = 32, LOOK_KIND = /"kind":"(?:point-light|spot-light|effect)"/;
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
			// a nested call's receipt names its action; the outer script's arguments do not
			const action = call.action ?? (call === result ? args?.action : null) ?? "";
			if (/^motion\./.test(action)) for (const id of call === result && args?.args?.characterId ? [args.args.characterId] : call.affectedIds ?? []) motionIds.add(id);
			// the look no check measures: the stage, and lights, glows and effects that are objects (#1064 review)
			if (/^(stage|light)|^object\.(light|glow|effect)\b/.test(action) || LOOK_KIND.test(JSON.stringify(call === result ? args ?? {} : call.args ?? {}))) stage = true;
		}
	}
	return { edited, ids: [...ids].slice(0, MAX_TARGETS), motionIds: [...motionIds], stage };
}

/** Failing numbers out of what the editor measured, one line per distinct finding (review-findings.mjs). Nothing that passed is listed. */
export function reviewFindings(measured = {}) { return findingLines(findingItems(measured)); }

/** The verify_result answers the model got in this run, from its frames: what it was already told, by scene revision. */
function ownChecks(frames) {
	const verify = new Set(frames.filter(f => f?.type === "tool.start" && f.name === "verify_result" && !f.review).map(f => f.callId));
	return frames.filter(f => f?.type === "tool.done" && f.ok === true && verify.has(f.callId) && Number.isSafeInteger(f.result?.revision)).map(f => f.result);
}

const imagePart = captured => { const m = /^data:([^;]+);base64,(.*)$/.exec(captured?.dataUrl ?? ""); return m ? { type: "image", data: m[2], mimeType: m[1] } : null; };

/** The next user message of the turn. Its label is OBSERVATION_LABEL's (session-store.mjs): a transcript does not show it as the user's words. */
// request (#1058): the user's message this turn answers. Without it a passed check sent the model back to an earlier,
// unfinished request (an undo of the lighting re-added a character and reframed the shot: 7 more minutes of a locked panel).
export function reviewContent({ findings, relations = [], images = [], revision = null, request = "" }) {
	const asks = findings.length
		? `These checks failed:\n${findings.map(line => `- ${line}`).join("\n")}\nRepair what belongs to this request and stop when they pass. If one should stay or you cannot fix it, say why in one line.`
		: `The checks that ran passed. Look at the picture: if the light and look do not show what ${request ? "this request" : "was"} asked, fix it${request ? "; an earlier request is not this turn's to finish" : ""}. If they do, do not repeat your answer; finish in one short line.`;
	const asked = request ? `\nThis turn's request: ${JSON.stringify(request.length > 300 ? `${request.slice(0, 299)}…` : request)}` : "";
	return [{ type: "text", text: `Studio frame observation after your edits, scene revision ${JSON.stringify(revision)}${images.length ? ": the shot camera" : ""}.${asked}\n${asks}${relations.length ? `\nRelations:\n${relations.join("\n")}` : ""}` }, ...images];
}

/**
 * Measures one run's edits through the turn's own tools. A check that cannot run is left out: the review never fails a turn.
 * scope (a task's run): only the characters and objects its scope keys name, plus the ids the run edited, are checked. A
 * finding about another task's character asked the task to repair what it may not touch (SCOPE_DENIED) and stalled it.
 */
export function createTurnReview({ invoke, hub, workspaceHandle, resolveImage, scope = null }) {
	const quiet = async work => { try { return await work(); } catch (error) { console.warn(`[agent] review check skipped: ${error.message}`); return null; } };
	// told: keys (review-findings.mjs itemKey) an earlier review of this turn sent; own: the model's own verify_result answers.
	return async (edits, request = "", { told = new Set(), own = [] } = {}) => {
		const seen = await quiet(() => hub.command("inspect_studio", { scope: "relations" }, workspaceHandle));
		const owned = scope ? new Set([...scope.map(key => layerOf(key)?.id ?? (key.startsWith("object:") ? key.slice(7) : null)).filter(Boolean), ...edits.ids, ...edits.motionIds]) : null;
		const characters = (seen?.characters ?? []).map(c => c.id).filter(id => !owned || owned.has(id)), verify = args => quiet(() => invoke("verify_result", args));
		// A receipt also names shots and camera keys; verify_result refuses a target that is not an object or a character.
		const known = seen?.entityIds ? new Set(seen.entityIds) : null, edited = known ? edits.ids.filter(id => known.has(id)) : edits.ids;
		const placement = edited.length ? await verify({ targets: edited, checks: ["placement"] }) : null;
		const framing = characters.length && seen?.camera ? await verify({ targets: characters.slice(0, MAX_TARGETS), checks: ["framing"], range: "whole_clip" }) : null;
		const lighting = edits.stage && characters.length ? await verify({ targets: characters.slice(0, MAX_TARGETS), checks: ["lighting"] }) : null;
		const motion = [];
		for (const id of edits.motionIds) { const r = await quiet(() => invoke("run_action", { action: "motion.qa", args: { characterId: id } })); if (r?.output?.qa) motion.push({ id, qa: r.output.qa }); }
		// Not told twice: what an earlier round sent, and what the model's own check of this very scene revision answered.
		const revision = seen?.revision?.scene ?? null, items = findingItems({ placement, framing, motion, lighting, owned });
		const answered = new Set(own.filter(r => revision !== null && r.revision === revision).flatMap(r => findingItems({ placement: r, framing: r, owned }).map(itemKey)));
		const fresh = items.filter(item => !told.has(itemKey(item)) && !answered.has(itemKey(item))), findings = findingLines(fresh);
		const left = findingLines(items.filter(item => told.has(itemKey(item)))), keys = fresh.map(itemKey);
		// #1058: passed checks end the review with no model call (box QA: 5 of 7 such rounds only said "looks fine", one redid an
		// earlier request). A stage change is the look no check measures, so it alone gets the shot picture; the top view never
		// led to a repair (0 of 12 rounds) and is not sent. Failures the model already has end it too: nothing new to say.
		if (!findings.length && (items.length || !edits.stage)) return seen ? { findings, keys, left, content: null, images: 0 } : null;
		// Through verify_result, so the agent panel's progress card shows the user what the model looked at; a bare capture where it has no target.
		const targets = (edited.length ? edited : characters).slice(0, MAX_TARGETS), images = [];
		for (const [visual, capture] of findings.length ? [] : [["frame", "capture_framing_png"]]) {
			const seenBy = targets.length && resolveImage ? await verify({ targets, checks: ["placement"], visual }) : null, ref = seenBy?.visualRefs?.[0];
			const shown = ref?.imageId ? await quiet(() => resolveImage(ref.imageId, { receiptId: seenBy.receiptId, revision: seenBy.revision })) : null;
			const part = imagePart(shown) ?? imagePart(await quiet(() => hub.command(capture, {}, workspaceHandle)));
			if (part) images.push(part);
		}
		if (!seen && !images.length) return null; // the editor went away: nothing to show the model
		// a task's request is its scope and brief (taskHeader); the main turn's is the user's message
		return { findings, keys, left, content: reviewContent({ findings, relations: seen?.relations, images, revision, request: scope ? "" : String(request ?? "") }), images: images.length };
	};
}

/** The relation rows a turn's context carries, or null when the editor cannot answer. */
export async function turnRelations(hub, workspaceHandle) {
	try { const seen = await hub.command("inspect_studio", { scope: "relations" }, workspaceHandle); return seen?.relations?.length ? { rows: seen.relations, camera: seen.camera ?? null, characters: seen.characters ?? [] } : null; }
	catch { return null; }
}

const addUp = (a = {}, b = {}) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(k => [k, typeof a[k] === "number" || typeof b[k] === "number" ? (a[k] ?? 0) + (b[k] ?? 0) : b[k] ?? a[k]]));
const addDone = (a, b) => (a ? { ...a, ...b, ...(a.usage || b.usage ? { usage: addUp(a.usage, b.usage) } : {}), ...(a.cost !== undefined || b.cost !== undefined ? { cost: (a.cost ?? 0) + (b.cost ?? 0) } : {}) } : b);

const ENDED_TASK = new Set(["done", "incomplete", "failed", "cancelled"]);
/** The edits of a finished request in Tasks mode, once no task of the board is still to run: { edited, ids, motionIds, stage } for one
 * review of the whole scene, else null. board: the task views (studio-tasks.mjs board()); pending: a Set of the scope keys and ids the
 * ended tasks and the coordinator changed, emptied when handed over. A cup is "floating" until the table task lands and a body
 * "overlaps" a stand-in a dress task is about to replace: a half-built scene is not judged. */
export function settledEdits(board, pending) {
	if (!pending?.size || board.some(task => !ENDED_TASK.has(task.status))) return null;
	const keys = [...pending], idOf = key => layerOf(key)?.id ?? key.replace(/^(object|character):/, "");
	pending.clear();
	return { edited: true, ids: [...new Set(keys.map(idOf))].slice(0, MAX_TARGETS), motionIds: [...new Set(keys.filter(key => key.startsWith("character:")).map(idOf))], stage: false };
}
const settledNote = findings => `\n<scene-review>The tasks of this request are all done. Checks on the finished scene failed:\n${findings.map(line => `- ${line}`).join("\n")}\nDispatch one repair task for what a task can fix, or tell the user plainly what stays as it is.</scene-review>`;

/**
 * start, wrapped: the model's runs and the reviews between them read as one run with one done frame. A failed or stopped run is not reviewed.
 * A plain turn: the review runs when the model stops after editing, and again after each repair, at most MAX_REVIEWS times; a review that
 * finds nothing it has not sent before (the repair made no progress, or the model chose to keep them) ends the loop and tells the user
 * what is left (rule 7). A failure the model's own verify_result already answered for the same scene revision is not sent either.
 * settled (the coordinator's turn in Tasks mode): { take() -> settledEdits(...) or null, note(ids) }. The finished request is reviewed
 * once before the coordinator answers and its failures ride in the coordinator's context; the coordinator's own edits join the pending
 * ones and are reviewed only when no task is still running.
 */
const stillFailing = lines => ({ type: "text.delta", text: `\n\nStill failing after a repair, left as it is:\n${lines.map(line => `- ${line}`).join("\n")}` });
export function reviewedStart({ start, review, signal, now = Date.now, settled = null }) {
	return async function* (input) {
		let next = input, done = null, last = null;
		const said = new Set(), own = []; // the findings the reviews sent, the model's own verify_result answers
		const finished = settled?.take();
		if (finished) {
			const started = now();
			yield { type: "tool.start", callId: "review-0", name: "verify_result", label: "Check the finished scene", args: { review: 0 }, review: true };
			let result = null;
			try { result = await review(finished, ""); } catch (error) { console.warn(`[agent] review skipped: ${error.message}`); }
			yield { type: "tool.done", callId: "review-0", ok: Boolean(result), elapsedMs: Math.round(now() - started), ...(result ? { result: { findings: result.findings, images: 0 } } : { error: "The review could not run." }) };
			if (result?.findings?.length) next = { ...input, contextText: `${input.contextText ?? ""}${settledNote(result.findings)}` };
		}
		for (let round = 0; ; round++) {
			const frames = [];
			let failed = false;
			for await (const frame of start(next)) {
				if (frame.type === "done") { done = addDone(done, frame); continue; }
				if (frame.type === "error") failed = true;
				if (frame.type === "tool.start" || frame.type === "tool.done") frames.push(frame);
				yield frame;
			}
			let edits = turnEdits(frames);
			own.push(...ownChecks(frames));
			if (failed || signal?.aborted || !edits.edited || round >= MAX_REVIEWS) break;
			if (settled) { settled.note(edits.ids); edits = settled.take(); if (!edits) break; }
			const callId = `review-${round + 1}`, started = now();
			// review: true: not the model's own call, so what it wrote before stays its reply (a task's summary, the main agent's claim check)
			yield { type: "tool.start", callId, name: "verify_result", label: "Check the result", args: { review: round + 1 }, review: true };
			let result = null;
			// a stop (the main turn's no-progress guard among them) ends a review that waits on an editor that never answers
			try { result = await Promise.race([review(edits, input.text, { told: said, own }), new Promise(resolve => signal?.addEventListener("abort", () => resolve(null), { once: true }))]); } catch (error) { console.warn(`[agent] review skipped: ${error.message}`); }
			yield { type: "tool.done", callId, ok: Boolean(result), elapsedMs: Math.round(now() - started), ...(result ? { result: { findings: result.findings, images: result.images } } : { error: "The review could not run." }) };
			if (signal?.aborted) break;
			// nothing new: what still fails was sent before and the model answered it; the user hears what stays (rule 7)
			if (!result?.content) { if (result?.left?.length) yield stillFailing(result.left); break; }
			const key = JSON.stringify(result.findings);
			if (result.findings.length && key === last) { yield stillFailing(result.findings); break; }
			last = key;
			for (const told of result.keys ?? []) said.add(told);
			next = { ...input, text: "", attachments: [], frameObservation: undefined, review: result.content };
		}
		if (done) yield done;
	};
}
