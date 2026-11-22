// The finish: one look laid over every surface and every frame, whatever the set is built from ("toon": two light steps with a
// hard edge, hard cast shadows, flat faces, black outline and crease lines; the owner's references, 2026-11-16). Off is the stock draw.
//
// Two layers, neither knows what an object is:
// - surface: a patch of three's own shader chunks, switched per material by a define, so stock materials compile
//   exactly as before while the look is off.
// - frame: a screen-space pass over the finished draw: lines from a normal/depth prepass, then a saturation grade.
//
// The scene is drawn into a float target flagged isXRRenderTarget. That flag is what three checks (WebGLPrograms.js,
// WebGLTextures.js) to tone-map and encode in the material, as it does on the canvas, so a finished frame gets the
// viewport's tone curve, its untouched sky and its fog instead of the unmapped light a plain render target holds.
import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { GIZMO_LAYER, POSER_LAYER } from "./dualview.jsx";
// The surface layer (the shader chunk patch, installed when that module loads) is stage-finish-surface.js.
import { applySurfaceLook } from "./stage-finish-surface.js";

// The line width, in pixels of a frame 1080 rows tall: every frame scales it by its own height, so the viewport (any pane
// size, any device pixel ratio) and the exports show the same share of the frame. 1 was the width of the pictures the
// owner approved first (2026-11-16); seeing it in the Studio, the owner picked half of it, for the exports too.
const LINE_WIDTH = 0.5;

// tone: three's curve for the draw; exposure: a multiplier on the stage's own (Neutral lacks the 1/0.6 that three's ACES
// applies); occlusion false: no soft contact darkening (stage-occlusion.js), a ramp the flat look has no place for.
export const FINISH_LOOKS = Object.freeze({
	toon: Object.freeze({
		tone: THREE.NeutralToneMapping, exposure: 1.3,
		surface: { bands: { level: 0.75, fill: 2.2, pool: 0.6, poolAt: 0.5, poolSoft: 0.35, reach: 8 } },
		// own: how far an object's own line spreads, in kernel widths (1: as wide as a crease)
		line: { color: "#0a0a0c", amount: 1, width: LINE_WIDTH, crease: 1, own: 1 },
		occlusion: false,
		saturation: 1.1,
	}),
});

