// What Annotate's doors do: a finished pen mark (a point, a loop or a stroke) becomes a
// numbered mark (context-chips.js) with what it hit named; the timeline's
// note pin (N, the head button, a pin click) is one more mark, with a frame
// range; a pen stroke that starts on a character offers "Apply as walk".
import * as THREE from "three";
import { ko } from "./locale.js";
import { addMark, markGlyph, readMarks, updateMark } from "./context-chips.js";
import { routeFromStroke, simplifyStroke, walkWaypoints } from "./route-sketch.js";
import { createTimelineNote, NOTE_MAX } from "./timeline-notes.js";
import { annotateWorld, armNoteBone, disarmViewportSketch } from "./viewport-sketch.js";
import { POSE_BONES, normalizeBoneName } from "./poses.js";
import { createStableItemId } from "./stable-items.js";
import { MAX_WAYPOINTS } from "./timeline-defaults.js";
import { characterName as displayName } from "./character-name.js";

const run = (shell, id, args) => shell.appContext.bus.run(id, args, { origin: "ui" });
// A mark waits in the agent composer, so the composer comes into view with it.
const showAgent = (shell) => { if (shell?.agentOpen === false) shell.toggleAgent?.(); };
const say = (shell, receipt, fallback) => { if (!receipt?.ok) shell.setToast?.(receipt?.message ?? fallback); return Boolean(receipt?.ok); };
const round = (value) => Math.round(value * 100) / 100;
const roundPoint = (p) => ({ x: round(p.x), y: round(p.y ?? 0), z: round(p.z) });
const WALK_START_M = 0.5; // a stroke that starts this close to a character's feet can be its walk

/** The POSE_BONES joint nearest a world point on the body: distance to each
 * matched bone's segment (bone to its first child bone). */
export function nearestPoseBone(rig, point) {
	rig.updateWorldMatrix(true, true);
	const a = new THREE.Vector3(), b = new THREE.Vector3(), segment = new THREE.Line3(), closest = new THREE.Vector3();
	let best = null;
	rig.traverse((bone) => {
		if (!bone.isBone) return;
		const name = normalizeBoneName(bone.name);
		const entry = POSE_BONES.find((row) => { const target = normalizeBoneName(row.bone); return name === target || name.endsWith(target); });
		if (!entry) return;
		bone.getWorldPosition(a);
		const child = bone.children.find((node) => node.isBone);
		if (child) child.getWorldPosition(b); else b.copy(a);
		segment.set(a, b).closestPointToPoint(point, true, closest);
		const distance = closest.distanceTo(point);
		if (!best || distance < best.distance) best = { id: entry.id, distance };
	});
	return best?.id ?? null;
}

const BONE_LABELS = {
	hips: ko("Hips", "골반"), spine: ko("Spine", "척추"), chest: ko("Chest", "가슴"), upperChest: ko("Upper chest", "윗가슴"), neck: ko("Neck", "목"), head: ko("Head", "머리"),
	lShoulder: ko("Left shoulder", "왼쪽 어깨"), rShoulder: ko("Right shoulder", "오른쪽 어깨"), lArm: ko("Left arm", "왼팔"), rArm: ko("Right arm", "오른팔"),
	lForeArm: ko("Left forearm", "왼쪽 아래팔"), rForeArm: ko("Right forearm", "오른쪽 아래팔"), lHand: ko("Left hand", "왼손"), rHand: ko("Right hand", "오른손"),
	lUpLeg: ko("Left thigh", "왼쪽 허벅지"), rUpLeg: ko("Right thigh", "오른쪽 허벅지"), lLeg: ko("Left shin", "왼쪽 정강이"), rLeg: ko("Right shin", "오른쪽 정강이"),
	lFoot: ko("Left foot", "왼발"), rFoot: ko("Right foot", "오른발"),
};
const FACE_LABELS = { top: ko("top", "윗면"), bottom: ko("bottom", "아랫면"), front: ko("front", "앞면"), back: ko("back", "뒷면"), left: ko("left side", "왼쪽 면"), right: ko("right side", "오른쪽 면") };

