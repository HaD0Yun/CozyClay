#!/usr/bin/env node
// qa/blocking.js (#1114): which QA groups block a take (what a viewer sees at 960x540 or what breaks the request) and which
// are warnings. The thresholds sit at their edges here: penetration 5 cm (DEEP), POP 25 cm/f^2, REACH 3 cm, a surface within
// 5 cm (NEAR) for FLOAT and REACH. fitFlagged: an answer cut to the receipt budget keeps every group's flag and says the
// counts in its brief. Then motion.compile through the registry: qa.blocking, each group flagged, the summary and brief
// counts, install "ifClean" on 0 blocking problems, INSTALL_WORSE and output.noImprovementRounds on blocking problems.
import assert from "node:assert/strict";
import { DEEP, NEAR, POP_HARD, REACH_GAP, blockingCount, blockingOf, blockingSay, fitFlagged, isBlocking, markBlocking, measureGroup } from "../../src/motion3/qa/blocking.js";
import { MOTION_OUTPUT_BUDGET, fitOutput } from "../../src/motion3/report.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { createStudioAppActions } from "../../src/commands/index.js";
import { specIdOf } from "../../src/motion3/spec-store.js";
import { SCENE_OBJECTS, CHARACTER, CUP } from "../motion3/fixtures/cup-scene.mjs";

const check = (name, fn) => { fn(); console.log(`ok - ${name}`); };
const g = (kind, subject, worst, extra = {}) => ({ kind, subject, ...(worst === undefined ? {} : { worst }), count: 3, severity: 4, first: 0, last: 7, ...extra });
const just = d => [d - 0.001, d + 0.001];

