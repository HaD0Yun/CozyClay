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

const DIRECT = "float dotNL = saturate( dot( geometryNormal, directLight.direction ) );\n\tvec3 irradiance = dotNL * directLight.color;";
const DIRECT_BANDS = `float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	#ifdef COZY_BANDS
		dotNL = COZY_BANDS_LEVEL * smoothstep( 0.02, 0.05, dotNL );
	#endif
	vec3 irradiance = dotNL * directLight.color;`;
// A cast shadow is in or out: the filtered edge of every shadow lookup is cut at its middle.
const SHADOW = "return mix( 1.0, shadow, shadowIntensity );";
const SHADOW_BANDS = `#ifdef COZY_BANDS
			shadow = smoothstep( 0.42, 0.58, shadow );
		#endif
		${SHADOW}`;
// Flat faces: no highlight and no mirrored surroundings; a metal keeps its colour as a plain one.
const FLAT = `
#ifdef COZY_BANDS
	material.diffuseContribution = diffuseColor.rgb;
	material.specularColor = vec3( 0.0 );
	material.specularColorBlended = vec3( 0.0 );
	material.specularF90 = 0.0;
#endif`;

// A lamp lights one flat pool whose rim fades over the last COZY_POOL_SOFT of its radius: everything within COZY_POOL of its range (or of COZY_REACH metres when
// it has no range) gets the light the stock falloff gives at COZY_POOL_AT of the way to that rim. A spot's cone keeps its own soft rim, and
// the sky/ground fill has three flat values (up, sideways, down) instead of a ramp around a curved surface.
const FALLOFF = "\treturn distanceFalloff;";
const FALLOFF_BANDS = `	#ifdef COZY_BANDS
		float cozyRim = COZY_POOL * ( cutoffDistance > 0.0 ? cutoffDistance : COZY_REACH );
		distanceFalloff = ( 1.0 - smoothstep( ( 1.0 - COZY_POOL_SOFT ) * cozyRim, cozyRim, lightDistance ) ) / pow( COZY_POOL_AT * cozyRim, decayExponent );
	#endif
${FALLOFF}`;
const HEMI = "float hemiDiffuseWeight = 0.5 * dotNL + 0.5;";
const HEMI_BANDS = `${HEMI}
		#ifdef COZY_BANDS
			hemiDiffuseWeight = 0.5 * smoothstep( - 0.52, - 0.48, dotNL ) + 0.5 * smoothstep( 0.48, 0.52, dotNL );
		#endif`;

// The shadow side stays readable: the sky/ground and ambient fill counts COZY_FILL times under a flat look, which has
// no bounce, no highlight and no occlusion ramp to show a form in the dark.
const FILL = "vec3 diffuse = irradiance * BRDF_Lambert( material.diffuseContribution )";
const FILL_BANDS = "vec3 diffuse = irradiance * COZY_FILL_GAIN * BRDF_Lambert( material.diffuseContribution )";
const FILL_GAIN = `
#ifdef COZY_BANDS
	#define COZY_FILL_GAIN COZY_FILL
#else
	#define COZY_FILL_GAIN 1.0
#endif
`;

/** Patch three's chunks once, before any material compiles; answers whether the surface look is in. */
function installSurfaceLooks(chunks = THREE.ShaderChunk) {
	if (chunks.lights_physical_pars_fragment.includes("COZY_BANDS")) return true;
	// A three upgrade that rewrites the direct light leaves the stock one in place.
	if (!chunks.lights_physical_pars_fragment.includes(DIRECT)) return false;
	chunks.lights_physical_pars_fragment = chunks.lights_physical_pars_fragment.replace(DIRECT, DIRECT_BANDS);
	chunks.shadowmap_pars_fragment = chunks.shadowmap_pars_fragment.replaceAll(SHADOW, SHADOW_BANDS);
	chunks.lights_physical_fragment += FLAT;
	chunks.lights_physical_pars_fragment = FILL_GAIN + chunks.lights_physical_pars_fragment.replace(FILL, FILL_BANDS);
	for (const [stock, banded] of [[FALLOFF, FALLOFF_BANDS], [HEMI, HEMI_BANDS]]) chunks.lights_pars_begin = chunks.lights_pars_begin.replace(stock, banded);
	return true;
}
installSurfaceLooks();

