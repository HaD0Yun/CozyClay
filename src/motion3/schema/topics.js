// motion.describe examples and notes, one per topic (describe.js builds the schemas from
// fields.js and types.js). Each example is a part of a spec that passes validation when merged
// into a spec with standIdle at f0 0 and frames 60 (probes: a motion.compile probes list);
// test/motion3/verify-motion3-describe.mjs checks that. Object ids are examples: use the scene's.
import { POSES, POSE_NAMES } from "../poses.js";
import { CONVENTIONS } from "../compiler/vocab.js";
import { FIX_KEYS } from "../fix/index.js";
import { literal } from "./brief.js";
import { WRIST_LIMITS } from "../compiler/arm-orient.js";
import { KEY_BLEND } from "../object-keys.js";

const SPOT = { kind: "world", p: [-0.2, 1.1, 0.35] };
const GRIP = { hand: "r", origin: ["RightHandIndex2", "RightHandMiddle2"], points: { fingers: [0, 0, 0] } };

export const EXAMPLES = {
	spec: { schema: "cozyclay.motion-spec.v1", fps: 24, frames: "auto", label: "walk up and grip the bar",
		use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } }, { skill: "walkTo", f0: 10, args: { to: [0, 1.2] } },
			{ skill: "reachGrip", f0: 140, args: { anchor: "bar", side: "r", define: { kind: "world", p: [-0.2, 1.2, 1.6] } } }],
		keys: [{ f: 150, set: { head_pitch: 10 } }] },
	anchors: { anchors: { spot: SPOT, pocket: { kind: "body", p: [0.13, -0.035, 0.08] }, knee: { kind: "segment", from: "LeftUpLeg", to: "LeftLeg", t: 0.45, reach: "l" },
		handle: { kind: "object", object: "cup", local: [0.07, 0, 0] }, mouth: { kind: "landmark", name: "mouth" } },
	keys: [{ f: 10, set: { armw_r: 1, w_spot_r: 0 } }, { f: 30, set: { w_spot_r: 1 } }] },
	props: { props: { cupGrip: GRIP }, anchors: { spot: SPOT }, fits: [{ side: "r", anchor: "spot", effector: { prop: "cupGrip", point: "fingers" } }] },
	objects: { props: { cupGrip: GRIP },
		objects: { cup: { prop: "cupGrip", grab: 20, release: 50 }, door: { pivot: [0.9, 0, 0.5], axis: [0, 1, 0], channel: "door" },
			bat: { prop: "cupGrip", grab: 52, keys: [{ f: 54, pos: [0.3, 1.2, 0.2], rot: [0, 0, 0.38268, 0.92388] }, { f: 58, pos: [0.3, 1.1, 0.4], aim: [0, -0.2, 1] }] },
			ember: { visible: "ember_vis", level: "ember" }, puff: { follow: "landmark:mouth", aim: "face", visible: "ember_vis" } },
		keys: [{ f: 0, set: { door: 0, ember_vis: 0, ember: 0.6 } }, { f: 30, set: { ember_vis: 1, ember: 2 }, step: ["ember_vis"] }, { f: 40, set: { door: -60 } }] },
	checks: { anchors: { spot: SPOT }, checks: {
		contacts: [{ name: "right hand on the spot", point: "joint:RightHand", target: "anchor:spot", tol: 0.05, when: [30, 40] }],
		clearance: [{ name: "hand off the cup", part: "hand_r", object: "cup", min: 0.01, frames: [0, 20] }],
		allow: [{ part: "hand", object: "cup", depth: 0.03 }], limits: { object: 0.01 } } },
	goals: { anchors: { spot: SPOT }, goals: [
		{ name: "hand at the spot", near: ["joint:RightHand", "anchor:spot"], tol: 0.06, at: [30, 40] },
		{ name: "hand over the table", above: ["joint:RightHand", "object:table.top"], by: 0.05, at: 35, mode: "any" },
		{ name: "cup lifted", moved: "object:cup", by: 0.1, at: [40, 59], after: "hand at the spot" },
		{ name: "cup still before", still: "object:cup", at: [0, 59], before: "cup lifted" },
		{ name: "hand quick", speed: "joint:RightHand", by: 1.2, at: [20, 30] }] },
	probes: [{ name: "handToCup", distance: ["joint:RightHand", "object:cup"], frames: [0, 59] }, { name: "cupTop", position: "object:cup.top", frames: [0, 59], every: 10 }],
	channels: { anchors: { spot: SPOT }, channels: ["lid"], keys: [
		{ f: 0, set: { armw_r: 1, hand_r: [-0.25, 1.0, 0.2], elbow_r: [-0.5, -1, -0.3], fingers_r: { grip: 0 }, lid: 0 } },
		{ f: 20, set: { w_spot_r: 1, fingers_r: { grip: 1 }, head_yaw: -15, spine_pitch: 8 } },
		{ f: 30, set: { lid: 1 }, step: ["lid"] }] },
	refs: { props: { cupGrip: GRIP }, anchors: { spot: SPOT }, goals: [
		{ name: "fingers at the spot", near: ["prop:cupGrip.fingers", "anchor:spot"], at: 30 },
		{ name: "cup at the mouth", near: ["object:cup.rim", "landmark:mouth"], tol: 0.06, at: [40, 50] },
		{ name: "hand above the hips", above: ["joint:RightHand", "bone:Hips"], at: 30 }] },
	fix: { fix: { reach: true, slide: true, penetration: 0.02, self: true, retime: true } },
};