check("the thresholds are the documented ones", () => {
	assert.deepEqual([DEEP, POP_HARD, REACH_GAP, NEAR], [0.05, 0.25, 0.03, 0.05]);
});
check("GOAL, KEY, CONTACT, LOAD, TELEPORT, FLIP, GRAB and CATCH always block", () => {
	for (const kind of ["GOAL", "KEY", "CONTACT", "LOAD", "TELEPORT", "FLIP", "GRAB", "CATCH"]) assert.equal(isBlocking(g(kind, "x", 0.001)), true, kind);
});
check("fingers, palms, thumbs, SLIDE, PALM_GAP, WRIST, KNEE and unknown kinds are warnings", () => {
	for (const kind of ["SLIDE", "PALM_GAP", "PALM_OFF", "WRIST", "KNEE", "ELBOW", "FINGER_GAP", "FINGER_PEN", "FINGER_ROM", "FINGER_SELF", "THUMB_OFF", "TIPS_OFF", "BALANCE", "SOMETHING_NEW"])
		assert.equal(isBlocking(g(kind, "Left ball slides", 9)), false, kind);
	assert.equal(isBlocking({}), false, "no kind");
});
check("POP blocks above 25 cm/f^2; a group without worst reads its subject", () => {
	const [under, over] = just(POP_HARD);
	assert.equal(isBlocking(g("POP", "LeftLeg accel x cm/f^2 in one frame", under)), false);
	assert.equal(isBlocking(g("POP", "LeftLeg accel x cm/f^2 in one frame", over)), true);
	assert.equal(isBlocking(g("POP", "LeftForeArm accel 24.90 cm/f^2 in one frame")), false);
	assert.equal(isBlocking(g("POP", "LeftForeArm accel 25.10 cm/f^2 in one frame")), true);
	assert.equal(isBlocking(g("POP", "a pop")), true, "an unreadable size blocks");
});
check("GROUND blocks the trunk, legs and head deeper than 5 cm; palms, fingers and arms warn", () => {
	const [under, over] = just(DEEP);
	for (const part of ["shin_l", "thigh_r", "hips", "torso_lo", "torso_hi", "head", "neck", "shoulder_l", "Left sole", "Right sole"]) {
		assert.equal(isBlocking(g("GROUND", `${part} below floor`, under)), false, `${part} ${under}`);
		assert.equal(isBlocking(g("GROUND", `${part} below floor`, over)), true, `${part} ${over}`);
	}
	for (const part of ["fingers_l", "hand_r", "farm_l", "uarm_r"]) assert.equal(isBlocking(g("GROUND", `${part} below floor`, 0.2)), false, part);
	assert.equal(isBlocking(g("GROUND", "shin_l below floor")), true, "an unreadable depth blocks");
});
check("COLLIDE, BODY, SELF, FACE, PERSON and OBJECT block deeper than 5 cm; fingers and palms in a body warn", () => {
	const [under, over] = just(DEEP);
	for (const [kind, subject] of [["COLLIDE", "thigh_l x cube"], ["COLLIDE", "crate x shelf"], ["BODY", "farm_l into thigh_l"], ["BODY", "hand_r into torso_lo"], ["SELF", "hands overlap"],
		["FACE", "hand_l into head"], ["PERSON", "thigh_l x person:char-b"], ["OBJECT", "cup into table"]]) {
		assert.equal(isBlocking(g(kind, subject, under)), false, `${subject} ${under}`);
		assert.equal(isBlocking(g(kind, subject, over)), true, `${subject} ${over}`);
	}
	for (const part of ["fingers_l", "fingers_r", "hand_l", "thumb_r"]) assert.equal(isBlocking(g("COLLIDE", `${part} x wall`, 0.11)), false, part);
});
check("SELF thighs and shins carry a touch distance, not a depth: the take's depth decides, unknown blocks", () => {
	assert.equal(isBlocking(g("SELF", "thighs overlap", 0.135, { limit: 0.135 })), true);
	assert.equal(isBlocking(g("SELF", "thighs overlap", 0.135, { limit: 0.135 }), { depth: 0.02 }), false);
	assert.equal(isBlocking(g("SELF", "shins touch", 0.1, { limit: 0.1 }), { depth: 0.06 }), true);
});
check("REACH blocks a contact or anchor target missed by more than 3 cm; a target in the air and an object off its keys warn", () => {
	const [under, over] = just(REACH_GAP);
	assert.equal(isBlocking(g("REACH", "arm_miss_l", under)), false);
	assert.equal(isBlocking(g("REACH", "arm_miss_l", over)), true, "no take to measure: blocks");
	assert.equal(isBlocking(g("REACH", "arm_miss_l", 0.12), { onSurface: false }), false, "a target in the air");
	assert.equal(isBlocking(g("REACH", "leg_miss_r", 0.12), { onSurface: true }), true, "a target on a surface");
	assert.equal(isBlocking(g("REACH", "arm_miss_l", 0.12, { cause: "anchor barL (fits[0]) via w_barL_l between use[1] reachGrip f30 and f111" }), { onSurface: false }), true, "an anchor");
	assert.equal(isBlocking(g("REACH", "crate: 6.2 cm off its keys", 0.062)), false);
});
check("FLOAT blocks unless the body rests on something on most of its frames", () => {
	assert.equal(isBlocking(g("FLOAT", "no foot on the ground f40-f50, hips fall at 2% of g", 0.98)), true);
	assert.equal(isBlocking(g("FLOAT", "no foot on the ground f40-f50, hips fall at 2% of g", 0.98), { rests: true }), false);
	assert.equal(isBlocking(g("FLOAT", "no foot on the ground f40-f50, hips fall at 2% of g", 0.98), { rests: false }), true);
});

// a synthetic take: the Y Bot's bind pose (soles on the floor, hands at 1.44 m, thighs 18 cm apart) raised by dy, 8 still frames
const sk = skeletonFor("y-bot-tpose");
const posed = dy => ({ frames: Array.from({ length: 8 }, () => ({ s: { P: sk.restWorldPos.map(p => [p[0], p[1] + dy, p[2]]), R: sk.restWorldRot } })),
	ctx: { sk, spec: {} }, objectsAt: () => ({}), fps: 24, f0: 0 });
const float = g("FLOAT", "no foot on the ground f0-f7, hips fall at 0% of g", 1);
check("measureGroup: a body held 1 m up floats; with its soles 3 cm over the floor it rests (within NEAR)", () => {
	assert.deepEqual(measureGroup(posed(1), float), { rests: false });
	assert.deepEqual(measureGroup(posed(0.03), float), { rests: true });
	assert.equal(isBlocking(float, measureGroup(posed(1), float)), true);
	assert.equal(isBlocking(float, measureGroup(posed(0.03), float)), false);
});
// one FLOAT group holds every run: 14 frames held 1 m up, a block under the feet at f6 splits them; a bar beside the left hand
// (not under it, so the hand is not down) from f7 on, or on every frame
const I = sk.index, hand = sk.restWorldPos[I.LeftHand].map((v, k) => v + (k === 1 ? 1 : 0)), box = (pos, half) => ({ pos, half, R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] });
const bar = box([hand[0], hand[1] - 0.05, hand[2] + 0.07], [0.05, 0.05, 0.05]), block = box([0, 0, 0], [0.6, 0.5, 0.6]);
const split = barFrom => ({ ...posed(1), frames: Array.from({ length: 14 }, () => posed(1).frames[0]),
	objectsAt: i => ({ ...(i === 6 ? { block } : {}), ...(i >= barFrom ? { bar } : {}) }) });