const characterName = (world, id) => { const row = world?.characters?.find((entry) => entry.id === id); return row ? displayName(row) : id; };
const objectName = (world, id) => { const row = world?.objects?.find((entry) => entry.id === id); return row?.name || row?.renderer || id; };
/** A character as a mark's hit, with its name (fix-send.js). */
export const characterHit = (id) => named(annotateWorld(), { type: "character", id });
/** The hit with the names a chip and the agent read. */
function named(world, hit) {
	if (hit.type === "character") return { ...hit, name: characterName(world, hit.id), bone: hit.bone ?? null };
	if (hit.type === "object") return { ...hit, name: hit.name ?? objectName(world, hit.id) };
	if (hit.type === "floor") return { type: "floor", id: null, name: ko("Floor", "바닥") };
	return { ...hit, name: hit.name || ko("Set", "세트") };
}

const partsOf = (hit) => [hit.face && FACE_LABELS[hit.face], hit.bone && BONE_LABELS[hit.bone]].filter(Boolean);

const loopLabel = (glyph, mark) => {
	const [first, ...rest] = mark.members ?? [];
	if (!first) return `${glyph} ${ko("Region", "영역")}`;
	return `${glyph} ${first.name}${first.bone ? ` ${BONE_LABELS[first.bone] ?? first.bone}` : ""}${rest.length ? ` +${rest.length}` : ""}`;
};

/** The chip's short words, so five chips fit two rows: "① Cube front", "② Cube +1", "③ Floor 3.0 m", "⑤ Note f30–54". */
export function markLabel(mark) {
	const glyph = markGlyph(mark.n), hit = mark.hit ?? {};
	if (mark.kind === "fix") return `${glyph} ${mark.label}`;
	if (mark.kind === "pen" && mark.shape === "route") return `${glyph} ${hit.name} ${(mark.length_m ?? 0).toFixed(1)} m`;
	if (mark.kind === "pen" && mark.shape === "loop" && hit.type !== "character") return loopLabel(glyph, mark);
	if (mark.kind === "note") return `${glyph} ${ko("Note", "노트")} f${mark.range.frameStart}–${mark.range.frameEnd}`;
	return [`${glyph} ${hit.name}`, ...partsOf(hit)].join(" ");
}

/** The chip's full words, its tooltip: "① Cube · top · f0", "③ Floor stroke · 4.4 m", "④ Y Bot · Left arm · f42". */
export function markTitle(mark) {
	const glyph = markGlyph(mark.n), hit = mark.hit ?? {}, part = partsOf(hit).map((text) => ` · ${text}`).join("");
	if (mark.kind === "fix") return `${glyph} ${mark.label} · ${hit.name}`;
	if (mark.kind === "pen" && mark.shape === "route") return `${glyph} ${hit.name} ${ko("stroke", "스트로크")} · ${(mark.length_m ?? 0).toFixed(1)} m · f${mark.frame}`;
	const bones = (hit.bones ?? []).filter((id) => BONE_LABELS[id]).map((id) => BONE_LABELS[id]);
	if (mark.kind === "pen" && hit.type === "character") return `${glyph} ${hit.name} · ${bones.join(", ") || BONE_LABELS[hit.bone] || ""} · f${mark.frame}`;
	if (mark.kind === "pen" && mark.shape === "loop" && hit.type !== "character") return `${glyph} ${(mark.members ?? []).map((member) => member.name).join(", ") || ko("Region", "영역")} · f${mark.frame}`;
	if (mark.kind === "note") return `${glyph} ${ko("Note", "노트")} @ f${mark.range.frameStart}–${mark.range.frameEnd} · ${hit.name}${part}`;
	return `${glyph} ${hit.name}${part} · f${mark.frame}`;
}

/** A finished drawing from the stage (annotate-hits.js read it): pen { shape: loop|stroke|route, hit, points,
 * floor?, members? } or { shape: point, hit, points }; every one with its `screen` polygon. */
