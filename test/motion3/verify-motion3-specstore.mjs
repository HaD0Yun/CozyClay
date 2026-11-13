#!/usr/bin/env node
// Lane D2 (motion API v3.1, C7): specId, the spec store (LRU of 64), base + patch requests,
// delta against the base's QA, the exact errors, motion.qa's specId and motion.report paging of
// a cut output, end to end through the command registry.
import { createStudioAppActions } from "../../src/commands/index.js";
import { SCENE_OBJECTS, CHARACTER } from "./fixtures/cup-scene.mjs";
import { EXITCAR_SPEC, SCENE_OBJECTS as CAR_OBJECTS, CHARACTER as DRIVER } from "./fixtures/exitcar-scene.mjs";
import { specIdOf, createSpecStore, SPEC_STORE_SIZE } from "../../src/motion3/spec-store.js";
import { deltaOf } from "../../src/motion3/delta.js";
import { specRefusalPath } from "../../src/motion3/schema/fields.js";
import { MOTION_OUTPUT_BUDGET } from "../../src/motion3/report.js";
import { MOVED_BARE, BASE_REMEASURE, REMEASURE, BASE_PROBES_IN_SPEC, PROBES_IN_SPEC } from "./fixtures/round2-calls.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const refusal = run => { try { run(); return ""; } catch (error) { return error.message; } };
const bytes = v => new TextEncoder().encode(JSON.stringify(v)).length;

// ---- 1. specIdOf -------------------------------------------------------------------------
const a = { schema: "s", frames: 24, use: [{ skill: "x", args: { at: [0, 0], heading: 0 } }], checks: { contacts: [] } };
const aShuffled = { checks: { contacts: [] }, use: [{ args: { heading: 0, at: [0, 0] }, skill: "x" }], frames: 24, schema: "s" };
expect("specIdOf: the same spec gives the same id, whatever the key order", specIdOf(a) === specIdOf(structuredClone(a)) && specIdOf(a) === specIdOf(aShuffled));
expect("specIdOf: spec-<12 hex>; any change gives a new id; array order counts",
	/^spec-[0-9a-f]{12}$/.test(specIdOf(a)) && specIdOf({ ...a, frames: 25 }) !== specIdOf(a) && specIdOf({ ...a, use: [] }) !== specIdOf(a)
	&& specIdOf({ v: [1, 2] }) !== specIdOf({ v: [2, 1] }) && specIdOf({ v: 1 }) !== specIdOf({ v: "1" }));
expect("specIdOf: an undefined field is the same as a missing one (as in JSON)", specIdOf({ ...a, label: undefined }) === specIdOf(a));
// FNV-1a 64 of the canonical JSON "{}" (0x7b, 0x7d), computed by hand here
let h = 0xcbf29ce484222325n;
for (const c of [0x7b, 0x7d]) h = BigInt.asUintN(64, (h ^ BigInt(c)) * 0x100000001b3n);
expect("specIdOf: FNV-1a 64 over the canonical JSON, first 12 hex digits", specIdOf({}) === `spec-${h.toString(16).padStart(16, "0").slice(0, 12)}`, specIdOf({}));

// ---- 2. the store: LRU of 64 -------------------------------------------------------------
const store = createSpecStore();
const ids = Array.from({ length: SPEC_STORE_SIZE }, (_, i) => store.put({ n: i }));
expect("store: 64 specs are all kept", SPEC_STORE_SIZE === 64 && ids.every((id, i) => store.get(id)?.n === i));
store.put({ n: 64 });
expect("store: the 65th forgets the least recently used", store.get(ids[0]) === null && store.get(ids[1])?.n === 1);
store.keepParts(ids[2], { groups: [{ kind: "X" }], timeline: [], probes: {} });
store.parts(ids[3]); // reading the parts counts as a use too
for (let i = 65; i < 68; i++) store.put({ n: i });
expect("store: get, parts and keepParts count as a use", store.get(ids[1])?.n === 1 && store.parts(ids[2])?.groups[0].kind === "X" && store.get(ids[3])?.n === 3
	&& store.get(ids[4]) === null && store.get(ids[5]) === null && store.get(ids[6]) === null && store.get(ids[7])?.n === 7);
const kept = store.get(ids[1]);
kept.n = 99;
expect("store: get answers a copy", store.get(ids[1]).n === 1);
expect("store: put of a known spec keeps its parts", store.put({ n: 2 }) === ids[2] && store.parts(ids[2])?.groups.length === 1);

