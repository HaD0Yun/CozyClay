// Export → AI video reference: the agent that blocked the scene writes what happens in each shot, with the second
// each beat starts, for the video prompt (POST /agent/beats). A video model reads the reference only as a blurred
// copy, so the beats in words are what holds the action and its order; in a test (2026-11-28) the timed beats were
// the one change that kept two jumps in order and a bend-over in place.
//
// The model gets three things and is told what each is for:
//   - the conversation that built the scene: what the user wanted (who chases whom, what they feel)
//   - the scene's own measurements per shot: its seconds, camera, and who is in frame where and when
//   - pictures of the shot camera every half second or so, each labelled with its second
// It writes the beats from the pictures; the conversation only names people, intent and feeling, and a beat the
// pictures do not show is left out, because the conversation can be older than the scene.

export const BEATS_LIMITS = Object.freeze({ transcriptChars: 14_000, messageChars: 1_500, frames: 30, timeoutMs: 180_000, actionChars: 1400 });

export const BEATS_SYSTEM_PROMPT = [
	"You write the action lines of a video-generation prompt for a previs scene made in CozyClay Studio.",
	"A video model will get a blurred, blocky copy of this previs as a reference, plus your lines. It cannot read actions from the blur, so your lines carry what each person does and when.",
	"",
	"Inputs:",
	"- CONVERSATION: how the user and the Studio agent built the scene. Use it for who the people are, what they want and feel. It can be older than the scene: never write a beat from it that the pictures do not show.",
	"- SHOTS: each shot's seconds on the film clock, its camera, and measured screen facts (who is in frame, where, when they enter or leave).",
	"- PICTURES: the shot camera at the labelled second (film clock). The figures are grey or coloured mannequins standing in for real people; the set is grey blocks standing in for a real place.",
	"",
	"For each shot write one paragraph of plain English, at most about 25 words per second of the shot:",
	"- every visible action of every person, in time order, each starting with the second it starts on the film clock: \"At 3.5 s Mira climbs onto the parapet\". Read the second from the picture labels; when a beat falls between two pictures, give the earlier label or the midpoint.",
	"- name people by the first name in each CAST entry (the part before the first comma); describe their body (stops, grips, bends over, looks back) and, in a few words, the feeling the user asked for or that the body plainly shows.",
	"- what a person does at the end of the shot too, if it differs from before (\"until 10 s Jin still grips the parapet\").",
	"- no camera, lens, framing or cut words; the prompt already has them. No mannequin, previs, grey or block words. No beat the pictures do not show.",
	"",
	"Answer with JSON only: {\"shots\":[{\"index\":1,\"action\":\"...\"}]} with one entry per shot, index as given.",
].join("\n");

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}\u2026` : text);
const seconds = (value) => (Math.round(value * 10) / 10).toString();

/** The user and agent words of a session transcript (transcriptFromHistory), newest kept when it is long. */
export function conversationText(transcript = [], limit = BEATS_LIMITS.transcriptChars) {
	const lines = [];
	for (const entry of transcript) {
		const text = typeof entry?.text === "string" ? entry.text.trim() : "";
		if (!text) continue;
		if (entry.kind === "user") lines.push(`USER: ${clip(text, BEATS_LIMITS.messageChars)}`);
		else if (entry.kind === "assistant" || entry.kind === "message") lines.push(`AGENT: ${clip(text, BEATS_LIMITS.messageChars)}`);
	}
	const kept = [];
	let size = 0;
	for (let index = lines.length - 1; index >= 0 && size + lines[index].length < limit; index -= 1) {
		kept.unshift(lines[index]);
		size += lines[index].length + 1;
	}
	return kept.join("\n");
}

const imagePart = (dataUrl) => {
	const match = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(String(dataUrl ?? ""));
	return match ? { type: "image", data: match[2], mimeType: match[1] } : null;
};

/**
 * The user message: conversation, shot facts, then each picture after its label.
 * @param {{ transcript?: object[], cast?: string[], setting?: string, shots: Array<{ index: number, startS: number, endS: number, camera?: string, inFrame?: string }>, frames: Array<{ atS: number, shotIndex: number, dataUrl: string }> }} input
 */
export function buildBeatsInput({ transcript = [], cast = [], setting = "", shots = [], frames = [] }) {
	const talk = conversationText(transcript);
	const head = [
		`CAST: ${cast.length ? cast.join("; ") : "(unnamed)"}`,
		...(setting.trim() ? [`PLACE: ${setting.trim()}`] : []),
		"",
		"CONVERSATION:",
		talk || "(none: the scene was made without the agent; write from the pictures alone)",
		"",
		"SHOTS:",
		...shots.map((shot) => `Shot ${shot.index} (${seconds(shot.startS)}-${seconds(shot.endS)} s)${shot.camera ? `, camera: ${shot.camera}` : ""}.${shot.inFrame ? ` Measured: ${shot.inFrame}` : ""}`),
		"",
		"PICTURES (film clock):",
	].join("\n");
	const content = [{ type: "text", text: head }];
	for (const frame of frames.slice(0, BEATS_LIMITS.frames)) {
		const image = imagePart(frame.dataUrl);
		if (!image) continue;
		content.push({ type: "text", text: `Shot ${frame.shotIndex} at ${seconds(frame.atS)} s:` }, image);
	}
	return content;
}

/** The model's answer as one action per shot index, or null when it is not the JSON asked for. */
export function parseBeats(text, shotCount) {
	const body = String(text ?? "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
	const start = body.indexOf("{"), end = body.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	let value;
	try { value = JSON.parse(body.slice(start, end + 1)); } catch { return null; }
	if (!Array.isArray(value?.shots)) return null;
	const actions = Array.from({ length: shotCount }, () => "");
	for (const entry of value.shots) {
		const index = Number(entry?.index);
		if (!Number.isInteger(index) || index < 1 || index > shotCount || typeof entry.action !== "string") continue;
		actions[index - 1] = clip(entry.action.replace(/\s+/g, " ").trim(), BEATS_LIMITS.actionChars);
	}
	return actions.some(Boolean) ? actions : null;
}

/** One model call: { actions: string[] } or { error }. */
export async function writeShotBeats({ registry, modelKey, effort = "medium", transcript, cast, setting, shots, frames, timeoutMs = BEATS_LIMITS.timeoutMs }) {
	const { resolveModel, resolveEffort } = await import("./providers.mjs");
	const slash = modelKey.indexOf("/");
	const provider = slash === -1 ? "openai-codex" : modelKey.slice(0, slash);
	const model = registry.getModel(provider, slash === -1 ? modelKey : modelKey.slice(slash + 1)) ?? (await resolveModel(modelKey, { models: registry })).model;
	const level = await resolveEffort(model, effort);
	const message = await registry.completeSimple(model, {
		systemPrompt: BEATS_SYSTEM_PROMPT,
		messages: [{ role: "user", content: buildBeatsInput({ transcript, cast, setting, shots, frames }), timestamp: Date.now() }],
	}, { ...(level && level !== "off" ? { reasoning: level } : {}), signal: AbortSignal.timeout(timeoutMs) });
	if (message?.stopReason === "error" || message?.stopReason === "aborted") return { error: message.errorMessage || `the model request ${message.stopReason === "aborted" ? "timed out" : "failed"}` };
	const text = (Array.isArray(message?.content) ? message.content : []).filter((part) => part?.type === "text").map((part) => part.text).join("");
	const actions = parseBeats(text, shots.length);
	return actions ? { actions, model: modelKey } : { error: "the model did not answer with the beats", raw: clip(text, 400) };
}

/** POST /agent/beats { model, sessionId?, cast, setting, shots, frames }: the conversation is the session's own, read here. */
export async function handleBeats(req, res, { readBody, json, sessionStore, transcriptFromHistory, models }) {
	let value;
	try { value = await readBody(req); } catch (error) { json(res, error.status || 400, { error: error.message }); return true; }
	if (!value || typeof value.model !== "string" || !Array.isArray(value.shots) || !value.shots.length || !Array.isArray(value.frames)) { json(res, 400, { error: "model, shots and frames are required" }); return true; }
	let transcript = [];
	if (typeof value.sessionId === "string" && value.sessionId) {
		try { const persisted = sessionStore.read(value.sessionId); if (persisted?.history?.length) transcript = transcriptFromHistory(persisted.history); } catch { /* no conversation: the pictures alone */ }
	}
	try {
		const result = await writeShotBeats({ registry: await models(), modelKey: value.model, effort: value.effort || "medium", transcript, cast: Array.isArray(value.cast) ? value.cast.map(String) : [], setting: typeof value.setting === "string" ? value.setting : "", shots: value.shots, frames: value.frames });
		json(res, result.error ? 502 : 200, { ...result, conversation: transcript.length > 0 });
	} catch (error) { json(res, 502, { error: error?.message || "the beats could not be written" }); }
	return true;
}
