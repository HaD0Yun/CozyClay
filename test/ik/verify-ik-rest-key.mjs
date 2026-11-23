import * as THREE from "three";
import { createIkState, ikEvaluate } from "../../src/motion/ik.js";

/* A limb track can hold keys that store no rotation: a fix rest key (fix-keys.js, "the take itself") and a
 * translation-only key. When such a track also holds a plain key (Key over the whole body after a hand fix), the
 * track leaves the fix-key path and ikEvaluate samples it as ordinary keys. It must not crash there, a rest key must
 * leave the take's pose alone, and between a rest key and a based key the correction eases from zero. */

let failures = 0;
function check(name, cond, detail = "") {
	if (cond) console.log(`PASS ${name}`);
	else { failures += 1; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

const axis = new THREE.Vector3(0, 0, 1);
const rot = (angle) => new THREE.Quaternion().setFromAxisAngle(axis, angle);
function makeChain() {
	const bones = [new THREE.Bone(), new THREE.Bone(), new THREE.Bone()];
	bones[0].add(bones[1]); bones[1].add(bones[2]);
	bones[1].position.set(0, -0.3, 0); bones[2].position.set(0, -0.3, 0);
	return { bones };
}
/** The take's pose at a frame: what playback writes before the IK layer. */
const TAKE = [rot(0.2), rot(0.4), rot(0.1)];
function playTake(chain) { chain.bones.forEach((bone, i) => bone.quaternion.copy(TAKE[i])); }
const angleTo = (a, b) => a.angleTo(b);

const fix = { id: "fix-a", takeId: "t", kf: true };
const pose = [rot(0.9), rot(1.1), rot(0.3)];
const keys = new Map([
	[34, new Map([["rightHand", { q: null, p: null, fix: { ...fix, rest: true } }]])],
	[40, new Map([["rightHand", { q: pose.map((q) => q.clone()), baseQ: TAKE.map((q) => q.clone()), p: null, keepTranslations: true, fix: { ...fix } }]])],
	[46, new Map([["rightHand", { q: null, p: null, fix: { ...fix, rest: true } }]])],
	[60, new Map([["rightHand", { q: pose.map((q) => q.clone()), p: null }]])], // a plain key: the track now mixes key kinds
]);
const chain = makeChain();
const rig = new Map([["rightHand", chain]]);
const state = { ...createIkState(), keys, tracked: new Set(["rightHand"]) };

for (const blend of [6, 0]) {
	for (const frame of [30, 34, 46]) {
		playTake(chain);
		let error = null;
		try { ikEvaluate(rig, state, frame, new Map(), blend); } catch (caught) { error = caught; }
		check(`blend ${blend}, frame ${frame} (rest key side): no throw`, !error, error?.message);
		if (frame === 34 || (frame === 30 && blend === 6)) {
			const off = Math.max(...chain.bones.map((bone, i) => angleTo(bone.quaternion, TAKE[i])));
			check(`blend ${blend}, frame ${frame}: the take's pose stays`, off < 1e-6, `off ${off}`);
		}
	}
}

// at the pose key and halfway from the rest key, with the correction blend the Studio uses over a take
playTake(chain); ikEvaluate(rig, state, 40, new Map(), 6);
const atKey = Math.max(...chain.bones.map((bone, i) => angleTo(bone.quaternion, pose[i])));
check("frame 40: the keyed pose", atKey < 1e-6, `off ${atKey}`);
playTake(chain); ikEvaluate(rig, state, 37, new Map(), 6);
const half = angleTo(chain.bones[0].quaternion, TAKE[0]) / angleTo(pose[0], TAKE[0]);
check("frame 37: half way from the take to the key (eased from the rest key, not jumped)", half > 0.3 && half < 0.7, `share ${half.toFixed(3)}`);

// a lone key without rotations with no take underneath (blend 0) applies none
const lone = { ...createIkState(), keys: new Map([[10, new Map([["rightHand", { q: null, p: new THREE.Vector3(0, 0, 0) }]])]]), tracked: new Set(["rightHand"]) };
playTake(chain);
let loneError = null;
try { ikEvaluate(rig, lone, 10, new Map(), 0); } catch (caught) { loneError = caught; }
check("translation-only chain key, blend 0: no throw", !loneError, loneError?.message);
check("translation-only chain key: rotations untouched", chain.bones.every((bone, i) => angleTo(bone.quaternion, TAKE[i]) < 1e-6));

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
