#!/usr/bin/env node
/**
 * External blockers for Fix Collisions: scene objects become boxes, the other
 * cast members become capsules, and both speak the id namespace the App's QA
 * surface reads back (`obj:<id>`, `char:<id>:<capsuleId>`).
 *
 * Standalone by design: this exercises the blocker BUILDERS, not the solver,
 * so it stays green while fix-collisions.js grows its `blockers` option.
 */
import * as THREE from "three";
import {
	sceneObjectBlockers,
	characterBlockers,
	collisionBlockers,
	blockerSummary,
	objectBlockerId,
	characterBlockerId,
	blockerCharacterId,
} from "../../src/motion/collision-blockers.js";
import { OBJECT_LIBRARY, createSceneObject, createCutoutObject, CUTOUT_THICKNESS } from "../../src/scene-objects.js";

let failures = 0;
function check(name, cond, detail = "") {
	if (cond) console.log(`PASS ${name}`);
	else {
		failures += 1;
		console.log(`FAIL ${name}${detail ? " — " + detail : ""}`);
	}
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

/* --- scene objects ---------------------------------------------------------- */

// A library cube at (2, 0, 3), yawed 30°.
const cube = { ...createSceneObject("cube", []), x: 2, z: 3, rot: 30 };
const plane = { ...createSceneObject("plane", [cube]), x: 0, z: 0 };
const cutout = { ...createCutoutObject({ assetId: "asset-1", aspect: 0.5, height: 1.8 }, [cube, plane]), x: -1, z: 4, rot: 90 };

const boxes = sceneObjectBlockers([cube, plane, cutout], { library: OBJECT_LIBRARY });
check("a plane (height 0) is not a blocker", !boxes.some((b) => b.id === objectBlockerId(plane.id)), JSON.stringify(boxes.map((b) => b.id)));
check("cube and cutout both become blockers", boxes.length === 2, String(boxes.length));

const cubeBox = boxes.find((b) => b.id === "obj:cube");
check("cube blocker uses the obj: namespace", !!cubeBox, JSON.stringify(boxes.map((b) => b.id)));
check("cube blocker is a box", cubeBox.kind === "box");
check(
	"cube centre sits half a height above its base at its floor position",
	near(cubeBox.center.x, 2) && near(cubeBox.center.y, 0.5) && near(cubeBox.center.z, 3),
	`${cubeBox.center.x},${cubeBox.center.y},${cubeBox.center.z}`,
);
check(
	"cube half extents are half the footprint and half the height",
	near(cubeBox.halfExtents.x, 0.5) && near(cubeBox.halfExtents.y, 0.5) && near(cubeBox.halfExtents.z, 0.5),
	JSON.stringify(cubeBox.halfExtents),
);
check("cube yaw is rot in radians", near(cubeBox.yaw, (30 * Math.PI) / 180), String(cubeBox.yaw));

// A cutout is a card: its width is DERIVED from height × aspect, its depth is
// the card thickness. The blocker must be that thin box, not a fat guess.
const cardBox = boxes.find((b) => b.id.startsWith("obj:cutout"));
check(
	"cutout becomes a thin card box (width = height × aspect, depth = thickness)",
	near(cardBox.halfExtents.x, (1.8 * 0.5) / 2) && near(cardBox.halfExtents.y, 0.9) && near(cardBox.halfExtents.z, CUTOUT_THICKNESS / 2),
	JSON.stringify(cardBox.halfExtents),
);
check("cutout yaw follows its rot", near(cardBox.yaw, Math.PI / 2), String(cardBox.yaw));

// Instance overrides: scale and a raised base go through objectSize / the y
// rule, not through the library numbers.
const scaled = { ...cube, id: "big", y: 1.5, scaleX: 2, scaleY: 3, scaleZ: 0.5 };
const [scaledBox] = sceneObjectBlockers([scaled], { library: OBJECT_LIBRARY });
check(
	"instance scale and raised base are respected",
	near(scaledBox.halfExtents.x, 1) && near(scaledBox.halfExtents.y, 1.5) && near(scaledBox.halfExtents.z, 0.25) && near(scaledBox.center.y, 1.5 + 1.5),
	JSON.stringify([scaledBox.halfExtents, scaledBox.center]),
);

// A record with no footprint at all falls back to the library entry rather
// than being dropped.
const bare = { id: "bare", renderer: "capsule", x: 1, y: 0, z: 1, rot: 0 };
const [bareBox] = sceneObjectBlockers([bare], { library: OBJECT_LIBRARY });
check("a footprint-less record resolves from the library", !!bareBox && near(bareBox.halfExtents.y, 1.4 / 2), JSON.stringify(bareBox ?? null));
check("without a library a footprint-less record is skipped", sceneObjectBlockers([bare]).length === 0);

// An attached prop's numbers are local to a bone frame — placing that box in
// world space would put a solid obstacle at a fictional position.
check("an attached prop is skipped", sceneObjectBlockers([{ ...cube, id: "held", attach: { characterId: "a", bone: "rightHand" } }], { library: OBJECT_LIBRARY }).length === 0);
check("skipIds drops a named object", sceneObjectBlockers([cube], { library: OBJECT_LIBRARY, skipIds: ["cube"] }).length === 0);
check("an empty scene yields no blockers", sceneObjectBlockers([]).length === 0 && sceneObjectBlockers(null).length === 0);

// A prop on a travel path stands somewhere else on every frame.
const walker = {
	...cube,
	id: "walker",
	x: 0,
	z: 0,
	path: { points: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }], speed: 0, loop: false, faceTravel: false, timing: "linear", extend: false },
};
const take = { frameCount: 11, fps: 10 };
const [at0] = sceneObjectBlockers([walker], { library: OBJECT_LIBRARY, frame: 0, take });
const [at10] = sceneObjectBlockers([walker], { library: OBJECT_LIBRARY, frame: 10, take });
check("a routed prop is sampled at the frame", at0.center.x < at10.center.x - 5, `${at0.center.x} → ${at10.center.x}`);
check("without a frame a routed prop stands at its authored position", near(sceneObjectBlockers([walker], { library: OBJECT_LIBRARY })[0].center.x, 0));

