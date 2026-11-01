// motion.fill: MotionBricks generates the transition between two poses (free spans) in each gap between the authored key poses of a spec (src/motion3/bricks/fill.js), then the
// filled spec runs the motion.compile path (compile, QA, install) and answers as it does. The model runs on onnxruntime-node,
// so the authored spec goes to the dev server's agent routes (POST /agent/motion-fill, mcp/motionbricks/service.mjs); a static
// build has no such server and the action says so instead of waiting.
import { fail, characterOf } from "./shared.js";
import { specIdOf } from "../motion3/spec-store.js";
import { MOTION_ACTION_HELP as HELP } from "../motion3/docs.js";
import { isFillKey } from "../motion3/bricks/fill-src.js";
import { expandPoses } from "../motion3/poses.js";
import { skeletonFor } from "../motion3/rigs/index.js";
import { applyPatch } from "../motion3/json-patch.js";

const id = { type: "string", minLength: 1 };
const openObject = { type: "object", properties: {}, required: [], additionalProperties: true };
const FILL_TIMEOUT_MS = 90000;

export const declarations = Object.freeze([
	{ id: "motion.fill", label: "Fill transition between two poses", kind: "job", domain: "motion", timeoutMs: 240000, description: HELP.fill,
		input: { type: "object", properties: { characterId: id, spec: openObject, base: { type: "string", pattern: "^spec-[0-9a-f]{12}$" },
			patch: { type: "array", items: openObject, maxItems: 64 }, at: { type: "integer", minimum: 0 }, timing: { type: "string", enum: ["exact", "free", "retime", "playground"] }, gate: { type: "boolean" }, install: { oneOf: [{ type: "boolean" }, { const: "ifClean" }, { const: "never" }], default: true } },
		required: ["characterId"], additionalProperties: false } },
	{ id: "motion.primitive", label: "Vault or jump over a block (MotionBricks Smart Primitive)", kind: "job", domain: "motion", timeoutMs: 240000, description: HELP.primitive,
		input: { type: "object", properties: { characterId: id, objectId: id, kind: { type: "string", enum: ["vault", "jump"] }, hand: { type: "string", enum: ["left", "right"] }, lane: { type: "number" },
			install: { oneOf: [{ type: "boolean" }, { const: "ifClean" }, { const: "never" }], default: true } }, required: ["characterId", "objectId", "kind"], additionalProperties: false } },
]);

const NO_SERVER = "MotionBricks fill needs the local dev server (npm run dev): this Studio has no Node side to run the model.";

/** POST the authored spec to the dev server; the filled spec, or a StudioProtocolError. */
async function requestFill(fetcher, body, route = "/agent/motion-fill") {
	let res;
	try {
		res = await fetcher(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(FILL_TIMEOUT_MS) });
	} catch (error) {
		fail("CAPABILITY_MISSING", `${NO_SERVER} (${error.name === "TimeoutError" ? "no answer in 90 s" : error.message})`);
	}
	const answer = await res.json().catch(() => null);
	if (!answer) fail("CAPABILITY_MISSING", `${NO_SERVER} (HTTP ${res.status})`);
	if (!res.ok) fail(answer.error?.code === "INVALID_ARGUMENT" ? "INVALID_ARGUMENT" : answer.error?.code === "TARGET_NOT_READY" ? "TARGET_NOT_READY" : "CAPABILITY_MISSING",
		answer.error?.message ?? (res.status === 503 ? NO_SERVER : `motion fill failed (HTTP ${res.status})`));
	return answer;
}

const MAX_LINES = 6;
const more = (list, line) => (list.length > MAX_LINES ? [...list.slice(0, MAX_LINES - 1).map(line), `${list.length - MAX_LINES + 1} more`] : list.map(line));
const authoredFrames = sp => [...new Set((sp?.keys ?? []).filter(k => !isFillKey(k)).map(k => k.f))].sort((a, b) => a - b);
/**
 * The fill's answer cut to a few short lines (the receipt is 8 KiB and the compile output takes most of it): mode, calls, keys, ms,
 * one line per gap, the authored keys the fill moved (retime, playground) and the guides, at most MAX_LINES of each. Exported for the test.
 */