// ---- 3. deltaOf --------------------------------------------------------------------------
const G = (kind, subject, severity, count = 1) => ({ kind, subject, count, severity });
const base = [G("COLLIDE", "thigh_r x cube: 1.2 cm deep", 10), G("CONTACT", "contacts[0]: 12.0 cm apart", 20), G("CONTACT", "contacts[1]: 3.0 cm apart", 8),
	G("SPEED", "LeftHand 3.1 m/s", 4), G("ORIENT", "orient[0]", 6)];
const now = [G("COLLIDE", "thigh_r x cube: 0.9 cm deep", 10.4), G("CONTACT", "contacts[0]: 30.0 cm apart", 21), G("CONTACT", "contacts[1]: 1.0 cm apart", 7.6),
	G("SPEED", "LeftHand 5.0 m/s", 4.19), G("BELOW", "Hips below cube", 3)];
const d = deltaOf(base, now, "spec-91c2a07d3e15");
// COLLIDE +4 % (same), contacts[0] +5 % (worse), contacts[1] -5 % (better), SPEED +4.75 % (same), ORIENT resolved, BELOW new
expect("deltaOf: resolved/new/worse/better by groupKey, 5 % of severity", d.base === "spec-91c2a07d3e15" && d.resolved === 1 && d.new === 1 && d.worse === 1 && d.better === 1
	&& d.keys.resolved[0] === "ORIENT orient[0]" && d.keys.new[0] === "BELOW Hips below cube" && d.keys.worse[0] === "CONTACT contacts[0]: # cm apart", JSON.stringify(d));
expect("deltaOf: the same groups change nothing", JSON.stringify(deltaOf(base, base, "b")) === JSON.stringify({ base: "b", resolved: 0, new: 0, worse: 0, better: 0, keys: { resolved: [], new: [], worse: [] } }));
const many = Array.from({ length: 9 }, (_, i) => G("COLLIDE", `part${"abcdefghi"[i]} x cube`, i + 1));
const dm = deltaOf(many, [], "b"), dn = deltaOf([], many, "b");
expect("deltaOf: counts are complete, keys at most 6, most severe first", dm.resolved === 9 && dm.keys.resolved.length === 6 && dm.keys.resolved[0] === "COLLIDE parti x cube"
	&& dn.new === 9 && dn.keys.new.length === 6 && dn.keys.new[5] === "COLLIDE partd x cube", JSON.stringify(dm.keys));
const merged = deltaOf([G("SPEED", "RightHand 2.1 cm/frame", 4), G("SPEED", "RightHand 3.4 cm/frame", 4)], [G("SPEED", "RightHand 2.5 cm/frame", 4)], "b");
expect("deltaOf: groups sharing a key are summed (8 -> 4 is better, not resolved)", merged.resolved === 0 && merged.better === 1 && merged.worse === 0, JSON.stringify(merged));
expect("deltaOf: a group without severity is weighed by severityOf", deltaOf([{ kind: "SPEED", subject: "x", count: 2, worst: 0.05, limit: 0.04 }], [{ kind: "SPEED", subject: "x", count: 4, worst: 0.05, limit: 0.04 }], "b").worse === 1);

// ---- 4. through the registry: base + patch, errors, motion.qa ----------------------------
const takes = new Map();
const owner = { replace: (cid, take) => takes.set(cid, take), motionFor: cid => takes.get(cid) ?? null };
const portsFor = (character, objects) => ({ state: () => ({ characters: [character], objects, frameCount: 800 }), storeDomain: name => (name === "motion" ? owner : null) });
const cup = createStudioAppActions(portsFor(CHARACTER, SCENE_OBJECTS));
const run = (registry, action, args) => registry.run(action, args).output;
const contact = (name, point, target, more = {}) => ({ name, point, target, ...more });
const stand = (extra = {}) => ({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 24, use: [{ skill: "standIdle", args: { at: [0, 0], heading: 0 }, f0: 0 }],
	anchors: { spot: { kind: "world", p: [0.2, 1, 0.85] }, far: { kind: "world", p: [0.2, 1, 1.5] } },
	checks: { contacts: [contact("lh", "joint:LeftHand", "anchor:spot"), contact("rh", "joint:RightHand", "anchor:far"), contact("head", "joint:Head", "anchor:spot"),
		contact("rhLoose", "joint:RightHand", "anchor:far", { tol: 1.5 })] }, ...extra });