/* --- other cast members ----------------------------------------------------- */

/* Synthetic Mixamo-spelled rig in a T-pose: arms along ±X, legs along -Y, toes
 * forward (+Z). Rig scaled 0.01 (cm → m). Same layout as test/ik/verify-ik.mjs. */
function makeRig(withFingers = false) {
	const rig = new THREE.Object3D();
	rig.scale.setScalar(0.01);
	const mk = (name, parent, x, y, z) => {
		const b = new THREE.Bone();
		b.name = name;
		b.position.set(x, y, z);
		parent.add(b);
		return b;
	};
	const hips = mk("mixamorigHips", rig, 0, 100, 0);
	const spine = mk("mixamorigSpine", hips, 0, 15, 0);
	const chest = mk("mixamorigSpine1", spine, 0, 15, 0);
	mk("mixamorigSpine2", chest, 0, 15, 0);
	const neck = mk("mixamorigNeck", chest, 0, 30, 0);
	const head = mk("mixamorigHead", neck, 0, 15, 0);
	mk("mixamorigHeadTop_End", head, 0, 20, 0);
	const lShoulder = mk("mixamorigLeftShoulder", chest, 10, 25, 0);
	const rShoulder = mk("mixamorigRightShoulder", chest, -10, 25, 0);
	const lArm = mk("mixamorigLeftArm", lShoulder, 10, -10, 0);
	const lFore = mk("mixamorigLeftForeArm", lArm, 30, 0, 0);
	const lHand = mk("mixamorigLeftHand", lFore, 30, 0, 0);
	const rArm = mk("mixamorigRightArm", rShoulder, -10, -10, 0);
	const rFore = mk("mixamorigRightForeArm", rArm, -30, 0, 0);
	const rHand = mk("mixamorigRightHand", rFore, -30, 0, 0);
	// A full Mixamo hand: five fingers a side, base joint to tip. Only rigs
	// built with `withFingers` carry them, so the fixture can show that the
	// exclusion is a CHOICE and not just a rig that never had fingers.
	if (withFingers) {
		for (const [hand, sign] of [[lHand, 1], [rHand, -1]]) {
			const side = sign > 0 ? "Left" : "Right";
			for (const finger of ["Thumb", "Index", "Middle", "Ring", "Pinky"]) {
				let joint = hand;
				for (let n = 1; n <= 4; n += 1) joint = mk(`mixamorig${side}Hand${finger}${n}`, joint, sign * 3, 0, 0);
			}
		}
	}
	const lUp = mk("mixamorigLeftUpLeg", hips, 10, 0, 0);
	const lLeg = mk("mixamorigLeftLeg", lUp, 0, -45, 0);
	const lFoot = mk("mixamorigLeftFoot", lLeg, 0, -45, 0);
	mk("mixamorigLeftToeBase", lFoot, 0, -5, 12);
	const rUp = mk("mixamorigRightUpLeg", hips, -10, 0, 0);
	const rLeg = mk("mixamorigRightLeg", rUp, 0, -45, 0);
	const rFoot = mk("mixamorigRightFoot", rLeg, 0, -45, 0);
	mk("mixamorigRightToeBase", rFoot, 0, -5, 12);
	rig.updateMatrixWorld(true);
	return rig;
}

