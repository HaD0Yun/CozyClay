#!/usr/bin/env node
// What the agent's checks show of a lowvis take is the take that is installed (eight agent turns read a playing take
// as frozen and made it again):
// - the block figure (skin-pose.js) takes its bones' pose whenever a render updates the scene's matrices, so a capture
//   that writes a frame's bones and renders at once (check pictures, own-camera views, exports) shows that frame's pose;
// - verify_result's views, beats and trace and frame_shot over "shot" read a raw take's own track (rawCompile), not a
//   compile of its spec, which has no keys and drew a figure standing at the origin;
// - a ghost of a rig the look hides draws the pose (ghost-set.js).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { TRACK_RIG, clipTrack } from "../../src/lowvis/studio/take.js";
import { followBones, jointBones } from "../../src/lowvis/studio/skin-pose.js";
import { LOOKS } from "../../src/lowvis/looks/index.js";
import { JOINTS } from "../../src/lowvis/rig17.js";
import { encodeRawTrack, decodeRawTrack } from "../../src/motion-v4/track/codec.js";
import { placedTake, rawCompile } from "../../src/motion-v4/track/literal.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { studioVisual } from "../../src/studio-motion-visual.js";
import { GhostSet } from "../../src/ghost-set.js";

const check = (name, fn) => { fn(); console.log(`PASS ${name}`); };
const near = (a, b, tol, what) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < tol, `${what}: ${a.map(x => x.toFixed(3))} vs ${b.map(x => x.toFixed(3))}`));

check("the block figure takes the pose its bones hold at each matrix update, with no frame of the render loop", () => {
	const scene = new THREE.Scene(), rig = new THREE.Group(), bones = JOINTS.map(name => Object.assign(new THREE.Bone(), { name: `mixamorig:${name}` }));
	for (const bone of bones) rig.add(bone);
	rig.position.set(2, 0, -1);
	const body = LOOKS.block({}), found = jointBones(rig);
	assert.deepEqual(found, bones, "each lowvis joint finds its rig bone");
	scene.add(rig, body.object3D);
	const undo = followBones(body, found), hips = body.object3D.children[0], at = new THREE.Vector3();
	for (const [frame, y] of [[0, 0.9], [70, 0.4], [71, 0.55]]) {
		// what an export does for one frame: write the bones, then render, which first updates the scene's matrices
		bones[0].position.set(0.1 * frame, y, 0);
		scene.updateMatrixWorld();
		near(hips.getWorldPosition(at).toArray(), [2 + 0.1 * frame, y, -1], 1e-6, `Hips of the figure at frame ${frame}`);
	}
	undo();
	bones[0].position.set(0, 0.2, 0);
	scene.updateMatrixWorld();
	near(hips.getWorldPosition(at).toArray(), [9.1, 0.55, -1], 1e-6, "after undo the figure no longer follows");
});

// the push clip: one figure walks 2 m and pushes a box; installed as motion.v4.install does it, standing where it starts
const clip = JSON.parse(readFileSync(new URL("../../public/lowvis/clips/pi/push.json", import.meta.url), "utf8"));
const sk = skeletonFor(TRACK_RIG), encoded = encodeRawTrack(clipTrack(clip, 0)), F = clip.frameCount;
const placement = { position: [clip.characters[0].pos[0], 0, clip.characters[0].pos[2]], yaw: 0 };
const take = placedTake(decodeRawTrack(encoded, sk), placement, { spec: { schema: "cozyclay.motion-spec.v1", fps: 24, frames: F, label: "push", raw: encoded }, prompt: "push" });
const clipHips = f => [0, 1, 2].map(k => clip.characters[0].pos[f * 17 * 3 + k]);

check("a raw take is read as its own track: the Hips go where the clip has them, in the world", () => {
	const r = rawCompile(take, []);
	assert.ok(r && r.out.frames.length === F);
	for (const f of [0, Math.floor(F / 2), F - 1]) near(r.out.frames[f].s.P[sk.index.Hips], clipHips(f), 1e-3, `Hips at frame ${f}`);
	assert.ok(Math.abs(clipHips(F - 1)[2] - clipHips(0)[2]) > 1.5, "the clip travels");
	assert.equal(rawCompile({ ...take, spec: { ...take.spec, raw: undefined } }, []), null, "a take without raw is left to the spec compile");
});

check("verify_result's trace of a raw take plots its hands, which move", () => {
	const s = { characters: [{ id: "man", model: TRACK_RIG, x: placement.position[0], z: placement.position[2], rot: 0 }], targets: new Map([["man", { motion: take }]]),
		objects: [], frameCount: F, revision: 1 };
	const result = { receiptId: null, visualRefs: [] };
	studioVisual({ targets: ["man"], visual: "trace" }, { s, receipt: null, result, images: new Map(), ports: { encodePng: () => "data:image/png;base64," } });
	const hand = result.visualRefs[0].series.find(row => row.name === "hand_l.y");
	assert.ok(hand.max - hand.min > 0.2, `the left hand rises and falls: ${JSON.stringify(hand)}`);
});

check("a ghost of a rig whose meshes a look hides draws those meshes; a mesh hidden otherwise stays hidden", () => {
	const rig = new THREE.Group(), geometry = new THREE.BoxGeometry(), material = new THREE.MeshBasicMaterial();
	const look = Object.assign(new THREE.Mesh(geometry, material), { name: "under", visible: false }), off = Object.assign(new THREE.Mesh(geometry, material), { name: "off", visible: false });
	look.userData.underLook = true;
	rig.add(look, off);
	const set = new GhostSet({ layer: 0 });
	set.setRig(rig);
	const slot = set.addSlot(), byName = name => slot.rig.getObjectByName(name);
	assert.equal(byName("under").visible, true);
	assert.equal(byName("off").visible, false);
	set.dispose();
});
console.log("verify-check-truth: all checks passed");
