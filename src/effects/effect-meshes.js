/**
 * GPU side of the effects: one instanced quad mesh for every particle in the
 * scene and one for every trail-ribbon quad, written from evaluateEffects.
 *
 * Quads face whichever camera draws them (the editor, the shot camera, a
 * contact-sheet view), so the CPU only redoes work when the frame changes.
 * Blending is premultiplied: a particle writes (rgb x a, a) to blend normally
 * or (rgb x a, cover x a) to mostly add, so smoke and fire share one draw. Smoke-like
 * particles are lit by the stage's lights (wrapped, from the camera side);
 * additive ones are emissive. Both take the stage fog, write no depth and
 * cast no shadow. Their instance matrices are all zero, so a pass that
 * swaps in its own material (normal, the ink prepass) collapses them to
 * nothing. The depth pass is the exception (render-passes.js): it lets these
 * two materials draw themselves, and they write their own distance as the
 * pass's grey, mixed over what is behind by the particle's opacity.
 */
import * as THREE from "three";
import { EFFECT_PARTICLE_CAP, EFFECT_SEGMENT_CAP, evaluateEffects } from "./simulate.js";

/** How much of what is behind an emissive (fire, sparks) particle it hides:
 * 0 would be purely additive, which vanishes over a light stage; at 0.85 a
 * flame stays orange on the daylight grey and still glows on a night sky. */
const EMISSIVE_COVER = 0.85;
const SHADE = /* glsl */ `
vec3 effectLight(vec3 base, vec3 viewPos) {
	vec3 n = vec3(0.0, 0.0, 1.0);
	vec3 irradiance = getAmbientLightIrradiance(ambientLightColor);
	#if NUM_HEMI_LIGHTS > 0
	for (int i = 0; i < NUM_HEMI_LIGHTS; i++) irradiance += getHemisphereLightIrradiance(hemisphereLights[i], n);
	#endif
	#if NUM_DIR_LIGHTS > 0
	for (int i = 0; i < NUM_DIR_LIGHTS; i++) irradiance += directionalLights[i].color * (0.55 + 0.45 * dot(n, directionalLights[i].direction));
	#endif
	#if NUM_POINT_LIGHTS > 0
	for (int i = 0; i < NUM_POINT_LIGHTS; i++) {
		vec3 toLight = pointLights[i].position - viewPos; float d = length(toLight);
		irradiance += pointLights[i].color * getDistanceAttenuation(d, pointLights[i].distance, pointLights[i].decay) * (0.55 + 0.45 * dot(n, toLight / max(d, 1e-4)));
	}
	#endif
	#if NUM_SPOT_LIGHTS > 0
	for (int i = 0; i < NUM_SPOT_LIGHTS; i++) {
		vec3 toLight = spotLights[i].position - viewPos; float d = length(toLight); vec3 l = toLight / max(d, 1e-4);
		float cone = getSpotAttenuation(spotLights[i].coneCos, spotLights[i].penumbraCos, dot(l, spotLights[i].direction));
		irradiance += spotLights[i].color * cone * getDistanceAttenuation(d, spotLights[i].distance, spotLights[i].decay) * (0.55 + 0.45 * dot(n, l));
	}
	#endif
	return base * irradiance * RECIPROCAL_PI;
}
// Tone map and encode like every stage material, then fog (additive light
// fades into it instead), then premultiply.
vec4 effectOut(vec3 color, float alpha, float additive) {
	gl_FragColor = vec4(color, 1.0);
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#ifdef USE_FOG
	#ifdef FOG_EXP2
	float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
	#else
	float fogF = smoothstep(fogNear, fogFar, vFogDepth);
	#endif
	gl_FragColor.rgb = additive > 0.5 ? gl_FragColor.rgb * (1.0 - fogF) : mix(gl_FragColor.rgb, fogColor, fogF);
	#endif
	return vec4(gl_FragColor.rgb * alpha, additive > 0.5 ? alpha * ${EMISSIVE_COVER.toFixed(2)} : alpha);
}
`;
const FRAGMENT_HEAD = /* glsl */ `
#include <common>
#include <lights_pars_begin>
#include <fog_pars_fragment>
uniform float globalOpacity;
uniform float passDepth; uniform float passNear; uniform float passFar; uniform float passInverse;
// The depth pass's grey for a fragment at this view position (render-passes.js, the same ramp), premultiplied.
vec4 effectDepth(vec3 viewPos, float alpha) {
	float d = -viewPos.z;
	float grey = passInverse > 0.5
		? clamp((1.0 / max(d, passNear) - 1.0 / passFar) / (1.0 / passNear - 1.0 / passFar), 0.0, 1.0)
		: 1.0 - clamp((d - passNear) / max(passFar - passNear, 0.0001), 0.0, 1.0);
	return vec4(vec3(grey) * alpha, alpha);
}
${SHADE}`;

