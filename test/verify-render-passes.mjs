#!/usr/bin/env node
// Depth/normal passes (#165). The override material is borrowed from the LIVE
// scene the viewport draws from, so the only thing that keeps the studio from
// turning permanently grey is putting it back. These checks pin the naming and
// that restore, including on a render that throws.
import assert from "node:assert/strict";
import * as THREE from "three";
import { passFileName, renderPass, PASS_KINDS, DEPTH_RANGE_M, depthGrey } from "../src/render-passes.js";

assert.equal(depthGrey(0.1, 0.1, 40, "inverse"), 1);
assert.equal(depthGrey(40, 0.1, 40, "inverse"), 0);
assert.equal(depthGrey(80, 0.1, 40, "inverse"), 0);
assert(depthGrey(0.2, 0.1, 40, "inverse") < depthGrey(0.2, 0.1, 40));
assert.equal(depthGrey(20.05, 0.1, 40), 0.5);
assert.equal(passFileName("depth"), "blocking-frame-depth.png");
assert.equal(passFileName("normal"), "blocking-frame-normal.png");
assert.throws(() => passFileName("albedo"), /Unknown render pass: albedo/, "an unknown pass is a hard error, not a mystery file name");
assert.deepEqual(PASS_KINDS, ["depth", "normal"]);
console.log("PASS render passes: file names for depth and normal, unknown kinds rejected");

// A stub rig that records what the scene looked like at the moment of the draw.
function stubCapture(scene, { fail = false } = {}) {
	const seen = [];
	const backgrounds = [];
	return {
		seen,
		backgrounds,
		render() {
			seen.push(scene.overrideMaterial);
			backgrounds.push(scene.background);
			if (fail) throw new Error("context lost");
			return new Uint8Array([1, 2, 3, 255]);
		},
	};
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.25, 100);

const depthRig = stubCapture(scene);
const depthBuffer = renderPass(depthRig, scene, camera, "depth");
assert.equal(depthRig.seen.length, 1, "the depth pass renders exactly once");
assert.ok(depthRig.seen[0] instanceof THREE.ShaderMaterial, "the depth pass overrides with the depth-to-grey shader");
assert.equal(depthRig.seen[0].uniforms.uNear.value, 0.25, "the ramp starts at the shot camera's near plane");
assert.equal(depthRig.seen[0].uniforms.uRange.value, DEPTH_RANGE_M, "the ramp spans the stage's working depth");
for (const chunk of ["common", "skinning_pars_vertex", "skinbase_vertex", "begin_vertex", "skinning_vertex"]) assert.ok(depthRig.seen[0].vertexShader.includes(`#include <${chunk}>`));
assert.match(depthRig.seen[0].vertexShader, /vec4\(transformed, 1\.0\)/);
const inverseRig = stubCapture(scene);
renderPass(inverseRig, scene, camera, "depth", null, { depthCurve: "inverse" });
assert.equal(inverseRig.seen[0].uniforms.uInverse.value, true);
assert.equal(depthRig.seen[0].uniforms.uInverse.value, false);
assert.equal(depthRig.seen[0].fog, false, "the stage fog does not tint the depth plate");
assert.match(depthRig.seen[0].fragmentShader, /1\.0 - normalized/, "near reads white, far reads black");
assert.equal(scene.overrideMaterial, null, "the depth override is taken back off the scene");
assert.deepEqual([...depthBuffer], [1, 2, 3, 255], "without a converter the raw read-back comes back");

// Empty sky is infinitely far away: on a depth plate it reads black, not the
// studio's grey stage colour.
const stageBackground = new THREE.Color("#232428");
scene.background = stageBackground;
const backgroundRig = stubCapture(scene);
renderPass(backgroundRig, scene, camera, "depth");
assert.equal(backgroundRig.backgrounds[0].getHex(), 0x000000, "the depth pass draws over a black sky");
assert.equal(scene.background, stageBackground, "the stage colour is put back after the depth pass");
const normalBackgroundRig = stubCapture(scene);
renderPass(normalBackgroundRig, scene, camera, "normal");
assert.equal(normalBackgroundRig.backgrounds[0], stageBackground, "the normal pass leaves the sky alone");
scene.background = null;

const normalRig = stubCapture(scene);
const dataUrl = renderPass(normalRig, scene, camera, "normal", (buffer) => `data:image/png;base64,${buffer.length}`);
assert.ok(normalRig.seen[0] instanceof THREE.MeshNormalMaterial, "the normal pass overrides with MeshNormalMaterial");
assert.equal(scene.overrideMaterial, null, "the normal override is taken back off the scene");
assert.equal(dataUrl, "data:image/png;base64,4", "the buffer goes through the caller's PNG encoder");
console.log("PASS render passes: overrideMaterial is set for the draw and restored after");

// A pass taken while another override is in place must restore THAT one, not null.
const existing = new THREE.MeshBasicMaterial();
scene.overrideMaterial = existing;
renderPass(stubCapture(scene), scene, camera, "depth");
assert.equal(scene.overrideMaterial, existing, "an override that was already in place survives the pass");
scene.overrideMaterial = null;

// A render that throws still gives the scene back.
const brokenRig = stubCapture(scene, { fail: true });
assert.throws(() => renderPass(brokenRig, scene, camera, "normal"), /context lost/);
assert.equal(scene.overrideMaterial, null, "a failed render does not leave the studio wearing the pass material");
console.log("PASS render passes: a failed render restores the scene material");

// Missing rig, scene or camera is "not ready", not a crash.
assert.equal(renderPass(null, scene, camera, "depth"), null);
assert.equal(renderPass(stubCapture(scene), null, camera, "depth"), null);
assert.equal(renderPass(stubCapture(scene), scene, null, "depth"), null);
// A rig that renders nothing (no shot camera yet) reports nothing.
assert.equal(renderPass({ render: () => null }, scene, camera, "depth", () => "never"), null);
assert.throws(() => renderPass(stubCapture(scene), scene, camera, "albedo"), /Unknown render pass/);
assert.equal(scene.overrideMaterial, null, "the rejected kind never touched the scene");
console.log("PASS render passes: an unready rig reports null instead of throwing");
