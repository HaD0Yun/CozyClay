// The surface layer of the finish (stage-finish.js): a patch of three's own shader chunks, switched per material by a
// define, so stock materials compile exactly as before while the look is off. The patch is installed when this module
// loads, before any material compiles; stage-finish.js imports it first for that reason.
import * as THREE from "three";
import { GIZMO_LAYER, POSER_LAYER } from "./dualview.jsx";
import { GLASS_PANE_OPACITY } from "./material-presets.js";

// One light step per light with a direction. A directional light with none (its target on itself: the rig's fill and
// rim while the bands are on, see applySurfaceLook) lights every face the same, at half the lit step: it lifts the set
// without drawing an edge where nobody placed a light. A light somebody placed keeps its direction and its step,
// whether it casts a shadow or not.
const DIRECT = "float dotNL = saturate( dot( geometryNormal, directLight.direction ) );\n\tvec3 irradiance = dotNL * directLight.color;";
const DIRECT_BANDS = `float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	#ifdef COZY_BANDS
		if ( ! cozyStockLamp ) dotNL = COZY_BANDS_LEVEL * ( dot( directLight.direction, directLight.direction ) < 0.5 ? 0.5 : smoothstep( 0.02, 0.05, dotNL ) );
	#endif
	vec3 irradiance = dotNL * directLight.color;`;
// A material that keeps the stock lamp light (userData.surfaceLampStock, see FALLOFF_BANDS) keeps a lamp's stock step
// too: the loops of the point and the spot lights say so, the directional loop after them takes it back.
const LAMPS = ["getPointLightInfo( pointLight, geometryPosition, directLight );", "getSpotLightInfo( spotLight, geometryPosition, directLight );"];
const SUN = "getDirectionalLightInfo( directionalLight, directLight );";
const lampFlag = (line, value) => `${line}
		#ifdef COZY_LAMP_STOCK
			cozyStockLamp = ${value};
		#endif`;
// A cast shadow is in or out: the filtered edge of every shadow lookup is cut at its middle. The cut needs a filter
// that rises evenly, so under the bands the taps are not turned by per-pixel noise (turned taps come out of the cut as
// a dotted edge) and the kernel stays between one and two texels (stage.lighting.shadowSoftness has no penumbra to
// widen under a hard edge; taps spread wider than the texels they read come out as a comb on a face that lies along
// the light, and a narrower kernel shows each texel of a wide shadow box as a step).
const SHADOW = "return mix( 1.0, shadow, shadowIntensity );";
const SHADOW_BANDS = `#ifdef COZY_BANDS
			shadow = smoothstep( 0.42, 0.58, shadow );
		#endif
		${SHADOW}`;
const NOISE = "float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;";
const NOISE_BANDS = `#ifdef COZY_BANDS
				float phi = 0.0;
			#else
				${NOISE}
			#endif`;
const KERNEL = "vec2 radius = shadowRadius * texelSize;";
const KERNEL_BANDS = `#ifdef COZY_BANDS
					shadowRadius = clamp( shadowRadius, 1.0, 2.0 );
				#endif
				${KERNEL}`;
// The environment light under the look is the hemisphere's three flat values (up, sideways, down) read from the map,
// at the same fill gain, so stage.lighting.envLight 1 keeps the hemisphere's brightness and adds no ramp from top to
// bottom. Sideways is read toward the face's own heading, so the map's side light (the glow toward the key, an HDR
// map's lamps, stage.lighting.hdrRotation) still falls on the faces that look at it.
const IBL = "iblIrradiance += getIBLIrradiance( geometryNormal );";
const IBL_BANDS = `#ifdef COZY_BANDS
				vec3 cozyUp = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
				float cozyY = dot( geometryNormal, cozyUp );
				vec3 cozySide = geometryNormal - cozyUp * cozyY;
				cozySide /= max( length( cozySide ), 0.001 );
				iblIrradiance += mix( mix( getIBLIrradiance( - cozyUp ), getIBLIrradiance( cozySide ), smoothstep( - 0.52, - 0.48, cozyY ) ), getIBLIrradiance( cozyUp ), smoothstep( 0.48, 0.52, cozyY ) );
			#else
				${IBL}
			#endif`;
const IBL_DIFFUSE = "vec3 indirectDiffuse = diffuse * cosineWeightedIrradiance;";
const IBL_DIFFUSE_BANDS = "vec3 indirectDiffuse = diffuse * cosineWeightedIrradiance * COZY_FILL_GAIN;";
// Flat faces: no highlight and no mirrored surroundings; a metal keeps its colour as a plain one.
const FLAT = `
#ifdef COZY_BANDS
	material.diffuseContribution = diffuseColor.rgb;
	material.specularColor = vec3( 0.0 );
	material.specularColorBlended = vec3( 0.0 );
	material.specularF90 = 0.0;
#endif`;

// A lamp lights one flat pool whose rim fades over the last COZY_POOL_SOFT of its radius: everything within COZY_POOL of its range (or of COZY_REACH metres when
// it has no range) gets the light the stock falloff gives at COZY_POOL_AT of the way to that rim. Past the pool the light is the stock falloff (never more than
// the pool's level), so a lamp hung higher than its pool still lights what is under it and a lamp's range ends where the record says. A material that says so
// (userData.surfaceLampStock: the deck) keeps the lamp's stock light, falloff and step: the pool keeps a form's faces flat, and the ground a lamp shines on shows how far its light goes.
// A spot's cone keeps its own soft rim, and the sky/ground fill has three flat values (up, sideways, down) instead of a ramp around a curved surface.
const FALLOFF = "\treturn distanceFalloff;";
const FALLOFF_BANDS = `	#if defined( COZY_BANDS ) && ! defined( COZY_LAMP_STOCK )
		float cozyRim = COZY_POOL * ( cutoffDistance > 0.0 ? cutoffDistance : COZY_REACH );
		float cozyLevel = 1.0 / pow( COZY_POOL_AT * cozyRim, decayExponent );
		distanceFalloff = max( ( 1.0 - smoothstep( ( 1.0 - COZY_POOL_SOFT ) * cozyRim, cozyRim, lightDistance ) ) * cozyLevel, min( distanceFalloff, cozyLevel ) );
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
bool cozyStockLamp = false;
`;