const glsl = (value) => (Number.isInteger(value) ? `${value}.0` : String(value));
const surfaceDefines = (surface) => (surface?.bands ? { COZY_BANDS: "", COZY_BANDS_LEVEL: glsl(surface.bands.level), COZY_FILL: glsl(surface.bands.fill), COZY_POOL: glsl(surface.bands.pool), COZY_POOL_AT: glsl(surface.bands.poolAt), COZY_POOL_SOFT: glsl(surface.bands.poolSoft), COZY_REACH: glsl(surface.bands.reach) } : {});
const SURFACE_KEYS = ["COZY_BANDS", "COZY_BANDS_LEVEL", "COZY_FILL", "COZY_POOL", "COZY_POOL_AT", "COZY_POOL_SOFT", "COZY_REACH"];
// Editor furniture (gizmos, handles, the selection cage) is UI: it never takes the look.
const isUi = (node) => node.layers.isEnabled(GIZMO_LAYER) || node.layers.isEnabled(POSER_LAYER);

const GLASS_OPACITY = 0.22;

/** Put a surface look (or none) on every lit standard material of the set; a material recompiles only when its look changes. */
export function applySurfaceLook(scene, surface) {
	const defines = surfaceDefines(surface), stamp = JSON.stringify(defines);
	scene.traverse((node) => {
		if (!node.isMesh || isUi(node)) return;
		for (const material of [node.material].flat()) {
			if (!material?.isMeshStandardMaterial || (material.userData.cozySurface ?? "{}") === stamp) continue;
			// Glass under a flat look is a plain tinted pane: three's transmission shows what is behind it as a blurred
			// copy of the frame, which no surface look reaches. The pane's own transmission comes back with the look off.
			const glass = material.userData.cozyGlass;
			if (surface?.bands && material.transmission > 0) {
				material.userData.cozyGlass = { transmission: material.transmission, transparent: material.transparent, opacity: material.opacity, depthWrite: material.depthWrite };
				Object.assign(material, { transmission: 0, transparent: true, opacity: GLASS_OPACITY, depthWrite: false });
			} else if (!surface?.bands && glass) {
				Object.assign(material, glass);
				delete material.userData.cozyGlass;
			}
			material.defines = { ...material.defines };
			for (const key of SURFACE_KEYS) delete material.defines[key];
			Object.assign(material.defines, defines);
			material.userData.cozySurface = stamp;
			material.needsUpdate = true;
		}
	});
}

