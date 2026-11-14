import { ko } from "./locale.js";
import { CUSTOM_MOVE } from "./shot.js";
import { CUTOUT_KIND, MESH_KIND } from "./scene-objects.js";

export const RIG_HIERARCHY_FOCUS = {
	"rig.torso": "spine",
	"rig.hips": "hips",
	"rig.spine": "spine",
	"rig.chest": "chest",
	"rig.neck": "neck",
	"rig.head": "head",
	"rig.leftArm": "leftHand",
	"rig.leftShoulder": "leftShoulder",
	"rig.leftElbow": "leftElbow",
	"rig.leftHand": "leftHand",
	"rig.rightArm": "rightHand",
	"rig.rightShoulder": "rightShoulder",
	"rig.rightElbow": "rightElbow",
	"rig.rightHand": "rightHand",
	"rig.leftLeg": "leftFoot",
	"rig.leftKnee": "leftKnee",
	"rig.leftFoot": "leftFoot",
	"rig.rightLeg": "rightFoot",
	"rig.rightKnee": "rightKnee",
	"rig.rightFoot": "rightFoot",
};

export const HIERARCHY_INSPECTOR_TITLES = {
	shot: ko("Shot settings", "샷 설정"),
	camera: ko("Camera", "카메라"),
	light: ko("Light", "조명"),
	characters: ko("Characters", "인물"),
	rig: ko("Rig", "리그"),
	environment: ko("Environment", "환경"),
	props: ko("Props", "소품"),
	"rig.torso": ko("Torso", "몸통"),
	"rig.hips": ko("Root / Hips", "루트 / 엉덩이"),
	"rig.spine": ko("Spine", "척추"),
	"rig.chest": ko("Chest", "가슴"),
	"rig.neck": ko("Neck", "목"),
	"rig.head": ko("Head", "머리"),
	"rig.leftArm": ko("Left Arm", "왼팔"),
	"rig.leftShoulder": ko("Left Shoulder", "왼쪽 어깨"),
	"rig.leftElbow": ko("Left Elbow", "왼쪽 팔꿈치"),
	"rig.leftHand": ko("Left Hand", "왼손"),
	"rig.rightArm": ko("Right Arm", "오른팔"),
	"rig.rightShoulder": ko("Right Shoulder", "오른쪽 어깨"),
	"rig.rightElbow": ko("Right Elbow", "오른쪽 팔꿈치"),
	"rig.rightHand": ko("Right Hand", "오른손"),
	"rig.leftLeg": ko("Left Leg", "왼다리"),
	"rig.leftKnee": ko("Left Knee", "왼쪽 무릎"),
	"rig.leftFoot": ko("Left Foot", "왼발"),
	"rig.rightLeg": ko("Right Leg", "오른다리"),
	"rig.rightKnee": ko("Right Knee", "오른쪽 무릎"),
	"rig.rightFoot": ko("Right Foot", "오른발"),
};

export const CAMERA_MOVE_LABELS_KO = new Map([
	["Static / locked-off", ko("Static / locked-off", "고정 샷")],
	["Zoom in", ko("Zoom in", "줌 인")],
	["Zoom out", ko("Zoom out", "줌 아웃")],
	["Push-in (dolly in)", ko("Push-in (dolly in)", "푸시인(돌리 인)")],
	["Pull-out (dolly out)", ko("Pull-out (dolly out)", "풀아웃(돌리 아웃)")],
	["Pan left", ko("Pan left", "왼쪽 팬")],
	["Pan right", ko("Pan right", "오른쪽 팬")],
	["Tilt up", ko("Tilt up", "틸트 업")],
	["Tilt down", ko("Tilt down", "틸트 다운")],
	["Tracking / follow", ko("Tracking / follow", "트래킹 / 팔로우")],
	["Orbit / arc", ko("Orbit / arc", "오빗 / 아크")],
	["Crane up", ko("Crane up", "크레인 업")],
	["Crane down", ko("Crane down", "크레인 다운")],
	["Handheld", ko("Handheld", "핸드헬드")],
	["Crash zoom in", ko("Crash zoom in", "크래시 줌 인")],
	["Dolly-zoom (vertigo)", ko("Dolly-zoom (vertigo)", "돌리 줌(버티고)")],
	["Whip pan", ko("Whip pan", "휩 팬")],
	["Aerial / drone", ko("Aerial / drone", "공중 / 드론")],
	[CUSTOM_MOVE, ko(CUSTOM_MOVE, "직접 입력…", "自定义…")],
]);

export const POSE_LABELS_KO = new Map([
	["T-pose", ko("T-pose", "T 포즈")],
	["Relaxed", ko("Relaxed", "편안한 자세")],
	["Contrapposto", ko("Contrapposto", "콘트라포스토")],
	["Walking", ko("Walking", "걷는 자세")],
	["Seated", ko("Seated", "앉은 자세")],
	["Arms crossed", ko("Arms crossed", "팔짱")],
	["Pointing", ko("Pointing", "가리키기")],
	["Hands on hips", ko("Hands on hips", "허리에 손")],
	["Looking back", ko("Looking back", "뒤돌아보기")],
	["Hands up", ko("Hands up", "손 올리기")],
]);

