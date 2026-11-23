// The lowvis authoring loop on CozyClay's pi agent loop (pi-agent-core's Agent on a pi-ai model), not on Claude Code.
//   const run = await runScene({ name, request, model, effort, images });   // also written to lowvis-out/pi/<name>/run.json
// The model gets the system prompt (prompt.mjs), the user's request (with the pictures given with it) and one tool, motion (compile-tool.mjs). It has no files.
// Context: the system prompt, the request and the conversation. Only the latest call's images stay in it: older
// tool results are sent as their text. The prompt-cache mark sits on the last assistant message, the last block
// that is the same in the next request, so the conversation before it is read from the cache.
// The model id and effort are the asked ones or the run fails: nothing here falls back to another model or effort.
// A model or proxy error ends the run as an infrastructure error; it is not retried inside the run.
// Safety limits against a runaway loop only (40 motion calls, 30 minutes); a run says when one was hit.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, createModels } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { cliproxyBase, cliproxyLiveModel, cliproxyProvider, fetchModelList } from "../../../bin/agent/cliproxy-provider.mjs";
import { auditCalls } from "./audit.mjs";
import { VARIANTS, features, systemPrompt } from "./prompt.mjs";
import { createCompileTool } from "./compile-tool.mjs";
import { shapedIds } from "./shapes.mjs";
import { lookBody } from "../studio/figure.js";

const ROOT = resolve(import.meta.dirname, "../../..");
export const DEFAULT_MODEL = "claude-fable-5-2", DEFAULT_EFFORT = "medium";
export const SAFETY = Object.freeze({ shots: 40, ms: 30 * 60_000 });
const MAX_IMAGES = 4;
const DROPPED = "[the sheet images of this call are no longer shown: only the latest call's images are kept]";
const round = v => Math.round(v);

const MOTION_PARAMETERS = Type.Object({
	scene: Type.Optional(Type.Object({
		frames: Type.Number(),
		characters: Type.Array(Type.Object({ id: Type.String(), at: Type.Array(Type.Number()), heading: Type.Number() })),
		props: Type.Optional(Type.Array(Type.Object({ id: Type.String(), size: Type.Array(Type.Number()), at: Type.Array(Type.Number()), turn: Type.Optional(Type.Number()), moves: Type.Optional(Type.Boolean()), shape: Type.Optional(Type.String()) }))),
	}, { description: "The scene. Send it in the first call and again only when it changes." })),
	spec: Type.Optional(Type.Record(Type.String(), Type.Array(Type.Any()), { description: "The motion spec: { <characterId or propId>: [[frame, verb, options], ...] }. Send the whole spec when it changes." })),
	look: Type.Optional(Type.Object({
		frames: Type.Optional(Type.Array(Type.Number())), view: Type.Optional(Type.String()), focus: Type.Optional(Type.Union([Type.String(), Type.Object({ joint: Type.String(), of: Type.String() })])), props: Type.Optional(Type.String()),
	}, { description: "Other frames (at most 12), another view (three, side, front, top), a close framing on one id or joint ({ joint, of }), props \"outline\" for props as edges, in place of the default sheet." })),
});
const MOTION_DESCRIPTION = "Compiles the scene and the motion spec, checks the clip and returns the check numbers and contact sheets. Keeps the last scene and spec, so send only what changed.";
const EDIT_PARAMETER = Type.Optional(Type.Record(Type.String(), Type.Array(Type.Any()), { description: "Changes to the kept spec, in place of spec: { <id>: [[frame, verb, options], ...] }. An entry replaces the action of that id with the same frame and verb, or adds it when there is none; [frame, verb, null] removes it." }));
const BODY_CHARACTER = Type.Object({ id: Type.String(), at: Type.Array(Type.Number()), heading: Type.Number(), scale: Type.Optional(Type.Number()), tint: Type.Optional(Type.String()) });
/** The tool parameters of a variant: the edit argument, and a character's scale and tint, only where the variant has them. */
function motionParameters(variant, off = []) {
	const f = features(variant, off), scene = f.body ? Type.Optional(Type.Object({ ...MOTION_PARAMETERS.properties.scene.properties, characters: Type.Array(BODY_CHARACTER) }, { description: MOTION_PARAMETERS.properties.scene.description })) : MOTION_PARAMETERS.properties.scene;
	return f.edit || f.body ? Type.Object({ ...MOTION_PARAMETERS.properties, scene, ...(f.edit ? { edit: EDIT_PARAMETER } : {}) }) : MOTION_PARAMETERS;
}

