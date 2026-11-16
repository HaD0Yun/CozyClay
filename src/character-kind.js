// What a cast member can do depends on its kind. A rigged character has a
// skeleton every motion, IK and physics tool writes to; a capsule figure
// (PROXY_FIGURE_MODEL) is a placement-only stand-in with no bones at all, so
// those tools refuse it by name instead of failing on a missing rig. An imported character (character-rig.js) plays
// compiled takes on its own bones, but Pose mode and IK write the X Bot's bones and rest pose, so those two refuse it.
import { isProxyFigure } from "./scenes.js";
import { isImportedModel } from "./character-rig.js";
import { isKo, isZh } from "./locale.js";
import { StudioProtocolError } from "./studio-agent-protocol.js";
import {
	PROXY_BODY_HEIGHT, PROXY_BODY_RADIUS, PROXY_HEAD_LIFT, PROXY_HEAD_RADIUS, PROXY_SIT_LEG_REACH, PROXY_SIT_TORSO_HEIGHT,
} from "./proxy-figure-shape.js";

export const CHARACTER_CAPABILITIES = Object.freeze(["rig", "ik", "pose", "motion"]);

/** Return a capsule figure's rendered world-space bounds without a rig. */
export function proxyFigureBounds(character, placement = character) {
	const posture = character?.posture === "sit" || character?.posture === "lie" ? character.posture : "stand";
	const bodyHeight = posture === "sit" ? PROXY_SIT_TORSO_HEIGHT : PROXY_BODY_HEIGHT;
	const top = bodyHeight + (PROXY_HEAD_LIFT + PROXY_HEAD_RADIUS);
	const stature = Number.isFinite(placement?.scale) ? placement.scale : Number.isFinite(character?.scale) ? character.scale : 1;
	const x = Number.isFinite(placement?.x) ? placement.x : character?.x ?? 0;
	const y = Number.isFinite(placement?.y) ? placement.y : character?.y ?? 0;
	const z = Number.isFinite(placement?.z) ? placement.z : character?.z ?? 0;
	const yaw = ((Number.isFinite(placement?.rot) ? placement.rot : character?.rot ?? 0) + (posture === "lie" ? 180 : 0)) * Math.PI / 180;
	const [minCorner, maxCorner] = posture === "lie"
		? [[-PROXY_BODY_RADIUS, PROXY_BODY_RADIUS - PROXY_HEAD_RADIUS, -top],
			[PROXY_BODY_RADIUS, PROXY_BODY_RADIUS + PROXY_HEAD_RADIUS, 0]]
		// Sit reaches forward (local +z, the facing direction) with its legs.
		: [[-PROXY_BODY_RADIUS, 0, -PROXY_BODY_RADIUS], [PROXY_BODY_RADIUS, top, posture === "sit" ? PROXY_SIT_LEG_REACH : PROXY_BODY_RADIUS]];
	const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
	const world = ([lx, ly, lz]) => {
		const sx = lx * stature, sy = ly * stature, sz = lz * stature;
		return { x: x + sx * Math.cos(yaw) + sz * Math.sin(yaw), y: y + sy, z: z - sx * Math.sin(yaw) + sz * Math.cos(yaw) };
	};
	for (const lx of [minCorner[0], maxCorner[0]]) for (const ly of [minCorner[1], maxCorner[1]]) for (const lz of [minCorner[2], maxCorner[2]]) {
		const w = world([lx, ly, lz]);
		for (const a of ["x", "y", "z"]) { min[a] = Math.min(min[a], w[a]); max[a] = Math.max(max[a], w[a]); }
	}
	return { min, max, ...proxyFigureCore(posture, bodyHeight, world) };
}

/** The drawn capsules' centre lines as points and [from, to] pairs, the way a rigged body's bones are: inside the flesh, one
 * capsule radius under the skin, so the contact, frame-edge and sight-line checks read a capsule figure as they read a rig. */
