#!/usr/bin/env node
// The Top-View's pan and zoom math: the opening framing keeps the old view
// when the content fits it, frames a long scene whole, and a pan or a zoom
// keeps the floor point under the pointer.
import { PLAN_EXTENT, openingPlanView, pannedPlanView, planContentBounds, zoomedPlanView } from "../src/plan-navigation.js";
import { WORLD } from "../src/world-scale.js";

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// The floor point under pane point (u, v), v down, for a view on a pane of this aspect.
const floorAt = (view, u, v, aspect) => {
	const half = PLAN_EXTENT / view.zoom;
	return { x: view.x + u * half * aspect, z: view.z + v * half };
};

const small = planContentBounds({ points: [{ x: -3, z: 2 }, { x: 4, z: -5 }], boxes: [{ x: 0, z: 0, yaw: 0, width: 2, depth: 2 }] });
const kept = openingPlanView(small, 1, 1);
expect("a scene inside the old view opens on the old view (centre 0, same zoom)", kept.x === 0 && kept.z === 0 && kept.zoom === 1, JSON.stringify(kept));
expect("the old view keeps a zoomed-in layout's zoom", openingPlanView(small, 1, 1.5).zoom === 1.5);
expect("an empty board opens on the old view", JSON.stringify(openingPlanView(null, 1, 0.8)) === JSON.stringify({ x: 0, z: 0, zoom: 0.8 }));

for (const span of [60, 200]) {
	const bounds = planContentBounds({ points: [{ x: 0, z: 0 }, { x: span, z: 0 }], boxes: [{ x: span / 2, z: 0, yaw: 0, width: span, depth: 4 }] });
	const view = openingPlanView(bounds, 1, 1);
	const left = floorAt(view, -1, 0, 1), right = floorAt(view, 1, 0, 1);
	expect(`a ${span} m scene is framed whole on a square pane`, left.x <= 0 && right.x >= span && near(view.x, span / 2), JSON.stringify({ view, left, right }));
}
// The old limit: zoom 0.25 about the stage centre, a 99.2 m square.
expect("the old widest view was 99.2 m", near(2 * PLAN_EXTENT / 0.25, 99.2, 1e-6));
const widest = openingPlanView({ minX: -WORLD.position, maxX: WORLD.position, minZ: 0, maxZ: 0 }, 1, 1);
expect("the widest view now holds the whole floor", 2 * PLAN_EXTENT / widest.zoom >= 2 * WORLD.position, JSON.stringify(widest));

const rotated = planContentBounds({ boxes: [{ x: 0, z: 0, yaw: Math.PI / 2, width: 10, depth: 2 }] });
expect("a turned prop's footprint turns its bounds", near(rotated.maxZ, 5) && near(rotated.maxX, 1), JSON.stringify(rotated));

const start = { x: 10, z: -4, zoom: 0.5 };
const under = floorAt(start, 0.3, -0.2, 1.4);
const panned = pannedPlanView(start, 40, -25, 300);
// 40 px right and 25 px up on a 300 px tall pane: the floor point moves with the pointer.
const after = floorAt(panned, 0.3 + (2 * 40) / (300 * 1.4), -0.2 - (2 * 25) / 300, 1.4);
expect("a pan keeps the floor point under the pointer", near(after.x, under.x, 1e-9) && near(after.z, under.z, 1e-9), JSON.stringify({ under, after }));

const zoomed = zoomedPlanView(start, 1.6, 0.5, -0.4, 1.4);
const kept2 = floorAt(zoomed, 0.5, -0.4, 1.4), before2 = floorAt(start, 0.5, -0.4, 1.4);
expect("a zoom keeps the floor point under the pointer", near(kept2.x, before2.x, 1e-9) && near(kept2.z, before2.z, 1e-9) && near(zoomed.zoom, 0.8), JSON.stringify({ zoomed, kept2, before2 }));
expect("zoom stops at 4x in", zoomedPlanView(start, 100, 0, 0, 1).zoom === 4);

if (failures) process.exit(1);
console.log("PASS plan navigation: old view kept when the content fits; 60 m and 200 m framed whole; widest view 99.2 m -> the whole floor; pan and zoom keep the point under the pointer");
