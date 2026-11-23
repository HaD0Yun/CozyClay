// A probe of test/lowvis/qa-install-browser.mjs (QA_PROBE=contact-frames): the frames the contact gaps are measured in
// (src/lowvis/studio/gaps.js, bin/agent/motion-fit.mjs), in a real Studio, against this file's own box arithmetic.
//  1. the live query contact_gaps reads an object's drawn look in its own frame, in metres: the same points give the
//     same distances while the object is turned, tilted and moved; a scaled object is as large as it is drawn;
//  2. an object that stands still is read where it stands: a hand the clip has on a tilted and turned box is on it (no
//     gap), and off by the move once the object is moved 0.2 m;
//  3. an object attached to a bone is read in its own frame too; a hidden one is not measured, and said so.
//   QA_PROBE=contact-frames node test/lowvis/qa-install-browser.mjs
import { installFit, rememberBoxes } from "../../bin/agent/motion-fit.mjs";
import { INDEX as J, REST, TIPS, fk } from "../../src/lowvis/rig17.js";

const RAD = Math.PI / 180, F = 24;
/** The turn of Studio angles rotX, rot, rotZ (degrees, applied in XYZ order) as a quaternion. */
function turnOf(rotX, rot, rotZ) {
	const [cx, cy, cz] = [rotX, rot, rotZ].map(v => Math.cos((v * RAD) / 2)), [sx, sy, sz] = [rotX, rot, rotZ].map(v => Math.sin((v * RAD) / 2));
	return [sx * cy * cz + cx * sy * sz, cx * sy * cz - sx * cy * sz, cx * cy * sz + sx * sy * cz, cx * cy * cz - sx * sy * sz];
}
const rotate = ([x, y, z, w], v) => { const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])]; return [v[0] + w * t[0] + (y * t[2] - z * t[1]), v[1] + w * t[1] + (z * t[0] - x * t[2]), v[2] + w * t[2] + (x * t[1] - y * t[0])]; };
const add = (a, b) => a.map((v, k) => v + b[k]), sub = (a, b) => a.map((v, k) => v - b[k]), near = (a, b, tol = 0.002) => Math.abs(a - b) <= tol;
const box = (id, size, at) => ({ id, shape: "box", size, position: [at[0], at[1] + size[1] / 2, at[2]], roundness: 0 });

