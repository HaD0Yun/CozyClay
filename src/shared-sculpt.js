// One built mesh per distinct sculpt recipe: copies of a prop (object.duplicate copies) share its geometry instead
// of each rebuilding it (a 30-part tree is ~150 ms of CSG and lofting). Each copy draws a clone of the template
// with its own materials, because the per-object passes (pose fade, glow, capture fades, depth rank) write materials.
// The template's geometry is freed only when no copy holds it, after a grace period: React builds in render and
// holds in an effect (twice under StrictMode), so a count that touches zero between them must not free anything.
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { buildSculptGroup, disposeSculptGroup } from "./sculpt-geometry.js";
import { autoFlat } from "./auto-flat.js";
import { GREY_BOX } from "./object-colors.js";

const GRACE_MS = 2000;
const builds = new Map();
const recipeKeys = new WeakMap();

// Content, not identity: a saved and reloaded scene's copies carry equal recipes in separate objects.
function keyOf(recipe, autoColor) {
	let json = recipeKeys.get(recipe);
	if (json === undefined) { json = JSON.stringify(recipe); recipeKeys.set(recipe, json); }
	return `${autoColor ?? ""}|${json}`;
}

function sweepLater(entry) {
	clearTimeout(entry.sweep);
	entry.sweep = setTimeout(() => {
		if (entry.users > 0 || builds.get(entry.key) !== entry) return;
		builds.delete(entry.key);
		disposeSculptGroup(entry.template);
	}, GRACE_MS);
	entry.sweep?.unref?.();
}

/** A drawable copy of `recipe` (flat `autoColor` when given), its template built once per recipe. Not yet held. */
export function sculptInstance(recipe, autoColor = null) {
	const key = keyOf(recipe, autoColor);
	let entry = builds.get(key);
	if (!entry) {
		const template = buildSculptGroup(recipe, autoColor ? { materialFor: () => new THREE.MeshStandardMaterial(autoFlat(autoColor)) } : {});
		entry = { key, template, users: 0, sweep: null };
		builds.set(key, entry);
		sweepLater(entry);
	}
	const group = entry.template.clone();
	// the recipe drawn: a closeup (studio-closeup.js) waits until a re-sculpt is drawn before it looks
	group.userData.sculptRecipe = recipe;
	const bases = [];
	group.traverse((node) => {
		if (!node.isMesh) return;
		const own = (material) => { const copy = material.clone(); bases.push([copy, copy.color?.clone() ?? null]); return copy; };
		node.material = Array.isArray(node.material) ? node.material.map(own) : own(node.material);
	});
	return { entry, group, bases, held: false };
}

export function holdSculpt(instance) {
	if (instance.held) return;
	instance.held = true;
	instance.entry.users += 1;
	clearTimeout(instance.entry.sweep);
}

/** Frees what the copy owns (its materials, a scatter's instance buffers); the shared geometry stays while held. */
export function releaseSculpt(instance) {
	if (!instance.held) return;
	instance.held = false;
	for (const [material] of instance.bases) material.dispose();
	instance.group.traverse((node) => node.isInstancedMesh && node.dispose());
	instance.entry.users -= 1;
	if (instance.entry.users <= 0) sweepLater(instance.entry);
}

/** The record's colour multiplies the recipe's own part colours; the default grey leaves them as authored. */
export function tintSculpt(instance, color, depthRank = 0) {
	const tint = color && color !== GREY_BOX ? new THREE.Color(color) : null;
	for (const [material, base] of instance.bases) {
		if (base) material.color.copy(base);
		if (base && tint) material.color.multiply(tint);
		material.polygonOffset = depthRank > 0;
		material.polygonOffsetFactor = material.polygonOffsetUnits = depthRank > 0 ? -depthRank : 0;
	}
}

/** How many distinct recipes have a built template right now (tests, QA). */
export const sharedSculptBuilds = () => builds.size;

export function useSharedSculpt({ recipe, autoColor, color }, depthRank = 0) {
	const instance = useMemo(() => sculptInstance(recipe, autoColor ?? null), [recipe, autoColor]);
	useMemo(() => tintSculpt(instance, autoColor ? null : color, depthRank), [instance, autoColor, color, depthRank]);
	useEffect(() => { holdSculpt(instance); return () => releaseSculpt(instance); }, [instance]);
	return instance.group;
}
