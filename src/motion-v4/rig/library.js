// The rig library: the global `rig` inside the js tool, and the same object in Node.
// buildRig(facts) calls the factories directly; rigLibrarySource(facts) builds one JS expression
// from the factories' source text that evaluates to the same object in QuickJS (or node:vm).
// Every factory and assembleRig are self-contained, so their text runs anywhere.
import { mathLib } from "./lib-math.js";
import { fkLib } from "./lib-fk.js";
import { ikLib } from "./lib-ik.js";
import { bodyLib } from "./lib-body.js";
import { motionLib } from "./lib-motion.js";
import { trackLib } from "./lib-track.js";

function assembleRig(facts, libs) {
	const M = libs.mathLib(), K = libs.fkLib(M, facts);
	const ik = libs.ikLib(M, K, facts), body = libs.bodyLib(M, K, facts), motion = libs.motionLib(M, K), tracks = libs.trackLib(M, K, facts);
	return {
		model: facts.model, fps: facts.fps, bones: K.names.slice(), index: { ...K.index }, parent: facts.parent.slice(),
		children: facts.children.map(c => c.slice()), limits: facts.limits, placement: facts.placement, scene: facts.scene,
		length: K.length, pose: K.pose, clone: K.clone, fk: K.fk, world: K.world, setLocal: K.setLocal, local: K.local,
		setRot: K.setRot, rotate: K.rotate, aim: K.aim, axes: K.axes, move: K.move,
		ik2: ik.ik2, plantFoot: ik.plantFoot, plantHand: ik.plantHand, chains: ik.chains,
		palm: body.palm, sole: body.sole, com: body.com, segments: body.segments, xcom: body.xcom,
		ease: motion.ease, hermite: motion.hermite, curve: motion.curve, slerp: motion.slerp, blend: motion.blend,
		ballistic: motion.ballistic, launch: motion.launch, arc: motion.arc, compose: motion.compose, relative: motion.relative,
		track: tracks.track, fromTrack: tracks.fromTrack,
		v: M.v, m: M.m, q: M.q,
	};
}

const LIBS = { mathLib, fkLib, ikLib, bodyLib, motionLib, trackLib };

/** The rig library object for rig facts (rigFacts()), built in this realm. */
export const buildRig = facts => assembleRig(facts, LIBS);

/** A JS expression that evaluates to buildRig(facts) in a realm with no imports (QuickJS, node:vm). */
export function rigLibrarySource(facts) {
	const libs = Object.entries(LIBS).map(([name, fn]) => `${name}: ${fn.toString()}`).join(",\n");
	return `(${assembleRig.toString()})(${JSON.stringify(facts)}, {\n${libs}\n})`;
}
