#!/usr/bin/env node
// Browser check of what arrange_objects can now edit, read off the drawn props (props.jsx placement hook):
// an object attached to a head bone, moved and turned in that bone's frame, is drawn there (also below the bone's
// origin), and the receipt's overlap evidence is of the edited place; a lamp placed in
// a routed cart's frame rides the cart at that local pose on every frame; the timeline length is set by command.
// Run: `COZYCLAY_LIVE_PORT=5396 npm run dev -- --port 5196`, then
// `QA_URL=http://127.0.0.1:5196/app/ CDP_PORT=9343 node tools/qa-browser.mjs -- node test/qa-agent-edit-reach-browser.mjs`
import assert from "node:assert/strict";
import { cameraBrowser } from "./camera-browser-harness.mjs";

const b = await cameraBrowser();
const near = (a, b, tol, label) => assert.ok(Math.abs(a - b) <= tol, `${label}: ${a} vs ${b}`);
try {
	await b.seed();
	await b.evaluate(`(() => {
		const element = document.querySelector('.app');
		let fiber = element[Object.keys(element).find(key => key.startsWith('__reactFiber'))];
		while (fiber && !fiber.memoizedProps?.value?.bus) fiber = fiber.return;
		if (!fiber) throw new Error('AppContext provider not found');
		window.__reachBus = fiber.memoizedProps.value.bus;
	})()`);
	const run = async (id, args) => {
		const receipt = await b.evaluate(`Promise.resolve(window.__reachBus.run(${JSON.stringify(id)}, ${JSON.stringify(args)}))`);
		assert.equal(receipt.ok, true, `${id}: ${JSON.stringify(receipt)}`);
		return receipt;
	};
	const record = id => b.evaluate(`window.__cozyclay.objects.find(o => o.id === ${JSON.stringify(id)})`);
	const drawn = (id, frame) => b.evaluate(`(async () => {
		delete window.__cclayPropWorld?.[${JSON.stringify(id)}]; // a fresh placement, not one drawn before the edit
		window.__cozyclay.scrub(${frame} === 0 ? 1 : 0);
		await new Promise(r => setTimeout(r, 200));
		window.__cozyclay.scrub(${frame});
		for (let i = 0; i < 200; i++) { const w = window.__cclayPropWorld?.[${JSON.stringify(id)}]; if (w && w.frame === ${frame}) return w; await new Promise(r => requestAnimationFrame(r)); }
		return null;
	})()`);

	// 1. A badge on the head bone, then moved, turned and scaled in that frame.
	const badge = (await run("object.add", { kind: "cube", name: "Badge" })).affectedIds[0];
	await run("object.attach", { objectId: badge, characterId: "char-a", bone: "head", local: { x: 0, y: 0.1, z: 0.1 } });
	const local = { x: 0.06, y: 0.16, z: 0.12 };
	const arranged = await run("objects.arrange", { ops: [{ op: "update", id: badge, position: { world: local }, rotationDeg: { x: 0, y: 30, z: 0 }, scale: { x: 0.2, y: 0.05, z: 0.05 }, space: "parent" }] });
	const kept = await record(badge);
	assert.deepEqual([kept.x, kept.y, kept.z, kept.rot, kept.scaleX], [local.x, local.y, local.z, 30, 0.2], "the channels hold the bone-frame numbers");
	assert.deepEqual(kept.attach, { characterId: "char-a", bone: "head" });
	// where the drawn head bone puts a point of its own unscaled frame
	const headPoint = p => b.evaluate(`(() => {
		let bone = null; window.__cozyclay.rigA.traverse(n => { if (!bone && n.isBone && /head$/i.test(n.name.replace(/[^a-z]/gi, ''))) bone = n; });
		bone.updateWorldMatrix(true, false); const e = bone.matrixWorld.elements, len = i => Math.hypot(e[i], e[i + 1], e[i + 2]);
		const p = ${JSON.stringify(p)}, s = [len(0), len(4), len(8)];
		return { x: e[12] + (e[0] * p.x / s[0] + e[4] * p.y / s[1] + e[8] * p.z / s[2]), y: e[13] + (e[1] * p.x / s[0] + e[5] * p.y / s[1] + e[9] * p.z / s[2]), z: e[14] + (e[2] * p.x / s[0] + e[6] * p.y / s[1] + e[10] * p.z / s[2]) };
	})()`);
	const head = await headPoint(local), shown = await drawn(badge, 0);
	for (const axis of ["x", "y", "z"]) near(shown[axis], head[axis], 2e-3, `badge drawn ${axis} at the head frame point`);
	console.log(`PASS attached: ${arranged.summary}; drawn ${JSON.stringify({ x: +shown.x.toFixed(3), y: +shown.y.toFixed(3), z: +shown.z.toFixed(3) })}`);

	// 1b. A place below and behind the bone's origin is kept as given (the deck at y 0 is a world limit) and drawn there.
	const low = { x: 0.02, y: -0.15, z: -0.1 };
	const lowered = await run("objects.arrange", { ops: [{ op: "update", id: badge, position: { world: low }, space: "parent" }] });
	const below = await record(badge);
	assert.deepEqual([below.x, below.y, below.z], [low.x, low.y, low.z], "the bone-frame place is written as given");
	assert.deepEqual(lowered.warnings.filter(w => ["CLAMPED", "FLOOR_LIFT", "FOOTPRINT_OVERLAP"].includes(w.code)), [], "nothing clamped or lifted, and the carrier is no overlap");
	const lowPoint = await headPoint(low), lowShown = await drawn(badge, 0);
	for (const axis of ["x", "y", "z"]) near(lowShown[axis], lowPoint[axis], 2e-3, `badge drawn ${axis} below the head`);
	console.log(`PASS below the bone: drawn ${JSON.stringify({ x: +lowShown.x.toFixed(3), y: +lowShown.y.toFixed(3), z: +lowShown.z.toFixed(3) })}`);

	// 1c. The receipt measures the edited place, not the place drawn before the edit: 3 m along the head frame's z a wall
	// stands; the badge put there overlaps the wall, and put back on the head it overlaps nothing.
	const far = { x: 0, y: 0.1, z: 3 }, farPoint = await headPoint(far);
	const wall = (await run("object.add", { kind: "cube", name: "Wall", placement: { x: farPoint.x, z: farPoint.z } })).affectedIds[0];
	await run("object.update", { id: wall, patch: { scaleX: 2, scaleY: 3, scaleZ: 2 } });
	const overlapsOf = receipt => receipt.warnings.filter(w => w.code === "FOOTPRINT_OVERLAP").map(w => w.id);
	const into = await run("objects.arrange", { ops: [{ op: "update", id: badge, position: { world: far }, space: "parent" }] });
	assert.deepEqual(overlapsOf(into), [wall], `in the wall: ${JSON.stringify(into.warnings)}`);
	const out = await run("objects.arrange", { ops: [{ op: "update", id: badge, position: { world: local }, space: "parent" }] });
	assert.deepEqual(overlapsOf(out), [], `back on the head: ${JSON.stringify(out.warnings)}`);
	await run("object.remove", { ids: [wall] });
	console.log(`PASS overlap evidence of the edited place: ${into.warnings.find(w => w.code === "FOOTPRINT_OVERLAP").message}; back on the head: none`);

	// 2. A lamp placed in a routed cart's frame rides it.
	await run("shot.setTimeline", { frameCount: 96 });
	assert.equal(await b.evaluate("window.__cozyclay.frameCount"), 96, "the timeline length is set by command");
	const cart = (await run("object.add", { kind: "cube", name: "Cart", placement: { x: 2, z: -1, rot: 20 } })).affectedIds[0];
	await b.evaluate(`window.__cozyclay.sceneObject.update({ id: ${JSON.stringify(cart)}, path: { points: [{ x: 2, y: 0, z: -1 }, { x: 4, y: 0, z: 4 }, { x: 9, y: 0, z: 7 }], faceTravel: true } })`);
	const lampLocal = { x: 0.2, y: 1.3, z: 0.4 };
	const placed = await run("objects.arrange", { ops: [{ op: "create", source: { kind: "point-light" }, name: "Lamp", parent: cart, position: { world: lampLocal }, space: "parent" }] });
	const lamp = (await b.evaluate(`window.__cozyclay.objects.find(o => o.name === 'Lamp')`)).id;
	const rotate = (q, v) => { // v by unit quaternion q
		const { x, y, z, w } = q, ix = w * v.x + y * v.z - z * v.y, iy = w * v.y + z * v.x - x * v.z, iz = w * v.z + x * v.y - y * v.x, iw = -x * v.x - y * v.y - z * v.z;
		return { x: ix * w + iw * -x + iy * -z - iz * -y, y: iy * w + iw * -y + iz * -x - ix * -z, z: iz * w + iw * -z + ix * -y - iy * -x };
	};
	const rows = [];
	for (const frame of [0, 40, 95]) {
		const c = await drawn(cart, frame), l = await drawn(lamp, frame), off = rotate(c.quat, lampLocal);
		for (const axis of ["x", "y", "z"]) near(l[axis], c[axis] + off[axis], 2e-3, `frame ${frame}: lamp ${axis} rides the cart`);
		rows.push({ frame, cart: [+c.x.toFixed(2), +c.z.toFixed(2)], lamp: [+l.x.toFixed(2), +l.y.toFixed(2), +l.z.toFixed(2)] });
	}
	assert.ok(Math.hypot(rows[2].cart[0] - rows[0].cart[0], rows[2].cart[1] - rows[0].cart[1]) > 5, `the cart travels: ${JSON.stringify(rows)}`);
	console.log(`PASS routed parent: ${placed.summary}; ${JSON.stringify(rows)}`);
} finally { b.close(); }
