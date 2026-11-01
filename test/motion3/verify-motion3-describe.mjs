#!/usr/bin/env node
// Lane A (motion API v3.1, docs/motion-api-v3.1.md C1, C9): motion.describe answers every topic
// under the receipt budget with an example that passes validation; unknown fields are refused at
// every level with a suggestion and the field list (and ignored on a lenient reload); the skill
// info matches the skills; frames: "auto" resolves to the last frame any part needs, plus 1.
// Lane G4: topic essentials answers every field, type and skill in one receipt.
// Lane H3c: and every meaning the round-2 sessions read in follow-up calls (reachGrip, objects, channels).
import { describe, DESCRIBE_BUDGET } from "../../src/motion3/describe.js";
import { literal } from "../../src/motion3/schema/brief.js";
import { DESCRIBE_TOPICS, PROBE_FIELDS, SPEC_FIELDS, KEY_FIELDS, USE_FIELDS, ANCHOR_FIELDS, PROP_FIELDS, FIT_FIELDS, OBJECT_FIELDS, WALK_FIELDS, CHECK_FIELDS,
	CHECK_ENTRY_FIELDS, GOAL_FIELDS, REF_KINDS } from "../../src/motion3/schema/fields.js";
import { VEC_CHANNELS, NUM_CHANNELS, MAP_CHANNELS, SKILL_CHANNELS } from "../../src/motion3/compiler/vocab.js";
import { fixture } from "../bus/fixture.mjs";
import { SKILL_NAMES, expandUse } from "../../src/motion3/skills/index.js";
import { SKILL_INFO } from "../../src/motion3/skills/info.js";
import { resolveFrames } from "../../src/motion3/skills/frames-auto.js";
import { validateSpec } from "../../src/motion3/compiler/validate.js";
import { nameChecks } from "../../src/motion3/qa/check-names.js";
import { checkRef } from "../../src/motion3/refs.js";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { createSceneObject } from "../../src/scene-objects.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { MOTION_OUTPUT_BUDGET } from "../../src/motion3/report.js";
import { compileTakeSource } from "../../src/domains/motion/take-source.js";
import { createStudioAppActions } from "../../src/commands/index.js";
import { SCENE_OBJECTS as CAR_OBJECTS } from "./fixtures/exitcar-scene.mjs";
import { SCENE_OBJECTS, CHARACTER } from "./fixtures/cup-scene.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const refusal = run => { try { run(); return ""; } catch (error) { return error.message; } };
const bytes = v => new TextEncoder().encode(JSON.stringify(v)).length;
const sk = skeletonFor("x-bot-tpose"), empty = { objects: {} }, car = motionScene(CAR_OBJECTS);
const STAND = { skill: "standIdle", f0: 0, args: { at: [0, 0] } };
const minimal = (extra = {}) => structuredClone({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 60, ...extra, use: [STAND, ...(extra.use ?? [])] });
/** The pipeline's validation path: frames, names, skills, then the strict validator. */
const validate = (spec, ctx = { sk, scene: empty }) => {
	const { spec: full } = expandUse(nameChecks(resolveFrames(spec, ctx)), ctx);
	validateSpec(JSON.parse(JSON.stringify(full)), ctx);
	return full;
};