const PARTICLE_VERTEX = /* glsl */ `
attribute vec3 iPos; attribute vec4 iParams; attribute vec4 iColor; attribute vec4 iStreak;
varying vec2 vUv; varying vec4 vColor; varying float vLit; varying float vAdd; varying vec3 vViewPos;
#include <fog_pars_vertex>
void main() {
	vec4 center = viewMatrix * vec4(iPos, 1.0);
	vec3 streak = (viewMatrix * vec4(iStreak.xyz, 0.0)).xyz;
	float size = iParams.x, len = length(streak.xy);
	vec2 offset;
	if (len > size * 0.25) {
		vec2 along = streak.xy / len;
		offset = along * position.y * (size + len) + vec2(-along.y, along.x) * position.x * size;
	} else {
		float c = cos(iParams.y), s = sin(iParams.y);
		offset = size * vec2(c * position.x - s * position.y, s * position.x + c * position.y);
	}
	vec4 mvPosition = center + vec4(offset, 0.0, 0.0);
	gl_Position = projectionMatrix * mvPosition;
	vUv = (uv + vec2(mod(iParams.z, 2.0), floor(iParams.z / 2.0))) * 0.5;
	vColor = iColor; vLit = iParams.w; vAdd = iStreak.w; vViewPos = mvPosition.xyz;
	#include <fog_vertex>
}`;
const PARTICLE_FRAGMENT = /* glsl */ `
uniform sampler2D map;
varying vec2 vUv; varying vec4 vColor; varying float vLit; varying float vAdd; varying vec3 vViewPos;
${FRAGMENT_HEAD}
void main() {
	float alpha = vColor.a * texture2D(map, vUv).r * globalOpacity;
	if (alpha < 0.002) discard;
	if (passDepth > 0.5) { gl_FragColor = effectDepth(vViewPos, alpha); return; }
	gl_FragColor = effectOut(vLit > 0.5 ? effectLight(vColor.rgb, vViewPos) : vColor.rgb, alpha, vAdd);
}`;

const RIBBON_VERTEX = /* glsl */ `
attribute vec3 rA0; attribute vec3 rB0; attribute vec3 rA1; attribute vec3 rB1; attribute vec2 rAlpha; attribute vec4 rColor;
varying float vAlpha; varying float vAcross; varying vec3 vColor; varying float vAdd; varying vec3 vViewPos;
#include <fog_pars_vertex>
void main() {
	float along = position.x + 0.5, across = position.y + 0.5;
	vec3 world = mix(mix(rA0, rB0, across), mix(rA1, rB1, across), along);
	vec4 mvPosition = viewMatrix * vec4(world, 1.0);
	gl_Position = projectionMatrix * mvPosition;
	vAlpha = mix(rAlpha.x, rAlpha.y, along); vAcross = across; vColor = rColor.rgb; vAdd = rColor.a; vViewPos = mvPosition.xyz;
	#include <fog_vertex>
}`;
const RIBBON_FRAGMENT = /* glsl */ `
varying float vAlpha; varying float vAcross; varying vec3 vColor; varying float vAdd; varying vec3 vViewPos;
${FRAGMENT_HEAD}
void main() {
	float alpha = vAlpha * pow(sin(PI * vAcross), 0.6) * globalOpacity;
	if (alpha < 0.002) discard;
	if (passDepth > 0.5) { gl_FragColor = effectDepth(vViewPos, alpha); return; }
	gl_FragColor = effectOut(vAdd > 0.5 ? vColor : effectLight(vColor, vViewPos), alpha, vAdd);
}`;

/** A 2x2 atlas of soft puffs: cell 0 a clean round falloff, cells 1-3 seeded wisps. */
function puffAtlas() {
	const size = 128, cell = 64, data = new Uint8Array(size * size * 4);
	const hash = (x, y, v) => { const h = Math.sin(x * 127.1 + y * 311.7 + v * 74.7) * 43758.5453; return h - Math.floor(h); };
	const noise = (x, y, v) => {
		const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
		const top = hash(ix, iy, v) + (hash(ix + 1, iy, v) - hash(ix, iy, v)) * sx, bottom = hash(ix, iy + 1, v) + (hash(ix + 1, iy + 1, v) - hash(ix, iy + 1, v)) * sx;
		return top + (bottom - top) * sy;
	};
	for (let v = 0; v < 4; v += 1) {
		for (let y = 0; y < cell; y += 1) {
			for (let x = 0; x < cell; x += 1) {
				const nx = (x + 0.5) / cell * 2 - 1, ny = (y + 0.5) / cell * 2 - 1, r = Math.hypot(nx, ny);
				let a = Math.exp(-r * r * 4.2) * (1 - Math.min(1, Math.max(0, (r - 0.82) / 0.18)));
				if (v > 0) {
					const fbm = 0.55 * noise(nx * 3 + 5, ny * 3, v) + 0.3 * noise(nx * 6, ny * 6 + 3, v) + 0.15 * noise(nx * 12 + 1, ny * 12, v);
					a *= Math.min(1, Math.max(0, 1.6 * fbm - 0.25));
				}
				const i = (((v >> 1) * cell + y) * size + (v & 1) * cell + x) * 4;
				data[i] = data[i + 1] = data[i + 2] = data[i + 3] = Math.round(255 * Math.min(1, a));
			}
		}
	}
	const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
	texture.minFilter = THREE.LinearMipmapLinearFilter;
	texture.magFilter = THREE.LinearFilter;
	texture.generateMipmaps = true;
	texture.needsUpdate = true;
	return texture;
}

