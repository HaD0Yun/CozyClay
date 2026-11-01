#!/usr/bin/env node
// What stands between a camera and the character (motion3/sightline.js), the frames a beats sheet adds for it
// (beats.js actionFrames), and the see-through capture (capture-fade.js).
import * as THREE from "three";
import { blockersAt, hiddenBy } from "../../src/motion3/sightline.js";
import { actionFrames, beatFrames } from "../../src/motion3/beats.js";
import { focusPoints } from "../../src/motion3/views.js";
import { withFaded } from "../../src/capture-fade.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${JSON.stringify(detail)}`}`);
	if (!condition) failures += 1;
}
const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const wall = (z, extra = {}) => ({ pos: [0, 0, z], R: I, half: [1, 1.25, 0.05], ...extra });
const body = Array.from({ length: 20 }, (_, i) => [0, 0.1 * i, 0]);
const scene = (boxes, P = body) => ({ f0: 0, frames: [{ s: { P } }], ctx: { objectsAt: () => boxes } });

// ---- sightlines ----
const eye = [0, 1, 5];
expect("a wall between the camera and the character hides every joint", blockersAt(scene({ wall: wall(2) }), eye, 0).share === 1 && blockersAt(scene({ wall: wall(2) }), eye, 0).by[0] === "wall");
expect("a wall behind the character hides nothing", blockersAt(scene({ wall: wall(-2) }), eye, 0).share === 0);
expect("a wall to the side hides nothing", blockersAt(scene({ wall: { ...wall(2), pos: [5, 0, 2] } }), eye, 0).share === 0);
expect("a carried or ignored box is not a wall", blockersAt(scene({ a: wall(2, { carried: true }), b: wall(2, { ignore: true }) }), eye, 0).share === 0);
const low = blockersAt(scene({ table: { pos: [0, 0, 2], R: I, half: [1, 0.005, 0.05] } }, Array.from({ length: 40 }, (_, i) => [0, 0.05 * i, 0])), [0, 0.005, 5], 0);
expect("a body hiding under 5% of the joints is not named", low.by.length === 0, low);
const turned = { pos: [0, 0, 2], R: [[0, 0, 1], [0, 1, 0], [-1, 0, 0]], half: [0.05, 1.25, 1] };
expect("a turned box (a door on its hinge) is tested in its own axes", blockersAt(scene({ door: turned }), eye, 0).share === 1);
const raised = { pos: [0, 2, 2], R: I, half: [1, 0.2, 0.05] };
expect("a box's pos is its base centre: a lintel above the sight lines hides nothing", Object.keys(hiddenBy({ raised }, [0, 1, 5], [[0, 1, 0]])).length === 0);
const seen = blockersAt(scene({ table: wall(2) }, []), eye, 0);
expect("a frame with no joints hides nothing", seen.share === 0 && seen.by.length === 0);
const focus = [{ p: [3, 1, 0], own: [] }], side = { pos: [1.8, 0, 2.5], R: I, half: [0.3, 1.25, 0.1] };
expect("a body hiding only the focus is named", blockersAt(scene({ side }), eye, 0).by.length === 0 && blockersAt(scene({ side }), eye, 0, focus).by[0] === "side");
expect("a focus object does not hide itself", blockersAt(scene({ door: wall(0) }, [[0, 1, 9]]), eye, 0, [{ p: [0, 1, 0], own: ["door"] }]).by.length === 0);
const groupScene = { f0: 0, frames: [{ s: { P: [[0, 1, 9]] } }], ctx: { spec: { objects: {} }, scene: { objects: { top: { ancestors: ["table"], half: [1, 0.05, 1], pos: [0, 1, 0], R: I }, leg: { ancestors: ["table"], half: [0.1, 0.5, 0.1], pos: [0, 0, 0], R: I }, wall: { half: [1, 1.25, 0.05], pos: [0, 0, 2], R: I } } }, objectsAt: () => ({ top: { pos: [0, 1, 0], R: I, half: [1, 0.05, 1] }, leg: { pos: [0, 0, 0], R: I, half: [0.1, 0.5, 0.1] } }) } };
expect("a focused group's own parts do not hide it", blockersAt(groupScene, eye, 0, focusPoints(groupScene, 0, ["object:table"])).by.length === 0, focusPoints(groupScene, 0, ["object:table"]));