const spec = stand();
const first = run(cup, "motion.compile", { characterId: CHARACTER.id, spec, install: false });
const again = run(cup, "motion.compile", { characterId: CHARACTER.id, spec: structuredClone(spec), install: false });
expect("motion.compile: the same spec gives the same specId, specIdOf of what was sent", first.specId === again.specId && first.specId === specIdOf(spec) && !("delta" in first));
const subjects = o => o.qa.groups.map(g => `${g.subject.split(":")[0]} ${g.severity}`).join(", ");
console.log(`  base ${first.specId}: ${subjects(first)}`);
const patch = [{ op: "add", path: "/checks/contacts/1/when", value: [0, 11] }, { op: "replace", path: "/checks/contacts/3/tol", value: 1.2 },
	{ op: "remove", path: "/checks/contacts/2" }, { op: "add", path: "/checks/contacts/-", value: contact("lf", "joint:LeftFoot", "anchor:far") }];
const next = run(cup, "motion.compile", { characterId: CHARACTER.id, base: first.specId, patch, install: false });
console.log(`  patched ${next.specId}: ${subjects(next)}; delta ${JSON.stringify(next.delta)}`);
const nd = next.delta;
// rh: 24 -> 12 frames (better); rhLoose: tol 1.5 -> 1.2 (worse); head removed (resolved); lf added (new); lh the same
expect("base + patch: a new specId, and a delta of 1 resolved, 1 new, 1 worse, 1 better", next.specId !== first.specId && nd?.base === first.specId
	&& nd.resolved === 1 && nd.new === 1 && nd.worse === 1 && nd.better === 1 && nd.keys.resolved[0] === "CONTACT head: # cm apart" && nd.keys.new[0] === "CONTACT lf: # cm apart"
	&& nd.keys.worse[0] === "CONTACT rhLoose: # cm apart", JSON.stringify(nd));
const stored = run(cup, "motion.compile", { characterId: CHARACTER.id, base: next.specId, install: false });
expect("base without patch: the stored spec again, the same specId, no change", stored.specId === next.specId && stored.delta.resolved + stored.delta.new + stored.delta.worse + stored.delta.better === 0, JSON.stringify(stored.delta));
const chained = run(cup, "motion.compile", { characterId: CHARACTER.id, base: next.specId, patch: [{ op: "test", path: "/checks/contacts/3/name", value: "lf" }, { op: "remove", path: "/checks/contacts/3" }], install: false });
expect("a patched spec is a base too (patches chain)", chained.delta.base === next.specId && chained.delta.resolved === 1 && chained.delta.keys.resolved[0] === "CONTACT lf: # cm apart", JSON.stringify(chained.delta));

// the exact C7 errors
const unknown = refusal(() => cup.run("motion.compile", { characterId: CHARACTER.id, base: "spec-91c2a07d3e15", patch: [{ op: "replace", path: "/frames", value: 30 }] }));
expect("an unknown base: the C7 message", unknown.endsWith('base "spec-91c2a07d3e15" is not known (the editor keeps the last 64 compiled specs this session); send spec'), unknown);
const nine = stand({ keys: Array.from({ length: 9 }, (_, f) => ({ f, set: { yaw: 0 } })), checks: {} });
const nineOut = run(cup, "motion.compile", { characterId: CHARACTER.id, spec: nine, install: false });
const badPath = refusal(() => cup.run("motion.compile", { characterId: CHARACTER.id, base: nineOut.specId,
	patch: [{ op: "replace", path: "/keys/4/f", value: 4 }, { op: "replace", path: "/keys/12/f", value: 112 }] }));
expect("a bad patch path: the C7 message with its index, what is there and how to address it by frame", badPath.includes("patch[1] (replace /keys/12/f): /keys/12 does not exist (keys has 9 entries; by f: /keys/@f=<f>, f 0, 1, 2") && !/MOTION_SPEC_INVALID/.test(badPath), badPath);
expect("spec and base together, and patch without base, are refused", /exactly one of spec or base/.test(refusal(() => cup.run("motion.compile", { characterId: CHARACTER.id, spec, base: first.specId })))
	&& /patch applies to base/.test(refusal(() => cup.run("motion.compile", { characterId: CHARACTER.id, spec, patch: [{ op: "remove", path: "/label" }] }))));