/** The pi model for `id` on the CLIProxyAPI the environment names. Throws when the proxy does not list the id. */
async function resolveModel(id, env) {
	const key = env.CLIPROXY_API_KEY;
	if (!env.CLIPROXY_BASE_URL || !key) throw new Error("CLIPROXY_BASE_URL and CLIPROXY_API_KEY must be set");
	const listed = (await fetchModelList(`${cliproxyBase({ env })}/v1`, key, "CLIProxyAPI")).map(e => typeof e === "string" ? { id: e } : e).find(e => e?.id === id);
	if (!listed) throw new Error(`the proxy does not list the model ${id}`);
	const provider = await cliproxyProvider({ env }), known = provider.getModels();
	let model = known.find(m => m.id === id), entry = "pi catalogue";
	if (!model) { // the proxy serves an id pi's catalogue does not know yet: the same id, on the wire settings of its family
		model = cliproxyLiveModel(id, listed.owned_by, known);
		if (!model) throw new Error(`no wire format is known for the model ${id} (owner ${listed.owned_by})`);
		entry = "built for this id from pi's newest entry of the same family";
		const all = provider.getModels.bind(provider);
		provider.getModels = () => [...all(), model];
	}
	const models = createModels();
	models.setProvider(provider);
	return { models, model, entry };
}

/** Older tool results as their text: only the latest result that has images keeps them. */
function latestImagesOnly(messages) {
	const hasImage = m => m.role === "toolResult" && Array.isArray(m.content) && m.content.some(c => c.type === "image");
	const last = messages.findLastIndex(hasImage);
	return messages.map((m, i) => i !== last && hasImage(m) ? { ...m, content: [...m.content.filter(c => c.type !== "image"), { type: "text", text: DROPPED }] } : m);
}

/** One cache mark in the conversation, on the last block of the last assistant message (or of the request). */
function markCache(payload) {
	const messages = (payload.messages ?? []).map(m => ({ ...m, content: typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content.map(({ cache_control: _drop, ...block }) => block) }));
	const target = messages.findLast(m => m.role === "assistant") ?? messages.at(-1), block = target?.content.at(-1);
	if (block && block.type !== "thinking" && block.type !== "redacted_thinking") target.content[target.content.length - 1] = { ...block, cache_control: { type: "ephemeral" } };
	return { ...payload, messages };
}

/**
 * Runs one request to its end. Returns the run record (also written to <outDir>/run.json).
 * keepImages: "latest" (default) or "all". log(line) gets one line per event.
 * variant: one of VARIANTS (default "base"): the system prompt and the numbers the model is told (prompt.mjs, compile-tool.mjs).
 * off: the feature flags of the variant switched off by name (prompt.mjs OFF).
 * images: pictures given with the request, [{ data: <base64>, mimeType }], at most MAX_IMAGES. The record keeps their count only.
 * bodies: { <character id>: { scale?, tint? } }: what a character the request names already has (compile-tool.mjs).
 * env.COZYCLAY_FIGURE: the look the Studio draws characters in (src/lowvis/studio/figure.js): its body is the figure at
 * scale 1, which the system prompt states (prompt.mjs systemPrompt body) and the tool builds (compile-tool.mjs figure).
 * shapes: { <prop id>: { h, parts } | null }, the drawn shapes a Studio has (compile-tool.mjs; none given: no Studio);
 * reshape(): async, the ones it has now, asked before each motion call (a failure keeps the last ones). The record keeps
 * the ids of the props each call compiled with a shape (calls.shots[].shapes) and reshape: { ok, failed, error } (the
 * last failure's message).
 * inbox: a steer inbox (bin/agent/steer-inbox.mjs): what the user sends while the run goes reaches the model as a user
 * message between its steps; the inbox is closed when the run ends. The record does not keep these messages.
 * kept: { scene?, spec } of the motion before this one, which the tool starts from (compile-tool.mjs kept): a call may then
 * send only an edit, a scene or a look. A compile whose spec came from it by edits alone logs "kept-spec".
 * onCompiled({ n, scene, spec, clip }): after each compile that went through (after its log line), with the scene and spec
 * it compiled (as the run's final holds them) and the file its clip was just written to (the next compile writes it again).
 */
