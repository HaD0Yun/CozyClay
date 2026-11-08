// Send fixes (src/shell/FixTools.jsx): one composer chip per fix island of the active character, on the annotation
// marks pipeline (context-chips.js), so Send carries each as a structured `fix` mark plus its own before | after still
// and arms the range guard over every island's frames. A fix mark: { kind: "fix", takeId, frame, range, bones, deltaDeg,
// pose: { before, after } }; the chip reads "Fix f34–46 · Left hand".
import { addMark, captureView } from "./context-chips.js";
import { characterHit } from "./context-chip-actions.js";
import { holdBones, islandsOf } from "./motion/fix-weight.js";
import { resolveIkRig } from "./motion/ik.js";
import { decodeMotionKeys } from "./domains/motion/motion-intent-codec.js";
import { capturePose } from "./poses.js";
import { ko } from "./locale.js";

const BODY = () => ({ hips: ko("Hips", "골반", "髋部"), spine: ko("Spine", "척추", "脊柱"), chest: ko("Chest", "가슴", "胸部"), neck: ko("Neck", "목", "颈部"), head: ko("Head", "머리", "头部"),
	leftHand: ko("Left hand", "왼손", "左手"), rightHand: ko("Right hand", "오른손", "右手"), leftFoot: ko("Left foot", "왼발", "左脚"), rightFoot: ko("Right foot", "오른발", "右脚"),
	leftShoulder: ko("Left shoulder", "왼쪽 어깨", "左肩"), rightShoulder: ko("Right shoulder", "오른쪽 어깨", "右肩") });
const FINGERS = () => ({ Thumb: ko("thumb", "엄지", "拇指"), Index: ko("index finger", "검지", "食指"), Middle: ko("middle finger", "중지", "中指"), Ring: ko("ring finger", "약지", "无名指"), Pinky: ko("little finger", "새끼손가락", "小指") });

/** "Left hand", "Hips", "Left index finger 2" for an IK track id. */
function trackLabel(track) {
	const body = BODY()[track];
	if (body) return body;
	const match = /^(left|right)(Thumb|Index|Middle|Ring|Pinky)(\d)$/.exec(track);
	if (!match) return track;
	return `${match[1] === "left" ? ko("Left", "왼쪽", "左") : ko("Right", "오른쪽", "右")} ${FINGERS()[match[2]]} ${match[3]}`;
}

const degrees = (base, q) => Math.round((2 * Math.acos(Math.min(1, Math.abs(base.dot(q)))) * 180 / Math.PI) * 10) / 10;
const boneName = (bone) => String(bone?.name ?? "").replace(/^mixamorig:?/, "");

/** How far each bone the island moved turned from the take, in degrees, by bone name. */
function deltasOf(entry, resolved) {
	const out = {};
	for (const [track, key] of entry) {
		if (!key.fix || !key.q || !key.baseQ) continue;
		const bones = resolved?.chains.get(track)?.bones ?? [resolved?.fkJoints.get(track)?.bone];
		key.q.forEach((q, i) => { if (q && key.baseQ[i] && bones[i]) out[boneName(bones[i])] = degrees(key.baseQ[i], q); });
	}
	return out;
}

const loaded = (url) => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = url; });
/** before | after, side by side in one picture (or the after alone). */
async function sideBySide(before, after) {
	if (!before || !after) return after ?? before ?? null;
	const [a, b] = await Promise.all([loaded(before), loaded(after)]), canvas = document.createElement("canvas");
	canvas.width = a.width + b.width; canvas.height = Math.max(a.height, b.height);
	const ctx = canvas.getContext("2d");
	ctx.drawImage(a, 0, 0); ctx.drawImage(b, a.width, 0);
	ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fillRect(0, 0, canvas.width, 28);
	ctx.fillStyle = "#fff"; ctx.font = "600 16px system-ui, sans-serif"; ctx.textBaseline = "middle";
	ctx.fillText(ko("Before (take)", "수정 전 (테이크)", "修正前（片段）"), 12, 14); ctx.fillText(ko("After (fixed)", "수정 후", "修正后"), a.width + 12, 14);
	ctx.fillStyle = "#fff"; ctx.fillRect(a.width - 1, 0, 2, canvas.height);
	return canvas.toDataURL("image/jpeg", 0.85);
}

/** Pose the live rig at `frame` as the take alone ("original") or with its fixes, read the pose and a still, put it back. */
function readAt(owner, characterId, rig, frame, view) {
	const state = owner.liveIkStates().get(characterId), restore = holdBones(rig), was = state?.fixView;
	try {
		if (state) state.fixView = view;
		owner.poseRigAt(characterId, frame);
		return { pose: { bones: capturePose(rig) }, still: captureView() };
	} finally { if (state) state.fixView = was; restore(); }
}

/** Put one chip per island of `characterId` in the composer. Returns how many. */
export async function sendFixes(app, characterId, rig) {
	const owner = app.storeDomain("motion"), row = owner?.read().find((entry) => entry.id === characterId);
	if (!owner || !rig || !row) return 0;
	const islands = islandsOf(row.ikKeys, owner.motionFor(characterId)?.frames ?? Infinity), keys = decodeMotionKeys(row.ikKeys), resolved = resolveIkRig(rig), hit = characterHit(characterId);
	let count = 0;
	for (const island of islands) {
		const before = readAt(owner, characterId, rig, island.frame, "original"), after = readAt(owner, characterId, rig, island.frame, "fixed");
		const anchorBone = resolved?.chains.get(island.tracks[0])?.bones.at(-1) ?? resolved?.fkJoints.get(island.tracks[0])?.bone;
		const anchor = anchorBone?.getWorldPosition(rig.position.clone());
		const still = await sideBySide(before.still, after.still);
		const label = `${ko("Fix", "보정", "修正")} f${island.start}–${island.end} · ${island.tracks.map(trackLabel).join(", ")}`;
		const mark = addMark({ kind: "fix", key: `fix:${characterId}:${island.id}`, label, hit, points: [], frame: island.frame,
			range: { frameStart: island.start, frameEnd: island.end }, takeId: island.takeId, bones: island.tracks, deltaDeg: deltasOf(keys.get(island.frame) ?? new Map(), resolved),
			pose: { before: before.pose, after: after.pose }, local: { ...(anchor ? { anchor: { x: anchor.x, y: anchor.y, z: anchor.z } } : {}), ...(still ? { still } : {}) } });
		if (mark) count += 1;
	}
	return count;
}