function effectMaterial(vertexShader, fragmentShader, extra = {}) {
	return new THREE.ShaderMaterial({
		uniforms: { ...THREE.UniformsUtils.merge([THREE.UniformsLib.lights, THREE.UniformsLib.fog]), globalOpacity: { value: 1 },
			passDepth: { value: 0 }, passNear: { value: 0.1 }, passFar: { value: 40 }, passInverse: { value: 0 }, ...extra },
		vertexShader, fragmentShader, lights: true, fog: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
		blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
		blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
	});
}

function instancedQuads(material, capacity, layout) {
	const geometry = new THREE.PlaneGeometry(1, 1);
	const attributes = {};
	for (const [name, width] of Object.entries(layout)) {
		attributes[name] = new THREE.InstancedBufferAttribute(new Float32Array(capacity * width), width).setUsage(THREE.DynamicDrawUsage);
		geometry.setAttribute(name, attributes[name]);
	}
	const mesh = new THREE.InstancedMesh(geometry, material, capacity);
	mesh.instanceMatrix.array.fill(0);
	mesh.count = 0;
	mesh.frustumCulled = false;
	mesh.renderOrder = 5;
	mesh.raycast = () => {};
	// The editor's ink prepass outlines geometry; a puff of smoke is none.
	mesh.userData.noInk = true;
	// The depth pass asks this of a node that draws its own distance: on with the pass's ramp, off with null.
	mesh.userData.ownDepth = (ramp) => {
		material.allowOverride = !ramp;
		material.uniforms.passDepth.value = ramp ? 1 : 0;
		if (ramp) { material.uniforms.passNear.value = ramp.near; material.uniforms.passFar.value = ramp.far; material.uniforms.passInverse.value = ramp.inverse ? 1 : 0; }
	};
	return { mesh, attributes };
}

const flush = (attributes, count) => {
	for (const attribute of Object.values(attributes)) {
		attribute.clearUpdateRanges();
		attribute.addUpdateRange(0, count * attribute.itemSize);
		attribute.needsUpdate = true;
	}
};

/** The two meshes and `update(scene, frame, opacity)`, which redraws every effect at `frame`. */
export function createEffectMeshes() {
	const map = puffAtlas();
	const particles = instancedQuads(effectMaterial(PARTICLE_VERTEX, PARTICLE_FRAGMENT, { map: { value: map } }), EFFECT_PARTICLE_CAP, { iPos: 3, iParams: 4, iColor: 4, iStreak: 4 });
	const ribbons = instancedQuads(effectMaterial(RIBBON_VERTEX, RIBBON_FRAGMENT), EFFECT_SEGMENT_CAP, { rA0: 3, rB0: 3, rA1: 3, rB1: 3, rAlpha: 2, rColor: 4 });
	const p = particles.attributes, r = ribbons.attributes;
	return {
		particles: particles.mesh,
		ribbons: ribbons.mesh,
		update(scene, frame, opacity = 1) {
			let n = 0, m = 0;
			evaluateEffects(scene.records, scene, frame, {
				particle(q) {
					if (n >= EFFECT_PARTICLE_CAP) return;
					p.iPos.array.set([q.x, q.y, q.z], n * 3);
					p.iParams.array.set([q.size, q.angle, q.variant, q.additive ? 0 : 1], n * 4);
					p.iColor.array.set([q.r, q.g, q.b, q.alpha], n * 4);
					p.iStreak.array.set([q.sx, q.sy, q.sz, q.additive ? 1 : 0], n * 4);
					n += 1;
				},
				segment(sg, em) {
					if (m >= EFFECT_SEGMENT_CAP) return;
					r.rA0.array.set(sg.a0, m * 3); r.rB0.array.set(sg.b0, m * 3); r.rA1.array.set(sg.a1, m * 3); r.rB1.array.set(sg.b1, m * 3);
					r.rAlpha.array.set([sg.alpha0, sg.alpha1], m * 2);
					r.rColor.array.set([...em.rgb, em.effect.additive ? 1 : 0], m * 4);
					m += 1;
				},
			});
			particles.mesh.count = n;
			ribbons.mesh.count = m;
			flush(p, n);
			flush(r, m);
			for (const mesh of [particles.mesh, ribbons.mesh]) mesh.material.uniforms.globalOpacity.value = opacity;
		},
		dispose() {
			map.dispose();
			for (const mesh of [particles.mesh, ribbons.mesh]) {
				mesh.geometry.dispose();
				mesh.material.dispose();
				mesh.dispose?.();
			}
		},
	};
}
