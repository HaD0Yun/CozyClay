#!/usr/bin/env node
// Depth/normal passes (#165). The override material is borrowed from the LIVE
// scene the viewport draws from, so the only thing that keeps the studio from
// turning permanently grey is putting it back. These checks pin the naming and
// that restore, including on a render that throws.
import assert from "node:assert/strict";
import * as THREE from "three";
import { passFileName, renderPass, PASS_KINDS, DEPTH_RANGE_M, depthGrey } from "../src/render-passes.js";
import { applyPoseFade } from "../src/pose-fade.js";

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
assert.equal(inverseRig.seen[0].uniforms.uCurve.value, 1, "the nearness curve");
assert.equal(depthRig.seen[0].uniforms.uCurve.value, 0, "a still pass keeps the linear curve");
assert.equal(depthRig.seen[0].fog, false, "the stage fog does not tint the depth plate");
assert.match(depthRig.seen[0].fragmentShader, /return 1\.0 - clamp\(\(d - near\)/, "near reads white, far reads black");
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

// The depth pass and what has no solid surface. A node that draws its own distance (particles, trails) is asked to for
// the draw and released after; a see-through mesh is drawn through a veil of the pass's material at the share of what
// is behind it that the picture covers, and gets its own material back; the normal pass does neither.
{
	const veilScene = new THREE.Scene();
	const pane = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.3 }));
	const glass = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshPhysicalMaterial({ transmission: 1 }));
	const solid = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
	const mixed = new THREE.Mesh(new THREE.BoxGeometry(), [new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.3 }), new THREE.MeshStandardMaterial()]);
	const asked = [], particles = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5 }));
	particles.userData.ownDepth = (ramp) => asked.push(ramp);
	veilScene.add(pane, glass, solid, mixed, particles);
	const own = { pane: pane.material, glass: glass.material, solid: solid.material, mixed: mixed.material, particles: particles.material };
	const drawn = [];
	const rig = { render(options) { drawn.push({ options: options ?? null, override: veilScene.overrideMaterial, pane: pane.material, glass: glass.material, solid: solid.material, mixed: mixed.material, particles: particles.material }); return new Uint8Array(4); } };
	renderPass(rig, veilScene, camera, "depth", null, { depthCurve: "log" });
	const at = drawn[0];
	assert.ok(at.pane !== own.pane && at.pane.uniforms.uCover.value === 0.3, "a pane at part opacity is drawn through a veil of that opacity");
	assert.ok(at.pane.transparent && at.pane.depthWrite === false && at.pane.allowOverride === false, "the veil is drawn after the solids, writes no depth and is not overridden");
	assert.equal(at.glass.uniforms.uCover.value, 0.22, "clear glass covers the share the plain pane covers");
	assert.equal(at.pane.uniforms.uNear, at.override.uniforms.uNear, "the veil shares the pass's ramp");
	assert.equal(at.override.uniforms.uCover.value, 1, "the pass itself covers what it draws whole");
	assert.equal(at.solid, own.solid, "a solid keeps its material (the scene override draws it)");
	assert.equal(at.mixed, own.mixed, "a mesh with one solid material is a solid");
	assert.equal(at.particles, own.particles, "a node that draws its own distance is not veiled");
	assert.equal(asked.length, 2, "it is asked for the draw and released after");
	assert.deepEqual(asked[0], { near: 0.25, far: DEPTH_RANGE_M, curve: 2 }, "with the pass's ramp");
	assert.equal(asked[1], null);
	assert.deepEqual([pane.material, glass.material, solid.material, mixed.material], [own.pane, own.glass, own.solid, own.mixed], "every mesh has its own material back");
	assert.equal(at.options, null, "an 8-bit pass asks the capture for nothing");
	renderPass(rig, veilScene, camera, "depth", null, { depthCurve: "ratio", precise: true });
	assert.deepEqual(drawn[1].options, { precise: true }, "the precise pass asks the capture for a half-float read-back");
	assert.equal(asked[2].curve, 3, "and is drawn by ratio, written as it is");
	asked.length = 0;
	renderPass(rig, veilScene, camera, "normal");
	assert.equal(drawn[2].pane, own.pane, "the normal pass veils nothing");
	assert.equal(asked.length, 0, "and asks no node for its own distance");
	const failing = { render() { throw new Error("context lost"); } };
	assert.throws(() => renderPass(failing, veilScene, camera, "depth"), /context lost/);
	assert.equal(pane.material, own.pane, "a draw that throws still gives the materials back");
	// Pose mode's working fade is an editing aid: a prop it fades is as solid in the plate as it is in the set, and a
	// pane keeps the share it was authored with. A mesh with no material at all is left alone.
	const prop = new THREE.Group(), crate = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
	const tinted = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()), bare = new THREE.Mesh(new THREE.BoxGeometry(), []);
	const tintedProp = new THREE.Group();
	prop.add(crate); tintedProp.add(tinted);
	veilScene.add(prop, tintedProp, bare);
	applyPoseFade(prop, 0.2, 1);
	applyPoseFade(tintedProp, 0.2, 0.5);
	assert.deepEqual([crate.material.opacity, tinted.material.opacity], [0.2, 0.1], "the working fade is on the materials the pass meets");
	const faded = { crate: crate.material, tinted: tinted.material };
	const seen = [];
	renderPass({ render() { seen.push({ crate: crate.material, tinted: tinted.material, bare: bare.material }); return new Uint8Array(4); } }, veilScene, camera, "depth");
	assert.equal(seen[0].crate, faded.crate, "a prop under the working fade is a solid in the depth plate");
	assert.equal(seen[0].tinted.uniforms.uCover.value, 0.5, "a pane under the working fade is veiled at its authored share");
	assert.ok(Array.isArray(seen[0].bare) && seen[0].bare.length === 0, "a mesh without materials is not veiled");
	assert.equal(tinted.material, faded.tinted, "and has its faded material back");
	console.log("PASS render passes: see-through meshes are veiled for the depth draw and restored; own-distance nodes are asked and released");
}
