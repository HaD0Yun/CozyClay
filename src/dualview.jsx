import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { fitAspect } from "./shot-frame.js";
import { updateVisibleViewOffsets } from "./viewport-visible-rect.js";
import { applyCameraOptics } from "./camera-optics.js";
import { useViewportTools } from "./viewport-tools.js";

/**
 * Two live viewports out of one scene.
 *
 * Blocking a shot means moving the camera and watching the frame change. Doing
 * that through a view toggle costs a round trip per nudge, so both views render
 * every frame into scissored regions of the same canvas. One scene, one WebGL
 * context, two cameras — cloning the scene would double the FBX cost for a
 * picture that is only ever a monitor.
 */

/** the plan pucks/wedge: overlay geometry only the top-down camera may see */
export const PLAN_LAYER = 2;
/** the ceiling: it would fill the entire top-down view, so hide it from the plan */
export const SHOT_LAYER = 3;
/** IK handles/gizmo: only the poser camera (the IK working view) sees them,
 * never the frozen shot camera in the inset or the plan. */
export const POSER_LAYER = 4;
/** the scene-object transform gizmo: live in both 3D working views, stripped
 * from the plan and from exported frames (the capture rig drops this layer). */
export const GIZMO_LAYER = 5;
/** the shot camera is locked to the export aspect no matter which pane holds it */
export const SHOT_ASPECT = 16 / 9;
/** Letterbox bars are chrome, so they wear the editor's background (--bg in
 * styles.css) rather than the scene's sky. Kept in sync by eye: a mismatch
 * here reads as a seam around the frame, not as a wrong colour. */
export const LETTERBOX = new THREE.Color("#1e1e1e");
// The light theme's bars take the light panel tone, not a black slab.
export const LETTERBOX_LIGHT = new THREE.Color("#dcdde1");
/** half-height of the plan frustum, in metres — covers the full camera throw */
export const PLAN_EXTENT = 12.4;

const EDGE_VERTEX = `
	varying vec2 vUv;
	void main() {
		vUv = uv;
		gl_Position = vec4(position.xy, 0.0, 1.0);
	}
`;