check("measureGroup: every FLOAT run must rest on something; a hang beside a bar does not excuse a run in the air", () => {
	assert.deepEqual(measureGroup(split(7), float), { rests: false }, "f0-f5 in the air, f7-f13 at the bar");
	assert.deepEqual(measureGroup(split(0), float), { rests: true }, "both runs at the bar");
});
// REST_SHARE: one 14-frame float run, its first k frames 3 cm over the floor and the rest 1 m up
const halfway = k => ({ ...posed(1), frames: Array.from({ length: 14 }, (_, i) => posed(i < k ? 0.03 : 1).frames[0]) });
const run14 = g("FLOAT", "no foot on the ground f0-f13, hips fall at 0% of g", 1, { last: 13 });
check("measureGroup: a float run rests when at least half its frames have a part within NEAR (REST_SHARE)", () => {
	assert.deepEqual(measureGroup(halfway(7), run14), { rests: true }, "7 of 14");
	assert.deepEqual(measureGroup(halfway(6), run14), { rests: false }, "6 of 14");
});
check("measureGroup: a sole within the miss + 5 cm of the floor may target it; a hand 1.4 m up does not", () => {
	assert.deepEqual(measureGroup(posed(0.08), g("REACH", "leg_miss_l", 0.04, { worstFrame: 3 })), { onSurface: true });
	assert.deepEqual(measureGroup(posed(0.2), g("REACH", "leg_miss_l", 0.04, { worstFrame: 3 })), { onSurface: false });
	assert.deepEqual(measureGroup(posed(0), g("REACH", "arm_miss_r", 0.1, { worstFrame: 3 })), { onSurface: false });
});
check("measureGroup: thighs 18 cm apart do not overlap", () => {
	const self = g("SELF", "thighs overlap", 0.135, { limit: 0.135 }), seen = measureGroup(posed(0), self);
	assert.ok(seen.depth < 0, JSON.stringify(seen));
	assert.equal(isBlocking(self, seen), false);
	assert.equal(measureGroup(posed(0), g("POP", "x", 0.3)), undefined, "a kind that needs no take");
});
check("markBlocking flags copies, blocking first in rank order, and builds the take once, only when a group needs it", () => {
	const groups = [g("POP", "a 1", 0.1), g("GOAL", "goal", 0.2), g("FLOAT", "float", 1), g("SLIDE", "s", 0.01), g("COLLIDE", "thigh_l x cube", 0.08)];
	let made = 0;
	const flagged = markBlocking(groups, () => { made++; return posed(0.03); });
	assert.equal(made, 1);
	assert.deepEqual(flagged.map(x => [x.kind, x.blocking]), [["GOAL", true], ["COLLIDE", true], ["POP", false], ["FLOAT", false], ["SLIDE", false]]);
	assert.equal(groups[0].blocking, undefined, "the groups themselves are not changed");
	made = 0;
	markBlocking([g("POP", "a", 0.3)], () => { made++; return null; });
	assert.equal(made, 0, "no group needs the take");
	assert.deepEqual(markBlocking([float]).map(x => x.blocking), [true], "without a take FLOAT blocks");
});
check("blockingOf reads the flags, blockingCount and blockingSay count a QA result", () => {
	assert.deepEqual(blockingOf([{ kind: "GOAL", blocking: false }, { kind: "SLIDE", blocking: true }, { kind: "LOAD" }]).map(x => x.kind), ["SLIDE", "LOAD"]);
	assert.equal(blockingCount({ ok: true, groups: [] }), 0);
	assert.equal(blockingCount({ ok: false, groups: [g("SLIDE", "s", 0.01)] }), 0, "warnings only");
	assert.equal(blockingCount({ ok: false, problems: 3, groups: [] }), 3, "a failed result without groups is never clean");
	assert.equal(blockingSay({ ok: false, groups: [g("GOAL", "x", 1), g("SLIDE", "s", 0.01), g("KNEE", "k", 90)] }), "1 blocking, 2 warnings");
	assert.equal(blockingSay({ ok: true, groups: [] }), "0 blocking, 0 warnings");
});

