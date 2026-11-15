// The surface layer of the finish (stage-finish.js): a patch of three's own shader chunks, switched per material by a
// define, so stock materials compile exactly as before while the look is off. The patch is installed when this module
// loads, before any material compiles; stage-finish.js imports it first for that reason.
import * as THREE from "three";
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
