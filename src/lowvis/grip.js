// Which hands hold something, frame by frame, read from what a clip already has (no extra clip field): a hand holds a
// prop when the prop is thin enough to close a hand around (a handle, a sword), the palm is at it, and the palm stays
// put on it from one frame to the next (the prop moves with the hand, or both are still). A look may close such a hand
// into a fist; see the `grip` argument of setPose in README.md.
import { INDEX, JOINT_COUNT, REST, TIPS, qConj, qRotate } from "./rig17.js";

const THIN = 0.1; // m: a prop fits in a closed hand when two of its three sizes are at most this (a rod, not a mat)
const REACH = 0.05; // m: the palm is at a prop when it is at most this far from the prop's box
const STEADY = 0.015; // m: how far the palm may slide on the prop between two frames and still hold it
const PALM = 0.08; // m from the wrist joint toward the finger tip
const SHORT = 3; // frames: a hold or a let-go shorter than this is noise and is dropped

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = a => { const l = Math.hypot(...a) || 1; return a.map(v => v / l); };

/** Runs shorter than SHORT frames take the value around them, so a hand does not flicker open and shut. */
function steady(frames) {
	for (const value of [0, 1]) {
		let i = 0;
		while (i < frames.length) {
			let j = i;
			while (j < frames.length && frames[j] === frames[i]) j++;
			if (frames[i] === value && j - i < SHORT && i > 0 && j < frames.length) frames.fill(1 - value, i, j);
			i = j;
		}
	}
	return frames;
}

/** { Left, Right }: one Uint8Array per hand, frameCount long, 1 where that hand of character `index` holds a prop. */
export function handGrips(clip, index) {
	const c = clip.characters[index], n = clip.frameCount;
	const thin = (clip.props ?? []).filter(p => [...p.size].sort((a, b) => a - b)[1] <= THIN);
	const out = {};
	for (const side of ["Left", "Right"]) {
		const j = INDEX[`${side}Hand`], toward = unit(sub(TIPS[`${side}Hand`], REST[j]));
		const palm = f => {
			const p = (f * JOINT_COUNT + j) * 3, q = (f * JOINT_COUNT + j) * 4, d = qRotate(Array.from(c.quat.slice(q, q + 4)), toward);
			return [c.pos[p] + d[0] * PALM, c.pos[p + 1] + d[1] * PALM, c.pos[p + 2] + d[2] * PALM];
		};
		const frames = new Uint8Array(n);
		for (const prop of thin) {
			const last = prop.pos.length / 3 - 1, half = prop.size.map(s => s / 2);
			// The palm in the prop's own frame: it stays put while the prop is held.
			const local = Array.from({ length: n }, (_, f) => {
				const k = Math.min(f, last);
				return qRotate(qConj(Array.from(prop.quat.slice(k * 4, k * 4 + 4))), sub(palm(f), Array.from(prop.pos.slice(k * 3, k * 3 + 3))));
			});
			for (let f = 0; f < n; f++) {
				const at = local[f], gap = Math.hypot(...at.map((v, i) => Math.max(Math.abs(v) - half[i], 0)));
				const near = (g, h) => Math.hypot(...sub(local[g], local[h])) <= STEADY;
				if (gap <= REACH && near(Math.max(f - 1, 0), f) && near(f, Math.min(f + 1, n - 1))) frames[f] = 1;
			}
		}
		out[side] = steady(frames);
	}
	return out;
}