// 1. every topic: small, the contract shape, an example that validates
for (const topic of DESCRIBE_TOPICS) {
	const a = describe(topic);
	const budget = topic === "essentials" ? DESCRIBE_BUDGET : MOTION_OUTPUT_BUDGET;
	expect(`describe ${topic}: ${bytes(a)} B <= ${budget}`, bytes(a) <= budget, bytes(a));
	// fill is words only (the MotionBricks workflow, motion.fill), no schema of its own
	if (topic === "fill") { expect("describe fill: { topic, notes } naming motion.fill", a.notes.length > 0 && a.notes.join(" ").includes("motion.fill")); continue; }
	if (topic === "skills" || topic === "essentials" || topic === "examples") continue; // examples: test/bus/verify-motion3-examples.mjs
	expect(`describe ${topic}: { topic, schema (2020-12), example, notes }`, a.topic === topic && /2020-12/.test(a.schema.$schema) && a.example && a.notes.length > 0 && a.notes.every(n => typeof n === "string"));
	const refs = JSON.stringify(a.schema).match(/"#\/\$defs\/[A-Za-z]+"/g) ?? [];
	expect(`describe ${topic}: every $ref resolves`, refs.every(r => a.schema.$defs?.[r.slice(9, -1)]), refs.join());
	if (topic === "probes") {
		const msgs = [], spec = validate(minimal());
		const ok = a.example.every((p, i) => Object.keys(p).every(f => PROBE_FIELDS.includes(f)) && [p.position, ...(p.distance ?? [])].filter(Boolean).every(ref => checkRef(spec, m => msgs.push(m), { sk, scene: empty }, `probes[${i}]`, ref)));
		expect("describe probes: the example's fields and refs are valid", ok && msgs.length === 0, msgs.join("\n"));
		continue;
	}
	const spec = topic === "spec" ? a.example : minimal(a.example);
	const msg = refusal(() => validate(spec));
	expect(`describe ${topic}: the example passes validation in a minimal spec`, msg === "", msg);
}
expect("describe spec: the frames \"auto\" example resolves to a number", Number.isInteger(resolveFrames(describe("spec").example, { sk, scene: empty }).frames));
expect("an unknown topic is refused with a suggestion", /topic "skils" is not a describe topic; did you mean "skills"\?/.test(refusal(() => describe("skils"))));

// 2. skills: the list is SKILL_NAMES, each with args, needs, frames, adds; one skill in full
const list = describe("skills");
expect("describe skills lists exactly SKILL_NAMES", JSON.stringify(list.skills.map(s => s.name)) === JSON.stringify(SKILL_NAMES) && JSON.stringify(Object.keys(SKILL_INFO).sort()) === JSON.stringify([...SKILL_NAMES].sort()));
expect("each skill says its args, needs, frames and adds", list.skills.every(s => typeof s.args === "string" && s.needs && s.frames && s.adds.length > 0));
expect("reachGrip: required args starred, defaults shown, adds props.<anchor>Grip", /anchor\*, side\*, reach=20/.test(list.skills.find(s => s.name === "reachGrip").args)
	&& list.skills.find(s => s.name === "reachGrip").adds.some(x => x.includes("props.<anchor>Grip")));
expect("walkTo says it needs a standing pose keyed before f0", /standing pose keyed before f0/.test(list.skills.find(s => s.name === "walkTo").needs));
for (const name of SKILL_NAMES) {
	// throwObject throws what a hand carries: the example's ball, carried in the right hand from f0; catchObject catches it
	// flying at the body from 6 m
	const throws = name === "throwObject", catches = name === "catchObject", ball = { ...createSceneObject("sphere"), id: "ball", name: "ball", x: 0.2, y: 0.9, z: 0.2, scaleX: 0.074, scaleY: 0.074, scaleZ: 0.074 };
	const one = describe("skills", name), scene = SKILL_INFO[name].needs.includes("car") || name === "sitInSeat" ? car : throws ? motionScene([ball]) : catches ? motionScene([{ ...ball, x: 0, y: 1.6, z: 6 }]) : empty;
	expect(`describe skills ${name}: ${bytes(one)} B, the args schema and a use example`, bytes(one) <= MOTION_OUTPUT_BUDGET && one.name === name && one.example.skill === name
		&& JSON.stringify(Object.keys(one.schema.properties)) === JSON.stringify(Object.keys(SKILL_INFO[name].args)) && one.schema.additionalProperties === false);
	const before = name === "exitCar" ? [{ skill: "sitInSeat", f0: 0, args: { car: "Car" } }] : name === "standIdle" || name === "sitInSeat" ? [] : [STAND];
	const spec = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: "auto", use: [...before, one.example],
		...(throws ? { props: { ballGrip: { hand: "r", origin: ["RightHandIndex2", "RightHandMiddle2"], points: {} } }, objects: { ball: { prop: "ballGrip", grasp: "spherical", grab: 0 } } } : {}),
		...(catches ? { objects: { ball: { fall: { at: 0, v: [0, 2.5, -9] } } } } : {}) };
	const msg = refusal(() => validate(spec, { sk, scene }));
	expect(`describe skills ${name}: the example expands and validates`, msg === "", msg);
}
expect("an unknown skill name is refused with a suggestion", /skill "walkto" is not a skill; did you mean "walkTo"\?/.test(refusal(() => describe("skills", "walkto"))));