// #1042: a refused spec names its top-level field (telemetry), the message stays the compiler's own
const detailsOf = run => { try { run(); return null; } catch (error) { return error.details; } };
expect("specRefusalPath names a declared spec field only", specRefusalPath("MOTION_SPEC_INVALID: spec.frames must be an integer") === "$.args.spec.frames"
	&& specRefusalPath("keys[3].f = 400 is outside 0..99") === "$.args.spec.keys" && specRefusalPath("spec.madeUp is not a spec field") === "$.args.spec" && specRefusalPath("walkTo: bad arg") === "$.args.spec");
const neither = detailsOf(() => cup.run("motion.compile", { characterId: CHARACTER.id }));
expect("neither spec nor base: the field and rule ride on the refusal", neither?.path === "$.args.spec" && neither?.rule === "variant", JSON.stringify(neither));
expect("neither spec nor base: the message says which was missing", /neither was sent/.test(refusal(() => cup.run("motion.compile", { characterId: CHARACTER.id }))));
const badKey = detailsOf(() => cup.run("motion.compile", { characterId: CHARACTER.id, spec: stand({ keys: [{ f: 9999, set: { yaw: 0 } }], checks: {} }), install: false }));
expect("a refused spec key carries $.args.spec.keys and rule spec", badKey?.path === "$.args.spec.keys" && badKey?.rule === "spec", JSON.stringify(badKey));

// eviction through the registry: 64 more compiles forget the first base
const evictReg = createStudioAppActions(portsFor(CHARACTER, SCENE_OBJECTS));
const plain = stand({ checks: {} });
const oldest = run(evictReg, "motion.compile", { characterId: CHARACTER.id, spec: plain, install: false }).specId;
for (let i = 1; i < SPEC_STORE_SIZE; i++) run(evictReg, "motion.compile", { characterId: CHARACTER.id, spec: { ...plain, label: `v${i}` }, install: false });
const stillKnown = run(evictReg, "motion.compile", { characterId: CHARACTER.id, base: oldest, install: false });
run(evictReg, "motion.compile", { characterId: CHARACTER.id, spec: { ...plain, label: "v64" }, install: false });
const secondOldest = specIdOf({ ...plain, label: "v1" });
expect("registry: the 64th-oldest base is still known; a base read keeps it; the least recently used goes",
	stillKnown.specId === oldest && /is not known/.test(refusal(() => evictReg.run("motion.compile", { characterId: CHARACTER.id, base: secondOldest, install: false }))));

// motion.qa answers the installed take's specId
const installed = run(cup, "motion.compile", { characterId: CHARACTER.id, base: next.specId, install: true });
const measured = run(cup, "motion.qa", { characterId: CHARACTER.id });
const remeasured = run(cup, "motion.qa", { characterId: CHARACTER.id, checks: { contacts: [contact("lh", "joint:LeftHand", "anchor:spot")] } });
expect("motion.qa answers the installed take's specId (with or without its own checks)", measured.specId === installed.specId && measured.specId === specIdOf(takes.get(CHARACTER.id).spec)
	&& remeasured.specId === installed.specId, `${installed.specId} ${measured.specId} ${remeasured.specId}`);
const searched = stand({ checks: {}, anchors: { spot: { kind: "world", p: [{ range: [0.1, 0.3] }, 1, 0.85] } } });
const found = run(cup, "motion.compile", { characterId: CHARACTER.id, spec: searched, install: true });
const takeSpec = takes.get(CHARACTER.id).spec;
expect("a searched spec: specId names the filled-in spec the take stores, and motion.qa agrees", typeof takeSpec.anchors.spot.p[0] === "number" && found.specId === specIdOf(takeSpec)
	&& found.specId !== specIdOf(searched) && run(cup, "motion.qa", { characterId: CHARACTER.id }).specId === found.specId, `${found.specId} ${JSON.stringify(takeSpec.anchors)}`);
const fromSearched = run(cup, "motion.compile", { characterId: CHARACTER.id, base: found.specId, patch: [{ op: "test", path: "/anchors/spot/p/0", value: takeSpec.anchors.spot.p[0] }], install: false });
expect("the stored filled-in spec is the base a patch addresses", fromSearched.specId === found.specId);