const VERTEX = "varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }";
// The line kernel is the viewport's (dualview.jsx EDGE_FRAGMENT): a Sobel over log depth, owned by the nearer side, and one over the normals.
const FINISH = `
uniform sampler2D tColor;
uniform sampler2D tNormal;
uniform sampler2D tDepth;
uniform sampler2D tMarks;
uniform float hasMarks;
uniform float markReach;
uniform vec2 texel;
uniform vec3 lineColor;
uniform float lineAmount;
uniform float lineWidth;
uniform float creaseAmount;
uniform float saturation;
uniform float cameraNear;
uniform float cameraFar;
varying vec2 vUv;
float linearDepth( float value ) {
	float z = value * 2.0 - 1.0;
	return ( 2.0 * cameraNear * cameraFar ) / ( cameraFar + cameraNear - z * ( cameraFar - cameraNear ) );
}
float depthTexel( vec2 uv ) { return linearDepth( texture2D( tDepth, uv ).x ); }
// an empty pixel of the prepass (alpha 0) faces the camera
vec3 normalTexel( vec2 uv ) { vec4 n = texture2D( tNormal, uv ); return mix( vec3( 0.0, 0.0, 1.0 ), n.xyz * 2.0 - 1.0, step( 0.5, n.a ) ); }
// The kernel's taps sit a fraction of a pixel out as often as not (the width follows the frame's height), so they blend
// the four texels around them: a nearest lookup would round every width to whole pixels, thicker or thinner than asked.
// Depth texels are not filterable, hence by hand.
float depthAt( vec2 uv ) {
	vec2 p = uv / texel - 0.5, f = fract( p ), o = ( floor( p ) + 0.5 ) * texel;
	return mix( mix( depthTexel( o ), depthTexel( o + vec2( texel.x, 0.0 ) ), f.x ), mix( depthTexel( o + vec2( 0.0, texel.y ) ), depthTexel( o + texel ), f.x ), f.y );
}
vec3 normalAt( vec2 uv ) {
	vec2 p = uv / texel - 0.5, f = fract( p ), o = ( floor( p ) + 0.5 ) * texel;
	return mix( mix( normalTexel( o ), normalTexel( o + vec2( texel.x, 0.0 ) ), f.x ), mix( normalTexel( o + vec2( 0.0, texel.y ) ), normalTexel( o + texel ), f.x ), f.y );
}
vec3 toLinear( vec3 c ) { return mix( c / 12.92, pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), step( 0.04045, c ) ); }
// An object's own lines (line geometry, drawn one pixel wide into tMarks where they are seen) in the look's ink: spread
// over the kernel's own reach, so a line drawn on a flat face comes out as wide as a crease the normals give.
float ink( vec2 x, vec2 y ) {
	if ( hasMarks < 0.5 ) return 0.0;
	vec2 a = x * markReach, b = y * markReach;
	float m = max( texture2D( tMarks, vUv ).r, max( max( texture2D( tMarks, vUv + a ).r, texture2D( tMarks, vUv - a ).r ), max( texture2D( tMarks, vUv + b ).r, texture2D( tMarks, vUv - b ).r ) ) );
	m = max( m, max( max( texture2D( tMarks, vUv + a + b ).r, texture2D( tMarks, vUv - a - b ).r ), max( texture2D( tMarks, vUv + a - b ).r, texture2D( tMarks, vUv - a + b ).r ) ) );
	// a one-pixel line that falls between two pixels covers each by half: that is still the whole line
	return smoothstep( 0.1, 0.5, m );
}
void main() {
	vec3 color = texture2D( tColor, vUv ).rgb;
	vec2 x = vec2( texel.x * lineWidth, 0.0 ), y = vec2( 0.0, texel.y * lineWidth );
	float centerZ = depthAt( vUv );
	float zL = depthAt( vUv - x ), zR = depthAt( vUv + x ), zB = depthAt( vUv - y ), zT = depthAt( vUv + y );
	vec3 nL = normalAt( vUv - x ), nR = normalAt( vUv + x ), nB = normalAt( vUv - y ), nT = normalAt( vUv + y );
	float fade = mix( 0.42, 1.0, clamp( 3.0 / max( centerZ, 0.001 ), 0.0, 1.0 ) );
	float owner = 1.0 - step( min( min( zL, zR ), min( zB, zT ) ) + max( 0.002, centerZ * 0.0015 ), centerZ );
	float dTL = log2( 1.0 + depthAt( vUv - x + y ) ), dTR = log2( 1.0 + depthAt( vUv + x + y ) ), dBL = log2( 1.0 + depthAt( vUv - x - y ) ), dBR = log2( 1.0 + depthAt( vUv + x - y ) );
	float dL = log2( 1.0 + zL ), dR = log2( 1.0 + zR ), dB = log2( 1.0 + zB ), dT = log2( 1.0 + zT );
	float depthEdge = length( vec2( dTL + 2.0 * dL + dBL - dTR - 2.0 * dR - dBR, dTL + 2.0 * dT + dTR - dBL - 2.0 * dB - dBR ) );
	vec3 nTL = normalAt( vUv - x + y ), nTR = normalAt( vUv + x + y ), nBL = normalAt( vUv - x - y ), nBR = normalAt( vUv + x - y );
	vec3 normalX = nTL + 2.0 * nL + nBL - nTR - 2.0 * nR - nBR, normalY = nTL + 2.0 * nT + nTR - nBL - 2.0 * nB - nBR;
	float normalEdge = sqrt( dot( normalX, normalX ) + dot( normalY, normalY ) );
	float edge = max( max( smoothstep( 0.055, 0.16, depthEdge ) * owner, smoothstep( 0.7, 1.7, normalEdge ) * creaseAmount ), ink( x, y ) );
	color = mix( color, lineColor, edge * lineAmount * fade );
	color = mix( vec3( dot( color, vec3( 0.2126, 0.7152, 0.0722 ) ) ), color, saturation );
	// the output target stores sRGB and encodes on write: hand it linear
	gl_FragColor = vec4( toLinear( clamp( color, 0.0, 1.0 ) ), 1.0 );
}`;

