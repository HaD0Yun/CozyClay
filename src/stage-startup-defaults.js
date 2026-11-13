import * as THREE from "three";
import { ko } from "./locale.js";
import { SHOT_ASPECT_RATIOS } from "./shot.js";
import {
	createSceneDocument,
	loadSceneDocumentFromStorage,
} from "./scenes.js";
import { POSE_BONES } from "./poses.js";
import { isPlaygroundEmbed, takePlaygroundProject } from "./playground.js";

// Stated the way a crew states a setup: how far back, which side, how high the
// lens rides, and what glass is on it. Order matters — Medium is the setup a
// director reaches for first, so it leads.
export const PRESETS = {
	medium: { label: ko("Medium", "미디엄"), distance: 2.6, azimuth: 22, elevation: 6, fov: 45, targetY: 1.35 },
	wide: { label: ko("Wide", "와이드"), distance: 7, azimuth: 25, elevation: 4, fov: 38, targetY: 1.2 },
	closeup: { label: ko("Close-Up", "클로즈업"), distance: 1.3, azimuth: 16, elevation: 2, fov: 45, targetY: 1.55 },
	low: { label: ko("Low Angle", "로우 앵글"), distance: 3.5, azimuth: 20, elevation: -14, fov: 50, targetY: 1.1 },
	high: { label: ko("High Angle", "하이 앵글"), distance: 4.5, azimuth: 20, elevation: 16, fov: 45, targetY: 1.1 },
};

export const SHOT_ASPECT_PRESETS = Object.freeze({
	"16:9": Object.freeze({ label: "16:9", aspect: SHOT_ASPECT_RATIOS["16:9"], width: 1920, height: 1080 }),
	"2.39:1": Object.freeze({ label: "2.39:1", aspect: SHOT_ASPECT_RATIOS["2.39:1"], width: 2390, height: 1000 }),
	"9:16": Object.freeze({ label: "9:16", aspect: SHOT_ASPECT_RATIOS["9:16"], width: 1080, height: 1920 }),
	"1:1": Object.freeze({ label: "1:1", aspect: SHOT_ASPECT_RATIOS["1:1"], width: 1080, height: 1080 }),
	"4:3": Object.freeze({ label: "4:3", aspect: SHOT_ASPECT_RATIOS["4:3"], width: 1440, height: 1080 }),
	"12:7": Object.freeze({ label: "12:7", aspect: SHOT_ASPECT_RATIOS["12:7"], width: 1536, height: 896, title: ko("Widescreen 12:7", "와이드스크린 12:7", "宽屏 12:7") }),
	"fal 480P": Object.freeze({ label: "fal 480P", aspect: SHOT_ASPECT_RATIOS["fal 480P"], width: 1664, height: 960, title: ko("480p widescreen (832x480)", "480p 와이드 (832x480)", "480p 宽屏（832x480）") }),
});
// Per-character rig model: the stage entry's `model` is the FBX file stem in
// public/models. Root-absolute on purpose: the studio is served from "/app/"
// while public files stay at the site root, so a page-relative path would
// resolve to "/app/models/..." and 404.
export const characterModelUrl = (model) => `/models/${model}.fbx`;

/** Shipped rig names as the operator says them, not as the files spell them. */
export { CHARACTER_MODEL_LABELS } from "./character-name.js";

/** Sequential ids for spawned characters, collision-free against the cast. */
export function nextCharacterId(list) {
	const ids = new Set(list.map((entry) => entry.id));
	let n = list.length + 1;
	let id = `char-${n}`;
	while (ids.has(id)) {
		n += 1;
		id = `char-${n}`;
	}
	return id;
}
// How long a deletion keeps offering its one-press Undo. Both toasts use the
// same window so the two deletion paths feel like one rule.
export const OBJECT_DELETE_UNDO_MS = 7000;
export const ASSET_DELETE_UNDO_MS = 7000;
// White clay: every figure starts white (the renderer still drops the value a
// little and shades the joint shells darker, so the body keeps its form).
export const CLAY = "#ffffff";
export const CLAY_B = "#ffffff";
export const CLAY_X = "#ffffff";
// Model/role default for a cast member; a user-picked entry.tint always wins
// over this at render time.
export const defaultCharacterTint = (entry, index) => (entry.model === "x-bot-tpose" ? CLAY_X : index === 0 ? CLAY : CLAY_B);