// 2b. essentials: one call names every field, type, channel, skill and skill arg; it fits one receipt.
// Lane H3c: checks names its lists only (topic checks has the entry fields); objects, channels and reachGrip carry meanings.
const ess = describe("essentials"), essText = JSON.stringify(ess);
// physical grasp (#816): the first spec learns the carry's grasp and mass, a fall's v, and where throw and catch live
expect("essentials names mass, grasp, spherical, fall.v, throwObject and catchObject", ["mass", "grasp", "spherical", "throwObject", "catchObject"].every(w => essText.includes(w)) && /fall[^"]*"?[^}]*\bv\?/.test(essText), essText.slice(0, 200));
expect("essentials answers { topic, types, skills, notes }", JSON.stringify(Object.keys(ess)) === '["topic","types","skills","notes"]' && ess.notes.every(n => typeof n === "string"));
expect("essentials has a type line for every topic but skills, and for every shared shape it names, no other",
	DESCRIBE_TOPICS.filter(t => !["skills", "essentials", "examples", "fill"].includes(t)).every(t => typeof ess.types[t] === "string")
	&& ["vec3", "frameSpan", "ref", "key", "use", "walk"].every(n => typeof ess.types[n] === "string") && ["checkRef", "part", "when"].every(n => !(n in ess.types)), Object.keys(ess.types).join());
/** f is named as a field: `{f: `, `, f?: `, or folded with others of one type, `a|f|b?: ` (`f_l|r?: ` for a pair). */
const named = (f, text) => new RegExp(`(?:[{|]|, )${f}(?:\\|\\w+)*\\??: `).test(text);
const tables = { SPEC_FIELDS, KEY_FIELDS, USE_FIELDS, ANCHOR_FIELDS: Object.values(ANCHOR_FIELDS).flat(), PROP_FIELDS, FIT_FIELDS, OBJECT_FIELDS: Object.values(OBJECT_FIELDS).flat(),
	WALK_FIELDS, CHECK_FIELDS, GOAL_FIELDS, PROBE_FIELDS };
const missing = Object.entries(tables).flatMap(([table, fields]) => fields.filter(f => !named(f, essText)).map(f => `${table}.${f}`));
expect("essentials names every field of every field table with its type (checks entries: topic checks)", missing.length === 0, missing.join());
expect("essentials: checks names every check list; topic checks still types every entry field", CHECK_FIELDS.every(f => named(f, ess.types.checks))
	&& Object.values(CHECK_ENTRY_FIELDS).flat().every(f => JSON.stringify(describe("checks").schema).includes(`"${f}":`)), ess.types.checks);