/** Patch three's chunks once, before any material compiles; answers whether the surface look is in. */
function installSurfaceLooks(chunks = THREE.ShaderChunk) {
	if (chunks.lights_physical_pars_fragment.includes("COZY_BANDS")) return true;
	// A three upgrade that rewrites the direct light leaves the stock one in place.
	if (!chunks.lights_physical_pars_fragment.includes(DIRECT)) return false;
	chunks.lights_physical_pars_fragment = chunks.lights_physical_pars_fragment.replace(DIRECT, DIRECT_BANDS).replace(IBL_DIFFUSE, IBL_DIFFUSE_BANDS);
	chunks.shadowmap_pars_fragment = chunks.shadowmap_pars_fragment.replaceAll(SHADOW, SHADOW_BANDS).replaceAll(NOISE, NOISE_BANDS).replace(KERNEL, KERNEL_BANDS);
	chunks.lights_physical_fragment += FLAT;
	chunks.lights_physical_pars_fragment = FILL_GAIN + chunks.lights_physical_pars_fragment.replace(FILL, FILL_BANDS);
	for (const [stock, banded] of [[FALLOFF, FALLOFF_BANDS], [HEMI, HEMI_BANDS]]) chunks.lights_pars_begin = chunks.lights_pars_begin.replace(stock, banded);
	for (const line of LAMPS) chunks.lights_fragment_begin = chunks.lights_fragment_begin.replace(line, lampFlag(line, true));
	chunks.lights_fragment_begin = chunks.lights_fragment_begin.replace(SUN, lampFlag(SUN, false));
	chunks.lights_fragment_maps = chunks.lights_fragment_maps.replace(IBL, IBL_BANDS);
	return true;
}
installSurfaceLooks();

const glsl = (value) => (Number.isInteger(value) ? `${value}.0` : String(value));
// own: what a material sets for itself (material.userData): surfaceFill, its fill gain in place of the look's; surfaceLampStock, the stock lamp falloff
const surfaceDefines = (surface, own = {}) => (surface?.bands ? { COZY_BANDS: "", COZY_BANDS_LEVEL: glsl(surface.bands.level), COZY_FILL: glsl(own.surfaceFill ?? surface.bands.fill), COZY_POOL: glsl(surface.bands.pool), COZY_POOL_AT: glsl(surface.bands.poolAt), COZY_POOL_SOFT: glsl(surface.bands.poolSoft), COZY_REACH: glsl(surface.bands.reach), ...(own.surfaceLampStock ? { COZY_LAMP_STOCK: "" } : {}) } : {});
const SURFACE_KEYS = ["COZY_BANDS", "COZY_BANDS_LEVEL", "COZY_FILL", "COZY_POOL", "COZY_POOL_AT", "COZY_POOL_SOFT", "COZY_REACH", "COZY_LAMP_STOCK"];
// Editor furniture (gizmos, handles, the selection cage) is UI: it never takes the look.
const isUi = (node) => node.layers.isEnabled(GIZMO_LAYER) || node.layers.isEnabled(POSER_LAYER);


/** A fill light (userData.fillLight: the rig's fill and rim, room.jsx) has no direction while the bands are on, which
 *  the shader reads as "light every face alike" (DIRECT_BANDS), and its own aim again with them off. */
function aimFillLight(light, flat) {
	const aim = (light.userData.fillAim ??= light.target.position.clone());
	if (flat) { light.updateWorldMatrix(true, false); light.target.position.setFromMatrixPosition(light.matrixWorld); } else light.target.position.copy(aim);
	light.target.updateMatrixWorld();
}

/** Put a surface look (or none) on every lit standard material of the set; a material recompiles only when its look changes. */
export function applySurfaceLook(scene, surface) {
	const shared = surfaceDefines(surface), sharedStamp = JSON.stringify(shared);
	scene.traverse((node) => {
		if (node.isDirectionalLight && node.userData.fillLight) aimFillLight(node, !!surface?.bands);
		if (!node.isMesh || isUi(node)) return;
		for (const material of [node.material].flat()) {
			if (!material?.isMeshStandardMaterial) continue;
			const own = surface?.bands && (material.userData.surfaceFill !== undefined || material.userData.surfaceLampStock);
			const defines = own ? surfaceDefines(surface, material.userData) : shared, stamp = own ? JSON.stringify(defines) : sharedStamp;
			if ((material.userData.cozySurface ?? "{}") === stamp) continue;
			// Glass under a flat look is a plain tinted pane: three's transmission shows what is behind it as a blurred
			// copy of the frame, which no surface look reaches. The pane's own transmission comes back with the look off.
			const glass = material.userData.cozyGlass;
			if (surface?.bands && material.transmission > 0) {
				material.userData.cozyGlass = { transmission: material.transmission, transparent: material.transparent, opacity: material.opacity, depthWrite: material.depthWrite };
				Object.assign(material, { transmission: 0, transparent: true, opacity: GLASS_PANE_OPACITY, depthWrite: false });
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
