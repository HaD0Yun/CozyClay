// The finish: the one look laid over every surface and every frame, whatever the set is built from.
// PROTOTYPE (proto/lowvis-bg-look): several candidate looks live here side by side so the owner can pick one by eye;
// the ones not picked go away with this note.
//
// Two layers, neither knows what an object is:
// - surface: a patch of three's own shader chunks, switched per material by a define, so stock materials compile
//   exactly as before while no look is on. `wobble` is a soft hand-formed unevenness (a bump from 3D noise in the
//   object's own frame, in metres, so it rides with a moving prop); `bands` quantises the direct light into steps.
// - frame: screen-space passes over the finished draw: lines and cavity shading from a normal/depth prepass, a grade,
//   depth of field, vignette and grain.
//
// The scene is drawn into a float target flagged isXRRenderTarget. That flag is what three checks (WebGLPrograms.js,
// WebGLTextures.js) to tone-map and encode in the material, as it does on the canvas, so an exported frame gets the
// viewport's tone curve, its untouched sky and its fog instead of the unmapped light a plain render target holds.
import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { GIZMO_LAYER, POSER_LAYER } from "./dualview.jsx";

const WOBBLE_COMMON = `
#ifdef COZY_WOBBLE
	varying vec3 vCozyPos;
	float cozyHash( vec3 p ) { p = fract( p * 0.3183099 + vec3( 0.1, 0.2, 0.3 ) ); p *= 17.0; return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) ); }
	float cozyNoise( vec3 x ) {
		vec3 i = floor( x ), f = fract( x );
		f = f * f * ( 3.0 - 2.0 * f );
		return mix( mix( mix( cozyHash( i ), cozyHash( i + vec3( 1.0, 0.0, 0.0 ) ), f.x ), mix( cozyHash( i + vec3( 0.0, 1.0, 0.0 ) ), cozyHash( i + vec3( 1.0, 1.0, 0.0 ) ), f.x ), f.y ),
			mix( mix( cozyHash( i + vec3( 0.0, 0.0, 1.0 ) ), cozyHash( i + vec3( 1.0, 0.0, 1.0 ) ), f.x ), mix( cozyHash( i + vec3( 0.0, 1.0, 1.0 ) ), cozyHash( i + vec3( 1.0, 1.0, 1.0 ) ), f.x ), f.y ), f.z );
	}
	float cozyRelief( vec3 p ) { return cozyNoise( p * COZY_WOBBLE_FREQ ) * 0.7 + cozyNoise( p * COZY_WOBBLE_FREQ * 2.7 + 7.3 ) * 0.3; }
#endif`;
const WOBBLE_VERTEX = `
#ifdef COZY_WOBBLE
	vCozyPos = position * vec3( length( modelMatrix[ 0 ].xyz ), length( modelMatrix[ 1 ].xyz ), length( modelMatrix[ 2 ].xyz ) );
#endif`;
// Mikkelsen's surface gradient with unnormalised derivatives (as material-look.js): COZY_WOBBLE_DEPTH is a relief in metres.
const WOBBLE_FRAGMENT = `
#ifdef COZY_WOBBLE
{
	vec3 cozySx = dFdx( - vViewPosition ), cozySy = dFdy( - vViewPosition );
	float cozyH = cozyRelief( vCozyPos );
	vec2 cozyDH = COZY_WOBBLE_DEPTH * vec2( cozyRelief( vCozyPos + dFdx( vCozyPos ) ) - cozyH, cozyRelief( vCozyPos + dFdy( vCozyPos ) ) - cozyH );
	vec3 cozyR1 = cross( cozySy, normal ), cozyR2 = cross( normal, cozySx );
	float cozyDet = dot( cozySx, cozyR1 ) * faceDirection;
	if ( abs( cozyDet ) > 1e-14 ) normal = normalize( abs( cozyDet ) * normal - sign( cozyDet ) * ( cozyDH.x * cozyR1 + cozyDH.y * cozyR2 ) );
}
#endif`;
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