// the channels only skills key (vocab.js SKILL_CHANNELS, e.g. arm_hang) stay out, so a first spec need not read them
const channels = [...VEC_CHANNELS, ...NUM_CHANNELS, ...MAP_CHANNELS].filter(ch => !SKILL_CHANNELS.has(ch) && !named(ch.replace(/_r$/, "_l"), ess.types.channels));
const skillOnly = [...SKILL_CHANNELS].filter(ch => named(ch, ess.types.channels));
expect("essentials names every channel (a left/right pair as x_l|r) but the skill-keyed ones", channels.length === 0 && skillOnly.length === 0, [...channels, ...skillOnly].join());
expect("essentials names every ref kind", REF_KINDS.every(k => ess.types.refs.includes(`${k}:`)), ess.types.refs);
// flip, hitReaction and throwObject (a tumble, a body thrown by a hit, a throw after a pickup: no first spec needs them) are in
// topic skills only: essentials has no room for them (describe.js FIRST_SPEC_SKIP; hitReaction left it when grasp, mass and
// fall.v joined, throwObject never joined, #816)
const SKIPPED = ["flip", "hitReaction", "throwObject", "catchObject"];
expect("essentials lists exactly SKILL_NAMES but flip, hitReaction, throwObject and catchObject, each with needs, frames, adds and every arg typed", JSON.stringify(ess.skills.map(s => s.name)) === JSON.stringify(SKILL_NAMES.filter(n => !SKIPPED.includes(n)))
	&& ess.skills.every(s => s.needs === SKILL_INFO[s.name].needs && s.frames === SKILL_INFO[s.name].frames && s.adds === SKILL_INFO[s.name].adds
		&& Object.keys(SKILL_INFO[s.name].args).every(a => named(a, s.args))));