const value = (initial) => ({ value: initial });
// What the line prepass leaves out, as the viewport's does (dualview.jsx): picture cards, the deck, glow halos.
// A see-through pane is left out too, so the things behind it get their lines.
const seeThrough = (node) => node.isMesh && [node.material].flat().every((material) => material?.transmission > 0 || material?.userData?.cozyGlass);
// Line geometry is a line the object already has. Under the look it is drawn in the look's ink, like every outline and
// crease: it leaves the colour draw and the prepass (it has no surface to take a normal from) for the mark pass below.
const ownLines = (node) => node.isLine === true;
const noLine = (node) => node.userData?.cutoutTexture !== undefined || node.userData?.noInk || node.userData?.beautyOnly || seeThrough(node) || ownLines(node);
// A layer no camera of the Studio uses: for the mark pass, the set's own lines alone.
const MARK_LAYER = 31;
// Size buckets kept alive at once (the viewport pane, the preview card, the exports).
const CACHED_SIZES = 4;

/** The frame pass for one renderer. render() draws `scene` through `camera` with `look` into `output` (an 8-bit sRGB target)
 *  and answers the depth of the draw (a depth texture of output's size). Layers the camera has off stay off. */
export function createFinish() {
	const normalMaterial = new THREE.MeshNormalMaterial({ blending: THREE.NoBlending, side: THREE.DoubleSide });
	const finish = new THREE.ShaderMaterial({ vertexShader: VERTEX, fragmentShader: FINISH, depthTest: false, depthWrite: false, toneMapped: false, uniforms: {
		tColor: value(null), tNormal: value(null), tDepth: value(null), texel: value(new THREE.Vector2()), cameraNear: value(0.1), cameraFar: value(100),
		lineColor: value(new THREE.Vector3()), lineAmount: value(0), lineWidth: value(1), creaseAmount: value(0.68), saturation: value(1),
		tMarks: value(null), hasMarks: value(0), markReach: value(1),
	} });
	// the mark pass: the solid set as depth only, then the own lines in white where they are seen. The surfaces sit a
	// hair back, as a line's own surface does in the draw (a line on a face is level with it and would fight it).
	const depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
	const markMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, depthWrite: false, toneMapped: false });
	const quad = new FullScreenQuad(), sizes = new Map(), clearColor = new THREE.Color(), display = new THREE.Color();
	const depthTexture = (width, height) => Object.assign(new THREE.DepthTexture(width, height, THREE.UnsignedIntType), { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
	const targetsFor = (width, height) => {
		const key = `${width}x${height}`;
		let set = sizes.get(key);
		if (set) sizes.delete(key);
		else {
			// display-referred, as the canvas: the flag makes the materials tone-map and encode (see the head of this file)
			const drawn = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, colorSpace: THREE.SRGBColorSpace, samples: 4, depthTexture: depthTexture(width, height) });
			drawn.isXRRenderTarget = true;
			const prepass = new THREE.WebGLRenderTarget(width, height, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, samples: 4, depthTexture: depthTexture(width, height) });
			// multisampled and read filtered: the one-pixel lines come out smooth, and the ink reads between pixels
			const marks = new THREE.WebGLRenderTarget(width, height, { samples: 4 });
			set = { drawn, prepass, marks };
		}
		sizes.set(key, set);
		if (sizes.size > CACHED_SIZES) {
			const [oldest, stale] = sizes.entries().next().value;
			sizes.delete(oldest);
			for (const target of Object.values(stale)) { target.depthTexture?.dispose(); target.dispose(); }
		}
		return set;
	};
	const srgb = (hex) => { display.set(hex); return new THREE.Vector3(...display.convertLinearToSRGB().toArray()); };
	function render(renderer, scene, camera, output, look) {
		const { drawn, prepass, marks } = targetsFor(output.width, output.height);
		const before = { target: renderer.getRenderTarget(), tone: renderer.toneMapping, exposure: renderer.toneMappingExposure, autoClear: renderer.autoClear, alpha: renderer.getClearAlpha(),
			background: scene.background, override: scene.overrideMaterial, mask: camera.layers.mask, shadowAuto: renderer.shadowMap.autoUpdate, shadowNeeds: renderer.shadowMap.needsUpdate, after: scene.onAfterRender, before: scene.onBeforeRender };
		renderer.getClearColor(clearColor);
		const hidden = [];
		try {
			applySurfaceLook(scene, look.surface);
			renderer.toneMapping = look.tone;
			renderer.toneMappingExposure = before.exposure * look.exposure;
			renderer.autoClear = true;
			// the set's own lines (on the layers this draw shows, not the editor's) are ink: out of the colour draw (kept in it by a look with no ink)
			const lines = [], set = camera.layers.mask & ~((1 << GIZMO_LAYER) | (1 << POSER_LAYER));
			scene.traverse((node) => {
				if (!node.visible || !ownLines(node) || !(node.layers.mask & set) || !(look.line.amount > 0)) return;
				lines.push(node);
				hidden.push(node);
				node.visible = false;
			});
			renderer.setRenderTarget(drawn);
			if (look.occlusion === false) scene.onAfterRender = () => {};
			renderer.render(scene, camera);
			scene.onAfterRender = before.after;
			// lines read the normals and depth of the solid set
			camera.layers.disable(GIZMO_LAYER);
			camera.layers.disable(POSER_LAYER);
			scene.traverse((node) => {
				if (!node.visible || !noLine(node)) return;
				hidden.push(node);
				node.visible = false;
			});
			// no backdrop: the stage sky's hook (stage-sky.jsx) would put one back and clear the prepass with it
			scene.background = null;
			scene.onBeforeRender = () => {};
			scene.overrideMaterial = normalMaterial;
			renderer.shadowMap.autoUpdate = false;
			renderer.setClearColor(0x000000, 0);
			renderer.setRenderTarget(prepass);
			if (look.line.amount > 0) renderer.render(scene, camera); // a look with no lines (an export with the look off) needs no prepass
			if (lines.length && look.line.amount > 0) {
				scene.overrideMaterial = depthOnly;
				renderer.setRenderTarget(marks);
				renderer.render(scene, camera);
				for (const node of lines) { node.visible = true; node.layers.enable(MARK_LAYER); }
				const seen = camera.layers.mask;
				camera.layers.set(MARK_LAYER);
				scene.overrideMaterial = markMaterial;
				renderer.autoClear = false;
				try { renderer.render(scene, camera); } finally {
					renderer.autoClear = true;
					camera.layers.mask = seen;
					for (const node of lines) node.layers.disable(MARK_LAYER);
				}
			}
			for (const node of hidden.splice(0)) node.visible = true;
			scene.background = before.background;
			scene.onBeforeRender = before.before;
			scene.overrideMaterial = before.override;
			camera.layers.mask = before.mask;
			const u = finish.uniforms;
			u.tColor.value = drawn.texture;
			u.tNormal.value = prepass.texture;
			u.tDepth.value = prepass.depthTexture;
			u.tMarks.value = marks.texture;
			u.hasMarks.value = lines.length ? 1 : 0;
			u.markReach.value = look.line.own;
			u.texel.value.set(1 / output.width, 1 / output.height);
			u.cameraNear.value = camera.near;
			u.cameraFar.value = camera.far;
			// colours of the frame pass are display values, like the frame they are mixed into
			u.lineColor.value.copy(srgb(look.line.color));
			u.lineAmount.value = look.line.amount;
			u.lineWidth.value = look.line.width * (output.height / 1080);
			u.creaseAmount.value = look.line.crease;
			u.saturation.value = look.saturation;
			renderer.setRenderTarget(output);
			quad.material = finish;
			quad.render(renderer);
			return drawn.depthTexture;
		} finally {
			for (const node of hidden) node.visible = true;
			scene.onAfterRender = before.after;
			scene.onBeforeRender = before.before;
			scene.background = before.background;
			scene.overrideMaterial = before.override;
			camera.layers.mask = before.mask;
			renderer.shadowMap.autoUpdate = before.shadowAuto;
			renderer.shadowMap.needsUpdate = before.shadowNeeds;
			renderer.setClearColor(clearColor, before.alpha);
			renderer.toneMapping = before.tone;
			renderer.toneMappingExposure = before.exposure;
			renderer.autoClear = before.autoClear;
			renderer.setRenderTarget(before.target);
		}
	}
	function dispose() {
		for (const set of sizes.values()) for (const target of Object.values(set)) { target.depthTexture?.dispose(); target.dispose(); }
		sizes.clear();
		normalMaterial.dispose();
		depthOnly.dispose();
		markMaterial.dispose();
		finish.dispose();
		quad.dispose();
	}
	return { render, dispose };
}