// tone: three's curve for the draw; exposure: a multiplier on the stage's own (Neutral lacks the 1/0.6 that three's ACES
// applies); occlusion false: no soft contact darkening (stage-occlusion.js), a ramp the flat look has no place for.
export const FINISH_LOOKS = Object.freeze({
	toon: Object.freeze({
		tone: THREE.NeutralToneMapping, exposure: 1.3,
		surface: { bands: { level: 0.75, fill: 2.2, pool: 0.6, poolAt: 0.5, poolSoft: 0.35, reach: 8 } },
		line: { color: "#0a0a0c", amount: 1, width: 1.4, crease: 1 },
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
float depthAt( vec2 uv ) { return linearDepth( texture2D( tDepth, uv ).x ); }
// an empty pixel of the prepass (alpha 0) faces the camera
vec3 normalAt( vec2 uv ) { vec4 n = texture2D( tNormal, uv ); return mix( vec3( 0.0, 0.0, 1.0 ), n.xyz * 2.0 - 1.0, step( 0.5, n.a ) ); }
vec3 toLinear( vec3 c ) { return mix( c / 12.92, pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), step( 0.04045, c ) ); }
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
	float edge = max( smoothstep( 0.055, 0.16, depthEdge ) * owner, smoothstep( 0.7, 1.7, normalEdge ) * creaseAmount );
	color = mix( color, lineColor, edge * lineAmount * fade );
	color = mix( vec3( dot( color, vec3( 0.2126, 0.7152, 0.0722 ) ) ), color, saturation );
	// the output target stores sRGB and encodes on write: hand it linear
	gl_FragColor = vec4( toLinear( clamp( color, 0.0, 1.0 ) ), 1.0 );
}`;

const value = (initial) => ({ value: initial });
// What the line prepass leaves out, as the viewport's does (dualview.jsx): picture cards, the deck, glow halos.
// A see-through pane is left out too, so the things behind it get their lines.
const seeThrough = (node) => node.isMesh && [node.material].flat().every((material) => material?.transmission > 0 || material?.userData?.cozyGlass);
const noLine = (node) => node.userData?.cutoutTexture !== undefined || node.userData?.noInk || node.userData?.beautyOnly || seeThrough(node);
// Size buckets kept alive at once (the viewport pane, the preview card, the exports).
const CACHED_SIZES = 4;

/** The frame pass for one renderer. render() draws `scene` through `camera` with `look` into `output` (an 8-bit sRGB target)
 *  and answers the depth of the draw (a depth texture of output's size). Layers the camera has off stay off. */
export function createFinish() {
	const normalMaterial = new THREE.MeshNormalMaterial({ blending: THREE.NoBlending, side: THREE.DoubleSide });
	const finish = new THREE.ShaderMaterial({ vertexShader: VERTEX, fragmentShader: FINISH, depthTest: false, depthWrite: false, toneMapped: false, uniforms: {
		tColor: value(null), tNormal: value(null), tDepth: value(null), texel: value(new THREE.Vector2()), cameraNear: value(0.1), cameraFar: value(100),
		lineColor: value(new THREE.Vector3()), lineAmount: value(0), lineWidth: value(1), creaseAmount: value(0.68), saturation: value(1),
	} });
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
			set = { drawn, prepass };
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
		const { drawn, prepass } = targetsFor(output.width, output.height);
		const before = { target: renderer.getRenderTarget(), tone: renderer.toneMapping, exposure: renderer.toneMappingExposure, autoClear: renderer.autoClear, alpha: renderer.getClearAlpha(),
			background: scene.background, override: scene.overrideMaterial, mask: camera.layers.mask, shadowAuto: renderer.shadowMap.autoUpdate, shadowNeeds: renderer.shadowMap.needsUpdate, after: scene.onAfterRender, before: scene.onBeforeRender };
		renderer.getClearColor(clearColor);
		const hidden = [];
		try {
			applySurfaceLook(scene, look.surface);
			renderer.toneMapping = look.tone;
			renderer.toneMappingExposure = before.exposure * look.exposure;
			renderer.autoClear = true;
			renderer.setRenderTarget(drawn);
			if (look.occlusion === false) scene.onAfterRender = () => {};
			renderer.render(scene, camera);
			scene.onAfterRender = before.after;
			// lines read the normals and depth of the solid set
			scene.traverse((node) => { if (node.visible && noLine(node)) { hidden.push(node); node.visible = false; } });
			// no backdrop: the stage sky's hook (stage-sky.jsx) would put one back and clear the prepass with it
			scene.background = null;
			scene.onBeforeRender = () => {};
			scene.overrideMaterial = normalMaterial;
			camera.layers.disable(GIZMO_LAYER);
			camera.layers.disable(POSER_LAYER);
			renderer.shadowMap.autoUpdate = false;
			renderer.setClearColor(0x000000, 0);
			renderer.setRenderTarget(prepass);
			renderer.render(scene, camera);
			for (const node of hidden.splice(0)) node.visible = true;
			scene.background = before.background;
			scene.onBeforeRender = before.before;
			scene.overrideMaterial = before.override;
			camera.layers.mask = before.mask;
			const u = finish.uniforms;
			u.tColor.value = drawn.texture;
			u.tNormal.value = prepass.texture;
			u.tDepth.value = prepass.depthTexture;
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
		finish.dispose();
		quad.dispose();
	}
	return { render, dispose };
}
