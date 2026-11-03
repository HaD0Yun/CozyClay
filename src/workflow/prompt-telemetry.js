// agent:prompt_sent: one per prompt the user sends to the agent, so retry loops and
// hesitation are measurable. Only numbers and closed values computed on the device
// leave: a length bucket and a similarity grade against the previous prompt. The
// text is never stored or sent; the previous prompt is kept only as its set of
// lowercase words (to grade the next one) and is dropped on pagehide.
//
// AgentPanel stages a prompt as it sends (stagePrompt); the turn's telemetry takes
// it when the turn really starts (takePrompt, agent-turn-telemetry.js), so a send the
// store refuses (empty, already streaming) never becomes an event.
import { CONNECT_PROVIDERS, bucketLong } from "../analytics-strict.js";
import { bucketFrictionCount } from "../analytics-friction.js";

const VIA = new Set(["typed", "retry_button", "regenerate", "chip", "supervisor"]);
const STAGED_MS = 10_000;

let now = () => Date.now();
let previousTokens = null, lastTurn = null, turns = 0, draftStartedAt = null, fromChip = false, staged = null;
if (typeof globalThis.addEventListener === "function") globalThis.addEventListener("pagehide", () => { previousTokens = null; staged = null; });

/** The prompt's words: lowercased, split on anything that is not a letter or digit. No stemming, no dictionary. */
export function promptTokens(text) {
	return new Set(String(text ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

/** Jaccard of two word sets: >= 0.9 same, >= 0.5 near, else different; first without a previous prompt. */
export function similarityGrade(previous, next) {
	if (!previous) return "first";
	let shared = 0;
	for (const token of next) if (previous.has(token)) shared += 1;
	const union = previous.size + next.size - shared;
	const jaccard = union === 0 ? 1 : shared / union;
	return jaccard >= 0.9 ? "same" : jaccard >= 0.5 ? "near" : "different";
}

/** 1-20, 21-80, 81-240, gte241 characters. */
export function bucketPromptLength(n) {
	if (n <= 20) return "1-20";
	if (n <= 80) return "21-80";
	if (n <= 240) return "81-240";
	return "gte241";
}

/** A keystroke (or paste) into the draft: composing starts now if it had not; a chip's text was edited. */
export function noteDraftInput() {
	if (draftStartedAt === null) draftStartedAt = now();
	fromChip = false;
}

/** The draft was consumed without a new turn (an accepted steering message): composing starts over. */
export function noteDraftConsumed() {
	draftStartedAt = null;
	fromChip = false;
}

/** A suggestion chip filled the draft. */
export function noteChipDraft() {
	if (draftStartedAt === null) draftStartedAt = now();
	fromChip = true;
}

// An OpenAI-compatible server's address class from the model list (bin/agent/openai-compatible-provider.mjs endpointClass).
const ENDPOINTS = new Set(["local", "lan", "hosted", "unknown"]);

/** The panel is sending `text`: keep only what the event needs, never the text. `endpoint`: the address class of an
 * openai-compatible model's server, sent only for that provider (#1043). */
export function stagePrompt(text, { via = "typed", model = "", endpoint, attached = false, taskMode = false } = {}) {
	try {
		const trimmed = String(text ?? "").trim();
		if (!trimmed) return;
		const how = via === "typed" && fromChip ? "chip" : VIA.has(via) ? via : "typed";
		const provider = String(model ?? "").split("/")[0];
		const composing = (how === "typed" || how === "chip") && draftStartedAt !== null;
		staged = { at: now(), tokens: promptTokens(trimmed), props: {
			provider: CONNECT_PROVIDERS.includes(provider) ? provider : "other", via: how, prompt_len: bucketPromptLength(trimmed.length),
			...(composing ? { compose_ms: bucketLong(now() - draftStartedAt) } : {}), attached: Boolean(attached), task_mode: Boolean(taskMode),
			...(provider === "openai-compatible" ? { endpoint: ENDPOINTS.has(endpoint) ? endpoint : "unknown" } : {}),
		} };
	} catch {
		staged = null;
	}
}

/** The turn started: the staged prompt as agent:prompt_sent's payload for `turnId`, or null. */
export function takePrompt(turnId) {
	const prompt = staged;
	staged = null;
	if (!prompt || !turnId || now() - prompt.at > STAGED_MS) return null;
	turns += 1;
	const props = {
		turn_id: turnId, ...prompt.props, similarity: similarityGrade(previousTokens, prompt.tokens),
		gap: lastTurn ? bucketLong(now() - lastTurn.at) : "first", prev_outcome: lastTurn?.outcome ?? "none", turn_index: bucketFrictionCount(turns),
	};
	previousTokens = prompt.tokens;
	draftStartedAt = null;
	fromChip = false;
	return props;
}

/** A turn ended (agent-turn-telemetry.js): the next prompt's gap and prev_outcome. */
export function notePromptTurnEnded(outcome) {
	lastTurn = { outcome: ["succeeded", "failed", "cancelled"].includes(outcome) ? outcome : "none", at: now() };
}

/** Tests only: drive the clock and start a clean session; returns the restore. */
export function promptTelemetrySeam(clock = () => Date.now()) {
	const previous = now;
	const reset = () => { previousTokens = null; lastTurn = null; turns = 0; draftStartedAt = null; fromChip = false; staged = null; };
	now = clock; reset();
	return () => { now = previous; reset(); };
}