export function createMark(kind, { hit, points, floor = [], members, shape, screen = [] }) {
	const world = annotateWorld(), shell = world?.shell, frame = world?.timeline?.currentFrame ?? shell?.tlFrame ?? 0;
	const drawn = kind === "pen" && shape !== "loop" ? simplifyStroke(points) : points.length > 64 ? points.filter((_, i) => i % Math.ceil(points.length / 64) === 0) : points;
	const mark = { kind, ...(shape ? { shape } : {}), hit: named(world, hit), points: drawn.map(roundPoint), frame, screen };
	if (members) mark.members = members.map((entry) => named(world, entry));
	if (shape === "route" || shape === "stroke") {
		let length = 0;
		for (let i = 1; i < points.length; i += 1) length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y, points[i].z - points[i - 1].z);
		mark.length_m = round(length);
	}
	// Apply as walk is offered only for a floor route that starts on a character (or at its feet).
	if (kind === "pen" && shape === "route" && floor.length > 1) {
		const start = floor[0], owner = hit.type === "character" ? world?.characters?.find((row) => row.id === hit.id)
			: world?.characters?.find((row) => Math.hypot(row.x - start.x, row.z - start.z) < WALK_START_M);
		if (owner) mark.local = { walk: { characterId: owner.id, start: { x: owner.x, z: owner.z }, floor } };
	}
	const added = addMark(mark);
	if (!added) shell?.setToast?.(ko("Up to 12 marks per message", "메시지 하나에 표시는 12개까지예요"));
	else showAgent(shell);
	return added;
}

/** "Apply as walk" on a pen mark that starts on a character: its root path, one undo entry, at 1.4 m/s. */
export function applyRouteAsWalk(shell, mark) {
	const walk = mark.local?.walk, route = walk && routeFromStroke(walk.floor, walk.start);
	if (!route) { shell.setToast?.(ko("The route is too short to walk", "걷기엔 경로가 너무 짧아요")); return null; }
	const fps = shell.tlFps ?? 24, frameCount = shell.tlFrameCount ?? 1;
	const waypoints = walkWaypoints(route.points, { fps, maxPins: MAX_WAYPOINTS });
	if (!waypoints.length) { shell.setToast?.(ko("The route is too short to walk", "걷기엔 경로가 너무 짧아요")); return null; }
	const end = waypoints.at(-1).frame;
	if (end > frameCount - 1) {
		shell.setToast?.(ko(`The walk needs ${(end / fps).toFixed(1)} s (frame ${end}) — extend the clip or sketch a shorter route`, `걷는 데 ${(end / fps).toFixed(1)}초(${end}프레임)가 필요해요 — 클립을 늘리거나 경로를 짧게 그려 주세요`, `步行需要 ${(end / fps).toFixed(1)} 秒（第 ${end} 帧）— 请延长片段或画更短的路线`));
		return null;
	}
	// The waypoint steps switch root-path mode on, which unfolds the Top-View: only the author opens it.
	const wasWaypointMode = Boolean(shell.waypointMode);
	const receipt = run(shell, "character.applyWalk", { characterId: walk.characterId, pins: waypoints });
	if (!wasWaypointMode) shell.setWaypointMode?.(false);
	if (!say(shell, receipt, ko("The walk could not be applied", "걷기를 적용하지 못했어요"))) return null;
	shell.setToast?.(ko(`Walk applied: ${waypoints.length} waypoints at 1.4 m/s, to frame ${end}`, `걷기 적용: 웨이포인트 ${waypoints.length}개, 1.4 m/s, ${end}프레임까지`, `已应用步行：${waypoints.length} 个路径点，1.4 m/s，至第 ${end} 帧`));
	return receipt;
}

// --- Timeline notes: a mark with a frame range --------------------------------

export const noteLabel = (note) => `${ko("Note", "노트")} @ f${note.frameStart}–${note.frameEnd}${note.bone ? ` · ${BONE_LABELS[note.bone] ?? note.bone}` : ""}`;

// Read from the cast owner, not the render that armed a callback: a bone pick lands after the note's own write.
const castRows = (shell) => shell.appContext.storeDomain?.("cast")?.read() ?? shell.appContext.live.characters ?? [];
const notesOf = (shell, characterId) => castRows(shell).find((entry) => entry.id === characterId)?.layer?.notes ?? [];
const noteMarkOf = (noteId) => readMarks().find((entry) => entry.key === `note:${noteId}`);

