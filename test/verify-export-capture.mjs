import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";

// Exercise the CaptureRig effect through its public ref, with real cameras and
// render targets. Only the GPU calls are substituted at the readback boundary.
const source = readFileSync(new URL("../src/stage-capture.jsx", import.meta.url), "utf8");
const component = source.slice(source.indexOf("export function CaptureRig("), source.indexOf("export async function captureMcpFrame("));
const targets = [];
class RenderTarget extends THREE.WebGLRenderTarget {
	constructor(...args) {
		super(...args);
		this.disposals = 0;
		this.addEventListener("dispose", () => { this.disposals += 1; });
		targets.push(this);
	}
}
const scene = new THREE.Scene();
scene.fog = new THREE.Fog("white", 20, 50);
const initialTarget = { editor: true };
let currentTarget = initialTarget;
let capturedCamera;
let drawnInto;
let readbackError = null;
// what the renderer says it can draw into: a capture reads it once, when it is made
const extensionNames = new Set(["EXT_color_buffer_float"]);
const gl = {
	extensions: { has: (name) => extensionNames.has(name) },
	getRenderTarget: () => currentTarget,
	setRenderTarget: (target) => { currentTarget = target; },
	render: (_scene, camera) => { capturedCamera = camera; drawnInto = currentTarget; },
	readRenderTargetPixels(target, _x, _y, width, height, buffer) {
		assert.equal(target.width, width);
		assert.equal(target.height, height);
		assert.equal(target.disposals, 0, "capture target is still owned");
		if (readbackError) throw readbackError;
		buffer.fill(127);
	},
};
let cleanup;
const browser = {};
const page = { visibilityState: "visible" };
// The finish (stage-finish.js) is the toon look's frame pass; it draws only when scene.userData.finishLook is set,
// so this stub records its calls. With the look off the renderer draws the frame itself, into a target of its own
// that three treats as the canvas; a pass (an override material) is drawn into the plain target.
const finishes = [];
const createFinish = () => {
	const finish = { renders: [], disposals: 0, render(...args) { finish.renders.push(args); }, dispose() { finish.disposals += 1; } };
	finishes.push(finish);
	return finish;
};
const CaptureRig = new Function("THREE", "useThree", "useEffect", "window", "document", "GIZMO_LAYER",
	"CAPTURE_W", "CAPTURE_H", "MCP_CAPTURE_W", "MCP_CAPTURE_H", "CAPTURE_FOG_NEAR", "CAPTURE_FOG_FAR", "createFinish",
	`${component.replace("export function", "function")}; return CaptureRig;`)(
	{ ...THREE, WebGLRenderTarget: RenderTarget }, () => ({ gl, scene }), (effect) => { cleanup = effect(); },
	browser, page, 5, 1920, 1080, 640, 360, 55, 95, createFinish,
);
const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 100);
camera.position.set(1, 2, 3);
camera.layers.enable(5);
const apiRef = { current: null };
const camRef = { current: camera };
CaptureRig({ apiRef, camRef, width: 16, height: 9 });
const editorApi = apiRef.current;
const exportApi = editorApi.createExportCapture({ width: 12, height: 7 });
assert.equal(exportApi.scene, scene);
// The renderer itself stays usable in a hidden tab: the video export writes each
// frame's bones and camera before it renders, so only live captures are refused.
page.visibilityState = "hidden";
assert.equal(exportApi.render().byteLength, 12 * 7 * 4, "export rendering still works in a hidden tab");
capturedCamera = undefined;
page.visibilityState = "visible";
assert.equal(exportApi.render().byteLength, 12 * 7 * 4);
assert.equal(capturedCamera.aspect, 12 / 7);
assert.equal(capturedCamera.layers.isEnabled(5), false);
assert.equal(camera.aspect, 16 / 9, "export never changes the editing camera aspect");
assert.equal(camera.layers.isEnabled(5), true);
assert.equal(currentTarget, initialTarget);
assert.deepEqual([scene.fog.near, scene.fog.far], [20, 50]);
// With the look off the export is the canvas's draw: the renderer draws it, tone curve and encoding in the material,
// into a target of the export's own that three treats as the canvas (made on the first such draw).
assert.equal(finishes[0].renders.length, 0, "the look-off draw does not go through the finish");
const asCanvas = targets[2];
assert.equal(drawnInto, asCanvas);
assert.equal(asCanvas.isXRRenderTarget, true, "three tone-maps and encodes a draw into it as it does on the canvas");
assert.deepEqual([asCanvas.width, asCanvas.height, asCanvas.samples, asCanvas.texture.internalFormat], [12, 7, 4, "RGBA8"]);
// A pass is data, drawn as is into the plain target, not tone-mapped.
scene.overrideMaterial = new THREE.MeshNormalMaterial();
assert.equal(exportApi.render().byteLength, 12 * 7 * 4);
assert.equal(drawnInto, targets[1], "a pass is drawn into the plain target");
assert.equal(targets[1].isXRRenderTarget, undefined);
scene.overrideMaterial = null;
assert.equal(exportApi.render().byteLength, 12 * 7 * 4);
assert.equal(targets.length, 3, "the canvas-like target is made once");