export async function scenarios(t) {
	const { ID, hub, act, pass, report, assert, sleep } = t, command = (name, args = {}) => hub.command(name, args);
	const rowOf = async id => (await command("describe", {})).objects.find(o => o.id === id);
	{
		// --- 1. the object's own frame ---
		// a post 0.4 x 0.6 x 0.2 m standing on its base: above its top, beside it, in its middle, and the surface under 1 m
		const post = (await act("object.sculpt", { name: "post", placement: { x: 1, y: 0, z: 2, rot: 0 }, recipe: { version: 1, parts: [box("body", [0.4, 0.6, 0.2], [0, 0, 0])] } })).affectedIds[0];
		const ask = async (points = [[0, 0.7, 0], [0.3, 0.3, 0], [0, 0.3, 0], [0.5, 0.3, 0]]) => { await sleep(400); return (await command("contact_gaps", { objects: [{ id: post, points: [points], columns: [[0, 0, 1]] }] })).objects[0]; };
		const plain = await ask();
		assert.ok(plain.drawn && [0.1, 0.1, -0.1, 0.3].every((d, k) => near(plain.points[0][k], d)) && near(plain.columns[0], 0.6), `the post as made: ${JSON.stringify(plain)}`);
		const poses = { "turned 40 deg": { rot: 40 }, "tilted 25 / 40 / -15 deg": { rotX: 25, rot: 40, rotZ: -15 }, "moved and lifted": { x: -2, y: 0.7, z: 1 } };
		for (const [name, patch] of Object.entries(poses)) {
			await act("object.update", { id: post, patch });
			const got = await ask();
			assert.ok([0.1, 0.1, -0.1, 0.3].every((d, k) => near(got.points[0][k], d)) && near(got.columns[0], 0.6), `${name}: ${JSON.stringify(got)}`);
		}
		pass(`contact_gaps: the same distances [0.1, 0.1, -0.1, 0.3] m and top 0.6 m in the object's own frame while it is ${Object.keys(poses).join(", ")}`);
		// twice as wide, half as tall: the drawn look is 0.8 x 0.3 x 0.2 m, and the points are still metres
		await act("object.update", { id: post, patch: { scaleX: 2, scaleY: 0.5 } });
		const scaled = await ask([[0, 0.7, 0], [0.3, 0.15, 0], [0, 0.15, 0], [0.5, 0.15, 0]]);
		assert.ok([0.4, -0.1, -0.1, 0.1].every((d, k) => near(scaled.points[0][k], d)) && near(scaled.columns[0], 0.3), `scaled: ${JSON.stringify(scaled)}`);
		pass(`contact_gaps: an object scaled 2 x 0.5 is read as large as it is drawn: ${JSON.stringify(scaled.points[0])}, top ${scaled.columns[0]}`);
		await act("object.update", { id: post, patch: { scaleX: 1, scaleY: 1, rotX: 0, rot: 0, rotZ: 0, x: 1, y: 0, z: 2 } });

		// --- 2. a still object is read where it stands ---
		// a body in the rest pose; a box 0.4 x 0.6 x 0.2 m tilted and turned so that the middle of its top is the middle of
		// the right hand; its look is a small pad there only, so a wrong frame would leave the hand in the air
		const pose = fk([0, 0, 0]), hips = [0, 1.043, 0], wrist = add(hips, pose.pos[J.RightHand]), tip = add(wrist, sub(TIPS.RightHand, REST[J.RightHand])), mid = add(wrist, sub(tip, wrist).map(v => v / 2));
		const angles = { rotX: 25, rot: 40, rotZ: -15 }, q = turnOf(angles.rotX, angles.rot, angles.rotZ), size = [0.4, 0.6, 0.2], base = sub(mid, rotate(q, [0, size[1], 0])), centre = add(base, rotate(q, [0, size[1] / 2, 0]));
		const clip = { frameCount: F, characters: [{ id: "a", pos: Array.from({ length: F }, () => pose.pos.flatMap(p => add(hips, p))).flat(), quat: Array.from({ length: F * 17 }, () => [0, 0, 0, 1]).flat() }], props: [{ id: "table", size, pos: centre, quat: q }] };
		const table = (await act("object.sculpt", { name: "table", placement: { x: base[0], y: base[1], z: base[2], rot: 0 }, recipe: { version: 1, parts: [box("pad", [0.06, 0.02, 0.06], [0, size[1] - 0.02, 0])] } })).affectedIds[0];
		await act("object.update", { id: table, patch: angles });
		await sleep(400);
		rememberBoxes("frames", { props: [{ id: "table", size, at: centre }] }, { table }, [], { clip, spec: null });
		const on = await installFit("frames", hub, 0);
		assert.match(on.contacts[0], new RegExp(`^table \\(${table}\\), where bodies meet it: a right hand at \\[-?0(\\.0[01])?, 0\\.6, -?0(\\.0[01])?\\] f0-23`), `the hand on the top's middle: ${JSON.stringify(on.contacts)}`);
		assert.deepEqual(on.gaps, [], `the pad is under the hand: ${JSON.stringify(on.gaps)}`);
		await act("object.update", { id: table, patch: { z: base[2] + 0.2 } }); // across the hand, which lies along x
		await sleep(400);
		const off = await installFit("frames", hub, 0), far = Number(/right hand at \[[^\]]+\] f0-23: (\d+) mm from the drawn look/.exec(off.gaps[0] ?? "")?.[1]);
		assert.ok(far >= 140 && far <= 200, `moved 0.2 m (the pad is 0.06 m wide): ${JSON.stringify(off.gaps)}`);
		pass(`a still object tilted ${angles.rotX} / ${angles.rot} / ${angles.rotZ} deg is read where it stands: the hand on its pad has no gap; moved 0.2 m: ${off.gaps[0]}`);
		await act("object.update", { id: table, patch: { z: base[2] } });

		// --- 3. hidden; attached to a bone ---
		await act("object.update", { id: table, patch: { hidden: true } });
		await sleep(400);
		const hidden = await installFit("frames", hub, 0);
		assert.deepEqual(hidden.gaps, [`table (${table}): not drawn now, so not measured`], `hidden: ${JSON.stringify(hidden.gaps)}`);
		pass(`a hidden object: ${hidden.gaps[0]}`);
		await act("object.update", { id: table, patch: { hidden: false } });
		await act("object.attach", { objectId: post, characterId: ID, bone: "rightHand" });
		const held = await ask(), heldRow = await rowOf(post);
		assert.ok(heldRow.attach && [0.1, 0.1, -0.1, 0.3].every((d, k) => near(held.points[0][k], d)) && near(held.columns[0], 0.6), `attached: ${JSON.stringify(held)}`);
		await act("character.update", { characterId: ID, patch: { scale: 2 } });
		const grown = await ask();
		pass(`an object attached to a bone is read in its own frame: [0.1, 0.1, -0.1, 0.3] m; on a body of scale 2 it is drawn ${near(grown.columns[0], 0.6) ? "as large as before" : `with its top at ${grown.columns[0]} m`}: ${JSON.stringify(grown.points[0])}`);
		await act("character.update", { characterId: ID, patch: { scale: 1 } });
		report.frames = { plain, scaled, on, off, hidden, held, grown };
	}
}