/** Replace one character's notes: one cast undo entry, saved with the scene. */
function writeNotes(shell, characterId, notes) {
	return say(shell, run(shell, "cast.setLayer", { characterId, layer: { notes } }), ko("The note could not be saved", "노트를 저장하지 못했어요"));
}

/** (Re)open a note's mark: the character, its bone and the note's range. */
function openNoteMark(shell, characterId, note) {
	const world = annotateWorld(), rig = world?.rigs?.[characterId];
	const top = rig ? new THREE.Box3().setFromObject(rig) : null;
	const anchor = top && !top.isEmpty() ? { x: (top.min.x + top.max.x) / 2, y: top.max.y, z: (top.min.z + top.max.z) / 2 } : null;
	const mark = addMark({ kind: "note", key: `note:${note.id}`, hit: named(world, { type: "character", id: characterId, bone: note.bone }), points: [], frame: note.frame,
		range: { frameStart: note.frameStart, frameEnd: note.frameEnd }, takeId: note.takeId ?? null, ...(anchor ? { local: { anchor } } : {}) });
	showAgent(shell);
	return mark;
}

/** Arm the stage for the note's bone: the next click on the character names it. */
function armBone(shell, characterId, noteId) {
	const rig = shell.appContext.live.state.rigs?.[characterId];
	if (!rig) return;
	armNoteBone({ noteId, characterId, rig, onBone: (bone) => {
		disarmViewportSketch();
		const notes = notesOf(shell, characterId), note = notes.find((entry) => entry.id === noteId);
		if (!note) return;
		const next = { ...note, bone };
		if (!writeNotes(shell, characterId, notes.map((entry) => (entry.id === noteId ? next : entry)))) return;
		const mark = noteMarkOf(noteId);
		if (mark) updateMark(mark.id, { hit: { bone } });
	} });
}

/** N or the head's pin: a note at the playhead on the selected character's lane. */
export function dropNoteAtPlayhead(shell) {
	const character = shell.activeChar;
	if (!character) { shell.setToast?.(ko("Select a character to pin a note on its lane", "노트를 꽂을 인물을 먼저 선택하세요")); return null; }
	const notes = notesOf(shell, character.id);
	if (notes.length >= NOTE_MAX) { shell.setToast?.(ko(`A character holds up to ${NOTE_MAX} notes`, `인물 하나에 노트는 ${NOTE_MAX}개까지예요`, `每个角色最多 ${NOTE_MAX} 条笔记`)); return null; }
	const note = createTimelineNote({ id: createStableItemId("note"), frame: shell.tlFrame ?? 0, frameCount: shell.tlFrameCount ?? 1, takeId: character.motionTake?.takeId ?? null });
	if (!writeNotes(shell, character.id, [...notes, note])) return null;
	openNoteMark(shell, character.id, note);
	armBone(shell, character.id, note.id);
	return note;
}

/** A pin click: the playhead goes to the pin, its mark opens again and the bone can be re-picked. */
export function reopenNote(shell, characterId, note) {
	shell.setTlFrame?.(note.frame);
	openNoteMark(shell, characterId, note);
	armBone(shell, characterId, note.id);
}

/** The edge drag's end: the note's new range, one undo entry, and its mark follows. */
export function setNoteRange(shell, characterId, noteId, range) {
	const notes = notesOf(shell, characterId), note = notes.find((entry) => entry.id === noteId);
	if (!note || (note.frameStart === range.frameStart && note.frameEnd === range.frameEnd)) return;
	if (!writeNotes(shell, characterId, notes.map((entry) => (entry.id === noteId ? { ...note, ...range } : entry)))) return;
	const mark = noteMarkOf(noteId);
	if (mark) updateMark(mark.id, { range: { frameStart: range.frameStart, frameEnd: range.frameEnd } });
}

export function removeNote(shell, characterId, noteId) {
	writeNotes(shell, characterId, notesOf(shell, characterId).filter((entry) => entry.id !== noteId));
}