// an answer past the receipt budget (review of #1114: v2's handstand r2 and r3 answers cut 6 of 10 groups to one-liners,
// blocking SELF among them, and the brief still said "18 problems")
const bytes = v => new TextEncoder().encode(JSON.stringify(v)).length;
const answerOf = groups => ({ frames: 100, fps: 24, installed: false, specId: "spec-000000000000",
	qa: { ok: false, problems: groups.length, total: groups.length * 3, goals: [], groups, blocking: blockingCount({ ok: false, groups }) } });
const long = { cause: "x".repeat(400), hint: "y".repeat(300) };
const mixed = markBlocking(Array.from({ length: 40 }, (_, i) => [g("SELF", "hands overlap", 0.09, long), g("SLIDE", `Left ball slides ${i}`, 0.02, long), g("POP", "LeftHand accel 9.00 cm/f^2 in one frame", 0.09, long)][i % 3]));
check("fitFlagged: every group of an answer cut to the budget keeps its flag, the one-liners too, and it fits", () => {
	const out = fitFlagged(answerOf(mixed)), lines = out.qa.groups.filter(x => !("worst" in x));
	assert.ok(lines.length > 0 && out.more.groups > 0, JSON.stringify(out.more));
	assert.deepEqual(out.qa.groups.map(x => x.blocking), mixed.slice(0, out.qa.groups.length).map(x => x.blocking));
	assert.ok(lines.some(x => x.blocking) && lines.some(x => !x.blocking), "one-liners of both kinds");
	assert.ok(bytes(out) <= MOTION_OUTPUT_BUDGET, `${bytes(out)} B`);
	assert.ok(out.qa.groups.length < fitOutput(answerOf(mixed)).qa.groups.length, "the flags took the room of a one-liner: fitted again");
	assert.equal(out.brief[0], "spec-000000000000 qa 14 blocking, 26 warnings (120 issues), not installed");
});
check("fitFlagged: over a head too big to fit, one-liners go from the end before a flag adds bytes", () => {
	const answer = { ...answerOf(mixed), stuck: "z".repeat(5600) }, plain = fitOutput(answer), out = fitFlagged(answer);
	assert.ok(bytes(plain) > MOTION_OUTPUT_BUDGET, `${bytes(plain)} B: fitOutput alone is over`);
	assert.ok(bytes(out) <= bytes(plain) && out.qa.groups.length < plain.qa.groups.length && out.qa.groups.every(x => typeof x.blocking === "boolean"), `${bytes(out)} B, ${out.qa.groups.length} groups`);
	assert.deepEqual(out.qa.groups.map(x => x.subject), plain.qa.groups.slice(0, out.qa.groups.length).map(x => x.subject), "the first ones stay");
	assert.equal(out.more.groups, plain.more.groups);
});
check("fitFlagged: the brief of a take with warnings only says 0 blocking and marks its group lines warnings", () => {
	const soft = markBlocking([g("SLIDE", "Left ball slides", 0.02), g("PALM_GAP", "palm_l off bar", 0.08)]), out = fitFlagged(answerOf(soft));
	assert.deepEqual(out.brief, ["spec-000000000000 qa 0 blocking, 2 warnings (6 issues), not installed", "SLIDE Left ball slides x3 f0-7 (warning)", "PALM_GAP palm_l off bar x3 f0-7 (warning)"]);
	assert.equal(Object.keys(out)[0], "brief");
	assert.deepEqual(out.qa.groups, soft, "an answer that fits keeps its groups as they are");
	const clean = fitFlagged({ specId: "spec-1", installed: true, qa: { ok: true, problems: 0, total: 0, goals: [], groups: [], blocking: 0 } });
	assert.deepEqual(clean.brief, ["spec-1 qa ok, installed"]);
});