// ---- actions a beats sheet must show ----
const sk = { index: { Hips: 0, LeftHand: 1, RightHand: 2, LeftFoot: 3, RightFoot: 4 } };
const pose = (kick, walk = 0) => [[walk, 1, 0], [walk + 0.3, 1, 0], [walk - 0.3, 1, 0], [walk + 0.1, 0, 0], [walk - 0.1, 0, kick]];
const take = (kicks, doorFrom = Infinity, n = 48, walk = 0) => ({ f0: 0, frames: Array.from({ length: n }, (_, f) => ({ s: { P: pose(kicks(f), walk * f) } })), ctx: { sk,
	objectsAt: f => ({ door: { pos: [0, 0, 2], R: I.map(row => row.slice()).map((row, i) => (i === 0 ? [1 - Math.max(0, f - doorFrom) * 0.05, 0, 0] : row)), half: [0.5, 1, 0.05] }, rock: { pos: [0, f * 0.1, 0], R: I, half: [0.1, 0.1, 0.1], carried: true } }) } });
const kick = f => (f <= 20 ? 0 : f < 24 ? (f - 20) * 0.25 : f < 30 ? 0.75 - (f - 24) * 0.125 : 0);
const rows = actionFrames(take(kick, 25), [0, 47]);
expect("a kick is one speed peak with the limb and speed", rows.filter(r => /RightFoot peaks at 6\.0 m\/s/.test(r.why)).length === 1 && rows.some(r => r.why.includes("peaks") && r.f >= 21 && r.f <= 23), rows);
expect("a hinged body's first move is named, a carried one's is not", rows.some(r => r.f === 26 && r.why === "door starts moving") && !rows.some(r => r.why.startsWith("rock")), rows);
expect("the whole body travelling is not a limb peak (speed is relative to the hips)", !actionFrames(take(() => 0, Infinity, 48, 0.3), [0, 47]).some(r => r.why.includes("peaks")));
expect("a slow motion names nothing", actionFrames(take(f => f * 0.05), [0, 47]).length === 0);
const two = f => kick(f) + kick(f - 18);
expect("two peaks apart stay two, and at most 2 are kept", actionFrames(take(two), [0, 47]).filter(r => r.why.includes("peaks")).length === 2);
expect("frames outside the range are not read", actionFrames(take(kick, 25), [0, 18]).length === 0, actionFrames(take(kick, 25), [0, 18]));
expect("no frames answer nothing", actionFrames({ frames: [], ctx: { sk } }, [0, 47]).length === 0);
const beats = beatFrames({ range: [0, 279], even: [0, 56, 112, 167, 223, 279], timeline: [{ beat: "keys", f: [0, 279], events: [] }], actions: [{ f: 80, why: "door starts moving" }], groups: [{ kind: "SLIDE", subject: "foot", worstFrame: 225 }], objects: { rock: { prop: "p", grab: 205, release: 252 } } });
expect("beats: an action comes after grab and release, before starts and worst frames", beats.frames.includes(80) && beats.picks.find(p => p.f === 80).why === "door starts moving", beats.picks);
const crowded = beatFrames({ range: [0, 279], even: [], timeline: Array.from({ length: 10 }, (_, i) => ({ beat: `b${i}`, f: [i * 25, i * 25 + 20], events: [] })), actions: [{ f: 80, why: "kick" }] });
expect("beats: 10 beat starts do not push an action out", crowded.frames.length === 6 && crowded.frames.includes(80), crowded.picks);

// ---- see-through capture ----
const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ opacity: 1 })), other = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
const group = new THREE.Group(); group.userData.sceneObjectId = "wall"; group.add(mesh);
const stage = new THREE.Scene(); stage.add(group, other);
const original = mesh.material;
let during = null;
withFaded(stage, ["wall"], () => { during = { transparent: mesh.material.transparent, opacity: mesh.material.opacity, depthWrite: mesh.material.depthWrite, otherSame: !other.material.transparent }; });
expect("the named body draws see-through during the render, the rest as it was", during.transparent && during.opacity < 0.5 && !during.depthWrite && during.otherSame, during);
expect("the body gets its own material back", mesh.material === original && !original.transparent);
let threw = false;
try { withFaded(stage, ["wall"], () => { throw new Error("render"); }); } catch { threw = true; }
expect("a render that throws still restores it", threw && mesh.material === original);
expect("nothing to fade renders straight through", withFaded(stage, [], () => 7) === 7 && withFaded(stage, undefined, () => 8) === 8);

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("PASS sightline");