/** Patch three's chunks once, before any material compiles; answers which surface looks are in. */
export function installSurfaceLooks(chunks = THREE.ShaderChunk) {
	const has = { wobble: chunks.common.includes("COZY_WOBBLE"), bands: chunks.lights_physical_pars_fragment.includes("COZY_BANDS") };
	if (!has.wobble) {
		chunks.common += WOBBLE_COMMON;
		chunks.begin_vertex += WOBBLE_VERTEX;
		chunks.normal_fragment_maps += WOBBLE_FRAGMENT;
		has.wobble = true;
	}
	// A three upgrade that rewrites the direct light leaves the stock one in place.
	if (!has.bands && chunks.lights_physical_pars_fragment.includes(DIRECT)) {
		chunks.lights_physical_pars_fragment = chunks.lights_physical_pars_fragment.replace(DIRECT, DIRECT_BANDS);
		chunks.shadowmap_pars_fragment = chunks.shadowmap_pars_fragment.replaceAll(SHADOW, SHADOW_BANDS);
		chunks.lights_physical_fragment += FLAT;
		chunks.lights_physical_pars_fragment = FILL_GAIN + chunks.lights_physical_pars_fragment.replace(FILL, FILL_BANDS);
		for (const [stock, banded] of [[FALLOFF, FALLOFF_BANDS], [HEMI, HEMI_BANDS]]) chunks.lights_pars_begin = chunks.lights_pars_begin.replace(stock, banded);
		has.bands = true;
	}
	return has;
}
installSurfaceLooks();

const glsl = (value) => (Number.isInteger(value) ? `${value}.0` : String(value));
const surfaceDefines = (surface) => ({
	...(surface?.wobble ? { COZY_WOBBLE: "", COZY_WOBBLE_FREQ: glsl(surface.wobble.freq), COZY_WOBBLE_DEPTH: glsl(surface.wobble.depth) } : {}),
	...(surface?.bands ? { COZY_BANDS: "", COZY_BANDS_LEVEL: glsl(surface.bands.level), COZY_FILL: glsl(surface.bands.fill), COZY_POOL: glsl(surface.bands.pool), COZY_POOL_AT: glsl(surface.bands.poolAt), COZY_POOL_SOFT: glsl(surface.bands.poolSoft), COZY_REACH: glsl(surface.bands.reach) } : {}),
});
const SURFACE_KEYS = ["COZY_WOBBLE", "COZY_WOBBLE_FREQ", "COZY_WOBBLE_DEPTH", "COZY_BANDS", "COZY_BANDS_LEVEL", "COZY_FILL", "COZY_POOL", "COZY_POOL_AT", "COZY_POOL_SOFT", "COZY_REACH"];

const GLASS_OPACITY = 0.22;