/**
 * The first editor view should read like a blocking desk, not a security
 * camera at the back of the stage. Keep the selected subject large enough to
 * judge a pose while leaving a little floor around the feet. This is a pure
 * framing helper so the seed and any future reset action share the same
 * distance rule.
 */
export function editorFrameForSubject(subject) {
	const scale = Number.isFinite(subject?.scale) && subject.scale > 0 ? subject.scale : 1;
	const distance = THREE.MathUtils.clamp(3.5 / scale, 2.8, 4.8);
	const x = subject?.x ?? 0;
	const z = subject?.z ?? 0;
	const target = { x, y: 1.05, z };
	return {
		target,
		position: {
			x: x + distance * 0.62,
			y: target.y + distance * 0.34,
			z: z + distance * 0.78,
		},
	};
}

export const DEFAULT_CAMERA_POSITION = { x: 0.97, y: 1.62, z: 2.39 };
export const REST_BONES = Object.fromEntries(POSE_BONES.map((b) => [b.id, [0, 0, 0]]));

// Unity's tool keys. They are free because camera movement now lives behind a
// held right button. (docs/unity-reference.md §9.2)
export const GIZMO_HOTKEYS = { KeyW: "move", KeyE: "rotate", KeyR: "scale" };

export const WORKSPACE_LAYOUT_KEY = "cozyclay.workspace-layout.v1";
export const DEFAULT_WORKSPACE_LAYOUT = Object.freeze({
	hierarchyWidth: 300,
	sidebarWidth: 380,
	timelineHeight: 224,
	insetWidth: 310,
	insetHeight: 310,
	insetCollapsed: false,
	planZoom: 1,
});

export function loadWorkspaceLayout() {
	// The landing-page playground is a fixed, chrome-less layout: the plan
	// inset starts folded and nothing the visitor drags is written back.
	if (isPlaygroundEmbed(globalThis.location?.search)) return { ...DEFAULT_WORKSPACE_LAYOUT, insetCollapsed: true };
	try {
		const saved = JSON.parse(localStorage.getItem(WORKSPACE_LAYOUT_KEY) || "null");
		return saved ? { ...DEFAULT_WORKSPACE_LAYOUT, ...saved } : { ...DEFAULT_WORKSPACE_LAYOUT };
	} catch {
		return { ...DEFAULT_WORKSPACE_LAYOUT };
	}
}

/** Load the Scene envelope once. Legacy single-scene objects are migrated by
 * scenes.js; a new room starts empty (createSceneDocument seeds no objects). */
export function loadSceneStartup() {
	// The landing-page playground never reads or writes the visitor's saved
	// scenes: it opens the preset the page fetched (or an empty room if that
	// fetch failed) and saving stays off for the whole session.
	if (isPlaygroundEmbed(globalThis.location?.search)) {
		const preset = takePlaygroundProject();
		const document = preset?.document ?? createSceneDocument();
		return { document, saveBlocked: true, error: null, startupCreatedScene: false, toast: null };
	}
	try {
		const result = loadSceneDocumentFromStorage(localStorage);
		if (result.status === "future") {
			const document = createSceneDocument();
			return {
				document,
				saveBlocked: true,
				error: null,
				toast: ko("Saved scenes were written by a newer CozyClay — they have been left untouched and this session will not save", "저장된 장면은 더 최신 CozyClay에서 만들어졌어요. 이 세션에서는 건드리지 않고 저장도 하지 않습니다."),
			};
		}
		const document = result.document;
		return {
			document,
			saveBlocked: false,
			error: null,
			// The startup scene is authored silently; without this flag the
			// funnel's "scene created" step never fires for a brand-new room.
			startupCreatedScene: result.status === "absent" || result.status === "corrupt",
			toast: result.status === "corrupt"
				? ko("Saved scenes were unreadable — starting fresh; your previous scenes were kept for recovery", "저장된 장면을 읽을 수 없어 새로 시작합니다. 이전 장면은 복구용으로 보관했어요.", "无法读取已保存的场景 — 将重新开始；之前的场景已保留以便恢复。")
				: result.dropped > 0
					? ko(`${result.dropped} saved scene(s) could not be restored`, `저장된 장면 ${result.dropped}개를 복원하지 못했어요`, `${result.dropped} 个已保存的场景无法恢复`)
					: null,
		};
	} catch {
		const document = createSceneDocument();
		return { document, saveBlocked: false, error: null, startupCreatedScene: true, toast: null };
	}
}