export function fillBrief(filled, source) {
	const gap = g => (g.kept ? `f${g.f.join("-")} kept` : g.skipped ? `f${g.f.join("-")} skipped (${g.skipped})` : `${g.f ? `f${g.f.join("-")}` : `to f${g.key}`} ${g.tokens} tokens, ${g.targets} target${g.targets === 1 ? "" : "s"}${g.modelWants ? `, model wants ${g.modelWants.exact ?? g.modelWants}` : ""}${g.early ? `, early ${g.early}` : ""}`);
	const was = authoredFrames(source), now = authoredFrames(filled.spec);
	// a playground fill drops its middle keys (guides): then only the last key is paired
	const moved = (was.length === now.length ? was.map((f, i) => [f, now[i]]) : [[was.at(-1), now.at(-1)]]).filter(([a, b]) => a !== b);
	const keys = filled.spec.keys.filter(k => isFillKey(k)).length;
	return { ...(filled.mode ? { mode: filled.mode } : {}), calls: filled.calls, keys, ...(filled.ms === undefined ? {} : { ms: filled.ms }), gaps: more(filled.gaps ?? [], gap),
		...(moved.length ? { moved: more(moved, ([a, b]) => `f${a} -> f${b}`) } : {}), ...(filled.guides?.length ? { guides: more(filled.guides, g => `f${g.authored} reached f${g.at}`) } : {}),
		...(filled.skipped?.length ? { skipped: filled.skipped.length } : {}), ...(filled.dropped ? { dropped: Array.isArray(filled.dropped) ? filled.dropped.length : filled.dropped } : {}),
		...(filled.passThrough ? { passThrough: Array.isArray(filled.passThrough) ? filled.passThrough.length : filled.passThrough } : {}),
		...(filled.notes?.length ? { notes: more(filled.notes, String) } : {}), ...(filled.warnings?.length ? { warnings: more(filled.warnings, w => (typeof w === "string" ? w : JSON.stringify(w)).slice(0, 160)) } : {}) };
}

/** The spec motion.fill fills: spec, or base (a compiled specId, or the installed take's). Exported for the argument test. */
export function fillSource({ spec, base }, specOf, installedSpec) {
	if ((spec === undefined) === (base === undefined)) fail("INVALID_ARGUMENT", "Send exactly one of spec or base (the specId of a compiled spec).");
	const source = spec ?? specOf(base) ?? (specIdOf(installedSpec ?? null) === base ? installedSpec : null)
		?? fail("INVALID_ARGUMENT", `base "${base}" is not known (the editor keeps the last compiled specs this session); send spec`);
	if (!Array.isArray(source.keys) || new Set(source.keys.filter(k => !isFillKey(k)).map(k => k?.f)).size < 2)
		fail("INVALID_ARGUMENT", "motion.fill needs at least 2 authored key poses in spec.keys (keys without src: \"fill\"); a gap is filled between neighbours.");
	return structuredClone(source);
}

/**
 * motion.compile's automatic fill: a spec with 2+ authored key poses and no skills or generators is filled by MotionBricks
 * before it compiles, only when spec.fill is true (off by default). In the browser only (the dev server runs the model); without it, or on any
 * refusal, the spec compiles as written with a note in output.fill. Answers { spec, fill } at once when nothing is sent.
 */