/** Put a surface look (or none) on every lit standard material of the scene; a material recompiles only when its look changes. */
export function applySurfaceLook(scene, surface) {
	const defines = surfaceDefines(surface), stamp = JSON.stringify(defines);
	scene.traverse((node) => {
		if (!node.isMesh) return;
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

// The candidates. tone: three's curve for the draw; exposure: a multiplier on the stage's own (AgX and Neutral lack
// the 1/0.6 that three's ACES applies); line/cavity/grade/dof/vignette/grain: the frame passes.
const CLAY = {
	tone: THREE.AgXToneMapping, exposure: 1.55,
	surface: { wobble: { freq: 9, depth: 0.0035 } },
	line: { color: "#2a3140", amount: 0.42, width: 1 },
	cavity: { ridge: 0.2, valley: 0.4 },
	grade: { saturation: 1.12, contrast: 1.05, black: "#0d0b14", white: "#fff6e8" },
	vignette: 0.2, grain: 0.012,
};
export const FINISH_LOOKS = Object.freeze({
	// the viewport's own curve and line, nothing else: what an export looks like once it matches the viewport
	match: { tone: THREE.ACESFilmicToneMapping, exposure: 1, surface: null, line: { color: "#243b4d", amount: 0.38, width: 0.8 }, cavity: null, grade: { saturation: 1, contrast: 1, black: "#000000", white: "#ffffff" }, vignette: 0, grain: 0 },
	clay: CLAY,
	ink: {
		tone: THREE.NeutralToneMapping, exposure: 1.3,
		surface: { bands: { level: 0.75, fill: 2.2, pool: 0.6, poolAt: 0.5, poolSoft: 0.35, reach: 8 } },
		line: { color: "#15131a", amount: 0.92, width: 1.5 },
		cavity: null,
		grade: { saturation: 1.15, contrast: 1.02, black: "#07070b", white: "#ffffff" },
		vignette: 0, grain: 0,
	},
	// two tones with a hard edge, hard cast shadows, flat faces, black lines (the owner's references, 2026-11-16)
	toon: {
		tone: THREE.NeutralToneMapping, exposure: 1.3,
		surface: { bands: { level: 0.75, fill: 2.2, pool: 0.6, poolAt: 0.5, poolSoft: 0.35, reach: 8 } },
		line: { color: "#0a0a0c", amount: 1, width: 1.4, crease: 1 },
		occlusion: false,
		cavity: null,
		grade: { saturation: 1.1, contrast: 1, black: "#000000", white: "#ffffff" },
		vignette: 0, grain: 0,
	},
	mini: { ...CLAY, grade: { saturation: 1.22, contrast: 1.1, black: "#0d0b14", white: "#fff6e8" }, dof: { aperture: 14, maxRadius: 16 }, vignette: 0.34, grain: 0.02 },
});

const VERTEX = "varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }";
const DEPTH = `
uniform float cameraNear;
uniform float cameraFar;
float linearDepth( float value ) {
	float z = value * 2.0 - 1.0;
	return ( 2.0 * cameraNear * cameraFar ) / ( cameraFar + cameraNear - z * ( cameraFar - cameraNear ) );
}`;
// One gather over a golden-angle spiral (Gustafsson's single-pass bokeh): a tap counts when its own blur reaches the
// centre, and a tap behind the centre never bleeds more than the centre's own blur. Focus: the depth around the middle.
const DOF = `
uniform sampler2D tColor;
uniform sampler2D tSceneDepth;
uniform vec2 texel;
uniform float aperture;
uniform float maxRadius;
varying vec2 vUv;
${DEPTH}
float blurOf( float z, float focus ) { return clamp( abs( 1.0 / focus - 1.0 / z ) * aperture, 0.0, 1.0 ) * maxRadius; }
void main() {
	float focus = 0.0;
	for ( int i = 0; i < 9; i ++ ) focus += linearDepth( texture2D( tSceneDepth, vec2( 0.5, 0.46 ) + vec2( float( i / 3 ) - 1.0, float( i - ( i / 3 ) * 3 ) - 1.0 ) * 0.04 ).x );
	focus /= 9.0;
	float centerZ = linearDepth( texture2D( tSceneDepth, vUv ).x ), centerBlur = blurOf( centerZ, focus );
	vec3 color = texture2D( tColor, vUv ).rgb;
	float total = 1.0, radius = 0.6;
	for ( float angle = 0.0; radius < maxRadius; angle += 2.39996323 ) {
		vec2 at = vUv + vec2( cos( angle ), sin( angle ) ) * texel * radius;
		float z = linearDepth( texture2D( tSceneDepth, at ).x ), blur = blurOf( z, focus );
		if ( z > centerZ ) blur = clamp( blur, 0.0, centerBlur * 2.0 );
		color += mix( color / total, texture2D( tColor, at ).rgb, smoothstep( radius - 0.5, radius + 0.5, blur ) );
		total += 1.0;
		radius += 0.9 / radius;
	}
	gl_FragColor = vec4( color / total, 1.0 );
}`;
// The line kernel is the viewport's (dualview.jsx EDGE_FRAGMENT): a Sobel over log depth, owned by the nearer side, and
// one over the normals. Cavity is the divergence of the view-space normals: ridges catch light, creases lose it.
const FINISH = `
uniform sampler2D tColor;
uniform sampler2D tNormal;
uniform sampler2D tDepth;
uniform vec2 texel;
uniform vec3 lineColor;
uniform float lineAmount;
uniform float lineWidth;
uniform float creaseAmount;
uniform float ridge;
uniform float valley;
uniform float saturation;
uniform float contrast;
uniform vec3 blackPoint;
uniform vec3 whitePoint;
uniform float vignette;
uniform float grain;
varying vec2 vUv;
${DEPTH}
float depthAt( vec2 uv ) { return linearDepth( texture2D( tDepth, uv ).x ); }
// an empty pixel of the prepass (alpha 0) faces the camera
vec4 normalAt( vec2 uv ) { vec4 n = texture2D( tNormal, uv ); return vec4( mix( vec3( 0.0, 0.0, 1.0 ), n.xyz * 2.0 - 1.0, step( 0.5, n.a ) ), n.a ); }
vec3 toLinear( vec3 c ) { return mix( c / 12.92, pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), step( 0.04045, c ) ); }
void main() {
	vec3 color = texture2D( tColor, vUv ).rgb;
	vec2 x = vec2( texel.x * lineWidth, 0.0 ), y = vec2( 0.0, texel.y * lineWidth );
	float centerZ = depthAt( vUv );
	float zL = depthAt( vUv - x ), zR = depthAt( vUv + x ), zB = depthAt( vUv - y ), zT = depthAt( vUv + y );
	vec4 nL = normalAt( vUv - x ), nR = normalAt( vUv + x ), nB = normalAt( vUv - y ), nT = normalAt( vUv + y );
	if ( lineAmount > 0.0 ) {
		float fade = mix( 0.42, 1.0, clamp( 3.0 / max( centerZ, 0.001 ), 0.0, 1.0 ) );
		float owner = 1.0 - step( min( min( zL, zR ), min( zB, zT ) ) + max( 0.002, centerZ * 0.0015 ), centerZ );
		float dTL = log2( 1.0 + depthAt( vUv - x + y ) ), dTR = log2( 1.0 + depthAt( vUv + x + y ) ), dBL = log2( 1.0 + depthAt( vUv - x - y ) ), dBR = log2( 1.0 + depthAt( vUv + x - y ) );
		float dL = log2( 1.0 + zL ), dR = log2( 1.0 + zR ), dB = log2( 1.0 + zB ), dT = log2( 1.0 + zT );
		float depthEdge = length( vec2( dTL + 2.0 * dL + dBL - dTR - 2.0 * dR - dBR, dTL + 2.0 * dT + dTR - dBL - 2.0 * dB - dBR ) );
		vec3 nTL = normalAt( vUv - x + y ).xyz, nTR = normalAt( vUv + x + y ).xyz, nBL = normalAt( vUv - x - y ).xyz, nBR = normalAt( vUv + x - y ).xyz;
		vec3 normalX = nTL + 2.0 * nL.xyz + nBL - nTR - 2.0 * nR.xyz - nBR, normalY = nTL + 2.0 * nT.xyz + nTR - nBL - 2.0 * nB.xyz - nBR;
		float normalEdge = sqrt( dot( normalX, normalX ) + dot( normalY, normalY ) );
		float edge = max( smoothstep( 0.055, 0.16, depthEdge ) * owner, smoothstep( 0.7, 1.7, normalEdge ) * creaseAmount );
		color = mix( color, lineColor, edge * lineAmount * fade );
	}
	if ( ridge > 0.0 || valley > 0.0 ) {
		float curve = ( nR.x - nL.x ) + ( nT.y - nB.y );
		float jump = max( max( abs( zL - centerZ ), abs( zR - centerZ ) ), max( abs( zB - centerZ ), abs( zT - centerZ ) ) ) / max( centerZ, 0.001 );
		curve *= ( 1.0 - smoothstep( 0.004, 0.012, jump ) ) * min( min( nL.a, nR.a ), min( nB.a, nT.a ) );
		color *= 1.0 - valley * clamp( - curve * 1.6, 0.0, 1.0 );
		color += ridge * clamp( curve * 1.6, 0.0, 1.0 ) * ( 1.0 - color );
	}
	color = mix( vec3( dot( color, vec3( 0.2126, 0.7152, 0.0722 ) ) ), color, saturation );
	color = ( color - 0.45 ) * contrast + 0.45;
	color = blackPoint + clamp( color, 0.0, 1.0 ) * ( whitePoint - blackPoint );
	vec2 q = ( vUv - 0.5 ) * vec2( texel.y / texel.x, 1.0 );
	color *= 1.0 - vignette * smoothstep( 0.35, 1.0, length( q ) / length( vec2( texel.y / texel.x, 1.0 ) * 0.5 ) );
	color += ( fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) - 0.5 ) * grain;
	// the output target stores sRGB and encodes on write: hand it linear
	gl_FragColor = vec4( toLinear( clamp( color, 0.0, 1.0 ) ), 1.0 );
}`;

const pass = (fragmentShader, uniforms) => new THREE.ShaderMaterial({ vertexShader: VERTEX, fragmentShader, uniforms, depthTest: false, depthWrite: false, toneMapped: false });
const value = (initial) => ({ value: initial });
// What the line prepass leaves out, as the viewport's does (dualview.jsx): picture cards, the deck, glow halos.
// A see-through pane is left out too, so the things behind it get their lines.
const seeThrough = (node) => node.isMesh && [node.material].flat().every((material) => material?.transmission > 0 || material?.userData?.cozyGlass);
const noLine = (node) => node.userData?.cutoutTexture !== undefined || node.userData?.noInk || node.userData?.beautyOnly || seeThrough(node);
const CACHED_SIZES = 3;

/** The frame passes for one renderer. render() draws `scene` through `camera` with `look` into `output` (an 8-bit sRGB target). */
export function createFinish() {
	const normalMaterial = new THREE.MeshNormalMaterial({ blending: THREE.NoBlending, side: THREE.DoubleSide });
	const dof = pass(DOF, { tColor: value(null), tSceneDepth: value(null), texel: value(new THREE.Vector2()), aperture: value(0), maxRadius: value(0), cameraNear: value(0.1), cameraFar: value(100) });
	const finish = pass(FINISH, {
		tColor: value(null), tNormal: value(null), tDepth: value(null), texel: value(new THREE.Vector2()), cameraNear: value(0.1), cameraFar: value(100),
		lineColor: value(new THREE.Vector3()), lineAmount: value(0), lineWidth: value(1), creaseAmount: value(0.68), ridge: value(0), valley: value(0),
		saturation: value(1), contrast: value(1), blackPoint: value(new THREE.Vector3()), whitePoint: value(new THREE.Vector3(1, 1, 1)), vignette: value(0), grain: value(0),
	});
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
			const blurred = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType });
			set = { drawn, prepass, blurred };
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
		const { drawn, prepass, blurred } = targetsFor(output.width, output.height);
		const before = { target: renderer.getRenderTarget(), tone: renderer.toneMapping, exposure: renderer.toneMappingExposure, autoClear: renderer.autoClear, alpha: renderer.getClearAlpha(),
			background: scene.background, override: scene.overrideMaterial, mask: camera.layers.mask, shadowAuto: renderer.shadowMap.autoUpdate, shadowNeeds: renderer.shadowMap.needsUpdate, after: scene.onAfterRender };
		renderer.getClearColor(clearColor);
		const hidden = [];
		try {
			applySurfaceLook(scene, look.surface);
			renderer.toneMapping = look.tone;
			renderer.toneMappingExposure = before.exposure * look.exposure;
			renderer.autoClear = true;
			renderer.setRenderTarget(drawn);
			// soft contact darkening (stage-occlusion.js) is a ramp: a flat look draws without it
			if (look.occlusion === false) scene.onAfterRender = () => {};
			renderer.render(scene, camera);
			scene.onAfterRender = before.after;
			// lines and cavity read the normals and depth of the solid set
			scene.traverse((node) => { if (node.visible && noLine(node)) { hidden.push(node); node.visible = false; } });
			scene.background = null;
			scene.overrideMaterial = normalMaterial;
			camera.layers.disable(GIZMO_LAYER);
			camera.layers.disable(POSER_LAYER);
			renderer.shadowMap.autoUpdate = false;
			renderer.setClearColor(0x000000, 0);
			renderer.setRenderTarget(prepass);
			renderer.render(scene, camera);
			for (const node of hidden.splice(0)) node.visible = true;
			scene.background = before.background;
			scene.overrideMaterial = before.override;
			camera.layers.mask = before.mask;
			const texel = [1 / output.width, 1 / output.height];
			let color = drawn.texture;
			if (look.dof) {
				dof.uniforms.tColor.value = color;
				dof.uniforms.tSceneDepth.value = drawn.depthTexture;
				dof.uniforms.texel.value.set(...texel);
				dof.uniforms.aperture.value = look.dof.aperture;
				dof.uniforms.maxRadius.value = look.dof.maxRadius * (output.height / 1080);
				dof.uniforms.cameraNear.value = camera.near;
				dof.uniforms.cameraFar.value = camera.far;
				renderer.setRenderTarget(blurred);
				quad.material = dof;
				quad.render(renderer);
				color = blurred.texture;
			}
			const u = finish.uniforms;
			u.tColor.value = color;
			u.tNormal.value = prepass.texture;
			u.tDepth.value = prepass.depthTexture;
			u.texel.value.set(...texel);
			u.cameraNear.value = camera.near;
			u.cameraFar.value = camera.far;
			// colours of the frame passes are display values, like the frame they are mixed into
			u.lineColor.value.copy(srgb(look.line?.color ?? "#000000"));
			u.lineAmount.value = look.line?.amount ?? 0;
			u.lineWidth.value = (look.line?.width ?? 1) * (output.height / 1080);
			u.creaseAmount.value = look.line?.crease ?? 0.68;
			u.ridge.value = look.cavity?.ridge ?? 0;
			u.valley.value = look.cavity?.valley ?? 0;
			u.saturation.value = look.grade.saturation;
			u.contrast.value = look.grade.contrast;
			u.blackPoint.value.copy(srgb(look.grade.black));
			u.whitePoint.value.copy(srgb(look.grade.white));
			u.vignette.value = look.vignette;
			u.grain.value = look.grain;
			renderer.setRenderTarget(output);
			quad.material = finish;
			quad.render(renderer);
		} finally {
			for (const node of hidden) node.visible = true;
			scene.onAfterRender = before.after;
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
		for (const material of [normalMaterial, dof, finish]) material.dispose();
		quad.dispose();
	}
	return { render, dispose };
}
