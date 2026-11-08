// Annotation marks: what the author points at in the 3D view to tell the
// agent "this part, change it like this". A mark is a pen mark (a point, a
// loop around something or a stroke along it) or a timeline note (with a
// frame range). Marks are numbered 1, 2, 3... in creation order and keep their
// number until the message is sent (a removed or undone mark leaves its
// number unused; redo brings the same number back). The stage draws them
// (context-chip-tools.jsx), the composer shows one chip per mark
// (workflow/ContextChips.jsx), and Send carries them as structured `marks` in
// the turn's context plus ONE annotated picture of the view, then clears them
// and arms the range guard (note-range-guard.js) for a mark with a range.
//
// No DOM or React here: the binding and the node tests import it.
import { armNoteRangeGuard } from "./note-range-guard.js";

const MARK_KINDS = Object.freeze(["pen", "note", "fix"]);
const MARK_MAX = 12;
const ABOUT = "Marks the author drew on the 3D view for this message, numbered n (the text may say ①, ②... or @1, @2...); the attached annotated picture shows them with their numbers. hit is what a mark points at: type object|character|floor|environment, its id and name, for a character bone (the main POSE_BONES joint) and bones (every joint it covers; fingers as leftIndex1...), for an object face (and faces). A pen mark's shape: point = the author clicked that spot; loop = the author ringed something, hit and members are what lies INSIDE it (read it as 'the problem is here'); stroke = drawn along a body or an object, bones/faces in stroke order; route = a path on the floor (length_m), e.g. for a walk. A note is a timeline mark on a character. points are world metres (a loop drawn at the depth of what it rings); screen is the mark's outline in 0..1 of the picture (x right, y down) to match the data to the image; frame is the playhead when drawn; members are what lies inside a loop; a mark with range (frames, inclusive) limits motion, IK and retiming edits of that character to those frames this turn. A fix is the author's own hand correction of one frame of the installed take (takeId): frame is the corrected frame, range the frames it eases over, bones the IK tracks it moved, deltaDeg how far each bone turned from the take (degrees), pose.before/after the whole pose there without and with the fix (POSE_BONES Euler degrees); a picture per fix shows the frame before | after. Read the fixes as what the take should do at those frames.";

let marks = [];
let redo = [];
let highlighted = null;
let sequence = 0;
let capture = null;
const listeners = new Set();
const emit = () => { for (const listener of listeners) listener(); };

export function subscribeMarks(listener) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
export const readMarks = () => marks;
export const readHighlightedMark = () => highlighted;
export function highlightMark(n) {
	if (highlighted === n) return;
	highlighted = n;
	emit();
}

const freeze = (mark) => Object.freeze({ ...mark, hit: Object.freeze({ ...mark.hit }) });

/** Add a mark (or, with the same `key`, replace that one in place, keeping its number).
 * `label` is the chip's text; `local` is UI-only data never sent. */
export function addMark({ kind, key = null, label, hit = {}, points = [], frame = 0, ...rest }) {
	if (!MARK_KINDS.includes(kind)) throw new Error(`Unknown mark kind: ${kind}`);
	const index = key ? marks.findIndex((entry) => entry.key === key) : -1;
	if (index === -1 && marks.length >= MARK_MAX) return null;
	const n = index === -1 ? Math.max(0, ...marks.map((entry) => entry.n)) + 1 : marks[index].n;
	const mark = freeze({ id: index === -1 ? `mark-${++sequence}` : marks[index].id, n, kind, key, label, hit, points, frame, ...rest });
	marks = index === -1 ? [...marks, mark] : marks.map((entry, i) => (i === index ? mark : entry));
	redo = [];
	emit();
	return mark;
}

export function updateMark(id, patch) {
	const index = marks.findIndex((entry) => entry.id === id);
	if (index === -1) return null;
	const mark = freeze({ ...marks[index], ...patch, hit: { ...marks[index].hit, ...patch.hit } });
	marks = marks.map((entry, i) => (i === index ? mark : entry));
	emit();
	return mark;
}

export function removeMark(id) {
	const next = marks.filter((entry) => entry.id !== id);
	if (next.length === marks.length) return;
	marks = next;
	emit();
}

/** Cmd/Ctrl+Z on unsent marks: the newest mark goes (and can come back). */
export function undoMark() {
	if (!marks.length) return false;
	redo = [...redo, marks.at(-1)];
	marks = marks.slice(0, -1);
	emit();
	return true;
}
export function redoMark() {
	if (!redo.length) return false;
	marks = [...marks, redo.at(-1)];
	redo = redo.slice(0, -1);
	emit();
	return true;
}

/** The stage registers how it draws the annotated picture of the view. */
export function registerAnnotatedCapture(fn) {
	capture = fn;
	return () => { if (capture === fn) capture = null; };
}
/** One picture of the editor view with every mark and its number drawn, or null. */
export function captureAnnotatedImage() {
	if (!marks.length || !capture) return null;
	try { return capture(marks); } catch { return null; }
}

/** The editor view as it is now, without marks (a fix's still), or null. */
export function captureView() {
	if (!capture) return null;
	try { return capture([]); } catch { return null; }
}
/** The pictures marks carry of their own (a fix's before | after still), for Send to attach after the annotated view. */
export const markStills = () => marks.filter((mark) => mark.local?.still).map((mark) => ({ dataUrl: mark.local.still, name: `fix-${mark.n}.jpg` }));

/** Send took the message: arm the range guard for the marks with a range (or disarm it) and clear. */
export function consumeMarks() {
	const ranged = marks.filter((mark) => mark.range && mark.hit?.type === "character").map((mark) => ({ characterId: mark.hit.id, frameStart: mark.range.frameStart, frameEnd: mark.range.frameEnd }));
	armNoteRangeGuard(ranged.length ? { ...ranged[0], ranges: ranged } : null);
	redo = [];
	highlighted = null;
	if (!marks.length) return;
	marks = [];
	emit();
}

/** The `marks` field of the Studio context: what the agent reads, never UI-only data. */
export function marksForAgent() {
	if (!marks.length) return {};
	return { marks: marks.map(({ id: _id, key: _key, local: _local, ...mark }, index) => ({ ...(index === 0 ? { about: ABOUT } : {}), ...mark })) };
}

/** ①..⑳ for the chips and the picture; past twenty, the plain number. */
export const markGlyph = (n) => (n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : `(${n})`);