const other = makeRig();
other.position.set(1.2, 0, 0); // the second cast member stands off to the side
other.updateMatrixWorld(true);
const rigs = { a: makeRig(), b: other, c: null };

const caps = characterBlockers(rigs, "a");
check("only the OTHER cast members become blockers", caps.length === 15, String(caps.length));
check("a null rig is skipped", !caps.some((c) => c.id.startsWith("char:c:")));
check("every blocker uses the char:<id>:<capsuleId> namespace", caps.every((c) => c.id.startsWith("char:b:")), caps[0]?.id);
check("blockers are capsules with a, b and a radius", caps.every((c) => c.kind === "capsule" && c.a instanceof THREE.Vector3 && c.b instanceof THREE.Vector3 && c.radius > 0));
check("the capsule table's own ids come through", caps.some((c) => c.id === characterBlockerId("b", "torso")) && caps.some((c) => c.id === characterBlockerId("b", "leftHand")), JSON.stringify(caps.map((c) => c.id)));
check("id round-trips to its character", blockerCharacterId(characterBlockerId("b", "torso")) === "b" && blockerCharacterId("obj:cube") === null);
check(
	"capsules are WORLD space — they carry the other rig's stage position",
	caps.find((c) => c.id === characterBlockerId("b", "torso")).a.x > 1.1,
	String(caps.find((c) => c.id === characterBlockerId("b", "torso")).a.x),
);

// Following the other rig: move it and rebuild, exactly as the whole-clip pass
// does after posing everyone at the next frame.
other.position.set(3.4, 0, 0);
other.updateMatrixWorld(true);
const moved = characterBlockers(rigs, "a");
check("rebuilt blockers follow the other rig's pose", near(moved.find((c) => c.id === characterBlockerId("b", "torso")).a.x - caps.find((c) => c.id === characterBlockerId("b", "torso")).a.x, 2.2, 1e-6));

check("no active id means the whole cast blocks", characterBlockers(rigs, null).length === 30, String(characterBlockers(rigs, null).length));
check("a Map of rigs reads the same as a plain object", characterBlockers(new Map(Object.entries(rigs)), "a").length === 15);
check("an empty cast yields no blockers", characterBlockers(null, "a").length === 0 && characterBlockers({}, "a").length === 0);

// A rig the capsule table cannot describe is skipped, never fatal.
const stranger = new THREE.Object3D();
stranger.add(Object.assign(new THREE.Bone(), { name: "root" }));
check("an unsupported rig is skipped, the rest still block", characterBlockers({ a: makeRig(), b: other, z: stranger }, "a").length === 15);

// ANOTHER character's fingers are ~11 mm thin and there are ten of them: they
// are not obstacles, and including them would nearly treble the pair loop.
const handy = makeRig(true);
handy.updateMatrixWorld(true);
const handyCaps = characterBlockers({ a: makeRig(), b: handy }, "a");
check("a rig WITH fingers still contributes only its 15 body capsules", handyCaps.length === 15, String(handyCaps.length));
check(
	"no finger capsule becomes a blocker",
	!handyCaps.some((c) => /Hand(Thumb|Index|Middle|Ring|Pinky)/.test(c.id)),
	JSON.stringify(handyCaps.filter((c) => /Hand(Thumb|Index|Middle|Ring|Pinky)/.test(c.id)).map((c) => c.id)),
);
check("the palm capsule itself is still a blocker", handyCaps.some((c) => c.id === characterBlockerId("b", "leftHand")));