function proxyFigureCore(posture, bodyHeight, world) {
	const R = PROXY_BODY_RADIUS, head = bodyHeight + PROXY_HEAD_LIFT;
	// lie: the standing figure turned onto its back, its axis along local -z one radius above the floor (proxy-figure.jsx)
	const local = posture === "lie" ? p => [p[0], R + p[2], -p[1]] : p => p;
	const lines = [[[0, R, 0], [0, bodyHeight - R, 0]], [[0, bodyHeight - R, 0], [0, head, 0]], ...(posture === "sit" ? [[[0, R, 0], [0, R, PROXY_SIT_LEG_REACH - R]]] : [])];
	const points = [], bones = [];
	for (const [a, b] of lines) {
		const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / CORE_STEP_M));
		for (let i = 0; i <= steps; i++) {
			points.push(world(local(a.map((v, k) => v + (i / steps) * (b[k] - v)))));
			if (i) bones.push([points.length - 2, points.length - 1]);
		}
	}
	return { points, bones };
}
const CORE_STEP_M = 0.1;

const IMPORTED_OFF = new Set(["ik", "pose"]);

/** `{ rig, ik, pose, motion }` - all false for a capsule figure, all true for a rigged character; an imported
 * character has no ik or pose. */
export function characterCapabilities(character) {
	const rigged = !isProxyFigure(character), imported = isImportedModel(character?.model);
	return Object.freeze(Object.fromEntries(CHARACTER_CAPABILITIES.map((name) => [name, rigged && !(imported && IMPORTED_OFF.has(name))])));
}

// The noun each refusal names. A feature id not listed here is used verbatim.
const FEATURE_LABELS = {
	rig: ["the rig", "리그", "骨骼"],
	ik: ["IK", "IK", "IK"],
	pose: ["Pose mode", "포즈 모드", "姿势模式"],
	motion: ["Compiled motion", "모션 컴파일", "编译动作"],
	take: ["Loading a take", "테이크 불러오기", "加载动作片段"],
};

// A character's kind (rig or capsule figure) is fixed at creation; character.update refuses a kind change.
export const KIND_FIXED_REFUSAL = Object.freeze({
	en: "A character's kind is chosen when it is created; add a new character instead.",
	ko: "캐릭터 종류는 만들 때 정합니다. 새 캐릭터를 추가하세요.",
	zh: "角色的类型在创建时确定；请改为添加新角色。",
});

export function kindRefusal(feature, ko = false, zh = false) {
	const label = FEATURE_LABELS[feature]?.[ko ? 1 : zh ? 2 : 0] ?? feature;
	if (ko) return `캡슐 인물은 리그가 없어요 - ${label}는 리그 캐릭터에서만 됩니다.`;
	if (zh) return `胶囊人物没有骨骼 — ${label}仅适用于带骨骼的角色。`;
	return `Capsule figures have no rig - ${label} works on rigged characters only.`;
}

/** Why an imported character refuses `feature` (ik or pose). */
export function importedRefusal(feature, ko = false, zh = false) {
	const label = FEATURE_LABELS[feature]?.[ko ? 1 : zh ? 2 : 0] ?? feature;
	if (ko) return `가져온 캐릭터는 자기 뼈로 컴파일한 테이크만 재생해요 - ${label}는 X Bot과 Y Bot에서만 됩니다.`;
	if (zh) return `导入的角色只在自己的骨骼上播放编译的动作 — ${label}仅适用于 X Bot 和 Y Bot。`;
	return `Imported characters play compiled takes on their own bones - ${label} works on the X Bot and Y Bot only.`;
}

/** The sentence `character` refuses `feature` with (a capsule figure's, or an imported character's), else null. */
export function capabilityRefusal(character, feature, ko = false, zh = false) {
	if (isProxyFigure(character)) return kindRefusal(feature, ko, zh);
	return isImportedModel(character?.model) && IMPORTED_OFF.has(feature) ? importedRefusal(feature, ko, zh) : null;
}

/** Throw TARGET_NOT_READY when `character` cannot use `feature` (capabilityRefusal). The protocol
 * message is English (the agent reads it); `uiMessage` is the locale's. */
export function refuseRigOnly(character, feature) {
	const message = capabilityRefusal(character, feature);
	if (message) throw Object.assign(new StudioProtocolError("TARGET_NOT_READY", message), { uiMessage: capabilityRefusal(character, feature, isKo, isZh) });
}