const rg = ess.skills.find(s => s.name === "reachGrip").args;
expect("essentials: reachGrip args are typed, required ones without ?, defaults shown", /anchor: string \(.*\), side: 'l'\|'r' \(the hand\), reach\?: int=20 \(frames to reach\)/.test(rg) && /fingers\?: .*='grip'/.test(rg), rg);
expect("essentials: a goal is a list entry with one of near|above|moved|still|speed and after|before", /^\(\{name: string, near\|above\?: \[ref, ref\], moved\|still\|speed\|after\|before\?: string.*\(one of near\|above\|moved\|still\|speed\)\)\[\]$/.test(ess.types.goals), ess.types.goals);
expect("essentials: objects maps an id to a hinge or a carry", /hinge \{pivot: vec3.*\| carry \{prop: string/.test(ess.types.objects), ess.types.objects);
expect("essentials: the notes say how to read a whole topic or one skill", /motion\.describe \{ topic \}/.test(ess.notes.join()) && /'skills', name/.test(ess.notes.join()));
expect("essentials: the spec line names the topic lines, the walk generator the walkTo args", /anchors\?: anchors, props\?: props\.props, fits\?: props\.fits, objects\?: objects/.test(ess.types.spec)
	&& ess.types.walk === "{type: 'walk', f0: int, heading?: [number, number], ...walkTo args but to, arrive}", `${ess.types.spec}\n${ess.types.walk}`);
// Round 2 (three live sessions): after essentials every run read skills reachGrip, objects and channels.
// Each meaning those answers gave (a field's description, but a bare unit) is in essentials, verbatim or as
// "<head>, as <field>" where its tail repeats an earlier field's; so do the carry example and its rest-in-the-palm note.
const FOLLOW_UPS = [["skills", "reachGrip"], ["objects"], ["channels"]];
const meanings = s => (!s || typeof s !== "object" ? [] : [...(typeof s.description === "string" && !/^(degrees|m)$/.test(s.description) ? [s.description] : []),
	...Object.entries(s).filter(([k]) => k !== "description" && k !== "$defs").flatMap(([, v]) => (Array.isArray(v) ? v.flatMap(meanings) : meanings(v)))]);
/** a map's "<key> -> <value>" description is the line's `[<key>]: ...` */
const covered = d => essText.includes(d) || essText.includes(`[${d.match(/^(?:[^:]*: )?(.+?) -> /)?.[1]}]: `) || [...d.matchAll(/[,:] /g)].some(m => essText.includes(`${d.slice(0, m.index)}, as `) && essText.includes(d.slice(m.index + 2)));
let facts = 0, followBytes = 0;
for (const [topic, name] of FOLLOW_UPS) {
	const a = describe(topic, name), ds = [...new Set(meanings(a.schema))];
	facts += ds.length; followBytes += bytes(a);
	const lost = ds.filter(d => !covered(d));
	expect(`essentials holds every meaning of describe ${topic}${name ? ` ${name}` : ""} (${ds.length})`, lost.length === 0, lost.join(" | "));
}
const carry = describe("objects");
const REST = "No at/along: it rests in the palm, fingers closed on it.";
expect("essentials holds the carry example (a grip prop's origin bones, grab, release) and the rest-in-the-palm note (#816; was no-jump)",
	essText.includes(literal({ props: carry.example.props, objects: { cup: carry.example.objects.cup } })) && carry.notes.some(n => n.includes(REST)) && essText.includes(REST));
expect("essentials: reachGrip's needs, frames and adds are the skill answer's notes", describe("skills", "reachGrip").notes.every(n => essText.includes(n.replace(/^(needs|frames from f0|adds): /, "").split("; ")[0])));
console.log(`  sizes: the round-2 follow-ups (${FOLLOW_UPS.map(f => f.join(" ")).join(", ")}) took ${followBytes} B in 3 calls for ${facts} meanings; essentials has them all in ${bytes(ess)} B (budget ${DESCRIBE_BUDGET})`);
// What the three live sessions read in 2-3 calls each (topics, then skills by name): the sum cannot fit
// one 8 KiB receipt; essentials covers each field of it (checks entries but by name) in one, and the full topics stay one call each.
const READ = ["spec", "skills", "goals", "objects", "anchors", "props", "channels", "refs", "checks"], SKILLS_READ = ["reachGrip", "walkTo"];
const readBytes = READ.reduce((n, t) => n + bytes(describe(t)), 0) + SKILLS_READ.reduce((n, k) => n + bytes(describe("skills", k)), 0);
console.log(`  sizes: the sessions read ${readBytes} B in full (${READ.join(", ")}, skills ${SKILLS_READ.join(", ")}); essentials ${bytes(ess)} B (budget ${DESCRIBE_BUDGET})`);
expect(`the full topics the sessions read (${readBytes} B) exceed one 8 KiB receipt, essentials (${bytes(ess)} B) fits it`, readBytes > 8192 && bytes(ess) <= DESCRIBE_BUDGET);
// through the real command bus: the receipt validates (<= 8 KiB); with a live host (uuid ids, long revisions) it still fits
const app = createStudioAppActions({ state: () => ({ characters: [], objects: [], frameCount: 100 }), storeDomain: () => null });
const bus = fixture([app.get("motion.describe")]);
const receipt = await bus.bus.run("motion.describe", { topic: "essentials" }, bus.request("agent"));
const uuid = "00000000-0000-4000-8000-000000000000", live = { ...receipt, host: { workspaceId: uuid, documentEpoch: uuid, sceneId: "scene-mv87b44h-1", sceneEpoch: uuid }, revision: { before: 999999, after: 999999 } };
const { output: _out, ...head } = live;
expect(`motion.describe essentials receipt: ${bytes(receipt)} B (live host ${bytes(live)} B, head ${bytes(head)} B) <= 8192`, receipt.ok && receipt.status === "completed"
	&& JSON.stringify(receipt.output) === essText && bytes(live) <= 8192 && bytes(head) <= 8192 - DESCRIBE_BUDGET, bytes(live));
for (const [topic, name] of [["spec"], ["skills"], ["skills", "reachGrip"]]) {
	const r = await bus.bus.run("motion.describe", { topic, ...(name ? { name } : {}) }, bus.request("agent"));
	expect(`motion.describe ${topic}${name ? ` ${name}` : ""} still answers through the bus as before`, r.ok && JSON.stringify(r.output) === JSON.stringify(describe(topic, name)));
}

// 3. a zzz field at every level is refused (strict), and ignored on a lenient reload
const grip = { hand: "r", origin: ["RightHandIndex2", "RightHandMiddle2"], points: { tip: [0, 0, 0] } }, spot = { kind: "world", p: [-0.2, 1.1, 0.35] };
const reach = { skill: "reachGrip", f0: 10, args: { anchor: "spot", side: "r" } };
const levels = [
	["spec", s => { s.zzz = 1; }, /spec\.zzz is not a spec field/],
	["keys[i]", s => { s.keys = [{ f: 0, set: { yaw: 0 }, zzz: 1 }]; }, /keys\[0\] has unknown field "zzz"/],
	["use[i]", s => { s.use[0].zzz = 1; }, /use\[0\] has unknown field "zzz"/],
	["use[i].args", s => { s.use[1].args.zzz = 1; }, /use\[1\]\.args\.zzz is not an arg of reachGrip \(args: anchor, side, reach, hold, release, elbow, fingers, define, orient\)/],
	["anchors", s => { s.anchors.spot = { ...spot, zzz: 1 }; }, /anchors\.spot \(world\) has unknown field "zzz" \(fields: kind, p\)/],
	["props", s => { s.props = { grip: { ...grip, zzz: 1 } }; }, /props\.grip has unknown field "zzz" \(fields: hand, origin, points\)/],
	["fits", s => { s.props = { grip }; s.fits = [{ side: "r", anchor: "spot", effector: { prop: "grip", point: "tip" }, zzz: 1 }]; }, /fits\[0\] has unknown field "zzz" \(fields: side, anchor, effector, offset, orient\)/],
	["generators", s => { s.generators = [{ type: "walk", f0: 5, steps: 2, zzz: 1 }]; }, /generators\[0\] has unknown field "zzz" \(fields: type, f0, steps/],
	["checks", s => { s.checks = { zzz: 1 }; }, /checks\.zzz is not a check \(checks: contacts, orient/],
	["checks.limits", s => { s.checks = { limits: { zzz: 1 } }; }, /checks\.limits\.zzz is not a QA limit/],
	["fix", s => { s.fix = { zzz: 1 }; }, /spec\.fix\.zzz is not a fix/],
	...[["contacts", { point: "joint:RightHand", target: "anchor:spot" }], ["orient", { from: "joint:RightArm", to: "joint:RightHand", along: "up" }], ["below", { joint: "RightForeArm", ref: "RightArm" }],
		["clearance", { part: "hand_r", object: "box", min: 0.01 }], ["appear", { channel: "box_vis", joint: "RightHand", anchor: "spot" }], ["supports", { object: "box" }], ["allow", { part: "hand", object: "box", depth: 0.02 }]]
		.map(([name, entry]) => [`checks.${name}[i]`, s => { s.use.pop(); s.checks = { [name]: [{ ...entry, zzz: 1 }] }; }, new RegExp(`checks\\.${name}\\[0\\] has unknown field "zzz" \\(fields: `)]),
];
for (const [level, edit, want] of levels) {
	const spec = minimal({ frames: 80, anchors: { spot }, use: [reach] });
	edit(spec);
	const msg = refusal(() => compileSpec(spec, { sk, scene: empty }));
	expect(`zzz in ${level}: refused`, want.test(msg), msg);
	const lenient = refusal(() => compileSpec(spec, { sk, scene: empty }, { lenient: true }));
	expect(`zzz in ${level}: ignored when lenient`, lenient === "", lenient);
}
const frameWord = refusal(() => compileSpec(minimal({ frames: 80, anchors: { spot }, checks: { contacts: [{ point: "joint:RightHand", target: "anchor:spot", frames: [0, 9] }] } }), { sk, scene: empty }));
expect("a frame word in a check points at when", frameWord.includes('checks.contacts[0] has unknown field "frames"; did you mean "when"? (fields: name, point, target, tol, when)'), frameWord);
const typo = refusal(() => compileSpec(minimal({ frames: 80, anchors: { spot }, use: [{ ...reach, args: { ...reach.args, hodl: 30 } }] }), { sk, scene: empty }));
expect("a misspelt skill arg gets a suggestion", /use\[1\]\.args\.hodl is not an arg of reachGrip; did you mean "hold"\?/.test(typo), typo);
expect("checks that are not lists are named, not a crash", /checks\.contacts must be an array of \{ name, point, target, tol, when \}, got 5/.test(refusal(() => compileSpec(minimal({ checks: { contacts: 5 } }), { sk, scene: empty }))));

// 4. a saved take with unknown fields still loads (compileTakeSource is lenient)
const saved = { schema: "cozyclay.take.v3", rig: "x-bot-tpose", placement: { position: [0, 0, 0], yaw: 0 }, scene: empty,
	spec: minimal({ frames: 80, anchors: { spot: { ...spot, zzz: 1 } }, props: { grip: { ...grip, zzz: 1 } }, checks: { zzz: 1, contacts: [{ point: "joint:RightHand", target: "anchor:spot", frames: [0, 9] }] },
		use: [{ ...reach, args: { ...reach.args, zzz: 1 } }] }) };
expect("compileTakeSource loads a source with unknown fields at every level", compileTakeSource(saved)?.frameCount === 80, refusal(() => compileTakeSource(saved)));

// 5. too few frames for a skill, and frames: "auto"
const short = refusal(() => compileSpec(minimal({ frames: 100, anchors: { spot }, use: [{ ...reach, f0: 86 }] }), { sk, scene: empty }));
expect("a skill past the last frame says how many frames it needs", short.includes('use[1] reachGrip needs 54 frames from f86 (to f140), past the last frame f99; set frames >= 141 or frames: "auto"'), short);
const auto = compileSpec(minimal({ frames: "auto", anchors: { spot }, use: [{ ...reach, f0: 86 }], keys: [{ f: 20, set: { head_yaw: 5 } }] }), { sk, scene: empty });
expect("frames auto: the last skill end + 1, kept in the resolved spec", auto.spec.frames === 141 && auto.out.frameCount === 141, `${auto.spec.frames} ${auto.out.frameCount}`);
const keysOnly = resolveFrames({ ...minimal({ frames: "auto" }), use: undefined, keys: [{ f: 0, set: { yaw: 0 } }, { f: 33, set: { yaw: 3 } }] }, { sk, scene: empty });
const walked = resolveFrames(minimal({ frames: "auto", generators: [{ type: "walk", f0: 5, steps: 2 }] }), { sk, scene: empty });
expect("frames auto: the last key f + 1, the walk generator's end + 1", keysOnly.frames === 34 && walked.frames === 80, `${keysOnly.frames} ${walked.frames}`);
const open = resolveFrames(minimal({ frames: "auto", anchors: { spot }, use: [{ ...reach, f0: { range: [10, 30] }, args: { ...reach.args, hold: { range: [10, 40] } } }] }), { sk, scene: empty });
expect("frames auto: open parameters count at their upper bound", open.frames === 30 + 20 + 40 + 12 + 1 && open.use[1].f0.range[1] === 30, JSON.stringify(open.frames));
const plain = minimal();
expect("frames given: resolveFrames answers the spec itself", resolveFrames(plain, { sk, scene: empty }) === plain);
// through motion.compile: the installed take stores the number, and reloads
const takes = new Map(), owner = { replace: (cid, take) => takes.set(cid, take), motionFor: cid => takes.get(cid) ?? null };
const registry = createStudioAppActions({ state: () => ({ characters: [CHARACTER], objects: SCENE_OBJECTS, frameCount: 800 }), storeDomain: name => (name === "motion" ? owner : null) });
const out = registry.run("motion.compile", { characterId: CHARACTER.id, spec: { ...minimal({ frames: "auto", anchors: { spot }, use: [reach] }) } }).output;
const take = takes.get(CHARACTER.id);
expect("motion.compile with frames auto installs and stores the number", out.frames === 65 && take?.spec.frames === 65, `${out.frames} ${take?.spec?.frames}`);
expect("the stored take reloads through compileTakeSource", compileTakeSource({ schema: "cozyclay.take.v3", rig: CHARACTER.model, spec: take.spec, placement: take.placement, scene: motionScene(SCENE_OBJECTS) })?.frameCount === 65);

if (failures) { console.error(`${failures} motion3 describe check(s) failed`); process.exit(1); }
console.log("motion3 describe: all checks passed");