// ---- 4b. re-measuring a base (lane H3a): patch: [] or none, install: "never", spec.probes --
const remeasureReg = createStudioAppActions(portsFor(CHARACTER, SCENE_OBJECTS));
const handProbe = [{ name: "hand", distance: ["joint:LeftHand", "anchor:spot"], frames: [0, 23], every: 4 }];
const measuredBase = run(remeasureReg, "motion.compile", { characterId: CHARACTER.id, spec, install: true });
const takeBefore = takes.get(CHARACTER.id);
const emptyPatch = run(remeasureReg, "motion.compile", { characterId: CHARACTER.id, base: measuredBase.specId, patch: [], probes: handProbe, install: false });
const noPatch = run(remeasureReg, "motion.compile", { characterId: CHARACTER.id, base: measuredBase.specId, probes: handProbe, install: false });
const unchanged = o => o.specId === measuredBase.specId && o.delta.resolved + o.delta.new + o.delta.worse + o.delta.better === 0 && o.probes?.hand?.min > 0;
expect("base + patch: [] re-measures the stored spec with new probes (same specId, no delta, probes answered)", unchanged(emptyPatch) && JSON.stringify(emptyPatch.probes) === JSON.stringify(noPatch.probes)
	&& unchanged(noPatch), JSON.stringify({ emptyPatch: [emptyPatch.specId, emptyPatch.delta, emptyPatch.probes] }));
const never = remeasureReg.run("motion.compile", { characterId: CHARACTER.id, base: measuredBase.specId, patch: [], probes: handProbe, install: "never" });
expect("install: \"never\" is install: false (installed false, no affectedIds, the take untouched)", never.output.installed === false && never.affectedIds.length === 0
	&& takes.get(CHARACTER.id) === takeBefore && never.output.probes?.hand?.min > 0, JSON.stringify({ installed: never.output.installed, affected: never.affectedIds }));
// "no" is a spelling of "never" (C19, normalizeCompileArgs); a word that is none is refused
const wrongInstall = refusal(() => remeasureReg.run("motion.compile", { characterId: CHARACTER.id, base: measuredBase.specId, install: "perhaps" }));
expect("any other install string is still refused, and the refusal lists \"never\"", /install must be true, false, "ifClean" or "never", got "perhaps"/.test(wrongInstall), wrongInstall);
const inPatch = run(remeasureReg, "motion.compile", { characterId: CHARACTER.id, base: measuredBase.specId, patch: [{ op: "add", path: "/probes", value: handProbe }], install: false });
expect("spec.probes added by a patch are measured like request probes, and are not part of the spec (same specId)", inPatch.specId === measuredBase.specId
	&& JSON.stringify(inPatch.probes) === JSON.stringify(noPatch.probes), JSON.stringify([inPatch.specId, inPatch.probes]));
const inSpec = run(remeasureReg, "motion.compile", { characterId: CHARACTER.id, spec: { ...spec, probes: handProbe }, install: true });
expect("spec.probes sent inside a spec: measured, and the specId and the stored take spec are the spec without them", inSpec.specId === measuredBase.specId
	&& !("probes" in takes.get(CHARACTER.id).spec) && inSpec.probes?.hand?.min > 0, JSON.stringify([inSpec.specId, Object.keys(takes.get(CHARACTER.id).spec)]));
const both = run(remeasureReg, "motion.compile", { characterId: CHARACTER.id, base: measuredBase.specId, patch: [{ op: "add", path: "/probes", value: [{ name: "head", position: "joint:Head", frames: 0 }] }], probes: handProbe, install: false });
expect("spec.probes join the request's probes", Object.keys(both.probes ?? {}).join() === "hand,head", JSON.stringify(both.probes));

// ---- 4c. the round-2 refusals, replayed verbatim on the cup scene (fixtures/round2-calls.mjs) ---
// a CI runner loaded during one compile (#1187): its clock runs 8x, so a full repair (~4 s here) reads past repair.js's 20 s cap
const realNow = performance.now.bind(performance);
// The cap is a wall-clock guard the product wants; this check is about the bare id, so its two compiles run on a held clock and
// each repair runs all its rounds, whatever the runner's load
const atClock = (now, fn) => { const was = performance.now; performance.now = now; try { return fn(); } finally { performance.now = was; } };
const loaded = fn => atClock(() => realNow() * 8, fn), compileHeld = args => atClock(() => 0, () => replay.run("motion.compile", args));
const replay = createStudioAppActions(portsFor(CHARACTER, SCENE_OBJECTS));
const bare = compileHeld(MOVED_BARE);
const lifted = bare.output.qa.goals?.find(g => g.name === "cup lifted off the table");
const prefixed = structuredClone(MOVED_BARE);
prefixed.spec.goals[1].moved = "object:empty-2";
expect("replay 95b449d7: goals[1].moved \"empty-2\" compiles as object:empty-2 (the cup is lifted; the same specId as the object: form)", lifted?.kind === "moved" && lifted.ok === true
	&& bare.output.specId === loaded(() => compileHeld(prefixed)).output.specId, JSON.stringify(bare.output.qa.goals));