// ---- through the registry: the cup scene (stuck test's fixture) --------------------------------
const takes = new Map();
const owner = { replace: (id, take) => takes.set(id, take), motionFor: id => takes.get(id) ?? null };
const registry = createStudioAppActions({ state: () => ({ characters: [CHARACTER], objects: SCENE_OBJECTS, frameCount: 300 }), storeDomain: name => (name === "motion" ? owner : null) });
const run = args => { const r = registry.run("motion.compile", { characterId: CHARACTER.id, ...args }); return { ...(r?.output ?? r), summary: r.summary }; };
const cupSpec = {
	schema: "cozyclay.motion-spec.v1", fps: 24, frames: 100,
	use: [{ skill: "standIdle", args: { at: [0.15, 0.3], heading: 0 }, f0: 0 }],
	props: { grip: { hand: "l", origin: ["LeftHandIndex2", "LeftHandMiddle2"], points: { fingers: [0, 0, 0] } } },
	anchors: { cupHandle: { kind: "object", object: "cube-6", local: [0, 0.03, 0] } },
	fits: [{ side: "l", anchor: "cupHandle", effector: { prop: "grip", point: "fingers" } }],
	keys: [{ f: 10, set: { pitch: 0, armw_l: 0, w_cupHandle_l: 0 } }, { f: 30, set: { pitch: 25, armw_l: 1, w_cupHandle_l: 1, hand_l: [0.3, 1, 0.7] } },
		{ f: 36, set: { w_cupHandle_l: 1, pitch: 25, hand_l: [0.3, 1, 0.7] } }, { f: 60, set: { w_cupHandle_l: 0, pitch: 10, hand_l: [0.3, 1.2, 0.6] } }, { f: 99, set: {} }],
	objects: { [CUP.group]: { prop: "grip", grab: 34, release: 80 } },
	goals: [{ name: "cup lifted", moved: `object:${CUP.group}`, by: 0.1, at: [65, 75] }],
};
const far = run({ spec: cupSpec, install: "never" });
check("motion.compile flags every group, blocking first, and says qa.blocking and the counts, never \"done\"", () => {
	assert.ok(far.qa.blocking >= 1 && far.qa.groups.every(x => typeof x.blocking === "boolean"), JSON.stringify(far.qa.groups.map(x => [x.kind, x.blocking])));
	const firstWarning = far.qa.groups.findIndex(x => !x.blocking);
	assert.ok(firstWarning === -1 || far.qa.groups.slice(firstWarning).every(x => !x.blocking), "blocking groups come first");
	assert.equal(far.qa.groups.filter(x => x.blocking).length, far.qa.blocking);
	assert.match(far.summary, new RegExp(`; QA \\d+ problems \\(\\d+ frame issues\\), ${far.qa.blocking} blocking, ${far.qa.groups.length - far.qa.blocking} warnings?`));
	assert.doesNotMatch(far.summary, /done/i);
	// the anchor reach (the hand 0.4 m short of the cup handle) blocks; the hand grazing the table top and the arm at the torso warn
	assert.ok(far.qa.groups.some(x => x.kind === "REACH" && x.blocking) && far.qa.groups.filter(x => ["COLLIDE", "BODY"].includes(x.kind)).every(x => !x.blocking));
});
const shift = [{ op: "replace", path: "/use/0/args/at", value: [0.2, 0.45] }];
const near = run({ base: far.specId, patch: shift, install: "ifClean" });
check("install \"ifClean\" installs a take with 0 blocking problems, though QA reports warnings", () => {
	assert.equal(near.qa.ok, false);
	assert.equal(near.qa.blocking, 0, JSON.stringify(near.qa.groups.map(x => [x.kind, x.subject, x.worst])));
	assert.equal(near.installed, true);
	assert.match(near.summary, /, 0 blocking, \d+ warnings?; installed\./);
	assert.match(near.brief[0], new RegExp(`^${near.specId} qa 0 blocking, ${near.qa.groups.length} warnings? \\(\\d+ issues\\), installed$`), "the brief a script returns says it too");
	assert.equal(specIdOf(takes.get(CHARACTER.id).spec), near.specId, "the character carries it");
});
const back = run({ base: far.specId, install: "ifClean", repair: false });
check("ifClean keeps the take with 0 blocking problems over one that blocks; noImprovementRounds counts blocking problems", () => {
	assert.ok(back.qa.blocking >= 1);
	assert.equal(back.installed, false);
	assert.equal(back.noImprovementRounds, 1);
});
const forced = run({ base: far.specId, install: true, repair: false });
check("INSTALL_WORSE counts blocking problems", () => {
	assert.ok((forced.notes ?? []).some(n => new RegExp(`^INSTALL_WORSE: replaced the installed take ${near.specId} \\(0 blocking problems\\) with this one \\(${forced.qa.blocking}\\)`).test(n)), JSON.stringify(forced.notes));
});
const measured = registry.run("motion.qa", { characterId: CHARACTER.id });
check("motion.qa answers the installed take's blocking count too", () => {
	assert.equal(measured.output.qa.blocking, forced.qa.blocking);
	assert.match(measured.summary, /, \d+ blocking, \d+ warnings?/);
});
console.log("verify-motion3-blocking: all checks passed");