const UNITS = `World metres, +Y up; ${CONVENTIONS.yaw}; the character's left is +X at yaw 0. Angles in degrees.`;
const NO_JUMP = "No at/along: it rests in the palm, fingers closed on it. Throw/catch: throwObject, catchObject.";
/** The objects example's carry: a grip prop and the object it holds. */
const CARRY = { props: EXAMPLES.objects.props, objects: { cup: EXAMPLES.objects.objects.cup } };

export const NOTES = {
	essentials: ["types: ? optional, =v default, a..b range, A | B one of, [key]: T map, a|b?: T both, x_l|r per side, (text) note.",
		`A carried object: ${literal(CARRY)}. ${NO_JUMP}`,
		"motion.describe { topic } or { topic: 'skills', name }: more."],
	spec: [UNITS,
		"frames: an integer, or \"auto\" (the last skill end, generator end or key f, plus 1); the stored spec keeps the number.",
		"Any number may be { range: [lo, hi] } (int: true for frames): the compiler searches it, QA 0 first, at most search.budget compiles.",
		"use expands skills (topic skills) into keys, anchors, props, fits and checks first; your own keys win on the same frame and your anchors/props replace a skill's.",
		"Keys ease between values (step jumps); a channel holds its last value. Unknown fields are refused with the field list.",
		"More: topics anchors, props, objects, checks, goals, probes, channels, refs, fix, skills."],
	anchors: ["An anchor is a named point a hand can go to: key w_<anchor>_l / w_<anchor>_r from 0 to 1 with armw_<side> 1 (the IK arm).",
		"An anchor name may not end in _l or _r.", "object anchors (a body or a group; local in its own axes) follow the object where it is (hinges, carries): put the other hand on a carried object with one; the carrying hand's own anchor stays where it took it. prop anchors are a point of a prop the other hand holds.",
		"segment with reach slides from t toward tMin until the arm reaches it.",
		"An object anchor with grasp (power, pinch, hook, palm) takes the hand by a socket of its object and the compiler turns the hand: power and hook put the knuckle line along the socket's axis with the palm on it, pinch holds at the fingertips, palm presses flat on the nearest face. socket names one (object.grasp sockets the user or you stored, or a thin part by its id: a bar, a grip, a magazine; a disc, a steering wheel, is its rim, held where nearest the shoulder, and the hand stays there as it moves); without it the socket nearest local, or the shoulder. Two hands on one carried object: each hand an object anchor with grasp on its part (a rifle's grip and magazine). reachGrip on such an anchor closes the fingers to the grasp. Never key the wrist for it; a wrist you key (wtwist/wflex) wins.",
		"person { person: <character id>, bone, offset? } is another character's joint where its installed take has it that frame (a hand on a shoulder, a push on the chest): install that character's take first; reachGrip on it allows the hand to touch that person."],
	props: ["A prop is a set of points fixed to one hand, [d, l, n] along the palm axes; prop:<prop>.origin is the mean of its origin bones.",
		"fits: the hand target moves so the effector (a prop point or the mean of joints), not the wrist, lands on the anchor.",
		"A fit on a scene body also turns the hand about the forearm into a grip: a thin body (a can, a bar, a handle, a neck) across the palm, else thumb up; never past a comfortable forearm turn. A wrist you turn (wtwist/wflex) wins; fit.orient: false (reachGrip args.orient: false) turns it off.",
		"reachGrip adds props.<anchor>Grip and its fit. Carry a scene object with objects.<id>.prop (topic objects).",
		"Do not pin a carried thing on a knuckle point: without at/along it rests in the palm and the fingers close on it (fix.grasp). objects.<id>.grasp names how: power, pinch, hook, palm, spherical (a ball). objects.<id>.mass (kg) weighs on the arm; past one hand QA says LOAD and patches in the other hand.",
		"objects.<id>.spring { length, stiffness, damping } (a carry, keyed included, or a free entry) swings it a beat behind the hand or its keys, then settles: a bag, a lantern. "
			+ "length (m, default half its longest side) is the string or rod; stiffness (1/s^2) defaults to 9.81 / length, a real pendulum; damping (default 0.5; 1: no overshoot) how soon it stops. "
			+ "A natural swing: length 0.4..0.6, damping 0.5..0.7. It turns, at most 60 deg about its base, never moves: put the base at the hand with at/along; a still hand leaves it still."],
	objects: ["A hinge turns the object (a body or a group) about pivot/axis by the angle channel your keys set.",
		"A carry follows the prop's hand: before grab the scene pose, grab..release in the hand, after release where it was let go, riding a body under it that keys or a hinge move.",
		"No at/along: it rests in the palm, fingers closed on it.",
		"A group (Empty) id moves all its parts; at/along pin a group's root to the palm too (an object.createKit kit). A carried object is an obstacle for the body and the scene.",
		"A switch { visible?, level? } moves nothing: it shows or hides any record (a part, a light, an effect) and sets its level, 0..4 light, glow and effect strength "
			+ "(an unkeyed level reads 1). Hiding a group hides its parts. A carry takes level too.",
		"keys pose a carried object in the world while in hand: pos its base (a group: its root), rot a quaternion, "
			+ "or aim [x, y, z] where its +Y points (a bat's barrel) plus roll degrees about it (none: the easiest roll). "
			+ `The object leads and the arm follows (elbow, forearm, then the wrist within ${Object.entries(WRIST_LIMITS).map(([k, [lo, hi]]) => `${k} ${lo}..${hi}`).join(", ")} deg; dev + toward the thumb); `
			+ "a left hand on a prop anchor of it turns with it; "
			+ `the hand eases in and out over ${KEY_BLEND} frames. REACH "<id>: n cm off its keys" is what the hand could not reach; `
			+ "observations.held measures each key as drawn.",
		"free { keys?, fall? } moves what nobody holds: keys at any frame; fall drops it at frame at onto the still top below (onto: that one; else the floor) "
			+ "to rest on a stable face, one small bounce (0: none). A carry falls before grab or after release.",
		"A follow { follow: <ref>, offset?, aim?, visible?, level? } puts any record (an effect, a light, a part) on a body point every frame: "
			+ "aim sets its +Y (an effect emits along it): up (default), face (forward), a direction or a ref (toward it); offset is metres along its axes after aim. It is no obstacle.",
		"The editor's motion.keyObject keys a drag (a hinge: its channel)."],
	checks: ["Each entry adds QA groups: contacts CONTACT, orient ORIENT, below BELOW, clearance CLEARANCE, appear APPEAR; supports mark where a part rests on an object (no FLOAT, no balance there); a foot on an object's top is on the ground without one.",
		"when: a weight channel (active above 0.99) or [f0, f1]; clearance uses frames.", "Check points take joint:, prop: and anchor: only; goals and probes take every ref (topic refs).",
		"allow excuses a body part inside an object up to depth; limits override the QA limits. Unnamed entries are named by place, contacts[0].",
		"Other characters with an installed take are bodies too: PERSON \"<part> x person:<id>\" is a part inside that person; a touch you mean (a push, a hug) is allow { part, object: \"person:<id>\", depth }.",
		"Speed, acceleration, knee bend and balance are style (output.observations), not judged. Naming one in limits checks it: SPEED, ACC, KNEE, BALANCE (mass-weighted centre of mass outside the support polygon of the feet, +8 cm margin). observations.near: each hand's and foot's nearest object and gap (< 0 inside), measured, not judged.",
		"motion.qa { checks } replaces every check for a re-measure."],
	goals: ["Exactly one of near (distance <= tol), above (a.y - b.y >= by), moved (an object's base moved at least by from the scene pose; any other point ref, e.g. prop:bat.tip, at least by from where it is at at[0], at: [f0, f1]), still (stays within tol, default 0.01 m, of where moved measures from) or speed (the point reaches by m/s).",
		"at is an absolute frame or [f0, f1]; mode all (every frame; the default) or any (one frame; speed's default). A failed goal is a GOAL group first in qa.groups and makes qa.ok false.",
		"after / before: another goal's name; at is cut to the frames after (before) the first frame that goal holds, so cause and effect keep their order wherever the event lands (the can moves after the kick). If that goal never holds, this one fails with value null.",
		"Intent lines as goals: a contact is near between the touching point (joint:RightHandIndex4, joint:RightToeBase) and the object, tol 0.02-0.03; a negative is still on the object before: \"<contact goal>\"; an effect is moved on the object after: \"<contact goal>\" (mode any); a strike is speed of the joint, by m/s, before: \"<contact goal>\"; an effect on something nobody holds (a can that drops, a machine that rocks) moves it by spec.objects keys or fall (topic: \"objects\"), not a hinge or a swapped copy.",
		"A cup or can brought to the mouth: an aim key with its top at the lips leans 45 by default so the elbow stays low (lean 0 holds aim exactly; observations.wrist raised counts the frames with the elbow over the shoulder). qa.warnings (ARM, never failing) name an elbow over the shoulder, over the head or flared out, its frames and the key or elbow_<side> pole that fixes it."],
	probes: ["motion.compile { probes } (at most 16); spec.probes are measured too, not stored; answered whether or not it installs.",
		"distance [a, b] -> { min, minAt, max, maxAt, mean, first, last } in m; a bare object:<id> measures to its surface. position -> { at: [{ f, p }] }, at most 16 rows."],
	channels: ["key.set names channels; values ease between keys and hold after the last key. step: [channel] jumps at f instead.",
		"Flow (spec.flow, on by default): the spine, head, arm swing/bend and wrist carry their speed through a key (a small overshoot) and trail the body (spine 1, head 2, arms 3 frames; lag: { spine, head, arms } or a number); and each change breaks along the body (overlap: the lower spine, chest, head, upper arm, forearm and wrist start and settle a few frames apart, one side trailing the other, the arm's swing settling past its stop; less for a short move, none on an arm's IK or a walk); feet, root, hand targets, weights, poles, fingers and objects land on their keys on time. The head leads the trunk into a turn (headLead: walking or standing, the head takes the turn the trunk makes over the next 5 frames, at most 30 degrees; not where keys move head_yaw). flow: false turns it off; { smooth: false }, { lag: false }, { overlap: false } or { headLead: false } one part (overlap: a number 0..2 scales it; headLead: 0..12 whole frames).",
		"w_<anchor>_<side> (0..1) weights a hand onto an anchor; the weights of one hand add up to at most 1.",
		"Any other numeric channel must come from spec.channels, a hinge (objects.<id>.channel), a check's when or a visible switch; names ending _vis are visibility switches (shown above 0.5)."],
	refs: ["A ref names a point: joint:/bone:<Bone>, prop:<prop>.<point>, anchor:<name>, landmark:mouth, object:<id>[.center|.top|.base|.rim], person:<character id>.<Bone> (another character's joint in its installed take).",
		"object .center/.top/.base are points of its world bounding box (a tilted cup's .top is not its rim); .rim is its opening (the top face in its own axes, tilting with it), against another point the nearest edge: drink goals take .rim.",
		"object:<id> takes a body or a group (the box around its parts); in a distance a bare object:<id> means its surface.",
		"Goals and probes take every kind; spec.checks keep joint:, prop: and anchor:."],
	fix: [`spec.fix keys: ${FIX_KEYS.join(", ")}; false turns all off. output.fixed reports what each one changed.`,
		"reach, slide, self, stance, person and retime are on by default; penetration is opt-in; fix: { retime: false } keeps the key timing exactly.",
		"reach also brings the body to a hand on a world or scene-object anchor the straight arm misses: a lean, a hip shift, lower hips, the feet kept (fixed.reachBody lists each move); farther, place the body. retime is kept only when QA is no worse with it.",
		"self keeps the arms out of the body on its fitted skin (QA BODY measures the same skin): wrist targets inside it go onto it, elbows turn about the shoulder-wrist line, a hand a little inside is pushed out. A fit's target (the mouth) is never moved; what is left is BODY, with checks.allow { part, object: <body part>, depth } for a contact meant to touch (a hand on a knee).",
		"person keeps the arms out of the other characters (QA PERSON): the wrist target moves out back the side the hand came from, however deep; an FK arm is left (fixed.person.skipped). A touch you mean: checks.allow { part, object: \"person:<id>\", depth }."],
	fill: ["Fill: MotionBricks generates the transition between two poses (free spans), as keys marked src: \"fill\".", "motion.compile does not fill unless fill: true (then it fills the safe gaps between key poses); motion.fill fills on request.",
		"Workflow: key 2-4 named poses at the extremes ({ f, pose, at?: [x, z], face?: deg, set?: overrides }), one motion.fill, then base + patch (a whole key: { op: \"replace\", path: \"/keys/@f=40\", value: { f: 40, pose: \"squat\" } }, or move it to another frame) and fill again; never type channel numbers into fill keys (src fill): QA on them is the model's, change the key around them.",
		`Poses: ${POSE_NAMES.map(n => `${n} (${POSES[n].says})`).join("; ")}.`,
		"timing (native fill, the upstream runtime's policy): \"exact\" keeps every authored frame: use it when the user's timing matters (a plop, a hit, a beat). \"retime\": the model picks each gap's length and the later keys move. \"playground\" chains like the HF playground: middle keys are guides passed 8 frames early, only the last key is reached, usually later (output.fill.moved, guides). \"free\" warps the model's length into the gap. Without timing the server's default fill runs; gate: false fills every gap of 14+ frames.",
		"A key the model cannot reach (a knee past its stop, a foot through the floor) stays a QA problem the repair cannot patch on fill keys: move or soften the authored key instead."],
};
