#!/usr/bin/env node
// Physical grasp (#816), the spec fields every later part reads, registered before any of them: fix.grasp, a carry's
// grasp (the same word and values as an object anchor's), spherical, a carry's mass and a fall's v. Nothing reads them
// yet, so writing the defaults out compiles the same take as leaving them out.
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { bakeTake } from "../../src/motion3/take.js";
import { massOf } from "../../src/motion3/mass.js";
import { GRASPS, GRASP_FINGERS } from "../../src/motion3/compiler/vocab.js";
import { takeHash } from "./fixtures/take-hash.mjs";
import { BALL_SCENE, BALL, ballPickupSpec, MODEL } from "./fixtures/ball-pickup.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` - ${detail}`}`);
	if (!condition) failures += 1;
}
const sk = skeletonFor(MODEL), scene = motionScene(BALL_SCENE);
/** The refusal text of a compile, "" when it compiles. */
const refusal = spec => { try { compileSpec(spec, { sk, scene }); return ""; } catch (error) { return String(error.message); } };

expect("fix.grasp false and true compile", refusal(ballPickupSpec({ fix: { grasp: false } })) === "" && refusal(ballPickupSpec({ fix: { grasp: true } })) === "",
	refusal(ballPickupSpec({ fix: { grasp: false } })) || refusal(ballPickupSpec({ fix: { grasp: true } })));
expect("fix.grasp \"x\" is refused", /fix\.grasp must be true/.test(refusal(ballPickupSpec({ fix: { grasp: "x" } }))), refusal(ballPickupSpec({ fix: { grasp: "x" } })));
expect("spherical is a grasp and closes the hand to the spherical preset", GRASPS.includes("spherical") && GRASP_FINGERS.spherical === "spherical");
expect("a carry takes grasp spherical", refusal(ballPickupSpec({ entry: { grasp: "spherical" } })) === "", refusal(ballPickupSpec({ entry: { grasp: "spherical" } })));
const sphere = refusal(ballPickupSpec({ entry: { grasp: "sphere" } }));
expect("a carry's grasp \"sphere\" is refused with did-you-mean spherical", /grasp must be one of/.test(sphere) && /did you mean "spherical"/.test(sphere), sphere);
// support holds a box in both hands on object anchors (compiler/anchors.js supportAt), never one hand's carry
const carried = refusal(ballPickupSpec({ entry: { grasp: "support" } }));
expect("a carry's grasp \"support\" is refused, naming the two-hand anchors it belongs to", /grasp must be one of power, pinch, hook, palm, spherical;/.test(carried) && /reachGrip each hand onto an object anchor with grasp support/.test(carried), carried);
const heavy = refusal(ballPickupSpec({ entry: { mass: -1 } }));
expect("mass -1 is refused naming 0.01..60", /mass must be kg in 0\.01\.\.60/.test(heavy), heavy);

expect("the ball kit weighs 0.15 kg", massOf({}, scene, BALL) === 0.15, massOf({}, scene, BALL));
const cube = motionScene([{ id: "box", name: "Box", renderer: "cube", x: 0, y: 0, z: 0, rot: 0, rotX: 0, rotZ: 0, scaleX: 0.3, scaleY: 0.3, scaleZ: 0.3, footprint: { width: 1, depth: 1 }, height: 1 }]);
expect("a 0.3 m cube weighs 10.8 kg (0.027 m^3 at 400 kg/m^3)", Math.abs(massOf({}, cube, "box") - 10.8) < 1e-9, massOf({}, cube, "box"));
expect("a spec's mass wins", massOf({ objects: { box: { mass: 2 } } }, cube, "box") === 2);

const free = (v, extra = {}) => ({ ...ballPickupSpec(), objects: { [BALL]: { fall: { at: 0, ...(v === undefined ? {} : { v }) }, ...extra } } });
expect("a fall takes v [0, 1, 2]", refusal(free([0, 1, 2])) === "", refusal(free([0, 1, 2])));
expect("a carry's fall takes v \"hand\"", refusal({ ...ballPickupSpec(), objects: { [BALL]: { ...ballPickupSpec().objects[BALL], keys: undefined, release: 60, fall: { at: 60, v: "hand" } } } }) === "",
	refusal({ ...ballPickupSpec(), objects: { [BALL]: { ...ballPickupSpec().objects[BALL], keys: undefined, release: 60, fall: { at: 60, v: "hand" } } } }));
expect("a fall's v \"fast\" is refused", /\.v must be \[vx, vy, vz\]/.test(refusal(free("fast"))), refusal(free("fast")));

const take = spec => takeHash(bakeTake(sk, compileSpec(spec, { sk, scene }).out));
expect("writing the defaults out (fix.grasp true, mass 0.15) bakes the take as leaving them out",
	take(ballPickupSpec()) === take(ballPickupSpec({ fix: { grasp: true }, entry: { mass: 0.15 } })));

if (failures) { console.log(`${failures} grasp field check(s) failed`); process.exit(1); }
console.log("motion3 grasp fields: all checks passed");
