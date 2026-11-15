// The finish (stage-finish.js) in the Studio: one view-wide switch, remembered per browser and on by default, that the
// viewport panes, captures, exports and the agent's own pictures all follow (scene.userData.finishLook).
import { useEffect, useState } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { GIZMO_LAYER, POSER_LAYER } from "./dualview.jsx";
import { FINISH_LOOKS, applySurfaceLook, createFinish } from "./stage-finish.js";

const STORAGE_KEY = "cozyclay.toon-look.v1";

export function readStoredToonLook(storage) {
	try { return storage?.getItem(STORAGE_KEY) !== "0"; } catch { return true; }
}

/** [on, setOn] for the "Toon look" view setting. */
export function useToonLook() {
	const [on, setOn] = useState(() => readStoredToonLook(globalThis.localStorage));
	useEffect(() => { try { globalThis.localStorage?.setItem(STORAGE_KEY, on ? "1" : "0"); } catch { /* private window: the setting lasts this page only */ } }, [on]);
	return [on, setOn];
}

/** Puts the setting on the scene. window.__cozyFinish(name) is the QA hook: "toon" or "off". */
export function FinishSetting({ on, onChange }) {
	const scene = useThree((state) => state.scene), invalidate = useThree((state) => state.invalidate);
	useEffect(() => {
		scene.userData.finishLook = on ? FINISH_LOOKS.toon : null;
		if (!on) applySurfaceLook(scene, null);
		invalidate();
	}, [scene, on, invalidate]);
	useEffect(() => {
		window.__cozyFinish = (name) => {
			const look = FINISH_LOOKS[name] ?? null;
			scene.userData.finishLook = look;
			if (!look) applySurfaceLook(scene, null);
			onChange(!!look);
			return { on: look ? name : null, looks: Object.keys(FINISH_LOOKS) };
		};
		return () => { delete window.__cozyFinish; };
	}, [scene, onChange]);
	return null;
}

// The finished picture onto the canvas with the depth of its draw, so the editor furniture drawn after it is hidden where the set is in front.
const COMPOSITE = new THREE.ShaderMaterial({
	vertexShader: "varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }",
	fragmentShader: "uniform sampler2D tColor;\nuniform sampler2D tDepth;\nvarying vec2 vUv;\nvoid main() {\n\tgl_FragColor = texture2D( tColor, vUv );\n\tgl_FragDepth = texture2D( tDepth, vUv ).x;\n\t#include <colorspace_fragment>\n}",
	uniforms: { tColor: { value: null }, tDepth: { value: null } },
	depthFunc: THREE.AlwaysDepth, toneMapped: false,
});

/** A pane's draw with the look: the set through the finish into the current viewport of the canvas, then the UI layers as they are. */
export function createViewFinish() {
	const finish = createFinish(), quad = new FullScreenQuad(COMPOSITE);
	const output = new THREE.WebGLRenderTarget(1, 1, { colorSpace: THREE.SRGBColorSpace });
	function draw(gl, scene, camera, look, width, height) {
		output.setSize(width, height);
		const mask = camera.layers.mask, autoClear = gl.autoClear, background = scene.background, before = scene.onBeforeRender, after = scene.onAfterRender, shadowAuto = gl.shadowMap.autoUpdate;
		try {
			camera.layers.disable(GIZMO_LAYER);
			camera.layers.disable(POSER_LAYER);
			COMPOSITE.uniforms.tDepth.value = finish.render(gl, scene, camera, output, look);
			COMPOSITE.uniforms.tColor.value = output.texture;
			gl.autoClear = false;
			quad.render(gl);
			camera.layers.mask = mask & ((1 << GIZMO_LAYER) | (1 << POSER_LAYER));
			if (!camera.layers.mask) return;
			// no backdrop over the finished picture (stage-sky.jsx's hook would put one back)
			scene.background = null;
			scene.onBeforeRender = () => {};
			scene.onAfterRender = () => {};
			gl.shadowMap.autoUpdate = false;
			gl.render(scene, camera);
		} finally {
			camera.layers.mask = mask;
			gl.autoClear = autoClear;
			scene.background = background;
			scene.onBeforeRender = before;
			scene.onAfterRender = after;
			gl.shadowMap.autoUpdate = shadowAuto;
		}
	}
	function dispose() { finish.dispose(); quad.dispose(); output.dispose(); }
	return { draw, dispose };
}