export async function runScene({ name, request, model: modelId = DEFAULT_MODEL, effort = DEFAULT_EFFORT, keepImages = "latest", variant = "base", off = [], images = [], bodies = {}, kept = null, shapes = null, reshape = null, safety = SAFETY, env = process.env, outDir = join(ROOT, "lowvis-out/pi", name), log = () => {}, onCompiled = () => {}, signal = null, inbox = null }) {
	const secrets = [env.CLIPROXY_API_KEY, env.CLIPROXY_BASE_URL].filter(s => typeof s === "string" && s.length > 3);
	const scrub = text => secrets.reduce((t, s) => t.split(s).join("<redacted>"), String(text));
	if (!VARIANTS.includes(variant)) throw new Error(`variant: want one of ${VARIANTS.join(", ")}, got ${variant}`);
	if (!Array.isArray(images) || images.length > MAX_IMAGES || images.some(i => typeof i?.data !== "string" || !i.data || typeof i?.mimeType !== "string")) throw new Error(`images: want at most ${MAX_IMAGES} of { data: <base64>, mimeType }`);
	const figure = env.COZYCLAY_FIGURE || null, SYSTEM_PROMPT = systemPrompt(variant, off, lookBody(figure), figure), PARAMETERS = motionParameters(variant, off);
	const record = { name, request, images: images.length, variant, off, ...(lookBody(figure) === 1 ? {} : { body: lookBody(figure) }), asked: { model: modelId, effort }, startedAt: new Date().toISOString(), prompt: { systemChars: SYSTEM_PROMPT.length, toolChars: MOTION_DESCRIPTION.length + JSON.stringify(PARAMETERS).length }, keepImages, safety: { ...safety, hit: null }, infraError: null };
	mkdirSync(outDir, { recursive: true });
	const save = () => { writeFileSync(join(outDir, "run.json"), scrub(JSON.stringify(record, null, "\t"))); if (record.infraError) writeFileSync(join(outDir, `infra-error-${record.startedAt.replace(/[:.]/g, "-")}.json`), scrub(JSON.stringify(record, null, "\t"))); return record; };

	let resolved;
	try {
		resolved = await resolveModel(modelId, env);
		if (clampThinkingLevel(resolved.model, effort) !== effort) throw new Error(`the model ${modelId} does not take the effort ${effort}`);
	} catch (error) {
		record.infraError = { at: "setup", message: scrub(error?.message ?? error) };
		return save();
	}
	const { models, model, entry } = resolved;
	record.modelEntry = entry;

	const motion = createCompileTool({ name, outDir, variant, off, bodies, figure, kept, shapes }), t0 = performance.now(), now = () => performance.now() - t0;
	const modelCalls = [], shots = [], transcript = [], byToolCall = new Map(), asked = { ok: 0, failed: 0, error: null }; // asked: the reshape calls
	let open = null, firstCompileMs = null, blocked = 0, agent = null;
	const fail = message => { record.infraError ??= { at: `model call ${open?.n ?? 0}`, message: scrub(message) }; agent?.abort(); };

	const tool = {
		name: "motion", label: "motion", description: MOTION_DESCRIPTION, parameters: PARAMETERS,
		prepareArguments: args => { // a nested value sent as JSON text is read as JSON
			if (!args || typeof args !== "object") return args;
			const out = { ...args };
			for (const k of ["scene", "spec", "look", "edit"]) if (typeof out[k] === "string") { try { out[k] = JSON.parse(out[k]); } catch { /* the schema check names it */ } }
			return out;
		},
		execute: async (toolCallId, params) => {
			if (reshape) try { motion.setShapes(await reshape()); asked.ok++; } catch (error) { asked.failed++; asked.error = scrub(error?.message ?? error); } // the Studio did not answer: the last shapes stay
			const started = now();
			let r;
			try { r = motion.call(params ?? {}); } catch (error) { r = { n: motion.state.calls, status: "rejected", error: `harness error: ${error?.message ?? error}`, text: `harness error (not yours): ${error?.message ?? error}`, images: [], files: [], scene: motion.state.scene, spec: motion.state.spec, shown: null, harnessError: true }; }
			const entry = { n: r.n, toolCallId, status: r.status, error: r.error ? scrub(r.error) : undefined, atMs: round(started), ms: round(now() - started), buildMs: r.buildMs, renderMs: r.renderMs, images: r.images.length, files: r.files, sent: Object.keys(params ?? {}), edit: r.edit, kept: r.kept, lookAsked: params?.look != null, scene: r.scene, spec: r.spec, shown: r.shown, harnessError: r.harnessError, shapes: shapedIds(motion.state.shapes), text: scrub(r.text) };
			shots.push(entry); byToolCall.set(toolCallId, entry);
			if (r.status === "ok") firstCompileMs ??= round(now());
			log(`  motion ${r.n}: ${r.status}${r.error ? ` (${scrub(r.error).slice(0, 120)})` : `, build ${r.buildMs} ms, render ${r.renderMs} ms, ${r.images.length} image(s)`}${r.kept && r.status === "ok" ? `, kept-spec${r.edit ? ` edit ${r.edit.replaced} replaced, ${r.edit.added} added, ${r.edit.removed} removed` : ""}` : ""}`);
			if (r.status === "ok") try { onCompiled({ n: r.n, scene: motion.state.last.scene, spec: motion.state.last.spec, clip: motion.clipFile }); } catch { /* a failing listener never fails the run */ }
			return { content: [{ type: "text", text: r.text }, ...r.images.map(i => ({ type: "image", data: i.data, mimeType: i.mimeType }))], details: { n: r.n, status: r.status } };
		},
	};

	agent = new Agent({
		initialState: { systemPrompt: SYSTEM_PROMPT, model, thinkingLevel: effort, tools: [tool] },
		streamFn: (m, context, options) => { open = { n: modelCalls.length + 1, atMs: round(now()) }; modelCalls.push(open); return models.streamSimple(m, context, options); },
		transformContext: async messages => keepImages === "latest" ? latestImagesOnly(messages) : messages,
		onPayload: payload => {
			const sent = { model: payload?.model, effort: payload?.output_config?.effort ?? null, thinking: payload?.thinking?.type ?? null };
			if (open) open.sent = sent;
			if (sent.model !== modelId || sent.effort !== effort) { fail(`the request would carry model ${sent.model} at effort ${sent.effort}, not the asked ${modelId} at ${effort}`); throw new Error("lowvis harness: the request does not carry the asked model and effort"); }
			return markCache(payload);
		},
		onProviderStreamEvent: event => {
			if (event?.type !== "message_start" || !open) return;
			open.served = event.message?.model ?? null;
			if (open.served && !String(open.served).startsWith(modelId)) fail(`the provider served ${open.served}, not the asked ${modelId}`);
		},
		beforeToolCall: async () => {
			if (motion.state.calls < safety.shots) return undefined;
			record.safety.hit ??= "shots";
			return { block: true, reason: "The harness stops this run here: no more motion calls. Write your report now.", terminate: ++blocked > 1 };
		},
		toolExecution: "sequential", sessionId: `lowvis-pi-${name}-${Date.now()}`, identity: { attribution: null },
	});
	inbox?.attach(agent);
	agent.subscribe(event => {
		if (event.type === "message_end" && event.message.role === "assistant") {
			const msg = event.message, u = msg.usage ?? {}, text = msg.content.filter(c => c.type === "text").map(c => c.text).join("\n").trim();
			const call = open ?? {};
			Object.assign(call, { ms: round(now() - (call.atMs ?? 0)), stopReason: msg.stopReason, input: u.input ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, cacheWrite1h: u.cacheWrite1h ?? 0, output: u.output ?? 0 });
			call.context = call.input + call.cacheRead + call.cacheWrite;
			if (msg.responseModel) call.served = msg.responseModel;
			transcript.push({ modelCall: call.n, text, thinkingChars: msg.content.filter(c => c.type === "thinking").reduce((n, c) => n + (c.thinking?.length ?? 0), 0), shots: msg.content.filter(c => c.type === "toolCall").map(c => ({ toolCallId: c.id, arguments: c.arguments })) });
			if (msg.stopReason === "error") fail(msg.errorMessage ?? "the model call failed");
			log(`model call ${call.n}: ${(call.ms / 1000).toFixed(1)} s, ${msg.stopReason}, context ${call.context}, out ${call.output}${text ? `, text ${text.length} chars` : ""}`);
			open = null;
		}
		if (event.type === "tool_execution_end" && event.isError && !byToolCall.has(event.toolCallId)) { // refused before motion ran: the arguments did not fit the schema, or the safety stop
			const text = scrub((event.result?.content ?? []).filter(c => c.type === "text").map(c => c.text).join(" "));
			const isBlock = record.safety.hit === "shots" && motion.state.calls >= safety.shots;
			shots.push({ n: null, toolCallId: event.toolCallId, status: isBlock ? "blocked" : "rejected", error: text, atMs: round(now()), ms: 0, images: 0, files: [], sent: [], scene: motion.state.scene, spec: motion.state.spec, shown: null, text });
			log(`  motion call refused before it ran: ${text.slice(0, 160)}`);
		}
	});

	const timer = setTimeout(() => { record.safety.hit ??= "time"; agent.abort(); }, safety.ms);
	const stop = () => agent.abort(); // the caller's signal (a Studio turn the user stopped) ends the run like the time limit does
	signal?.addEventListener("abort", stop, { once: true });
	try { if (!signal?.aborted) await (images.length ? agent.prompt(request, images.map(i => ({ type: "image", data: i.data, mimeType: i.mimeType }))) : agent.prompt(request)); } catch (error) { fail(error?.message ?? error); } finally { clearTimeout(timer); signal?.removeEventListener("abort", stop); inbox?.close(); }

	const wallMs = round(now()), sum = k => modelCalls.reduce((n, c) => n + (c[k] ?? 0), 0), contexts = modelCalls.map(c => c.context ?? 0).filter(Boolean);
	const last = transcript.at(-1), finished = last && modelCalls.at(-1)?.stopReason === "stop", finalText = finished ? last.text : null;
	const calls = shots.map((s, i) => ({ ...s, n: s.n ?? `after ${shots[i - 1]?.n ?? 0}` }));
	Object.assign(record, {
		finished: Boolean(finished) && !record.infraError, endedBy: record.infraError ? "infrastructure error" : record.safety.hit ? `safety limit (${record.safety.hit})` : finished ? "the model's report" : `stop reason ${modelCalls.at(-1)?.stopReason ?? "none"}`,
		served: { models: [...new Set(modelCalls.map(c => c.served).filter(Boolean))], effort: null, effortNote: "the response does not expose the effort; the request carried the asked one", sent: modelCalls[0]?.sent ?? null },
		wallMs, firstCompileMs, modelCalls: modelCalls.length, shots: shots.length, compiles: motion.state.compiles,
		modelMs: sum("ms"), toolMs: shots.reduce((n, s) => n + s.ms, 0),
		tokens: { inputFresh: sum("input"), cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite"), cacheWrite1h: sum("cacheWrite1h"), output: sum("output") },
		context: { perCall: modelCalls.map(c => c.context ?? 0), average: contexts.length ? round(contexts.reduce((a, b) => a + b, 0) / contexts.length) : 0, max: Math.max(0, ...contexts) },
		unnecessary: auditCalls(calls),
		final: motion.state.last ? { scene: motion.state.last.scene, spec: motion.state.last.spec, specChars: JSON.stringify(motion.state.last.spec).length, sceneChars: JSON.stringify(motion.state.last.scene).length, frames: motion.state.last.frames, buildMs: motion.state.last.buildMs, checks: motion.state.last.rows.map(({ key, label, value, unit, frame, who, note }) => ({ key, label, value: Math.round(value * 100) / 100, unit, frame, who, note })), clip: motion.clipFile } : null,
		design: transcript[0]?.text || null, report: finalText, missing: finalText ? (/^\s*Missing:\s*(.+)$/im.exec(finalText)?.[1]?.trim() ?? null) : null,
		calls: { model: modelCalls, shots: calls }, transcript, ...(reshape ? { reshape: asked } : {}),
	});
	return save();
}