export const SHOT_SIZE_LABELS_KO = new Map([
	["extreme close-up", ko("extreme close-up", "익스트림 클로즈업")],
	["close-up", ko("close-up", "클로즈업")],
	["medium close-up", ko("medium close-up", "미디엄 클로즈업")],
	["medium shot", ko("medium shot", "미디엄 샷")],
	["medium-wide shot", ko("medium-wide shot", "미디엄 와이드 샷")],
	["wide shot", ko("wide shot", "와이드 샷")],
	["extreme wide shot", ko("extreme wide shot", "익스트림 와이드 샷")],
]);

export const SHOT_LEVEL_LABELS_KO = new Map([
	["overhead", ko("overhead", "오버헤드")],
	["high angle", ko("high angle", "하이 앵글")],
	["eye level", ko("eye level", "아이 레벨")],
	["chest level", ko("chest level", "가슴 높이")],
	["hip level", ko("hip level", "엉덩이 높이")],
	["knee level", ko("knee level", "무릎 높이")],
	["ground level", ko("ground level", "바닥 높이")],
]);

export const SCENE_RENDERER_LABELS_KO = new Map([
	["cube", ko("cube", "큐브")],
	["sphere", ko("sphere", "구")],
	["capsule", ko("capsule", "캡슐")],
	["cylinder", ko("cylinder", "원기둥")],
	["cone", ko("cone", "원뿔")],
	["plane", ko("plane", "평면")],
	[CUTOUT_KIND, ko("cutout", "컷아웃")],
	[MESH_KIND, ko("Mesh", "모델", "模型")],
	["sculpt", ko("Sculpt", "조형")],
]);

export const SCENE_OBJECT_NAME_LABELS_KO = new Map([
	["Cube", ko("Cube", "큐브")],
	["Sphere", ko("Sphere", "구")],
	["Capsule", ko("Capsule", "캡슐")],
	["Cylinder", ko("Cylinder", "원기둥")],
	["Cone", ko("Cone", "원뿔")],
	["Plane", ko("Plane", "평면")],
	["Mesh", ko("Mesh", "모델")],
	["Model", ko("Model", "모델")],
]);

export function poseLabelKo(pose) {
	return pose?.custom ? pose.label : POSE_LABELS_KO.get(pose?.label) ?? pose?.label ?? "";
}

export function cameraMoveLabelKo(move) {
	return CAMERA_MOVE_LABELS_KO.get(move) ?? move;
}

export function sceneRendererLabelKo(renderer) {
	return SCENE_RENDERER_LABELS_KO.get(renderer) ?? renderer;
}

export function sceneObjectNameDisplayKo(name) {
	const match = /^(.+?)(?: ([2-9]\d*))?$/.exec(name ?? "");
	if (!match) return name;
	const [, base, suffix] = match;
	const label = SCENE_OBJECT_NAME_LABELS_KO.get(base);
	return label ? `${label}${suffix ? ` ${suffix}` : ""}` : name;
}

export function viewShortKo(viewShort) {
	if (viewShort === "front") return ko("front", "정면");
	if (viewShort === "back") return ko("back", "후면");
	if (viewShort?.includes("profile")) return viewShort.startsWith("left") ? ko("left profile", "왼쪽 측면") : ko("right profile", "오른쪽 측면");
	if (viewShort?.startsWith("front ¾")) return / L$/.test(viewShort) ? ko("front ¾ L", "정면 ¾ 왼쪽") : ko("front ¾ R", "정면 ¾ 오른쪽");
	if (viewShort?.startsWith("rear ¾")) return / L$/.test(viewShort) ? ko("rear ¾ L", "후면 ¾ 왼쪽") : ko("rear ¾ R", "후면 ¾ 오른쪽");
	return viewShort;
}

export function slateLineKo(shot) {
	return [
		SHOT_SIZE_LABELS_KO.get(shot.sizeLabel) ?? shot.sizeLabel,
		viewShortKo(shot.viewShort),
		SHOT_LEVEL_LABELS_KO.get(shot.levelLabel) ?? shot.levelLabel,
		`${shot.focalMm}mm`,
	].filter(Boolean).join(" · ");
}

export function moveSequenceSlateKo(segments) {
	if (!segments.length) return "";
	if (segments.length === 1) {
		const seg = segments[0];
		return `${slateLineKo(seg.from)} → ${slateLineKo(seg.to)} · ${cameraMoveLabelKo(seg.label)}`;
	}
	const parts = [slateLineKo(segments[0].from)];
	for (const seg of segments) parts.push(`${cameraMoveLabelKo(seg.label)} → ${slateLineKo(seg.to)}`);
	return parts.join(" · ");
}

/** The hierarchy node id an IK focus lights up. Focus maps stay keyed by the
 * BONE TOKEN; the row id namespaces the result so each cast member's tree
 * highlights its own bone (#76). */
export function hierarchyIdForIkFocus(focus, rowId) {
	if (!focus || !rowId) return null;
	const exact = Object.entries(RIG_HIERARCHY_FOCUS)
		.find(([id, mappedFocus]) =>
			!["rig.torso", "rig.leftArm", "rig.rightArm", "rig.leftLeg", "rig.rightLeg"].includes(id) &&
			mappedFocus === focus
		);
	return `${rowId}.${exact?.[0] ?? "rig"}`;
}
