import { makeTurnText, referenceArg } from "./sculpt-run-text.js";

const INITIAL_MESSAGE = "Measure the reference landmarks before placing parts.";

const initialState = ({ targetIou, maxRounds }) => ({
	stage: "idle",
	round: 0,
	maxRounds,
	iou: null,
	targetIou,
	elapsedMs: 0,
	sheetDataUrl: null,
	message: null,
	error: null,
	sculptId: null,
	// What the operator watches while a turn is out: a log, what we wait on, the score history.
	activity: [],
	waiting: null,
	history: [],
	candidates: null,
	outline: null,
	changedParts: null,
});

const ACTIVITY_LIMIT = 40;
// How long each wait usually takes, from the live runs in docs/sculpt-from-image.md.
const EXPECTED_WAIT_MS = Object.freeze({ measure: 1500, draft: 60000, refine: 35000, agent: 20000, tool: 3000, score: 1500 });

function toolLabel(action, args = {}, who = "Agent") {
	if (action === "object.sculpt") return args.edits ? `${who} is applying the winning edits` : `${who} is building the recipe`;
	if (action === "sculpt.compare") return Array.isArray(args.candidates) ? `${who} is test-fitting ${args.candidates.length} candidate fixes` : `${who} is scoring the sculpt`;
	if (action === "inspect_studio" || action === "inspect") return `${who} is reading the editor`;
	return `${who} is running ${action}`;
}

// a refusal's first line (bin/agent/refusal.mjs: the facts line after it is the model's)
const shortError = error => String(error ?? "").split("\n")[0].replace(/\s*\(inspect, do not retry\)\s*$/, "").slice(0, 140);

const isAsyncIterable = value => value && typeof value[Symbol.asyncIterator] === "function";
const commandName = event => event?.action ?? event?.command ?? (event?.commandId ? event?.name : undefined) ?? event?.name ?? event?.id;
const commandArgs = event => event?.args ?? event?.arguments ?? event?.request?.args ?? {};
const commandResult = event => event?.result ?? event?.receipt ?? event?.output ?? event?.response ?? event?.value;
const affectedIds = value => Array.isArray(value?.affectedIds) ? value.affectedIds : [];

function dataUrlFromSheet(sheet) {
	if (typeof sheet === "string") return sheet;
	// Raw RGBA is no image a browser can show: only sheetDataUrl (a PNG) is displayed.
	return null;
}

/**
 * Adapt the callback-based Studio client into the small port consumed by the
 * sculpt controller. The controller deliberately owns the session/turn loop.
 */
// The sidecar's Studio envelope requires UUIDs for both the session and the turn.
export function createAgentPort(client, { sessionId = crypto.randomUUID() } = {}) {
	return {
		async *sendTurn({ text, attachments = [], signal, model, effort, turnId = crypto.randomUUID() }) {
			const events = [];
			let wake;
			let ended = false;
			const push = event => { events.push(event); wake?.(); wake = null; };
			const result = client.turn({
				surface: "studio",
				sessionId,
				turnId,
				text,
				...(model ? { model } : {}),
				...(effort ? { effort } : {}),
				...(attachments.length ? { attachments } : {}),
				context: null,
			}, push, signal);
			Promise.resolve(result).then(() => { ended = true; wake?.(); wake = null; }, error => { ended = true; push({ type: "error", message: String(error?.message || error) }); });
			while (!ended || events.length) {
				if (!events.length) await new Promise(resolve => { wake = resolve; });
				while (events.length) yield events.shift();
			}
		},
	};
}

