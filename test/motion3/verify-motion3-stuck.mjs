#!/usr/bin/env node
// The stop rule (repair-watch.js): output.stuck says when more compiles stopped paying. The same
// failing groups for 3 compiles in a row -> a stuck note naming them and the best take so far; failures
// that improve -> no note; a whole spec after a note starts the streak again; 10 repair compiles -> the
// cap note; a compile after a passing one -> the polish note. Through the real registry the note fits
// the output budget and never changes what is compiled. A note never leaves the take empty: on a compile
// that did not install itself, the best take so far at the character's place goes on (no compile), once
// per change; the agent's own install stays; a move of the character or the set starts the best again.
import { createStudioAppActions } from "../../src/commands/index.js";
import { createRepairWatch } from "../../src/motion3/repair-watch.js";
import { MOTION_OUTPUT_BUDGET } from "../../src/motion3/report.js";
import { specIdOf as specIdOfSpec } from "../../src/motion3/spec-store.js";
import { SCENE_OBJECTS, CHARACTER, CUP } from "./fixtures/cup-scene.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

// ---- the rule on its own ----------------------------------------------------------------------
const g = (kind, subject, severity) => ({ kind, subject, severity });
const fail2 = (sev = 4) => ({ ok: false, groups: [g("REACH", "hand_l misses cupHandle by 3 cm", sev), g("COLLIDE", "hand_l x table", 2)] });
let w = createRepairWatch(), n = 0;
const next = (qa, base, turnId = "t1", characterId = "c") => w.note({ characterId, turnId, specId: `spec-${String(++n).padStart(12, "0")}`, base, qa }).say;
const notes = [next(fail2(3)), next(fail2(), "b"), next(fail2(), "b"), next(fail2(), "b")];
expect("no note for the first two compiles of a failure", notes[0] === undefined && notes[1] === undefined, JSON.stringify(notes));
expect("the third compile with the same failures says stuck, names them and the best take", /^REACH hand_l misses cupHandle by # cm, COLLIDE hand_l x table unchanged over 3 compiles\. Stop patching it or re-applying its hint: start afresh or try another approach\. Install the best take here, spec-0+1 \(2 problems\)\. If neither helps, report its problems\.$/.test(notes[2] ?? ""), notes[2]);
expect("and keeps saying it while nothing moves", /unchanged over 4 compiles/.test(notes[3] ?? ""), notes[3]);
expect("a whole spec after the note is the fresh start: no note", next(fail2()) === undefined);
expect("the note is short", notes[2].length <= 280, `${notes[2].length}`);

w = createRepairWatch();
const better = [next(fail2(6)), next(fail2(5), "b"), next(fail2(4), "b"), next({ ok: false, groups: [g("REACH", "hand_l misses cupHandle by 2 cm", 4)] }, "b")];
expect("severity dropping 5 % or more, or fewer groups: no note", better.every(x => x === undefined), JSON.stringify(better));
const superset = [next({ ok: false, groups: [g("BODY", "hand_l into thigh_l", 2)] }), next({ ok: false, groups: [g("BODY", "hand_l into thigh_l", 2), g("POP", "a", 1)] }, "b"),
	next({ ok: false, groups: [g("BODY", "hand_l into thigh_l", 2), g("POP", "a", 1)] }, "b")];
expect("a superset that does not improve counts as the same failure", superset[2] !== undefined && /BODY hand_l into thigh_l unchanged over 3/.test(superset[2]), JSON.stringify(superset));

w = createRepairWatch();
const sev = k => ({ ok: false, groups: [g("GOAL", `goal ${k}`, 10 - k * 0.6)] });
const capped = Array.from({ length: 12 }, (_, k) => next(sev(k), k ? "b" : undefined, "t2"));
expect("no note before the cap while failures change", capped.slice(0, 10).every(x => x === undefined), JSON.stringify(capped));
expect("the 11th compile of a turn (10 repairs) says install the best take and report", /^10 repair compiles\. Install the best take here, spec-\d+ \(1 problem\)\. Report its problems; stop unless asked for more\.$/.test(capped[10] ?? ""), capped[10]);
expect("another turn of the same character starts again", next(sev(1), "b", "t3") === undefined);
// in a turn the cap counts agent calls: a script's compiles (one callId) are one repair step
w = createRepairWatch();
const byCall = (k2, callId) => w.note({ characterId: "c", turnId: "t4", callId, specId: `spec-${String(++n).padStart(12, "0")}`, base: k2 ? "b" : undefined, qa: sev(k2 % 10) }).say;
const scripts = Array.from({ length: 30 }, (_, k2) => byCall(k2, `call-${Math.floor(k2 / 3)}`));
expect("30 compiles in 10 scripts (3 each): no cap note (10 calls, 9 repair steps)", scripts.every(x => x === undefined), JSON.stringify(scripts.filter(Boolean)));
const eleventh = [byCall(30, "call-10"), byCall(31, "call-10")];
expect("the 11th call is the cap, said in calls, for each of its compiles", /^10 repair calls\. /.test(eleventh[0] ?? "") && /^10 repair calls\. /.test(eleventh[1] ?? ""), JSON.stringify(eleventh));
// the stuck streak counts steps too: three variants with the same failures in one script are one try
w = createRepairWatch();
const sameCall = ["s1", "s1", "s1", "s1"].map((callId, k2) => w.note({ characterId: "c", turnId: "t6", callId, specId: `spec-${String(++n).padStart(12, "0")}`, base: k2 ? "b" : undefined, qa: fail2() }).say);
expect("4 compiles with the same failures in one call: no stuck note", sameCall.every(x => x === undefined), JSON.stringify(sameCall));
const nextCalls = ["s2", "s3"].map(callId => w.note({ characterId: "c", turnId: "t6", callId, specId: `spec-${String(++n).padStart(12, "0")}`, base: "b", qa: fail2() }).say);
expect("the same failures over 3 calls: the stuck note on the third", nextCalls[0] === undefined && /unchanged over 3 calls\. /.test(nextCalls[1] ?? ""), JSON.stringify(nextCalls));
w = createRepairWatch();
const loose = Array.from({ length: 11 }, (_, k2) => w.note({ characterId: "c", turnId: "t5", specId: `spec-${String(++n).padStart(12, "0")}`, base: k2 ? "b" : undefined, qa: sev(k2) }).say);
expect("compiles with no call id (MCP, tests) are a step each: the 11th says repair compiles", loose.slice(0, 10).every(x => x === undefined) && /^10 repair compiles\. /.test(loose[10] ?? ""), JSON.stringify(loose[10]));
w = createRepairWatch();
const chain = Array.from({ length: 11 }, (_, k) => next(sev(k), k ? `spec-${String(n).padStart(12, "0")}` : undefined, null));
expect("without a turn the cap counts along the base chain", /^10 repair compiles/.test(chain[10] ?? "") && next(sev(0), undefined, null) === undefined, chain[10]);

w = createRepairWatch();
const pass = { ok: true, groups: [] };
const polish = [next(fail2()), next(pass, "b"), next(fail2(), "b"), next(pass, "b")];
const passed = `spec-${String(n - 2).padStart(12, "0")}`;
expect("the first pass gets no note", polish[1] === undefined);
expect("a compile after a pass says QA passed: stop unless asked", polish[2] === `${passed} already passed QA: stop unless the user asked for a specific change.` && polish[3] === polish[2], JSON.stringify(polish));
expect("other characters keep their own history", next(fail2(), "b", "t1", "other") === undefined);

// ---- through the registry: the cup scene, base alone three times --------------------------
const takes = new Map();
const owner = { replace: (id, take) => takes.set(id, take), motionFor: id => takes.get(id) ?? null };
const registry = createStudioAppActions({ state: () => ({ characters: [CHARACTER], objects: SCENE_OBJECTS, frameCount: 300 }), storeDomain: name => (name === "motion" ? owner : null) });
const run = args => { const r = registry.run("motion.compile", { characterId: CHARACTER.id, install: false, ...args }); return r?.output ?? r?.receipt?.output ?? r; };
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
const first = run({ spec: cupSpec });
expect("the cup take fails QA (the fixture's REACH/COLLIDE groups)", first.qa?.ok === false && first.stuck === undefined, JSON.stringify(first.qa?.groups?.map(x => x.kind)));
const second = run({ base: first.specId, patch: [{ op: "replace", path: "/keys/@f=99/set", value: {} }] });
const third = run({ base: second.specId });
expect("the third unchanged compile answers output.stuck", second.stuck === undefined && /unchanged over 3 compiles/.test(third.stuck ?? ""), JSON.stringify([second.stuck, third.stuck]));
const bytes = JSON.stringify(third).length;
expect("an answer with the note still fits the receipt budget", bytes <= MOTION_OUTPUT_BUDGET, `${bytes} B`);
expect("the note changes nothing compiled: the same specId", third.specId === first.specId);
expect("install: false at the note: the best take so far goes on (nothing else was installed)", takes.get(CHARACTER.id)?.spec && specIdOfSpec(takes.get(CHARACTER.id).spec) === first.specId
	&& / Installed the best take here, spec-[0-9a-f]{12} \(\d+ problems\), bound to this position \(recompile after a move\)\. If neither helps, report its problems\.$/.test(third.stuck ?? ""), third.stuck);
const moved = run({ base: first.specId, patch: [{ op: "move", from: "/keys/@f=60", path: "/keys/@f=64" }, { op: "add", path: "/keys/@f=20/set/pitch", value: 5 }] });
expect("a base + patch by frame compiles: the keys moved and added", moved.specId !== first.specId && moved.delta?.base === first.specId, JSON.stringify(moved.delta));

// ---- the best take at a note, on its own (takes are tokens here) ------------------------------
const POS = "bound to this position (recompile after a move)", ELSE = "If neither helps, report its problems.";
w = createRepairWatch();
let k = 0;
const qaOf = (count, sev = 2) => ({ ok: false, groups: Array.from({ length: count }, (_, i) => g("REACH", `hand_l misses cup ${i}`, sev)) });
const step = (qa, extra = {}) => { const specId = `spec-b${String(++k).padStart(11, "0")}`; return { specId, ...w.note({ characterId: "c", turnId: "t9", specId, base: k > 1 ? "b" : undefined, qa, at: "here", take: `take ${specId}`, ...extra }) }; };
// ifClean that never came clean: nothing installed, the 2-problem compile the best, the same failures three times
const s1 = step(qaOf(3)), s2 = step(qaOf(2)), s3 = step(qaOf(2)), s4 = step(qaOf(2, 2.5));
expect("ifClean unclean until the stuck note: no install before it", !s1.install && !s2.install && !s3.install, JSON.stringify([s1, s2, s3]));
expect("at the note the best take so far goes on, with its take and how many problems it keeps", s4.install?.specId === s2.specId && s4.install.take === `take ${s2.specId}`
	&& s4.say.endsWith(`another approach. Installed the best take here, ${s2.specId} (2 problems), ${POS}. ${ELSE}`), JSON.stringify(s4));
const s5 = step(qaOf(2, 3), { current: s2.specId });
expect("the next note while the character carries it: no second install, it says the take stays", !s5.install && s5.say.endsWith(`another approach. ${s2.specId} (2 problems) stays installed, ${POS}. ${ELSE}`), JSON.stringify(s5));
const s6 = step(qaOf(2, 3), { current: null });
expect("a take rolled back or undone (the character carries none): the next note puts it on again", s6.install?.specId === s2.specId, JSON.stringify(s6));
const s7 = step(qaOf(1), { current: s2.specId }), s8 = step(qaOf(1), { current: s2.specId }), s9 = step(qaOf(1, 2.2), { current: s2.specId });
expect("a better compile after it: the note after it puts the better one on", !s7.install && s9.install?.specId === s7.specId && /Installed the best take here, spec-b0+7 \(1 problem\)/.test(s9.say), JSON.stringify([s7, s8, s9]));
const own = step(qaOf(1, 2.3), { installed: true });
expect("a compile that installed itself keeps its take: no install, the note says so", !own.install && / This take is installed; best so far spec-b0+7 \(1 problem\)\. If neither helps, report its problems\.$/.test(own.say), JSON.stringify(own));
// replay merged r3 S8: the agent's install: true take, then an install "never" measuring compile at the cap
const after1 = step(qaOf(0, 0), { current: own.specId }), after2 = step(qaOf(1, 2.3), { current: own.specId });
expect("a take the agent installed is never swapped, not even for a better compile; the note says the agent's take stays", !after1.install && !after2.install
	&& after2.say === `11 repair compiles. Your installed take ${own.specId} (1 problem) stays; best so far ${after1.specId} (0 problems). Report its problems; stop unless asked for more.`, JSON.stringify([after1, after2]));
w = createRepairWatch(); k = 0;
const pre = [step(qaOf(2), { current: "spec-from-before" }), step(qaOf(2), { current: "spec-from-before" }), step(qaOf(2, 2.1), { current: "spec-from-before" })];
expect("a take the character had before the line stays too: the note names the best take to install instead", !pre[2].install && pre[2].say.endsWith(`another approach. The earlier take stays; to replace it, install the best take here, ${pre[0].specId} (2 problems). ${ELSE}`), JSON.stringify(pre[2]));
// replay merged r1 S8: the body moved 0.88 -> 0.94 -> 0.88 m; each place keeps its own best take
w = createRepairWatch(); k = 0;
const atA = [step(qaOf(2), { at: "A" }), step(qaOf(5), { at: "A" })];
const atB = [step(qaOf(4), { at: "B" }), step(qaOf(4), { at: "B" }), step(qaOf(4, 2.1), { at: "B" })];
expect("the character moved: the note installs the best take where it now stands (a take fits only its own place)", atB[2].install?.specId === atB[0].specId, JSON.stringify(atB[2]));
// the streak goes on, so the first compile back at A has a note
const backA = step(qaOf(6), { at: "A", current: atB[0].specId });
expect("back at the first place: the take the watch put on is upgraded to that place's own best, kept across the move", backA.install?.specId === atA[0].specId && backA.install.take === `take ${atA[0].specId}`, JSON.stringify(backA));
const places = ["C", "D", "E"].map(at => step(qaOf(1), { at }));
const evicted = [step(qaOf(7), { at: "A", current: null }), step(qaOf(7), { at: "A", current: null }), step(qaOf(7, 2.1), { at: "A", current: null })];
expect("only the last 3 places keep their best: a fourth drops the oldest", places.length === 3 && evicted[2].install?.specId === evicted[0].specId, JSON.stringify(evicted[2]));
w = createRepairWatch(); k = 0;
const capRun = Array.from({ length: 11 }, (_, i) => step(qaOf(9 - (i % 4))));
expect("the cap without a stuck streak: the fewest problems so far goes on", capRun[10].install?.specId === capRun[3].specId && capRun[10].say === `10 repair compiles. Installed the best take here, ${capRun[3].specId} (6 problems), ${POS}. Report its problems; stop unless asked for more.` && capRun[10].say.length <= 180, JSON.stringify(capRun[10]));
w = createRepairWatch(); k = 0;
const draft = step({ ok: true, groups: [] }), after = step(qaOf(1));
expect("a pass compiled with install false: the polish note puts the passing take on", after.install?.specId === draft.specId && after.say === `${draft.specId} passed QA and is now installed, ${POS}: stop unless the user asked for a specific change.`, JSON.stringify(after));
// replay merged r6 S8: the pass was at another position; the note names both
w = createRepairWatch(); k = 0;
const passA = step({ ok: true, groups: [] }, { at: "A" }), atOther = step(qaOf(2), { at: "B" });
expect("a pass at another position: the polish note says so and installs the best take here", atOther.install?.specId === atOther.specId
	&& atOther.say === `${passA.specId} passed QA at another position; the best take here, ${atOther.specId} (2 problems), is installed, ${POS}. Report its problems; stop unless the user asked for a specific change.`, JSON.stringify(atOther));
const stillA = step(qaOf(3), { at: "A", current: atOther.specId });
expect("back where it passed: the passing take goes on again", stillA.install?.specId === passA.specId && stillA.say === `${passA.specId} passed QA and is now installed, ${POS}: stop unless the user asked for a specific change.`, JSON.stringify(stillA));
w = createRepairWatch();
const lineNote = (characterId, i) => w.note({ characterId, turnId: "t", specId: `spec-${characterId}${String(i).padStart(10, "0")}`, base: i ? "b" : undefined, qa: qaOf(2), at: "here", take: `take ${characterId}` });
for (const c of ["c1", "c2", "c3", "c4", "c5", "c6"]) lineNote(c, 0);
const old = [1, 2].map(i => lineNote("c1", i)).at(-1), fresh = [1, 2].map(i => lineNote("c6", i)).at(-1);
expect("only the 4 newest lines keep a take (memory): an older line's note asks for the install, a newer one installs", !old.install && / Install the best take here, spec-c1\d+ \(2 problems\)\. If neither helps, report its problems\.$/.test(old.say) && fresh.install?.take === "take c6", JSON.stringify([old, fresh]));
const noTake = createRepairWatch().note({ characterId: "c", turnId: "t", specId: "spec-000000000001", qa: qaOf(1) });
expect("no take kept (a caller without bake): never an install", noTake.install === undefined);

// ---- through the registry in an agent turn: compiles that never install, the S8 shape ---------
// (S8 ran ifClean that never came clean; ifClean now installs the first take and one that beats it, so "never" keeps that shape)
const held = new Map(), body = { ...CHARACTER };
const owner2 = { replace: (id, take) => held.set(id, take), motionFor: id => held.get(id) ?? null };
const turn = createStudioAppActions({ state: () => ({ characters: [body], objects: SCENE_OBJECTS, frameCount: 300 }), storeDomain: name => (name === "motion" ? owner2 : null) });
const inTurn = (args, turnId = "turn-1") => { const r = turn.run("motion.compile", { characterId: body.id, install: "never", ...args }, { turnId }); return { ...(r?.output ?? r?.receipt?.output ?? r), affectedIds: r.affectedIds, summary: r.summary }; };
const heldId = () => (held.get(body.id)?.spec ? specIdOfSpec(held.get(body.id).spec) : null);
const t0 = inTurn({ spec: cupSpec }), closer = inTurn({ base: t0.specId, patch: [{ op: "replace", path: "/use/0/args/at", value: [0.2, 0.45] }] });
const pitch = [{ op: "replace", path: "/keys/@f=30/set/pitch", value: 40 }];
const worse = [inTurn({ base: t0.specId, patch: pitch })];
while (!worse.at(-1).stuck && worse.length < 12) worse.push(inTurn({ base: worse[0].specId }));
const noted = worse.at(-1);
expect("never installed: nothing installed before the note", t0.installed === false && closer.installed === false && worse.slice(0, -1).every(x => x.installed === false && !x.affectedIds.length), JSON.stringify(worse.map(x => x.brief?.[0])));
expect(`the note installs the compile with the fewest problems (${closer.qa.problems} of ${[t0, closer, ...worse].map(x => x.qa.problems).join(", ")}): the character carries it`, Boolean(noted.stuck) && heldId() === closer.specId
	&& noted.affectedIds.includes(body.id) && /the best take so far, spec-[0-9a-f]{12}, installed/.test(noted.summary) && noted.stuck.includes(`Installed the best take here, ${closer.specId}`), JSON.stringify({ stuck: noted.stuck, summary: noted.summary, held: heldId() }));
expect("its brief still says this compile was not installed", noted.installed === false && /not installed$/.test(noted.brief[0]), noted.brief[0]);
const again = inTurn({ base: worse[0].specId });
expect("the next note: the take stays, no second install", Boolean(again.stuck) && !again.affectedIds.length && heldId() === closer.specId && again.stuck.includes(`${closer.specId} (${closer.qa.problems} problems) stays installed, bound to this position`), JSON.stringify(again.stuck));
body.z = 0.12;
const there = [inTurn({ base: worse[0].specId }), inTurn({ base: worse[0].specId }), inTurn({ base: worse[0].specId })];
expect("the character moved: the note installs a take baked where it now stands, not the earlier best", heldId() === there[0].specId && held.get(body.id).placement.position[2] === 0.12, JSON.stringify({ held: heldId(), there: there.map(x => [x.specId, x.stuck?.slice(0, 60)]) }));
body.z = 0;
const mine = inTurn({ base: worse[0].specId, install: true }, "turn-2"), mine2 = inTurn({ base: worse[0].specId, install: true }, "turn-2"), mine3 = inTurn({ base: worse[0].specId, install: true }, "turn-2");
expect("install: true at the note: the agent's own take stays (no swap)", Boolean(mine3.stuck) && heldId() === mine3.specId && / This take is installed\. If neither helps, report its problems\.$/.test(mine3.stuck), JSON.stringify([mine.stuck, mine2.stuck, mine3.stuck]));
// replay merged r3 S8 through the registry: a better draft, the agent's install: true of a worse one, then "never" measures
const draft3 = inTurn({ base: t0.specId, patch: [{ op: "replace", path: "/use/0/args/at", value: [0.2, 0.45] }], install: "never" }, "turn-3");
const agent3 = inTurn({ base: t0.specId, patch: pitch, install: true }, "turn-3");
const measure3 = [inTurn({ base: agent3.specId, install: "never" }, "turn-3")];
while (!measure3.at(-1).stuck && measure3.length < 12) measure3.push(inTurn({ base: agent3.specId, install: "never" }, "turn-3"));
expect(`the agent's install: true take (${agent3.qa.problems} problems) stays through "never" compiles and their note, though a draft had ${draft3.qa.problems}`, draft3.qa.problems < agent3.qa.problems && heldId() === agent3.specId
	&& measure3.every(x => !x.affectedIds.length) && measure3.at(-1).stuck?.includes(`Your installed take ${agent3.specId}`), JSON.stringify({ held: heldId(), stuck: measure3.at(-1).stuck }));

// through the registry: the bus hands motion.compile the agent's call id (command-bus.js context.callId)
const steps = [];
for (let c = 0; c < 4; c++) for (let v = 0; v < 3; v++) {
	const r = turn.run("motion.compile", { characterId: body.id, base: t0.specId, patch: [{ op: "replace", path: "/keys/@f=30/set/pitch", value: 20 + c * 3 + v }], install: "never" }, { turnId: "turn-4", callId: `toolu_${c}` });
	steps.push((r?.output ?? r?.receipt?.output ?? r).stuck ?? null);
}
expect("12 compiles in 4 agent calls through the registry: never a cap note (3 repair steps)", steps.every(x => x === null || !/repair (calls|compiles)/.test(x)), JSON.stringify(steps));
if (failures) { console.error(`${failures} motion3 stuck check(s) failed`); process.exit(1); }
console.log("motion3 stuck: all checks passed");
