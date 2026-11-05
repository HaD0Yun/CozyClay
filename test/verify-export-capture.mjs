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
let readbackError = null;
const gl = {
	getRenderTarget: () => currentTarget,
	setRenderTarget: (target) => { currentTarget = target; },
	render: (_scene, camera) => { capturedCamera = camera; },
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
const CaptureRig = new Function("THREE", "useThree", "useEffect", "window", "document", "GIZMO_LAYER",
	"CAPTURE_W", "CAPTURE_H", "MCP_CAPTURE_W", "MCP_CAPTURE_H", "CAPTURE_FOG_NEAR", "CAPTURE_FOG_FAR",
	`${component.replace("export function", "function")}; return CaptureRig;`)(
	{ ...THREE, WebGLRenderTarget: RenderTarget }, () => ({ gl, scene }), (effect) => { cleanup = effect(); },
	browser, page, 5, 1920, 1080, 640, 360, 55, 95,
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

cleanup();
assert.equal(targets[0].disposals, 1, "editor resize releases its own target");
assert.equal(targets[1].disposals, 0, "in-flight export target survives editor resize");
CaptureRig({ apiRef, camRef, width: 9, height: 16 });
assert.equal(apiRef.current.render().byteLength, 9 * 16 * 4);
assert.equal(exportApi.render().byteLength, 12 * 7 * 4, "retry settings remain independent of live dimensions");

readbackError = new Error("injected readback failure");
assert.throws(() => exportApi.render(), (error) => error === readbackError);
assert.equal(currentTarget, initialTarget, "failed capture restores render target");
assert.deepEqual([scene.fog.near, scene.fog.far], [20, 50], "failed capture restores fog");
exportApi.dispose();
assert.equal(targets[1].disposals, 1, "attempt cleanup releases the export target");
assert.equal(targets[2].disposals, 0, "attempt cleanup does not dispose the live preview");
cleanup();
assert.ok(targets.every((target) => target.disposals === 1));
console.log("PASS independent export capture dimensions, resize survival, failure restoration and resource disposal");
