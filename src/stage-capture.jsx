import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { GIZMO_LAYER } from "./dualview.jsx";
import { withFaded } from "./capture-fade.js";

export const CAPTURE_W = 1920;
export const CAPTURE_H = 1080;
export const MCP_CAPTURE_W = 640;
export const MCP_CAPTURE_H = 360;
export const MCP_CAPTURE_SAMPLE_STEP = 32;
// How far the deck runs in an EXPORTED frame. The viewport fades it out at
// 18..54 m to keep the working view clean; a blocking frame needs the far edge
// to survive, so the falloff starts later and ends further away, letting the
// floor resolve into a horizon instead of dissolving into the background.
//
// Both values must stay inside the shot camera's far plane (100 m) — geometry
// past it is clipped outright, so a fog range that ended beyond it would cut
// the deck off mid-fade and take the horizon with it.
export const CAPTURE_FOG_NEAR = 55;
export const CAPTURE_FOG_FAR = 95;

/** Offscreen aspect-aware read-back, always from the shot camera. */
export function CaptureRig({ apiRef, camRef, width = CAPTURE_W, height = CAPTURE_H }) {
	const { gl, scene } = useThree();
	useEffect(() => {
		// Each attempt owns its target independently of the live output size.
		// Resizing the editor cannot dispose an in-flight export's resources.
		// `camera` makes the camera of each render: a clone of the shot camera unless a caller
		// (renderView) brings its own; the shot camera itself is never moved.
		function createExportCapture({ width, height }, camera = () => camRef.current?.clone()) {
			const target = new THREE.WebGLRenderTarget(width, height, {
				colorSpace: THREE.SRGBColorSpace,
				samples: 4,
			});
			const buffer = new Uint8Array(width * height * 4);
			return {
				scene,
				dispose: () => target.dispose(),
				render() {
					const cam = camera();
					if (!cam) return null;
					// the transform gizmo is UI: it never reaches an exported frame
					cam.layers.disable(GIZMO_LAYER);
					// QA hook: the layer mask the export camera actually renders
					// with — the browser suite asserts GIZMO_LAYER (the gizmo AND
					// the selection cage) is never in it.
					window.__captureCameraMask = cam.layers.mask;
					// A view offset (a crop of a wider frustum) already fixes the aspect.
					if (!cam.view?.enabled) cam.aspect = width / height;
					cam.updateProjectionMatrix();
					const previous = gl.getRenderTarget();
					// The viewport's fog dissolves the deck into the background by ~54 m
					// so the working view has no horizon to distract from blocking. An
					// exported frame wants the opposite: the horizon IS the vanishing
					// point, and without it the floor has no far edge to read depth
					// against. Push the falloff back for this draw only, then restore
					// it so the viewport is untouched. Haze (stage.lighting.fog, set by
					// StageAtmosphere) is part of the look, so it brings its own range.
					const fog = scene.fog;
					const fogNear = fog?.near;
					const fogFar = fog?.far;
					const look = scene.userData.stageCapture;
					if (fog) {
						fog.near = look?.fog?.near ?? CAPTURE_FOG_NEAR;
						fog.far = look?.fog?.far ?? CAPTURE_FOG_FAR;
					}
					// three tone-maps only the canvas, never a render target, so the
					// viewport's exposure reaches an export as light: every light, and
					// the environment light, is scaled by it for this draw and put back after.
					const scaled = [], environmentIntensity = scene.environmentIntensity, backgroundIntensity = scene.backgroundIntensity, fogColor = fog?.color.clone();
					if (look && look.exposure !== 1) scene.traverse((node) => { if (node.isLight) scaled.push([node, node.intensity]); });
					for (const [light, intensity] of scaled) light.intensity = intensity * look.exposure;
					if (look && look.exposure !== 1) scene.environmentIntensity = environmentIntensity * look.exposure;
					// An HDR backdrop (stage.lighting.hdrBackground) is light too, and so is the horizon the deck fades into.
					if (look?.backdrop && look.exposure !== 1) {
						scene.backgroundIntensity = backgroundIntensity * look.exposure;
						fog?.color.multiplyScalar(look.exposure);
					}
					try {
						gl.setRenderTarget(target);
						gl.render(scene, cam);
						gl.readRenderTargetPixels(target, 0, 0, width, height, buffer);
					} finally {
						gl.setRenderTarget(previous);
						if (fog) {
							fog.near = fogNear;
							fog.far = fogFar;
						}
						for (const [light, intensity] of scaled) light.intensity = intensity;
						scene.environmentIntensity = environmentIntensity;
						scene.backgroundIntensity = backgroundIntensity;
						if (fogColor) fog.color.copy(fogColor);
					}
					return buffer;
				},
			};
		}
		// verify_result's own views (motion3/views.js): one read-back from a camera at eye, a vertical fov, fade drawn see-through.
		function renderView({ eye, quaternion, fovDeg, output, fade }) {
			const own = createExportCapture(output, () => {
				const source = camRef.current;
				if (!source) return null;
				const cam = source.clone();
				cam.clearViewOffset();
				cam.position.set(...eye);
				cam.quaternion.set(...quaternion);
				cam.fov = fovDeg;
				return cam;
			});
			try { return withFaded(scene, fade, own.render); } finally { own.dispose(); }
		}
		const api = { ...createExportCapture({ width, height }), createExportCapture, renderView };
		apiRef.current = api;
		if (width === MCP_CAPTURE_W && height === MCP_CAPTURE_H) {
			window.__cozyclayMcpCaptureReady = true;
			window.dispatchEvent(new Event("cozyclay:mcp-capture-ready"));
		}
		// QA hook: run one real export render and report what the capture
		// camera saw — the layer mask plus an amber scan of the output
		// frame (the selection cage's warm tone). Lets the suite prove the
		// deliverable frame stays free of editor furniture without driving
		// the whole generation form.
		window.__captureFrame = () => {
			const buffer = apiRef.current?.render() ?? null;
			if (!buffer) return null;
			let amber = 0;
			for (let i = 0; i < buffer.length; i += 4) {
				const r = buffer[i];
				const g = buffer[i + 1];
				const b = buffer[i + 2];
				if (r >= 180 && g >= 165 && g - b >= 35) amber++;
			}
			return { layersMask: window.__captureCameraMask ?? 0, amber, pixels: buffer.length / 4 };
		};
		return () => {
			if (apiRef.current === api) apiRef.current = null;
			if (width === MCP_CAPTURE_W && height === MCP_CAPTURE_H) window.__cozyclayMcpCaptureReady = false;
			api.dispose();
		};
	}, [gl, scene, camRef, apiRef, width, height]);
	return null;
}