// A GHOST: undo removes the second subject, but the rig map can still hold the
// entry it was mounted under. The cast list is the authority — a body nobody
// can see must not go on blocking.
const ghostRigs = { a: makeRig(), b: other, gone: makeRig() };
check(
	"a rig whose character has left the cast contributes nothing",
	characterBlockers(ghostRigs, "a", { characterIds: ["a", "b"] }).every((c) => !c.id.startsWith("char:gone:")),
	JSON.stringify([...new Set(characterBlockers(ghostRigs, "a", { characterIds: ["a", "b"] }).map((c) => blockerCharacterId(c.id)))]),
);
check("the surviving cast still blocks", characterBlockers(ghostRigs, "a", { characterIds: ["a", "b"] }).length === 15);
check("character RECORDS work as the cast list too", characterBlockers(ghostRigs, "a", { characterIds: [{ id: "a" }, { id: "b" }] }).length === 15);
const hiddenRig = makeRig();
hiddenRig.updateMatrixWorld(true);
check(
	"a hidden cast record does not block",
	characterBlockers({ a: makeRig(), b: hiddenRig }, "a", { characterIds: [{ id: "a" }, { id: "b", hidden: true }] }).length === 0,
);
const hiddenProp = { ...cube, id: "ghost-box", hidden: true };
check("a hidden prop is not a blocker", sceneObjectBlockers([hiddenProp], { library: OBJECT_LIBRARY }).length === 0);
const hiddenParent = { ...cube, hidden: true };
const hiddenChild = { ...createSceneObject("cube", [cube]), id: "child", parent: hiddenParent.id };
check(
	"a child of a hidden parent is not a blocker",
	sceneObjectBlockers([hiddenParent, hiddenChild], { library: OBJECT_LIBRARY }).length === 0,
);
const carried = { ...cube, id: "carried", attach: { characterId: "a" } };
const cargo = { ...createSceneObject("cube", [cube]), id: "cargo", parent: "carried" };
check(
	"a child of a prop on a hidden character is not a blocker",
	sceneObjectBlockers([carried, cargo], { library: OBJECT_LIBRARY, characters: [{ id: "a", hidden: true }] }).length === 0,
);
check("no cast list means no opinion — every mounted rig blocks", characterBlockers(ghostRigs, "a").length === 30);
check("an empty cast list blocks nothing", characterBlockers(ghostRigs, "a", { characterIds: [] }).length === 0);
check(
	"collisionBlockers passes the cast list through",
	collisionBlockers({ rigs: ghostRigs, activeId: "a", characterIds: ["a", "b"], sceneObjects: [cube], library: OBJECT_LIBRARY }).length === 16,
);

/* --- combined + summary ------------------------------------------------------ */

const all = collisionBlockers({ rigs, activeId: "a", sceneObjects: [cube, plane], library: OBJECT_LIBRARY });
check("collisionBlockers merges cast and scene", all.length === 16 && all.some((b) => b.id === "obj:cube") && all.some((b) => b.id.startsWith("char:b:")), String(all.length));

const summary = blockerSummary(all);
check("summary is JSON-safe", JSON.parse(JSON.stringify(summary)).length === 16);
check("summary keeps every id and kind", summary.every((s) => typeof s.id === "string" && (s.kind === "box" || s.kind === "capsule")));
check("summary flattens vectors to numbers", summary.every((s) => Object.values(s).every((v) => typeof v === "string" || Number.isFinite(v))), JSON.stringify(summary[0]));
check("box summary carries centre, half extents and yaw", (() => {
	const s = summary.find((each) => each.id === "obj:cube");
	return near(s.cx, 2) && near(s.cy, 0.5) && near(s.hz, 0.5) && near(s.yaw, (30 * Math.PI) / 180);
})());
check("capsule summary carries both endpoints and the radius", (() => {
	const s = summary.find((each) => each.id === characterBlockerId("b", "torso"));
	return Number.isFinite(s.ax) && Number.isFinite(s.by) && s.radius > 0;
})());

if (failures) {
	console.log(`${failures} collision-blocker check(s) FAILED`);
	process.exit(1);
}
console.log("all collision blocker checks PASS");