const EDGE_FRAGMENT = `
	uniform sampler2D tNormal;
	uniform sampler2D tDepth;
	uniform vec2 texel;
	uniform vec3 edgeColor;
	uniform float cameraNear;
	uniform float cameraFar;
	uniform float orthographic;
	varying vec2 vUv;

	float linearDepth(float value) {
		if (orthographic > 0.5) return mix(cameraNear, cameraFar, value);
		float z = value * 2.0 - 1.0;
		return (2.0 * cameraNear * cameraFar) /
			(cameraFar + cameraNear - z * (cameraFar - cameraNear));
	}

	void main() {
		float centerZ = linearDepth(texture2D(tDepth, vUv).x);
		// Keep the stroke kernel stable, but soften its opacity past the 3 m
		// reference distance. A minimum 42% opacity keeps distant silhouettes
		// readable without letting ink become the only visible part of the body.
		float distanceFade = orthographic > 0.5
			? 1.0
			: mix(0.42, 1.0, clamp(3.0 / max(centerZ, 0.001), 0.0, 1.0));
		vec2 x = vec2(texel.x * 0.8, 0.0);
		vec2 y = vec2(0.0, texel.y * 0.8);
		float nearestZ = min(
			min(linearDepth(texture2D(tDepth, vUv - x).x), linearDepth(texture2D(tDepth, vUv + x).x)),
			min(linearDepth(texture2D(tDepth, vUv - y).x), linearDepth(texture2D(tDepth, vUv + y).x))
		);
		float foregroundOwner = 1.0 - step(nearestZ + max(0.002, centerZ * 0.0015), centerZ);
		float dTL = log2(1.0 + linearDepth(texture2D(tDepth, vUv - x + y).x));
		float dT  = log2(1.0 + linearDepth(texture2D(tDepth, vUv + y).x));
		float dTR = log2(1.0 + linearDepth(texture2D(tDepth, vUv + x + y).x));
		float dL  = log2(1.0 + linearDepth(texture2D(tDepth, vUv - x).x));
		float dR  = log2(1.0 + linearDepth(texture2D(tDepth, vUv + x).x));
		float dBL = log2(1.0 + linearDepth(texture2D(tDepth, vUv - x - y).x));
		float dB  = log2(1.0 + linearDepth(texture2D(tDepth, vUv - y).x));
		float dBR = log2(1.0 + linearDepth(texture2D(tDepth, vUv + x - y).x));
		float depthX = dTL + 2.0 * dL + dBL - dTR - 2.0 * dR - dBR;
		float depthY = dTL + 2.0 * dT + dTR - dBL - 2.0 * dB - dBR;
		float depthEdge = length(vec2(depthX, depthY));

		vec3 nTL = texture2D(tNormal, vUv - x + y).xyz * 2.0 - 1.0;
		vec3 nT  = texture2D(tNormal, vUv + y).xyz * 2.0 - 1.0;
		vec3 nTR = texture2D(tNormal, vUv + x + y).xyz * 2.0 - 1.0;
		vec3 nL  = texture2D(tNormal, vUv - x).xyz * 2.0 - 1.0;
		vec3 nR  = texture2D(tNormal, vUv + x).xyz * 2.0 - 1.0;
		vec3 nBL = texture2D(tNormal, vUv - x - y).xyz * 2.0 - 1.0;
		vec3 nB  = texture2D(tNormal, vUv - y).xyz * 2.0 - 1.0;
		vec3 nBR = texture2D(tNormal, vUv + x - y).xyz * 2.0 - 1.0;
		vec3 normalX = nTL + 2.0 * nL + nBL - nTR - 2.0 * nR - nBR;
		vec3 normalY = nTL + 2.0 * nT + nTR - nBL - 2.0 * nB - nBR;
		float normalEdge = sqrt(dot(normalX, normalX) + dot(normalY, normalY));

		float depthLine = smoothstep(0.055, 0.16, depthEdge);
		float normalLine = smoothstep(0.7, 1.7, normalEdge);
		float edge = max(depthLine * foregroundOwner, normalLine * 0.68);
		gl_FragColor = vec4(edgeColor, edge * 0.38 * distanceFade);
	}
`;