export async function captureMcpFrame({ capture, camera, characters, activeCharacterId, objects, rigs, readAuthoredState, partColours = null }) {
	if (!capture || !camera) throw new Error("No renderable shot camera is available for capture_frame.");
	const authoredStateBefore = JSON.stringify(readAuthoredState());
	const buffer = capture.render();
	if (!buffer) throw new Error("No renderable shot camera is available for capture_frame.");
	let nonBlackPixels = 0;
	for (let offset = 0; offset < buffer.length; offset += 4) {
		if (buffer[offset] > 5 || buffer[offset + 1] > 5 || buffer[offset + 2] > 5) nonBlackPixels += 1;
	}
	if (nonBlackPixels === 0) throw new Error("capture_frame rejected a black rendered frame.");
	camera.updateMatrixWorld();
	const raycaster = new THREE.Raycaster();
	const roots = [];
	capture.scene.traverse((node) => {
		const id = node.userData?.sceneObjectId;
		if (typeof id === "string" && objects.some((object) => object.id === id)) roots.push({ id, root: node });
	});
	const assertions = characters.map((character) => {
		const rig = rigs[character.id];
		if (!rig || character.hidden) return { id: character.id, renderable: false, behindCameraPlane: null, fartherAlongCameraForward: null, distanceToFloor: null, occludedBy: null, visiblePixelCount: 0 };
		rig.updateWorldMatrix(true, true);
		const bounds = new THREE.Box3().setFromObject(rig);
		const center = bounds.getCenter(new THREE.Vector3());
		const cameraSpace = camera.worldToLocal(center.clone());
		const behindCameraPlane = cameraSpace.z >= 0;
		const distanceToFloor = Math.max(0, bounds.min.y);
		if (behindCameraPlane || bounds.isEmpty()) {
			return { id: character.id, renderable: true, behindCameraPlane, fartherAlongCameraForward: -cameraSpace.z, distanceToFloor, occludedBy: null, visiblePixelCount: 0 };
		}
		const corners = [
			new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z), new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.max.z),
			new THREE.Vector3(bounds.min.x, bounds.max.y, bounds.min.z), new THREE.Vector3(bounds.min.x, bounds.max.y, bounds.max.z),
			new THREE.Vector3(bounds.max.x, bounds.min.y, bounds.min.z), new THREE.Vector3(bounds.max.x, bounds.min.y, bounds.max.z),
			new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.min.z), new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.max.z),
		].map((corner) => corner.project(camera));
		const minX = Math.max(0, Math.floor(((Math.min(...corners.map((corner) => corner.x)) + 1) * 0.5) * MCP_CAPTURE_W));
		const maxX = Math.min(MCP_CAPTURE_W - 1, Math.ceil(((Math.max(...corners.map((corner) => corner.x)) + 1) * 0.5) * MCP_CAPTURE_W));
		const minY = Math.max(0, Math.floor(((1 - Math.max(...corners.map((corner) => corner.y))) * 0.5) * MCP_CAPTURE_H));
		const maxY = Math.min(MCP_CAPTURE_H - 1, Math.ceil(((1 - Math.min(...corners.map((corner) => corner.y))) * 0.5) * MCP_CAPTURE_H));
		const occluders = new Map();
		let visiblePixelCount = 0;
		for (let y = minY; y <= maxY; y += MCP_CAPTURE_SAMPLE_STEP) {
			for (let x = minX; x <= maxX; x += MCP_CAPTURE_SAMPLE_STEP) {
				raycaster.setFromCamera({ x: (x / MCP_CAPTURE_W) * 2 - 1, y: 1 - (y / MCP_CAPTURE_H) * 2 }, camera);
				const characterHit = raycaster.intersectObject(rig, true)[0];
				if (!characterHit) continue;
				const objectHit = raycaster.intersectObjects(roots.map((entry) => entry.root), true)[0];
				const pixels = MCP_CAPTURE_SAMPLE_STEP * MCP_CAPTURE_SAMPLE_STEP;
				if (!objectHit || objectHit.distance >= characterHit.distance - 1e-4) {
					visiblePixelCount += pixels;
					continue;
				}
				const occluder = roots.find((entry) => {
					let node = objectHit.object;
					while (node) {
						if (node === entry.root) return true;
						node = node.parent;
					}
					return false;
				});
				if (occluder) occluders.set(occluder.id, (occluders.get(occluder.id) ?? 0) + pixels);
			}
		}
		const occludedBy = [...occluders.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
		return { id: character.id, renderable: true, behindCameraPlane, fartherAlongCameraForward: -cameraSpace.z, distanceToFloor, occludedBy, visiblePixelCount };
	});
	const active = assertions.find((entry) => entry.id === activeCharacterId) ?? assertions[0];
	const authoredStateAfter = JSON.stringify(readAuthoredState());
	const canvas = document.createElement("canvas");
	canvas.width = MCP_CAPTURE_W;
	canvas.height = MCP_CAPTURE_H;
	const context = canvas.getContext("2d");
	if (!context) throw new Error("capture_frame could not encode the rendered image.");
	const image = context.createImageData(MCP_CAPTURE_W, MCP_CAPTURE_H);
	for (let row = 0; row < MCP_CAPTURE_H; row += 1) {
		image.data.set(buffer.subarray((MCP_CAPTURE_H - 1 - row) * MCP_CAPTURE_W * 4, (MCP_CAPTURE_H - row) * MCP_CAPTURE_W * 4), row * MCP_CAPTURE_W * 4);
	}
	context.putImageData(image, 0, 0);
	const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
	if (!blob) throw new Error("capture_frame could not compress the rendered image.");
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return {
		width: MCP_CAPTURE_W,
		height: MCP_CAPTURE_H,
		mimeType: "image/png",
		encoding: "base64",
		byteSize: bytes.length,
		data: btoa(binary),
		partColours,
		authoredStateBefore,
		authoredStateAfter,
		assertions: {
			renderable: true,
			blackFrame: false,
			nonBlackPixels,
			behindCameraPlane: active?.behindCameraPlane ?? null,
			fartherAlongCameraForward: active?.fartherAlongCameraForward ?? null,
			distanceToFloor: active?.distanceToFloor ?? null,
			occludedBy: active?.occludedBy ?? null,
			visiblePixelCount: active?.visiblePixelCount ?? 0,
			characters: assertions,
		},
	};
}
