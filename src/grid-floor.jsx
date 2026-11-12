import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { STAGE_SIZE } from "./room.jsx";
import { GRID_COLORS, GRID_COLORS_LIGHT } from "./grid-view.js";

/**
 * The Blender-style reference grid: one shader plane instead of a floor.
 *
 * Blender draws its grid as a viewport overlay — it is not geometry, casts
 * and receives nothing, and fades out with distance so there is no horizon
 * line. This mesh reproduces that: metre lines and ten-metre lines are drawn
 * in the fragment shader with fwidth() anti-aliasing, the X and Z axes get
 * their Blender colours, and everything dissolves radially into the
 * background long before the plane's real edge could be seen.
 *
 * The material ignores scene lighting and fog on purpose: a reference reads
 * identically under every stage light. Depth testing stays ON so props still
 * occlude the grid; depth WRITING stays off so the transparent plane can
 * never punch holes into other transparents.
 */

const GRID_VERTEX = /* glsl */ `
	varying vec3 worldPos;
	void main() {
		vec4 world = modelMatrix * vec4(position, 1.0);
		worldPos = world.xyz;
		gl_Position = projectionMatrix * viewMatrix * world;
	}
`;

const GRID_FRAGMENT = /* glsl */ `
	uniform vec3 minorColor;
	uniform vec3 majorColor;
	uniform vec3 axisXColor;
	uniform vec3 axisZColor;
	uniform float fadeDistance;
	varying vec3 worldPos;

	// distance-to-line for a 1D repeating grid, anti-aliased by fwidth
	float gridLine(vec2 coord) {
		vec2 wrapped = abs(fract(coord - 0.5) - 0.5) / fwidth(coord);
		return 1.0 - min(min(wrapped.x, wrapped.y), 1.0);
	}

	void main() {
		float minor = gridLine(worldPos.xz);
		float major = gridLine(worldPos.xz / 10.0);
		float radial = clamp(1.0 - length(worldPos.xz - cameraPosition.xz) / fadeDistance, 0.0, 1.0);

		// axis ribbons: one line-width band along x = 0 and z = 0
		float axisXBand = 1.0 - min(abs(worldPos.z) / fwidth(worldPos.z), 1.0);
		float axisZBand = 1.0 - min(abs(worldPos.x) / fwidth(worldPos.x), 1.0);

		vec3 color = minorColor;
		float alpha = minor * 0.55;
		if (major > 0.0) { color = majorColor; alpha = max(alpha, major * 0.9); }
		if (axisXBand > 0.0) { color = axisXColor; alpha = max(alpha, axisXBand); }
		if (axisZBand > 0.0) { color = axisZColor; alpha = max(alpha, axisZBand); }

		alpha *= radial;
		if (alpha <= 0.003) discard;
		gl_FragColor = vec4(color, alpha);
	}
`;

export function GridFloor({ layer = null, light = false }) {
	const colors = light ? GRID_COLORS_LIGHT : GRID_COLORS;
	const material = useMemo(() => new THREE.ShaderMaterial({
		vertexShader: GRID_VERTEX,
		fragmentShader: GRID_FRAGMENT,
		uniforms: {
			minorColor: { value: new THREE.Color(colors.minor) },
			majorColor: { value: new THREE.Color(colors.major) },
			axisXColor: { value: new THREE.Color(colors.axisX) },
			axisZColor: { value: new THREE.Color(colors.axisZ) },
			fadeDistance: { value: 120 },
		},
		transparent: true,
		depthWrite: false,
		fog: false,
	}), [colors]);
	useEffect(() => () => material.dispose(), [material]);
	return (
		<mesh
			rotation={[-Math.PI / 2, 0, 0]}
			position={[0, 0.001, 0]}
			material={material}
			// A reference overlay never joins the scene's light transport.
			receiveShadow={false}
			onUpdate={(mesh) => { if (layer !== null) mesh.layers.set(layer); }}
			name="grid-floor"
		>
			<planeGeometry args={[STAGE_SIZE, STAGE_SIZE]} />
		</mesh>
	);
}