const baseA = run(replay, "motion.compile", { characterId: CHARACTER.id, spec: BASE_REMEASURE, install: false }).specId;
const remeasure = replay.run("motion.compile", { ...REMEASURE, base: baseA });
expect("replay 95b449d7: install \"never\", base + patch: [] + 3 probes answers the probes and installs nothing", remeasure.output.specId === baseA && remeasure.output.installed === false
	&& remeasure.affectedIds.length === 0 && ["fingers", "shoulder", "cup"].every(n => remeasure.output.probes?.[n]?.at?.length === 12), JSON.stringify(remeasure.output.probes).slice(0, 300));
const baseB = run(replay, "motion.compile", { characterId: CHARACTER.id, spec: BASE_PROBES_IN_SPEC, install: false }).specId;
const probesInSpec = replay.run("motion.compile", { ...PROBES_IN_SPEC, base: baseB });
expect("replay c8f2018b: install \"never\" + a patch adding /probes answers both probes, with the base's specId", probesInSpec.output.specId === baseB && probesInSpec.output.installed === false
	&& probesInSpec.output.probes?.["fingers-handle"]?.min >= 0 && probesInSpec.output.probes?.wrist?.at?.length === 10, JSON.stringify(probesInSpec.output.probes).slice(0, 300));

// ---- 5. a cut output continues through motion.report -------------------------------------
const car = createStudioAppActions(portsFor(DRIVER, CAR_OBJECTS));
const wrecked = structuredClone(EXITCAR_SPEC);
wrecked.fix = false;
delete wrecked.checks.allow;
for (const k of wrecked.keys) for (const ch of ["root", "foot_l", "foot_r", "hand_l", "hand_r"]) if (k.set[ch]) k.set[ch] = [k.set[ch][0] - 0.5, k.set[ch][1] - (ch === "root" ? 0.2 : 0), k.set[ch][2]];
const big = run(car, "motion.compile", { characterId: DRIVER.id, spec: wrecked, install: false });
const pages = [];
for (let from = 0; from !== null && pages.length < 50;) {
	const page = run(car, "motion.report", { specId: big.specId, part: "groups", from });
	pages.push(page);
	from = page.next;
}
const all = pages.flatMap(p => p.items), fullShown = big.qa.groups.filter(g => "worst" in g).length;
expect(`a cut output (${bytes(big)} B) says what it cut in more`, bytes(big) <= MOTION_OUTPUT_BUDGET && big.more?.specId === big.specId && big.more.groups > 0, JSON.stringify(big.more));
expect(`motion.report pages every group in full (${pages.length} pages, ${all.length} groups)`, pages.every(p => bytes(p) <= MOTION_OUTPUT_BUDGET && p.specId === big.specId)
	&& all.length === fullShown + big.more.groups && all.every(g => "worst" in g && "severity" in g)
	&& big.qa.groups.every((g, i) => all[i].subject === g.subject) && pages.at(-1).next === null, `${all.length} vs ${fullShown} + ${big.more.groups}`);
const tail = run(car, "motion.report", { specId: big.specId, part: "groups", from: big.qa.groups.length });
expect("motion.report from where the output stopped answers the groups it left out", tail.items[0]?.subject === all[big.qa.groups.length]?.subject || big.qa.groups.length === all.length);
const empty = run(car, "motion.report", { specId: big.specId, part: "probes" });
expect("motion.report of a part with nothing in it: no items, no next", Array.isArray(empty.items) && empty.items.length === 0 && empty.next === null);
expect("motion.report refuses a specId it does not know, with the advice", /specId "spec-000000000000" is not known \(the editor keeps the last 64 compiled specs this session\); compile it again/
	.test(refusal(() => car.run("motion.report", { specId: "spec-000000000000", part: "groups" }))));

if (failures) { console.error(`${failures} motion3 spec store check(s) failed`); process.exit(1); }
console.log("motion3 spec store: all checks passed");
