// Timeline notes: a pin the author drops on a character's lane to say "this
// stretch of the take" to the agent. A note is { id, frame, frameStart,
// frameEnd, bone, takeId }: frames inclusive, bone a POSE_BONES id or null.
// Notes ride the character's layer (layer.notes), so they save, load and undo
// with the cast. Pure: scenes.js and the node tests import it.

export const NOTE_HALF_RANGE = 12; // the default range is the pinned frame ±12
export const NOTE_MAX = 32; // per character

const int = (value, fallback = 0) => (Number.isFinite(value) ? Math.round(value) : fallback);

/** A range [start, end] inside the timeline that always holds `frame`. */
export function clampNoteRange(frame, start, end, frameCount) {
	const last = Math.max(0, int(frameCount, 1) - 1);
	const at = Math.max(0, Math.min(last, int(frame)));
	return { frameStart: Math.max(0, Math.min(at, int(start, at))), frameEnd: Math.min(last, Math.max(at, int(end, at))) };
}

export function createTimelineNote({ id, frame, frameCount, takeId = null }) {
	const at = Math.max(0, Math.min(Math.max(0, int(frameCount, 1) - 1), int(frame)));
	return { id, frame: at, ...clampNoteRange(at, at - NOTE_HALF_RANGE, at + NOTE_HALF_RANGE, frameCount), bone: null, takeId };
}

/** The notes a saved layer carries, repaired; never more than NOTE_MAX. */
export function normalizeTimelineNotes(value) {
	if (!Array.isArray(value)) return [];
	const seen = new Set();
	const notes = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !entry.id || seen.has(entry.id) || !Number.isFinite(entry.frame)) continue;
		seen.add(entry.id);
		const frame = Math.max(0, int(entry.frame));
		notes.push({ id: entry.id, frame, frameStart: Math.min(frame, Math.max(0, int(entry.frameStart, frame))), frameEnd: Math.max(frame, int(entry.frameEnd, frame)),
			bone: typeof entry.bone === "string" && entry.bone ? entry.bone : null, takeId: typeof entry.takeId === "string" && entry.takeId ? entry.takeId : null });
	}
	return notes.slice(0, NOTE_MAX);
}

/** The layer field scenes.js writes: absent when the character has no notes. */
export const noteLayerField = (value) => {
	const notes = normalizeTimelineNotes(value);
	return notes.length ? { notes } : {};
};

/** The three stills a note carries: six frames either side of the pin, clamped. */
export function noteStillFrames(frame, frameCount) {
	const last = Math.max(0, int(frameCount, 1) - 1);
	return [frame - 6, frame, frame + 6].map((value) => Math.max(0, Math.min(last, value)));
}
