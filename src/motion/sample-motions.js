// Sample motions: takes anyone can install with one click, with no agent and no agent server. Each one is a motion spec
// built from the compiler's own skills (motion3/skills) around the spot and heading the character stands at, so it goes
// through the same motion.compile, QA and install as a take the agent authors. The hosted Studio has no agent server,
// and this is how a visitor there sees a character move (test/verify-sample-motions.mjs keeps every sample QA-clean).
//
// A walk ends where the character stands, coming from behind it: a walk that starts there leaves the view the user
// set up around the character, and the take would end off screen.
const stand = (at, heading) => ({ skill: "standIdle", f0: 0, args: { at, heading } });
const flip = f0 => ({ skill: "flip", f0, args: { kind: "back" } });
const walkTo = (to, args = {}) => ({ skill: "walkTo", f0: 10, args: { to, ...args } });
const WALK_FLIP_ARRIVE = 100;

export const SAMPLE_MOTIONS = Object.freeze([
	{ id: "walk", en: "Walk in", ko: "걸어 들어오기", zh: "走过来", use: (at, h, from) => [stand(from(2), h), walkTo(at)] },
	{ id: "walk_turn", en: "Walk in on a curve", ko: "돌아서 걸어오기", zh: "绕弯走过来", use: (at, h, from) => [stand(from(2, 1.4), h + 60), walkTo(at)] },
	{ id: "back_flip", en: "Back flip", ko: "백플립", zh: "后空翻", use: (at, h) => [stand(at, h), flip(10)] },
	{ id: "walk_flip", en: "Walk in, then flip", ko: "걸어와서 백플립", zh: "走过来后空翻", use: (at, h, from) => [stand(from(1.5), h), walkTo(at, { arrive: WALK_FLIP_ARRIVE }), flip(WALK_FLIP_ARRIVE + 6)] },
]);

/** The motion spec of sample `id` for a character standing at (x, z) and turned `rot` degrees; null for an unknown id. */
export function sampleMotionSpec(id, { x = 0, z = 0, rot = 0 } = {}) {
	const sample = SAMPLE_MOTIONS.find(s => s.id === id);
	if (!sample) return null;
	const heading = Number.isFinite(rot) ? rot : 0, r = heading * Math.PI / 180, at = [x || 0, z || 0];
	// `back` metres behind the character and `left` metres to its left; heading 0 faces +z
	const from = (back, left = 0) => [+(at[0] - Math.sin(r) * back + Math.cos(r) * left).toFixed(3), +(at[1] - Math.cos(r) * back - Math.sin(r) * left).toFixed(3)];
	return { schema: "cozyclay.motion-spec.v1", fps: 24, frames: "auto", use: sample.use(at, heading, from) };
}