export function createSculptRun({
	bus,
	agent,
	reference,
	sculptId = null,
	targetIou = 0.9,
	maxRounds = 3,
	timeBudgetMs = 180000,
	now = Date.now,
	// Optional ({ id, reference }) -> sculpt.compare result. The harness scores a turn the agent left unscored.
	score = null,
	// Optional (reference) -> measureReferenceOutline result, put into the first turn's text.
	measure = null,
	// The blueprint's cropped views ([{ view, yaw, dataUrl, name? }], #970): attached next to the reference and scored with it.
	views = [],
	// The model every turn runs on (a /agent/models key) and its effort; omitted = the sidecar's defaults.
	// Measured on the Snorlax reference: effort "high" made the draft twice as slow for no better score.
	model = undefined,
	effort = undefined,
	// How the model is named to the operator ("GPT-6 Astra"); the key when unset.
	modelLabel = undefined,
} = {}) {
	if (!agent?.sendTurn) throw new TypeError("sculpt run requires an agent port");
	const who = modelLabel || model || "Agent";
	const listeners = new Set();
	const controller = new AbortController();
	let state = { ...initialState({ targetIou, maxRounds }), model: { key: model ?? null, label: who, effort: effort ?? null } };
	let running = false;
	let settled = false;
	let startedAt = 0;
	let turnSculpted = false;
	let turnScored = false;
	let lastReport = null;
	// A score repeated with no edit in between says nothing new: keep its sheet, skip the log line.
	let editedSinceScore = true;
	let retryCount = 0;
	let turnPromise = null;

	const elapsed = () => Math.max(0, now() - startedAt);
	const publish = patch => {
		state = { ...state, ...patch, elapsedMs: elapsed() };
		// An observer must never stop the run it watches.
		for (const listener of [...listeners]) {
			try { listener(state); } catch (error) { console.error("sculpt run listener failed", error); }
		}
	};
	let activitySeq = 0;
	const entry = (kind, text) => ({ id: ++activitySeq, atMs: elapsed(), kind, text });
	// One line in the activity log, with whatever else changes at the same moment.
	const note = (kind, text, patch = {}) => publish({ ...patch, activity: [...state.activity, entry(kind, text)].slice(-ACTIVITY_LIMIT) });
	const waitFor = (what, label) => ({ what, label, since: now(), expectMs: EXPECTED_WAIT_MS[what] ?? null });
	const toolCalls = new Map();
	// The turn's own wait ("writing the recipe", since the turn went out): a tool call interrupts it, never resets it.
	let turnWait = null;
	// The turns this run sent: only their commands are the run's. Another turn,
	// MCP or a UI edit on any sculpt is never claimed.
	const ownTurns = new Set();
	const onBus = event => { if (!controller.signal.aborted && ownTurns.has(event?.turnId)) onCommand(event); };
	const onCommand = event => {
		const name = commandName(event);
		const args = commandArgs(event);
		const result = commandResult(event);
		const ids = affectedIds(result);
		if (name === "object.sculpt" || event?.type === "object.sculpt") {
			const id = args.id ?? ids[0] ?? event?.sculptId ?? state.sculptId;
			if (id) {
				turnSculpted = true;
				turnScored = false; // a score taken before this edit no longer describes the sculpt
				editedSinceScore = true;
				const stage = state.round > 1 ? "refine" : "draft";
				const edits = Array.isArray(args.edits) ? args.edits : null;
				const ids = edits ? [...new Set(edits.map(edit => edit?.set ?? edit?.add?.id ?? edit?.remove).filter(Boolean))] : "all";
				const parts = /(\d+) parts/.exec(String(result?.summary ?? ""))?.[1];
				const text = edits ? `Applied ${edits.length} edit${edits.length === 1 ? "" : "s"}${ids.length ? ` to ${ids.slice(0, 4).join(", ")}${ids.length > 4 ? "…" : ""}` : ""}` : `Draft on the turntable${parts ? `: ${parts} parts` : ""}`;
				note("ok", text, { sculptId: id, round: Math.max(1, state.round), stage, message: edits ? "Edits applied." : "Draft sculpt applied.", changedParts: { ids, nonce: activitySeq + 1 } });
			}
			return;
		}
		if (name !== "sculpt.compare" && event?.type !== "sculpt.compare") return;
		const report = result?.report ?? event?.report;
		if (result && Number.isFinite(Number(result.report?.iou ?? result.iou))) lastReport = result.report ?? result;
		const iou = Number(report?.iou ?? result?.iou ?? event?.iou);
		const sheet = result?.sheetDataUrl ?? event?.sheetDataUrl ?? dataUrlFromSheet(result?.sheet);
		const ranking = Array.isArray(result?.ranking) ? result.ranking : null;
		if (ranking) {
			// A candidate ranking scores the sculpt as it stands; the edit that follows is what counts.
			const best = ranking.find(row => !row.refused);
			note("score", best ? `Ranked ${ranking.length} candidate fixes: "${best.label}" leads${Number.isFinite(best.delta) ? ` (${best.delta >= 0 ? "+" : ""}${best.delta.toFixed(3)})` : ""}` : `Ranked ${ranking.length} candidate fixes`, {
				candidates: ranking.map(row => ({ label: row.label, iou: Number.isFinite(row.iou) ? row.iou : null, delta: Number.isFinite(row.delta) ? row.delta : null, refused: Boolean(row.refused) })),
				...(sheet ? { sheetDataUrl: sheet } : {}),
			});
			return;
		}
		if (Number.isFinite(iou)) turnScored = true;
		if (Number.isFinite(iou) && !editedSinceScore && iou === state.iou) {
			publish({ stage: "score", ...(sheet ? { sheetDataUrl: sheet } : {}) });
			return;
		}
		if (Number.isFinite(iou)) editedSinceScore = false;
		const previous = state.history.at(-1)?.iou;
		const delta = Number.isFinite(iou) && Number.isFinite(previous) ? iou - previous : null;
		note("score", Number.isFinite(iou) ? `Scored IoU ${iou.toFixed(3)}${delta !== null ? ` (${delta >= 0 ? "+" : ""}${delta.toFixed(3)})` : ""}` : "Scored the sculpt", {
			stage: "score",
			...(Number.isFinite(iou) ? { iou, history: [...state.history, { round: state.round, iou, atMs: elapsed() }] } : {}),
			...(sheet ? { sheetDataUrl: sheet } : {}),
			message: Number.isFinite(iou) ? `Sculpt comparison scored IoU ${iou}.` : "Sculpt comparison complete.",
		});
	};
	const unsubscribeBus = bus?.subscribe?.(onBus) ?? (() => {});

	const consumeTurn = async text => {
		turnSculpted = false;
		turnScored = false;
		const events = [];
		let turnError = null;
		const callback = event => {
			events.push(event);
			if (event?.type === "text.delta") publish({ message: `${state.message ?? ""}${event.text ?? ""}` });
			if (event?.type === "tool.start") {
				const action = event.args?.action ?? event.name;
				toolCalls.set(event.callId, action);
				publish({ waiting: waitFor("tool", toolLabel(action, event.args?.args ?? {}, who)) });
			}
			if (event?.type === "tool.done") {
				const action = toolCalls.get(event.callId);
				toolCalls.delete(event.callId);
				// Successes reach the log through the editor's receipts; a refusal only shows up here.
				const patch = { waiting: turnWait ?? waitFor("agent", `${who} is deciding the next step`) };
				if (event.ok === false) note("warn", `${action === "object.sculpt" ? "Recipe refused" : `${action ?? "A tool"} failed`}: ${shortError(event.error)}. The agent is fixing it.`, patch);
				else publish(patch);
			}
			// A refused or failed turn is the run's failure, not a turn that forgot to sculpt.
			if (event?.type === "error") turnError ??= new Error(event.message || event.code || "The agent turn failed.");
		};
		const turnId = crypto.randomUUID();
		ownTurns.add(turnId);
		const attachments = [...(reference?.dataUrl ? [{ dataUrl: reference.dataUrl, name: reference.name }] : []), ...views.map(view => ({ dataUrl: view.dataUrl, name: view.name ?? `blueprint-${view.view}.png` }))];
		const returned = agent.sendTurn({ turnId, text, attachments, signal: controller.signal, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }, callback);
		if (isAsyncIterable(returned)) {
			for await (const event of returned) callback(event);
		} else await returned;
		if (turnError) throw turnError;
		// The agent's own closing words, first line only: what it did or what the image hides.
		const said = events.filter(event => event?.type === "text.delta").map(event => event.text ?? "").join("").replace(/[*_`#]/g, "").split(/\n+/).map(line => line.trim()).find(Boolean);
		if (said) note("agent", `${who}: ${said.length > 160 ? `${said.slice(0, 157)}…` : said}`);
	};

	const loop = async () => {
		startedAt = now();
		note("step", "Measuring the reference outline", { stage: "measure", round: 0, message: INITIAL_MESSAGE, error: null, waiting: waitFor("measure", "Measuring the reference outline") });
		let outline = null;
		if (measure) {
			try {
				outline = await measure(referenceArg(reference));
				const split = outline?.rows?.filter(row => row.spans.length > 1).length ?? 0;
				note("ok", `Outline measured: width:height ${outline.widthToHeight}, ${outline.rows.length} slices${split ? `, ${split} with separate limbs` : ""}`, { outline });
			} catch (error) { note("warn", `Could not measure the reference: ${shortError(error?.message || error)}`, { message: `Could not measure the reference: ${String(error?.message || error)}` }); }
		}
		if (controller.signal.aborted) { note("warn", "Cancelled", { stage: "cancelled", message: "Sculpt run cancelled.", waiting: null }); settled = true; return; }
		if (views.length) note("ok", `Using the blueprint's ${views.map(view => view.view).join(" and ")} view${views.length > 1 ? "s" : ""} next to the reference`);
		let text = makeTurnText(reference, sculptId, false, outline, views);
		while (!controller.signal.aborted) {
			if (elapsed() >= timeBudgetMs) break;
			const roundBefore = state.round;
			turnWait = roundBefore === 0 ? waitFor("draft", `${who} is writing the recipe`) : waitFor("refine", `${who} is weighing fixes`);
			// Measuring is over once the first turn goes out: the stepper moves on to Draft.
			note("agent", roundBefore === 0 ? `Asked ${who}${effort ? ` (effort ${effort})` : ""} for a first draft` : `Round ${state.round}: asked ${who} for 3-6 candidate fixes`, {
				waiting: turnWait, ...(roundBefore === 0 ? { stage: "draft" } : {}),
			});
			turnPromise = consumeTurn(text);
			try { await turnPromise; } catch (error) {
				if (controller.signal.aborted) break;
				note("error", `Run failed: ${shortError(error?.message || error)}`, { stage: "failed", error: String(error?.message || error), message: "Sculpt run failed.", waiting: null });
				settled = true;
				return;
			} finally { turnPromise = null; }
			if (controller.signal.aborted) break;
			if (!turnSculpted) {
				if (retryCount === 0) {
					retryCount += 1;
					note("warn", "The agent ended without sculpting; asking again", { stage: roundBefore > 0 ? "refine" : "measure", message: "No object.sculpt command arrived; retrying with a firm reminder." });
					text = `${text} Firm reminder: you must execute object.sculpt before ending this turn, then call sculpt.compare.`;
					continue;
				}
				note("error", "No sculpt after one retry", { stage: "failed", error: "The turn ended without an object.sculpt command.", message: "No sculpt was applied after one retry.", waiting: null });
				settled = true;
				return;
			}
			retryCount = 0;
			if (!turnScored && score && state.sculptId) {
				const args = views.length ? { id: state.sculptId, views: [{ yaw: 0, reference: referenceArg(reference) }, ...views.map(view => ({ yaw: view.yaw, reference: { dataUrl: view.dataUrl } }))] } : { id: state.sculptId, reference: referenceArg(reference) };
				publish({ waiting: waitFor("score", "Scoring the silhouette against the reference") });
				try {
					const value = await score(args);
					onCommand({ action: "sculpt.compare", args, result: value?.output ?? value });
				} catch (error) {
					note("warn", `Scoring failed: ${shortError(error?.message || error)}`, { message: `Scoring failed: ${String(error?.message || error)}` });
				}
				if (controller.signal.aborted) break;
			}
			if (state.iou !== null && state.iou >= targetIou) break;
			if (state.round >= maxRounds || elapsed() >= timeBudgetMs) break;
			const nextRound = Math.max(1, state.round + 1);
			publish({ stage: "refine", round: nextRound, message: `Preparing refinement round ${nextRound} of ${maxRounds}.` });
			// The next turn's note says what was asked; nothing to log in between.
			text = makeTurnText(reference, state.sculptId, { round: nextRound, maxRounds, iou: state.iou, report: lastReport }, null, views);
		}
		if (controller.signal.aborted) {
			note("warn", "Cancelled", { stage: "cancelled", message: "Sculpt run cancelled.", waiting: null });
		} else {
			const reached = state.iou !== null && state.iou >= targetIou;
			note(reached ? "done" : "ok", state.iou === null ? "Finished without a score" : `${reached ? "Target reached" : "Finished"} at IoU ${state.iou.toFixed(3)}`, { stage: "done", message: state.iou === null ? "Sculpt run finished without a score." : `Sculpt run finished at IoU ${state.iou}.`, waiting: null });
		}
		settled = true;
	};
	// A finished run stops listening to the bus, whichever way it ended.
	const run = async () => {
		try { await loop(); } finally { unsubscribeBus(); }
	};

	return {
		start() {
			if (running) return turnPromise ?? Promise.resolve();
			running = true;
			return run();
		},
		cancel() {
			if (settled) return;
			controller.abort("sculpt-run-cancelled");
			if (!running) { unsubscribeBus(); note("warn", "Cancelled", { stage: "cancelled", message: "Sculpt run cancelled.", waiting: null }); }
		},
		getState: () => state,
		subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
	};
}
