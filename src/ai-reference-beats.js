// Export → AI video reference, "Write with the agent": the pictures and facts the sidecar's beat writer reads
// (bin/agent/shot-beats.mjs), and the request. The agent of this Studio's own conversation writes each shot's
// timed beats, which the dialog shows for the operator to edit before they become the shot captions in prompt.txt.

/** Seconds between pictures of a shot, and the most pictures of the whole film the writer gets. */
const BEAT_STEP_S = 0.5, BEAT_MAX_FRAMES = 30;
// The keys AgentPanel stores (workflow/agent-client.js STUDIO_SESSION_STORAGE_KEY, AGENT_MODEL_KEY), read here
// without pulling the Workflow bundle into the Studio.
const SESSION_KEY = "cozyclay.agent.session.studio", MODEL_KEY = "cozyclay.agent.model";
const PICTURE_WIDTH = 640;

const read = (key) => { try { return globalThis.localStorage?.getItem(key) || null; } catch { return null; } };
const storedAgentSession = () => read(SESSION_KEY);
const storedAgentModel = () => read(MODEL_KEY);

/**
 * The frames to show: each shot from its first frame, every step seconds, and its last frame, thinned evenly
 * when the film would pass max. Film-clock seconds, so the beats read on the same clock as the prompt's spans.
 * @returns {Array<{ shotIndex: number, frame: number, atS: number }>}
 */
export function beatFrames(shots, fps, { stepS = BEAT_STEP_S, max = BEAT_MAX_FRAMES } = {}) {
	const step = Math.max(1, Math.round(stepS * fps));
	const all = [];
	shots.forEach((shot, index) => {
		const frames = [];
		for (let frame = shot.startFrame; frame < shot.endFrame; frame += step) frames.push(frame);
		frames.push(shot.endFrame);
		for (const frame of frames) all.push({ shotIndex: index + 1, frame, atS: Math.round((frame / fps) * 100) / 100 });
	});
	if (all.length <= max) return all;
	return Array.from({ length: max }, (_, i) => all[Math.round((i * (all.length - 1)) / (max - 1))]);
}

/** A PNG data URL scaled to the picture width as a JPEG, so thirty pictures stay a small request. */
async function smaller(dataUrl) {
	if (typeof document === "undefined" || !dataUrl) return dataUrl;
	const image = new Image();
	image.src = dataUrl;
	await image.decode();
	const scale = Math.min(1, PICTURE_WIDTH / image.naturalWidth);
	const canvas = document.createElement("canvas");
	canvas.width = Math.round(image.naturalWidth * scale);
	canvas.height = Math.round(image.naturalHeight * scale);
	canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
	return canvas.toDataURL("image/jpeg", 0.82);
}

/**
 * Ask the sidecar for the beats. capture(frame) is the shot-camera PNG the video export draws.
 * @returns {Promise<{ actions: string[], conversation: boolean, model: string }>}
 */
export async function requestShotBeats({ shots, fps, capture, cast, setting, shotFacts, fetchImpl = globalThis.fetch?.bind(globalThis), sessionId = storedAgentSession(), model = storedAgentModel() }) {
	if (!model) throw new Error("Pick a model in the Agent panel first");
	const picks = beatFrames(shots, fps);
	const frames = [];
	for (const pick of picks) frames.push({ shotIndex: pick.shotIndex, atS: pick.atS, dataUrl: await smaller(capture(pick.frame)) });
	const response = await fetchImpl("/agent/beats", {
		method: "POST",
		headers: { "content-type": "application/json" },
		credentials: "same-origin",
		body: JSON.stringify({ model, sessionId, cast, setting, frames, shots: shots.map((shot, index) => ({ index: index + 1, startS: shot.startFrame / fps, endS: (shot.endFrame + 1) / fps, ...shotFacts?.[index] })) }),
	});
	const value = await response.json().catch(() => ({}));
	if (!response.ok || !Array.isArray(value.actions)) throw new Error(value.error || `the agent could not write the beats (${response.status})`);
	return value;
}