export function autoFill(ports, character, spec) {
	const fetcher = ports.fetch ?? (typeof window === "undefined" ? null : globalThis.fetch);
	const authored = Array.isArray(spec?.keys) ? new Set(spec.keys.filter(k => !isFillKey(k)).map(k => k?.f)).size : 0;
	// off unless the spec asks with fill: true (option A: every K/L/M2 bench filled by default; the fill reached installed takes only on sit)
	if (!fetcher || spec?.fill !== true || authored < 2) return { spec, fill: null };
	if (spec.use?.length || spec.generators?.length) return { spec, fill: { note: "a spec with use or generators is not filled (skills own their frames); key poses only, or motion.fill" } };
	return requestFill(fetcher, { spec, model: character.model, auto: true, objects: ports.state?.().objects ?? [] }).then(
		filled => ({ spec: filled.spec, fill: { gaps: filled.gaps, calls: filled.calls, keys: filled.spec.keys.filter(k => isFillKey(k)).length, ...(filled.passThrough ? { passThrough: filled.passThrough } : {}), ...(filled.promoted ? { promoted: filled.promoted } : {}), ...(filled.skipped ? { skipped: filled.skipped } : {}), spans: filled.spans, ...(filled.dropped ? { dropped: filled.dropped } : {}), ...(filled.notes ? { notes: filled.notes } : {}), ...(filled.warnings ? { warnings: filled.warnings } : {}) } }),
		error => ({ spec, fill: { note: `MotionBricks fill did not run (${error.message}); compiled with the default interpolation` } }));
}

export function register(registry, ports) {
	const mounted = () => Boolean(ports.storeDomain?.("motion")) || "The motion owner is not mounted.";
	registry.register({ ...declarations[0], available: mounted, target: args => args.characterId, async run({ characterId, spec, base, patch, at, timing, gate, install = true }, context) {
		const character = characterOf(ports, characterId);
		if (patch !== undefined && base === undefined) fail("INVALID_ARGUMENT", "patch applies to base, the specId of a compiled spec; send base with it.");
		// base + patch (a few ops: a key's pose, a frame) re-fills the patched spec instead of the agent writing it out again
		const sent = fillSource({ spec, base }, b => registry.motionSpecOf?.(b), ports.storeDomain("motion")?.motionFor(characterId)?.spec);
		let patched = sent;
		if (patch?.length) try { patched = applyPatch(sent, patch, []); } catch (error) { fail("INVALID_ARGUMENT", error.message.replace(/^MOTION_SPEC_INVALID:\s*/, "")); }
		const source = expandPoses(patched, skeletonFor(character.model));
		const filled = await requestFill(ports.fetch ?? globalThis.fetch, { spec: source, model: character.model, objects: ports.state?.().objects ?? [], ...(at === undefined ? {} : { at }), ...(timing ? { timing } : {}), ...(gate === undefined ? {} : { gate }) });
		// the brief rides in the compile's own output (fitted to the receipt budget with it); the playground fill is kept as generated: no repair or thinning
		const fill = fillBrief(filled, source);
		const r = await registry.get("motion.compile").run({ characterId, spec: filled.spec, install, filled: fill, ...(filled.mode === "native-playground" ? { repair: false, thin: false } : {}) }, context);
		return { ...r, summary: `${r.summary}${fill.mode ? ` Fill ${fill.mode}, ${fill.keys} keys.` : ""}${fill.moved ? ` The fill moved authored keys ${fill.moved.join(", ")}.` : ""}` };
	} });
	// a Smart Primitive's take is the runner's dense spec (it holds its own contacts and block clearance): compiled as is, no repair or thinning
	registry.register({ ...declarations[1], available: mounted, target: args => args.characterId, async run({ characterId, objectId, kind, hand, lane, install = true }, context) {
		characterOf(ports, characterId);
		const made = await requestFill(ports.fetch ?? globalThis.fetch, { kind, objectId, lane, hand, objects: ports.state?.().objects ?? [] }, "/agent/motion-primitive");
		const r = await registry.get("motion.compile").run({ characterId, spec: { ...made.spec, fix: false }, install, repair: false, thin: false, filled: { mode: `primitive-${kind}`, calls: 0, keys: made.spec.keys.length, gaps: [], ...made.report } }, context);
		return { ...r, summary: `${r.summary} Smart Primitive ${made.report.seq}: over the block at f${made.report.actionAtFrame ?? "?"}, ${made.report.frames} frames.` };
	} });
}
