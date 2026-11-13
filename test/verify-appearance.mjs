#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const props = readFileSync(new URL("../src/props.jsx", import.meta.url), "utf8");
const room = readFileSync(new URL("../src/room.jsx", import.meta.url), "utf8");
const dualview = readFileSync(new URL("../src/dualview.jsx", import.meta.url), "utf8");
const posestudio = readFileSync(new URL("../src/posestudio.jsx", import.meta.url), "utf8");
const ikHandlesSource = posestudio.slice(posestudio.indexOf("export function IkHandles"));
const stageCharacters = readFileSync(new URL("../src/stage-characters.jsx", import.meta.url), "utf8");

// A colour picker streams a tint every drag frame: rebuilding the clone for each one re-bound the rig (playback,
// IK, contact radii) and froze the Studio for ~190 ms a value.
const cloneDeps = stageCharacters.match(/\}, \[fbx[^\]]*\]\);/)?.[0] ?? "";
expect("a new character tint does not rebuild the rig clone", cloneDeps !== "" && !cloneDeps.includes("tint"), cloneDeps || "clone memo not found");
expect(
	"the tint recolours the clay materials in place and asks for a frame",
	stageCharacters.includes("child.material.color.copy(") && stageCharacters.includes("[model, tint, partColoursEnabled, invalidate]"),
);
expect(
	"legacy per-mesh outline modules are removed",
	!existsSync(new URL("../src/cozy-clay-appearance.jsx", import.meta.url)) &&
		!existsSync(new URL("../src/cozy-clay-style.js", import.meta.url)),
);
expect(
	"renderers contain no hull or geometry edge attachments",
	![app, props, room].some((source) =>
		source.includes("CozyClayOutlines") ||
		source.includes("<Outlines") ||
		source.includes("<Edges"),
	),
);
expect(
	"one screen-space pass owns all shot linework",
	dualview.includes("EDGE_FRAGMENT") &&
		dualview.includes("scene.overrideMaterial = edgePass.normalMaterial") &&
		dualview.includes("edgePass.passScene"),
);
expect(
	"line extraction uses a Sobel depth kernel",
	dualview.includes("depthX = dTL + 2.0 * dL") &&
		dualview.includes("depthY = dTL + 2.0 * dT"),
);
expect(
	"line extraction uses a Sobel normal kernel",
	dualview.includes("normalX = nTL + 2.0 * nL") &&
		dualview.includes("normalY = nTL + 2.0 * nT"),
);
expect(
	"depth silhouettes stay attached to the nearer surface",
	dualview.includes("foregroundOwner") &&
		dualview.includes("depthLine * foregroundOwner"),
);
expect(
	"distant outlines soften without disappearing or changing kernel width",
	dualview.includes("float distanceFade") &&
		dualview.includes("mix(0.42, 1.0") &&
		dualview.includes("3.0 / max(centerZ, 0.001)") &&
		dualview.includes("texel.x * 0.8") &&
		dualview.includes("edge * 0.38 * distanceFade"),
);
expect(
	"each pane renders into its own local edge target",
	dualview.includes("edgePass.target.setSize(targetWidth, targetHeight)") &&
		!dualview.includes("gl.setViewport(0, 0, targetWidth, targetHeight)") &&
		!dualview.includes("regionOrigin"),
);
expect(
	"plan view remains free of shot post-processing",
	dualview.includes("drawVisibleInset(planCam, planPane, null, false)") && !dualview.includes("drawVisibleInset(planCam, planPane, null, true)"),
);
expect(
	"IK controls emphasize the camera-nearest circles",
	posestudio.includes("camera.matrixWorldInverse") &&
		posestudio.includes("OPACITY_NEAR") &&
		posestudio.includes("OPACITY_FAR") &&
		posestudio.includes("MathUtils.smoothstep(closeness"),
);
expect(
	"IK circles mirror their real clickability",
	posestudio.includes("const clickable =") &&
		posestudio.includes("OPACITY_DISABLED_NEAR") &&
		posestudio.includes("OPACITY_DISABLED_FAR") &&
		posestudio.includes("clickable"),
);
expect(
	"occluded IK controls remain visible and pickable",
	posestudio.includes("ikControlIsExposed") &&
		posestudio.includes("visibilityRef.current.set(id, isExposed)") &&
		posestudio.includes("mesh.userData.ikExposed = isExposed") &&
		posestudio.includes("mesh.visible = true") &&
		posestudio.includes("handleRefs.current[p.track.id]?.visible") &&
		!posestudio.includes("handleRefs.current[p.track.id]?.userData.ikExposed === true"),
);
expect(
	"IK occlusion caches sampled skin proxies instead of re-skinning every ray",
	posestudio.includes("skinnedBlockerProxiesRef") &&
		posestudio.includes("positions.count / 6000") &&
		posestudio.includes("const staticBlockers = blockers.filter") &&
		!posestudio.includes("intersectObjects(blockers, false)"),
);
expect(
	"IK handles do not raycast on every camera pointer move",
	!ikHandlesSource.includes("onPointerOver") &&
		!ikHandlesSource.includes("onPointerOut"),
);
expect(
	"replaced rigs cannot retain stale skin proxy clouds",
	posestudio.includes("currentSkinnedBlockers") &&
		posestudio.includes("skinnedBlockerProxiesRef.current.delete(object)"),
);
expect(
	"gizmo arrows have forgiving invisible hit volumes",
	posestudio.includes("GIZMO_PICK_SHAFT_R") &&
		posestudio.includes("GIZMO_PICK_TIP_R") &&
		posestudio.includes('register(gizmoTrack, gizmoKind, dir, "hit-shaft")') &&
		posestudio.includes('register(gizmoTrack, gizmoKind, dir, "hit-tip")') &&
		posestudio.includes("opacity={0}"),
);
expect(
	"gizmo arrows and swing rings remain visible over the player body",
	posestudio.includes("depthTest={false} depthWrite={false} transparent opacity={0.85}") &&
		posestudio.includes("depthTest={false} depthWrite={false} transparent opacity={0.95}") &&
		posestudio.includes("backFaceFade(m)} color={color} toneMapped={false} depthTest={false}"),
);
expect(
	"unchanged IK frames reuse the previous exposure pass",
	posestudio.includes("exposureInputRef") &&
		posestudio.includes("if (exposureDirty)") &&
		posestudio.includes("exposurePerfRef.current.skippedFrames += 1"),
);

if (failures) process.exit(1);
console.log("all screen-space NPR appearance checks PASS");