cleanup();
assert.equal(targets[0].disposals, 1, "editor resize releases its own target");
assert.equal(targets[1].disposals, 0, "in-flight export target survives editor resize");
assert.equal(finishes[0].disposals, 0, "a resize during an export does not dispose the finish the export draws through");
CaptureRig({ apiRef, camRef, width: 9, height: 16 });
assert.equal(apiRef.current.render().byteLength, 9 * 16 * 4);
assert.equal(exportApi.render().byteLength, 12 * 7 * 4, "retry settings remain independent of live dimensions");

// With a look set, the frame goes through the finish into the attempt's own target, and is read back from it.
scene.userData.finishLook = { name: "toon" };
assert.equal(exportApi.render().byteLength, 12 * 7 * 4);
const drawn = finishes[0].renders.at(-1); // exportApi came from the first rig
assert.equal(drawn[0], gl);
assert.equal(drawn[1], scene);
assert.equal(drawn[3], targets[1], "the finish draws into the export's own target");
assert.equal(drawn[4], scene.userData.finishLook);
assert.equal(currentTarget, initialTarget, "a finished capture restores the render target");
delete scene.userData.finishLook;

// A pass is data with the look on too: it is not drawn through the finish (no ink lines on a depth plate).
scene.userData.finishLook = { name: "toon" };
scene.overrideMaterial = new THREE.MeshNormalMaterial();
const finished = finishes[0].renders.length;
assert.ok(exportApi.render() instanceof Uint8Array);
assert.equal(finishes[0].renders.length, finished, "a pass does not go through the look's finish");
assert.equal(drawnInto, targets[1], "it is drawn as is into the plain target");
delete scene.userData.finishLook;
// A pass that asks for its precision is drawn into a half-float target of the capture's own, made once, and read
// back as half floats; a pass that does not ask keeps its bytes.
assert.equal(exportApi.precise, true, "a renderer with float colour buffers reads a pass back at half-float precision");
const before = targets.length;
const half = exportApi.render({ precise: true });
assert.ok(half instanceof Uint16Array && half.length === 12 * 7 * 4, "the precise read-back is RGBA half floats");
const preciseTarget = targets.at(-1);
assert.equal(targets.length, before + 1);
assert.equal(drawnInto, preciseTarget);
assert.deepEqual([preciseTarget.width, preciseTarget.height, preciseTarget.samples, preciseTarget.texture.type], [12, 7, 4, THREE.HalfFloatType]);
assert.equal(preciseTarget.isXRRenderTarget, undefined, "data is not tone-mapped or encoded");
assert.equal(exportApi.render({ precise: true }), half);
assert.equal(targets.length, before + 1, "the half-float target is made once");
assert.ok(exportApi.render() instanceof Uint8Array, "an 8-bit pass still reads bytes");
assert.equal(drawnInto, targets[1]);
assert.equal(currentTarget, initialTarget, "a precise capture restores the render target");
scene.overrideMaterial = null;

readbackError = new Error("injected readback failure");
assert.throws(() => exportApi.render(), (error) => error === readbackError);
assert.equal(currentTarget, initialTarget, "failed capture restores render target");
assert.deepEqual([scene.fog.near, scene.fog.far], [20, 50], "failed capture restores fog");
exportApi.dispose();
assert.equal(targets[1].disposals, 1, "attempt cleanup releases the export target");
assert.equal(finishes[0].disposals, 1, "the export was the last holder of the old rig's finish: its cleanup frees it");
exportApi.dispose();
assert.equal(finishes[0].disposals + targets[1].disposals, 2, "a second dispose frees nothing twice");
assert.equal(asCanvas.disposals, 1, "attempt cleanup releases the export's canvas-like target with it");
assert.equal(preciseTarget.disposals, 1, "and its half-float target");
assert.equal(targets[3].disposals, 0, "attempt cleanup does not dispose the live preview");
// A renderer that cannot draw into a float colour buffer says so, and a capture of it makes no half-float target.
extensionNames.clear();
const plain = apiRef.current.createExportCapture({ width: 4, height: 4 });
assert.equal(plain.precise, false, "without float colour buffers a capture is 8-bit only");
plain.dispose();
extensionNames.add("EXT_color_buffer_half_float");
const halfOnly = apiRef.current.createExportCapture({ width: 4, height: 4 });
assert.equal(halfOnly.precise, true, "half-float colour buffers are enough");
halfOnly.dispose();
cleanup();
assert.ok(targets.every((target) => target.disposals === 1));
assert.ok(finishes.length >= 1 && finishes.every((finish) => finish.disposals === 1), "every rig's finish is released with it");
console.log("PASS independent export capture dimensions, resize survival, failure restoration and resource disposal");
