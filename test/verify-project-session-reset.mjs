#!/usr/bin/env node
import assert from "node:assert/strict";
import { cameraBrowser } from "./camera-browser-harness.mjs";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";
import { PROJECT_SESSION_KEY } from "../src/project.js";
import { skeletonFor } from "../src/motion3/rigs/index.js";

const b = await cameraBrowser();
try {
	const click = selector => b.evaluate(`(() => {
		const element = document.querySelector(${JSON.stringify(selector)});
		if (!element) throw new Error("missing element: " + ${JSON.stringify(selector)});
		element.click();
		return true;
	})()`);
	console.log("seed: navigate");
	await b.navigate(new URL("/app/", b.base));
	await b.arm("Boolean(window.__cozyclay?.rigA && window.__cozyclay.runStudioAction && window.__cozyclayProject?.export)");
	await b.settled();
	// Seed a compiled take on the open character, so File > New has a take to drop.
	let exported = await b.evaluate("window.__cozyclayProject.export('session-reset')");
	while (typeof exported === "string") exported = JSON.parse(exported);
	const findCharacter = (node) => {
		if (!node || typeof node !== "object") return null;
		if (Array.isArray(node.characters) && node.characters[0]?.model) return node.characters[0];
		for (const value of Object.values(node)) { const hit = findCharacter(value); if (hit) return hit; }
		return null;
	};
	const first = findCharacter(exported);
	assert.ok(first, "no character in the open scene");
	const sk = skeletonFor(first.model), I = sk.index, P = sk.restWorldPos, ank = P[I.LeftFoot][1];
	const [x, y, z] = [first.x ?? 0, first.y ?? 0, first.z ?? 0];
	const spec = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 140,
		keys: [{ f: 0, set: { root: [x, y + P[I.Hips][1] - 0.01, z], yaw: 0, foot_l: [x + 0.09, y + ank, z - 0.03], foot_r: [x - 0.09, y + ank, z + 0.03], fyaw_l: 0, fyaw_r: 0 } }],
		generators: [{ type: "walk", f0: 6, steps: 4, heading: [0, 0] }] };
	const compiled = await b.evaluate(`(async () => { const r = await window.__cozyclay.runStudioAction("motion.compile", ${JSON.stringify({ characterId: first.id, spec })}); return Boolean(r?.ok); })()`);
	assert.ok(compiled, "motion.compile was refused");
	await b.arm("!!window.__cozyclay.motion");
	await b.settled();
	console.log("seed: ready");
	const seeded = await b.evaluate(`(async () => {
		const db = await new Promise((resolve, reject) => {
			const request = indexedDB.open("cozyclay.motions");
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		// A compiled take (v3) lives in the scene document; the store only exists once a clip was saved.
		const records = !db.objectStoreNames.contains("motions") ? [] : await new Promise((resolve, reject) => {
			const request = db.transaction("motions", "readonly").objectStore("motions").getAllKeys();
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		db.close();
		const scene = JSON.parse(localStorage.getItem(${JSON.stringify(SCENES_STORAGE_KEY)}));
		return {
			keys: Object.keys(localStorage),
			scene: {
				activeSceneId: scene?.activeSceneId,
				name: scene?.scenes?.[0]?.name,
				motionRefs: scene?.scenes?.flatMap((entry) => entry.stage?.characters?.map((character) => character.motionRef) ?? []),
			},
			motionRecords: records,
			frameCount: window.__cozyclay.frameCount,
			motion: Boolean(window.__cozyclay.motion),
		};
	})()`);
	await b.evaluate("window.confirm = () => true");
	console.log("seed: dumped");
	await click('[data-testid="menu-file"]');
	console.log("new: file menu");
	await click('[data-testid="menubar-new"]');
	console.log("new: chooser");
	await b.arm("document.querySelector('[data-testid=\"start-new-project-card\"]')");
	await b.settled();
	await click('[data-testid="start-new-project-card"]');
	console.log("new: blank selected");
	await b.arm("document.querySelector('[data-testid=\"start-project-name\"]')");
	await b.settled();
	await click('[data-testid="start-create"]');
	console.log("new: created");
	await b.arm("document.querySelector('.studio-project-head') && window.__cozyclay?.frameCount === 360");
	await b.settled();
	const afterCreate = await b.evaluate(`(async () => {
		const db = await new Promise((resolve, reject) => {
			const request = indexedDB.open("cozyclay.motions");
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		// A compiled take (v3) lives in the scene document; the store only exists once a clip was saved.
		const records = !db.objectStoreNames.contains("motions") ? [] : await new Promise((resolve, reject) => {
			const request = db.transaction("motions", "readonly").objectStore("motions").getAllKeys();
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		db.close();
		const scene = JSON.parse(localStorage.getItem(${JSON.stringify(SCENES_STORAGE_KEY)}));
		return {
		document: {
			activeSceneId: scene?.activeSceneId,
			name: scene?.scenes?.[0]?.name,
			motionRefs: scene?.scenes?.flatMap((entry) => entry.stage?.characters?.map((character) => character.motionRef) ?? []),
		},
		frameCount: window.__cozyclay.frameCount,
		motion: Boolean(window.__cozyclay.motion),
		dirty: Boolean(document.querySelector(".project-dirty-dot")),
		keys: Object.keys(localStorage),
		motionRecords: records,
		};
	})()`);
	console.log("new: dumped");
	assert.equal(afterCreate.document.name, "SCENE 01");
	assert.equal(afterCreate.frameCount, 360);
	assert.equal(afterCreate.motion, false);
	assert.equal(afterCreate.dirty, false);

	await b.navigate(new URL("/app/", b.base));
	// Wait for the restored studio, not for the take: the fix means no take comes back.
	await b.arm("document.querySelector('.studio-project-head') && typeof window.__cozyclay?.frameCount === 'number'");
	await b.settled();
	const afterReload = await b.evaluate(`(() => {
		const scene = JSON.parse(localStorage.getItem(${JSON.stringify(SCENES_STORAGE_KEY)}));
		return {
		document: {
			activeSceneId: scene?.activeSceneId,
			name: scene?.scenes?.[0]?.name,
			motionRefs: scene?.scenes?.flatMap((entry) => entry.stage?.characters?.map((character) => character.motionRef) ?? []),
		},
		frameCount: window.__cozyclay.frameCount,
		motion: Boolean(window.__cozyclay.motion),
		dirty: Boolean(document.querySelector(".project-dirty-dot")),
		session: JSON.parse(localStorage.getItem(${JSON.stringify(PROJECT_SESSION_KEY)}) || "null"),
		};
	})()`);
	console.log("reload: dumped");
	console.log("project-session-reset:", JSON.stringify({
		seeded: {
			keys: seeded.keys,
			scene: seeded.scene,
			motionRecords: seeded.motionRecords,
			frameCount: seeded.frameCount,
			motion: seeded.motion,
		},
		afterCreate: {
			keys: afterCreate.keys,
			document: afterCreate.document,
			motionRecords: afterCreate.motionRecords,
			frameCount: afterCreate.frameCount,
			motion: afterCreate.motion,
			dirty: afterCreate.dirty,
		},
		afterReload,
	}));
	assert.equal(afterReload.document.name, "SCENE 01");
	assert.equal(afterReload.frameCount, 360);
	assert.equal(afterReload.motion, false);
	assert.equal(afterReload.dirty, false);
	assert.equal(afterReload.session?.previsMode, undefined, "a blank project's session record holds no previs mode");
} finally {
	b.close();
}
