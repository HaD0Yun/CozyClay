#!/usr/bin/env node
// One held camera for a whole take (motion3/shot-framing.js): it frames every pose and stays off what hides them.
import { fitHeld, heldIssues } from "../../src/motion3/shot-framing.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${JSON.stringify(detail)}`}`);
	if (!condition) failures += 1;
}
const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
// a figure of 19 joints walking along z from 0 to 3, through a wall at z = 1.5 with a doorway around x = 0
const pose = z => Array.from({ length: 19 }, (_, i) => [0, 0.1 * i, z]);
const walk = (boxes = {}) => ({ f0: 0, frames: Array.from({ length: 49 }, (_, f) => ({ s: { P: pose((f / 48) * 3) } })), ctx: { objectsAt: () => boxes } });
const doorway = { l: { pos: [-1, 0, 1.5], R: I, half: [0.5, 1.25, 0.05] }, r: { pos: [1, 0, 1.5], R: I, half: [0.5, 1.25, 0.05] } };
const frames = Array.from({ length: 13 }, (_, i) => i * 4), opts = { tanV: 0.45, aspect: 16 / 9, fraction: 0.4, levelShare: 0.6 };

const open = fitHeld(walk(), frames, { asked: 90, ...opts });
expect("an empty set keeps the asked view and lens", open.chosen === 90 && open.lensFactor === 1, open);
expect("every pose is in the picture and nothing is hidden", open.hidden.length === 0 && open.outOfFrame.length === 0, open);
expect("the camera stands off the side at the middle of the walk", open.eye[0] > 1 && Math.abs(open.eye[2] - 1.5) < 0.01, open.eye);

const asked = fitHeld(walk(doorway), frames, { asked: 90, ...opts });
expect("a walk through a doorway stays clear on the asked side", asked.hidden.length === 0, asked);

const door = { door: { pos: [1, 0, 2.2], R: [[0, 0, 1], [0, 1, 0], [-1, 0, 0]], half: [1.5, 1.25, 0.05] } };
const blocked = fitHeld(walk(door), frames, { asked: 90, mirror: -90, ...opts });
expect("a door along the walk on the asked side sends it to the mirrored profile", blocked.chosen === -90 && blocked.hidden.length === 0, blocked);
const noMirror = fitHeld(walk(door), frames, { asked: 90, ...opts });
expect("with no mirror it turns no farther than it must", noMirror.hidden.length === 0 && noMirror.chosen !== 90, noMirror);

const near = { post: { pos: [2, 0, 1.2], R: I, half: [0.2, 1.25, 0.2] } };
const backed = fitHeld(walk(near), frames, { asked: 90, ...opts }), kept = fitHeld(walk(near), frames, { asked: 90, ...opts, fixedLens: true });
expect("the search is deterministic", JSON.stringify(backed) === JSON.stringify(fitHeld(walk(near), frames, { asked: 90, ...opts })));
expect("a lens the caller named stays that lens", kept.lensFactor === 1, kept);
expect("the longest lens stays inside the editor's range", backed.lensFactor === 1 || opts.tanV / backed.lensFactor >= Math.tan((7.5 * Math.PI) / 180), backed);
expect("no poses answer null", fitHeld({ frames: [], ctx: { objectsAt: () => ({}) } }, [0], { asked: 0, ...opts }) === null);

const stuck = heldIssues(walk(door), { eye: [6, 1, 2.2], lookAt: [0, 1, 2.2] }, frames, opts);
expect("heldIssues names what a camera misses behind a body", stuck.hidden.length > 0, stuck);
const tight = heldIssues(walk(), { eye: [2.2, 0.9, 0], lookAt: [0, 0.9, 0] }, frames, opts);
expect("heldIssues names the frames a pose leaves the picture", tight.outOfFrame.includes(48) && !tight.outOfFrame.includes(0), tight);
const behind = heldIssues(walk(), { eye: [0, 1, -3], lookAt: [0, 1, -6] }, frames, opts);
expect("a camera facing away has every frame out", behind.outOfFrame.length === frames.length, behind);

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("PASS shot framing");