export function DualRender({ stageRef, mainRef, insetRef, shotPreviewRef, shotCamRef, planCamRef, poserCamRef, editorCamRef, ikMode = false, playMode = false, lookThrough = false, insetCollapsed = false, planZoom = 1, shotAspect = SHOT_ASPECT, shotOptics = null, editorLook = false }) {
	const { xray } = useViewportTools();
	const invalidate = useThree((state) => state.invalidate);
	const lastPoserPose = useRef({ position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), valid: false });
	const interactivePixelRatio = useRef({ base: null, reduced: false, needsFrozenRedraw: false });
	// Demand mode draws nothing by itself: the first frame can land before the
	// layout settles (the inset reads 0x0), and async scene content commits
	// later. Force frames on mount and after the DOM has caught up.
	useEffect(() => {
		invalidate();
		const f1 = requestAnimationFrame(invalidate);
		const f2 = requestAnimationFrame(() => requestAnimationFrame(invalidate));
		return () => {
			cancelAnimationFrame(f1);
			cancelAnimationFrame(f2);
		};
	}, [invalidate]);
	// The theme is read per frame, but a demand-mode canvas draws nothing after
	// a toggle unless something asks for a frame.
	useEffect(() => {
		window.addEventListener("cozyclay:theme-change", invalidate);
		return () => window.removeEventListener("cozyclay:theme-change", invalidate);
	}, [invalidate]);
	// Likewise when the preview card is resized (the dock handle changes
	// --shell-dock): the dock's glass hole grows at once, and without a new
	// frame it shows whatever the canvas last drew there.
	useEffect(() => {
		const card = shotPreviewRef?.current;
		if (!card || typeof ResizeObserver === "undefined") return undefined;
		const observer = new ResizeObserver(() => invalidate());
		observer.observe(card);
		return () => observer.disconnect();
	}, [shotPreviewRef, invalidate]);
	const { gl, scene, size } = useThree();
	const edgePass = useMemo(() => {
		const target = new THREE.WebGLRenderTarget(1, 1, {
			depthBuffer: true,
			stencilBuffer: false,
			minFilter: THREE.NearestFilter,
			magFilter: THREE.NearestFilter,
		});
		// The outline pre-pass used to be single-sample even when the visible
		// canvas was antialiased. At 100% zoom that made the mannequin's silhouette
		// look stair-stepped, which users read as low-poly/low-resolution. Keep the
		// depth and normal lookups nearest (the edge kernel relies on that), but
		// multisample the render target itself so the resolved edge has a clean
		// contour. WebGL1 safely ignores this property; WebGL2 resolves it for us.
		target.samples = 4;
		target.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
		target.depthTexture.minFilter = THREE.NearestFilter;
		target.depthTexture.magFilter = THREE.NearestFilter;
		const normalMaterial = new THREE.MeshNormalMaterial({
			blending: THREE.NoBlending,
			side: THREE.DoubleSide,
		});
		const material = new THREE.ShaderMaterial({
			vertexShader: EDGE_VERTEX,
			fragmentShader: EDGE_FRAGMENT,
			transparent: true,
			depthTest: false,
			depthWrite: false,
			toneMapped: false,
			uniforms: {
				tNormal: { value: target.texture },
				tDepth: { value: target.depthTexture },
				texel: { value: new THREE.Vector2(1, 1) },
				edgeColor: { value: new THREE.Color("#243b4d") },
				cameraNear: { value: 0.1 },
				cameraFar: { value: 100 },
				orthographic: { value: 0 },
			},
		});
		const passScene = new THREE.Scene();
		const passCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
		passScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
		return { target, normalMaterial, material, passScene, passCamera };
	}, []);

	useEffect(() => () => {
		edgePass.target.dispose();
		edgePass.normalMaterial.dispose();
		edgePass.material.dispose();
		edgePass.passScene.children[0].geometry.dispose();
	}, [edgePass]);

	// Layer masks are set once. The shot camera must never pick up the plan
	// overlay, or exported frames would carry pucks across the floor.
	useEffect(() => {
		const shot = shotCamRef.current;
		const plan = planCamRef.current;
		const poser = poserCamRef?.current;
		const editor = editorCamRef?.current;
		if (shot) {
			shot.layers.set(0);
			shot.layers.enable(SHOT_LAYER);
			shot.layers.enable(GIZMO_LAYER);
		}
		if (editor) {
			// The editor working view sees the set exactly like the shot camera
			// (ceiling included) plus the editing chrome, never the plan overlay.
			editor.layers.set(0);
			editor.layers.enable(SHOT_LAYER);
			editor.layers.enable(GIZMO_LAYER);
		}
		if (plan) {
			plan.layers.set(0);
			plan.layers.enable(PLAN_LAYER);
		}
		if (poser) {
			poser.layers.set(0);
			poser.layers.enable(SHOT_LAYER);
			poser.layers.enable(POSER_LAYER);
			poser.layers.enable(GIZMO_LAYER);
		}
	});

	// priority 1 takes over the render loop; R3F stops auto-rendering for us
	useFrame(() => {
		const shotCam = shotCamRef.current;
		const planCam = planCamRef.current;
		const poserCam = poserCamRef?.current;
		const editorCam = editorCamRef?.current;
		const stage = stageRef.current;
		if (!shotCam || !planCam || !stage || !mainRef.current || !insetRef.current) return;

		const base = stage.getBoundingClientRect();
		const rectOf = (el) => {
			const r = el.getBoundingClientRect();
			return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height };
		};
		const mainRect = rectOf(mainRef.current);
		updateVisibleViewOffsets({ editorCam, poserCam, canvas: gl.domElement.getBoundingClientRect(), aspect: mainRect.w / mainRect.h });
		// A collapsed inset is just its tag pill: skip the whole inset pass
		// instead of drawing a squished viewport into it.
		const insetRect = insetCollapsed ? { x: 0, y: 0, w: 0, h: 0 } : rectOf(insetRef.current);
		// The glass shell hides the plan/shot inset with CSS (display: none), which
		// leaves it 0x0. That skips the inset pass like a collapsed one; it must not
		// skip the main pane, or the stage stays blank.
		const insetOff = insetCollapsed || (!playMode && insetRect.w < 2);
		if (mainRect.w < 2) return;

		const planPane = insetRect;
		const shotPane = mainRect;
		// During camera navigation the poser view is the only surface changing.
		// Keep the frozen inset in the existing framebuffer and avoid its
		// additional scene + outline passes until the gesture ends.
		const cameraGesture = typeof window !== "undefined" && window.__cozyclayCameraGesture === true;
		const lastPose = lastPoserPose.current;
		const cameraMoved = ikMode && poserCam && (
			!lastPose.valid ||
			lastPose.position.distanceToSquared(poserCam.position) > 1e-12 ||
			1 - Math.abs(lastPose.quaternion.dot(poserCam.quaternion)) > 1e-10
		);
		if (ikMode && poserCam) {
			lastPose.position.copy(poserCam.position);
			lastPose.quaternion.copy(poserCam.quaternion);
			lastPose.valid = true;
		} else {
			lastPose.valid = false;
		}
		const navigatingCamera = cameraGesture || cameraMoved;
		// Camera navigation is transient editor chrome: render it at one device
		// pixel per CSS pixel, then restore the configured DPR before the first
		// settled frame. At DPR 2 this cuts the moving viewport's fragment work to
		// roughly a quarter without changing the authored or exported frame.
		const pixelState = interactivePixelRatio.current;
		if (navigatingCamera && !pixelState.reduced) {
			pixelState.base = gl.getPixelRatio();
			if (pixelState.base > 1) gl.setPixelRatio(1);
			pixelState.reduced = true;
			pixelState.needsFrozenRedraw = true;
		} else if (!navigatingCamera && pixelState.reduced) {
			gl.setPixelRatio(pixelState.base ?? 1);
			pixelState.base = null;
			pixelState.reduced = false;
			pixelState.needsFrozenRedraw = false;
		}
		// setPixelRatio resizes the shared canvas and clears its old pixels. Paint
		// frozen panes once, without ink, after that resize; later gesture frames
		// can leave them untouched again.
		const redrawFrozenPanes = navigatingCamera && pixelState.needsFrozenRedraw;
		// Shadow maps are unchanged while only the camera moves. Three otherwise
		// rebuilds every shadow map on every navigation frame, even though the
		// poser scene is static, which is the largest hidden cost of right-drag.
		const shadowMap = gl.shadowMap;
		const shadowAutoUpdateBefore = shadowMap?.autoUpdate;
		if (shadowMap) {
			if (navigatingCamera) shadowMap.autoUpdate = false;
			else if (shadowAutoUpdateBefore === false) {
				shadowMap.autoUpdate = true;
				shadowMap.needsUpdate = true;
			}
		}

		// scissor bounds the clear, viewport bounds the image. The bars around a
		// letterboxed frame are editor surface, not set: painting them with the
		// scene background put a sheet of near-white either side of the shot the
		// moment an aspect narrower than the pane was chosen, which is glare
		// rather than information. They take the editor's own tone instead, and
		// the scene draw is scissored to the image so the sky inside the frame is
		// untouched.
		const uiTheme = typeof document !== "undefined" ? document.documentElement.dataset.theme : undefined;
		const letterbox = uiTheme === "light" ? LETTERBOX_LIGHT : LETTERBOX;
		const draw = (camera, pane, imageRect, ink = true) => {
			const glY = size.height - (pane.y + pane.h);
			gl.setScissorTest(true);
			gl.setScissor(pane.x, glY, pane.w, pane.h);
			gl.setClearColor(letterbox, 1);
			gl.clear(true, true, false);
			const img = imageRect ?? pane;
			const imgY = size.height - (img.y + img.h);
			if (ink) {
				const targetWidth = Math.max(1, Math.round(img.w * gl.getPixelRatio()));
				const targetHeight = Math.max(1, Math.round(img.h * gl.getPixelRatio()));
				edgePass.target.setSize(targetWidth, targetHeight);
				edgePass.material.uniforms.texel.value.set(1 / targetWidth, 1 / targetHeight);
				gl.setRenderTarget(edgePass.target);
				gl.setScissorTest(false);
				gl.setClearColor(0x000000, 0);
				gl.clear(true, true, false);
				scene.overrideMaterial = edgePass.normalMaterial;
				// Editor chrome (grid, gizmo, pins) takes no ink: the override
				// material ignores per-material depthWrite opt-outs, and a
				// stylised outline on UI reads as set dressing. Mask restored
				// exactly, so plan/poser cameras keep their own layer sets.
				const inkMask = camera.layers.mask;
				camera.layers.disable(GIZMO_LAYER);
				// Cutout cards take no ink either: the prepass renders the card's
				// full rectangle regardless of the picture's alpha, so the outline
				// used to trace an empty frame around every pasted image — the
				// "border that will not go away". Hiding the card from the prepass
				// leaves the wall behind it continuous, so no edge is drawn.
				// The deck takes no ink either (userData.noInk, room.jsx): seen at a
				// grazing angle its depth runs away fast enough that the depth
				// kernel inked the whole far floor as a dark band under the
				// horizon. Without it in the prepass, figures still outline
				// against the cleared depth behind them. A glow halo (beautyOnly)
				// is light, not a surface: it takes no ink either.
				const cutouts = [];
				scene.traverse((node) => {
					if ((node.userData?.cutoutTexture !== undefined || node.userData?.noInk || node.userData?.beautyOnly) && node.visible) {
						cutouts.push(node);
						node.visible = false;
					}
				});
				gl.render(scene, camera);
				for (const node of cutouts) node.visible = true;
				camera.layers.mask = inkMask;
				scene.overrideMaterial = null;
			}
			gl.setRenderTarget(null);
			gl.setScissorTest(true);
			// The image only: three.js clears with the scene background before it
			// draws, so scissoring to the pane here would repaint the bars white.
			gl.setScissor(img.x, imgY, img.w, img.h);
			gl.setViewport(img.x, imgY, img.w, img.h);
			gl.render(scene, camera);
			if (ink) {
				const uniforms = edgePass.material.uniforms;
				uniforms.cameraNear.value = camera.near;
				uniforms.cameraFar.value = camera.far;
				uniforms.orthographic.value = camera.isOrthographicCamera ? 1 : 0;
				gl.autoClear = false;
				gl.render(edgePass.passScene, edgePass.passCamera);
				gl.autoClear = true;
			}
		};
		// X-Ray belongs to the working view only. Restore every material before
		// the shot monitor, plan or offscreen capture can draw the same scene.
		const drawEditorPane = (...args) => {
			if (!xray) { draw(...args); return; }
			const changed = new Map();
			scene.traverse(node => {
				if (!node.isMesh || node.userData?.noXray) return;
				for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
					if (!material || changed.has(material)) continue;
					changed.set(material, { transparent: material.transparent, opacity: material.opacity, depthWrite: material.depthWrite });
					material.transparent = true; material.opacity = Math.min(material.opacity, 0.22); material.depthWrite = false;
				}
			});
			try { draw(...args); }
			finally { for (const [material, saved] of changed) Object.assign(material, saved); }
		};
		const drawVisibleInset = (...args) => {
			if (!insetOff) draw(...args);
		};
		// The shot card. Every main-pane draw above covers the whole canvas,
		// including the pixels under the card, so the card is repainted every
		// frame — a camera drag used to leave the editor's pixels showing through
		// it. Only the ink pass waits for the gesture to settle.
		const drawPreviewCard = () => {
			const previewEl = shotPreviewRef?.current;
			if (!previewEl || previewEl.hidden) return;
			const previewRect = rectOf(previewEl);
			// The inset card's header strip (src/shell/viewport.css) is chrome:
			// the frame is drawn into the card body below it.
			const header = parseFloat(getComputedStyle(previewEl).getPropertyValue("--shot-preview-header")) || 0;
			previewRect.y += header;
			previewRect.h -= header;
			if (previewRect.w < 2 || previewRect.h < 2) return;
			const previewMask = shotCam.layers.mask;
			shotCam.layers.disable(GIZMO_LAYER);
			draw(shotCam, previewRect, fitAspect(previewRect, shotAspect), !navigatingCamera);
			shotCam.layers.mask = previewMask;
		};
		// The heads' facing marks are the exported frame's heading cue, not
		// something to look at: the studio hides them in every on-screen draw and
		// puts them back before the frame ends, so captures (which render outside
		// this loop) still carry them.
		const marks = [];
		if (editorLook) scene.traverse((node) => { if (node.userData.facingMark) marks.push(node); });
		for (const mark of marks) mark.visible = false;

		gl.autoClear = true;
		shotCam.aspect = shotAspect;
		applyCameraOptics(shotCam, shotOptics);
		// An orthographic plan keeps every puck the same size and the floor
		// undistorted; a perspective one skews the pucks near the edges and reads
		// as a 3/4 view rather than a plan.
		if (planCam.isOrthographicCamera) {
			// planZoom is the Top-View's camera height: larger zoom = smaller
			// extent = the pucks draw bigger.
			const extent = PLAN_EXTENT / Math.max(0.25, planZoom);
			const a = planPane.w / planPane.h;
			planCam.top = extent;
			planCam.bottom = -extent;
			planCam.left = -extent * a;
			planCam.right = extent * a;
		} else {
			planCam.aspect = planPane.w / planPane.h;
		}
		planCam.updateProjectionMatrix();

		// Branch order is the contract: `playMode` (the preview state, #195) is
		// tested first, so the Workflow embed and the playground rail land HERE —
		// the framed player — and never in the editing draw below that keeps the
		// gizmo layer, the plan inset, and fly controls on the shot camera.
		try {
			if (playMode) {
				// PlayView (Unity Game view): the shot camera owns the whole pane —
				// no plan inset, no editing chrome, just the framed output. Editor
				// furniture (selection cage, gizmo, grid, pins) lives on
				// GIZMO_LAYER and is dropped for this draw, mask restored after.
				const playMask = shotCam.layers.mask;
				shotCam.layers.disable(GIZMO_LAYER);
				draw(shotCam, mainRect, fitAspect(mainRect, shotAspect));
				shotCam.layers.mask = playMask;
			} else if (ikMode && poserCam) {
				// IK mode: the main pane is the poser working view (free navigation,
				// handle layer visible); the inset is the FROZEN shot camera — the
				// separate camera-placement screen the framing lives on.
				drawEditorPane(poserCam, mainRect, null, !navigatingCamera);
				if (!navigatingCamera || redrawFrozenPanes) drawVisibleInset(shotCam, insetRect, fitAspect(insetRect, shotAspect), !navigatingCamera);
				drawPreviewCard();
			} else if (editorCam && !lookThrough) {
				// Split-camera editing: the main pane is the EDITOR camera — free
				// navigation that never touches the recording. The shot camera only
				// appears in its own preview pane, framed to the export aspect and
				// stripped of editing chrome, exactly like an exported frame.
				// A right-drag is a camera gesture even with IK off. Keep the main
				// image readable while the camera is moving by deferring the expensive
				// edge/ink pass until the gesture ends; the plan inset stays frozen.
				drawEditorPane(editorCam, mainRect, null, !navigatingCamera);
				if (!navigatingCamera || redrawFrozenPanes) drawVisibleInset(planCam, planPane, null, false);
				drawPreviewCard();
			} else {
				// Shot camera in the main pane WITH the editing chrome. Look-through
				// (the PiP expand) lands here so the operator
				// can fly the recording lens with the same bindings as the free camera.
				// The QA hook (`window.__cozyclay.setLookThrough`) draws the same path.
				// Look-through is the recording lens: it keeps the authored stage.
				// The pane is the open stage less the rails (shell.css), so the
				// canvas around it is bars too: clear it, or the last full-canvas
				// draw stays there and reads as picture the export does not have.
				if (lookThrough) {
					gl.setScissorTest(false);
					gl.setClearColor(letterbox, 1);
					gl.clear(true, true, false);
				}
				draw(shotCam, shotPane, fitAspect(shotPane, shotAspect), !navigatingCamera);
				if (!navigatingCamera || redrawFrozenPanes) drawVisibleInset(planCam, planPane, null, false);
				drawPreviewCard();
			}
			if (redrawFrozenPanes) pixelState.needsFrozenRedraw = false;
		} finally {
			for (const mark of marks) mark.visible = true;
			gl.setScissorTest(false);
			gl.setViewport(0, 0, size.width, size.height);
		}
	}, 1);

	return null;
}
