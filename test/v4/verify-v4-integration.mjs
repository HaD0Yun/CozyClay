#!/usr/bin/env node
// v4 integration (design 4.3): the real tool set (bin/agent/v4/tool-set.mjs) over a fake turn. The engine's
// createV4Context binds it; run_action goes through the real editor action registry (createStudioAppActions with
// motionV4 in COMMAND_MODULES); the v4_render live query is the real renderV4Sheet over a solid-colour renderer.
// One js cell builds a 48-frame squat with the rig library, then track commit, measure, qa and render run, and the
// installed take is saved (takeSource), reloaded (compileTakeSource with the raw hook) and exported (rawTakeJson).
import { deflateSync } from "node:zlib";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { createStudioAppActions } from "../../src/commands/index.js";
import { takeSource, normalizeTakeSource, compileTakeSource } from "../../src/domains/motion/take-source.js";
import { renderV4Sheet } from "../../src/motion-v4/render/editor-render.js";
import { rawTakeJson } from "../../src/motion-v4/track/take-json.js";
import { createV4Context } from "../../bin/agent/v4/context.mjs";
import { createV4McpServer } from "../../bin/agent/v4/mcp-server.mjs";
import { createV4ToolSet } from "../../bin/agent/v4/tool-set.mjs";
import { V4_SYSTEM_PROMPT } from "../../bin/agent/v4/prompt.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const now = () => performance.now();
const bytes = values => new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
const sameBytes = (a, b) => a.length === b.length && bytes(a).every((v, i) => v === bytes(b)[i]);

const sk = skeletonFor("y-bot-tpose"), B = sk.names.length, F = 48;

// ---- fixtures: the BARBELL set of design 3.2 (as test/v4/verify-v4-track.mjs writes it) ----
const base = { rot: 0, rotX: 0, rotZ: 0, path: null, attach: null, hidden: false, color: "#9e9e9e", footprint: { width: 1, depth: 1 }, height: 1, supportY: 1 };
const BARBELL = [
	{ ...base, id: "barbell", name: "Barbell", renderer: "empty", x: 0, y: 0.225, z: 0.35, scaleX: 1, scaleY: 1, scaleZ: 1, parent: null, footprint: { width: 0, depth: 0 }, height: 0, supportY: 0 },
	{ ...base, id: "barbell-bar", name: "Barbell bar", renderer: "cylinder", x: -1, y: 0.225, z: 0.35, rotZ: -90, scaleX: 0.028, scaleY: 2, scaleZ: 0.028, parent: "barbell" },
	{ ...base, id: "barbell-plate-l", name: "Barbell plate left", renderer: "cylinder", x: 0.77, y: 0.225, z: 0.35, rotZ: -90, scaleX: 0.45, scaleY: 0.06, scaleZ: 0.45, parent: "barbell" },
	{ ...base, id: "barbell-plate-r", name: "Barbell plate right", renderer: "cylinder", x: -0.83, y: 0.225, z: 0.35, rotZ: -90, scaleX: 0.45, scaleY: 0.06, scaleZ: 0.45, parent: "barbell" },
];
const BARBELL_SET_OBJECTS = [
	{ id: "barbell", shape: "group", mass: 60 },
	{ id: "barbell-bar", shape: "cylinder", axis: "x", size: [2, 0.028, 0.028], parent: "barbell" },
	{ id: "barbell-plate-l", shape: "cylinder", axis: "x", size: [0.06, 0.45, 0.45], parent: "barbell" },
	{ id: "barbell-plate-r", shape: "cylinder", axis: "x", size: [0.06, 0.45, 0.45], parent: "barbell" },
];
const character = { id: "char-a", model: "y-bot-tpose", subject: "a person", x: 0, y: 0, z: 0, rot: 0, scale: 1 };

// ---- the editor side: action registry and the v4_render live query ----
const takes = new Map();
const owner = { replace: (id, take) => takes.set(id, take), motionFor: id => takes.get(id) ?? null };
const ports = { state: () => ({ characters: [character], objects: BARBELL, scenes: [], frameCount: 300 }), storeDomain: name => (name === "motion" ? owner : null) };
const registry = createStudioAppActions(ports);
const crc = (() => { const t = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; }); return b => { let c = ~0; for (const x of b) c = t[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; }; })();
function pngDataUrl(data, { width, height }) {
	const chunk = (type, body) => { const head = Buffer.alloc(8), tail = Buffer.alloc(4), tb = Buffer.concat([Buffer.from(type), body]); head.writeUInt32BE(body.length); tail.writeUInt32BE(crc(tb)); return Buffer.concat([head.subarray(0, 4), tb, tail]); };
	const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr.set([8, 6, 0, 0, 0], 8);
	const raw = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y++) Buffer.from(data.buffer, data.byteOffset + (height - 1 - y) * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
	const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
	return `data:image/png;base64,${png.toString("base64")}`;
}
const pngSize = b64 => { const b = Buffer.from(b64.slice(0, 64), "base64"); return b.toString("latin1", 1, 4) === "PNG" ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null; };
const editor = { renderFrameBuffer: (frame, view) => ({ data: new Uint8Array(view.output.width * view.output.height * 4).fill(128), width: view.output.width, height: view.output.height }), encodePng: pngDataUrl };

// ---- the turn: describe, studio tools and the hub, as the engine sees them ----
const actions = [], commands = [];
const studioTools = { internal: { invoke: async (tool, { action, args }) => {
	if (tool !== "run_action") throw new Error(`unexpected studio tool ${tool}`);
	actions.push(action);
	return { receiptId: `receipt-${actions.length}`, ...registry.run(action, args) };
} } };
const hub = { command: async (name, args, handle, options) => {
	commands.push({ name, handle, options });
	if (name !== "v4_render") throw new Error(`unexpected live command ${name}`);
	return renderV4Sheet(args, editor);
} };
const describe = { activeCharacterId: "char-a", characters: [character], objects: BARBELL };
const ctx = createV4Context({ describe, studioTools, hub, workspaceHandle: "ws-1", signal: new AbortController().signal });
const toolSet = await createV4ToolSet(ctx);
const tool = Object.fromEntries(toolSet.tools.map(t => [t.name, t]));
const model = { from: "model" };

{
	expect("registry: motion.v4.install is a registered action in COMMAND_MODULES", registry.list().some(row => row.id === "motion.v4.install" && row.agentHidden === true));
	expect("tool set: js, track, measure, render, qa in that order", toolSet.tools.map(t => t.name).join() === "js,track,measure,render,qa", toolSet.tools.map(t => t.name).join());
	expect("tool set: ctx.track is the store the tools share", typeof ctx.track?.commit === "function" && ctx.track.revision === 0);
	const caps = { js: 9000, track: 2000, measure: 2000, render: 2000, qa: 2000 };
	expect("tool set: descriptions within their caps", toolSet.tools.every(t => t.description.length <= caps[t.name]), JSON.stringify(toolSet.tools.map(t => [t.name, t.description.length])));
	const size = V4_SYSTEM_PROMPT.length + toolSet.tools.reduce((n, t) => n + t.description.length + JSON.stringify(t.inputSchema).length, 0);
	console.log(`  prompt + real descriptions + schemas: ${size} chars`);
	expect("tool set: prompt, descriptions and schemas stay under 38,000 chars", size <= 38000, String(size));
}

// The real SDK registers the real schemas (engine zodShape); the captured handlers are what Claude Code calls.
const handlers = {};
{
	const sdk = await import("@anthropic-ai/claude-agent-sdk");
	const { z } = await import("zod");
	const shapes = {};
	const spy = { tool: (name, description, shape, handler) => { shapes[name] = shape; handlers[name] = handler; return sdk.tool(name, description, shape, handler); }, createSdkMcpServer: sdk.createSdkMcpServer };
	const server = createV4McpServer(spy, toolSet.tools);
	expect("mcp: the real SDK builds the cozyclay server from the five real tools", server?.type === "sdk" && server.name === "cozyclay" && Object.keys(handlers).join() === "js,track,measure,render,qa", JSON.stringify({ type: server?.type, name: server?.name }));
	handlers.parse = (name, args) => z.object(shapes[name]).strict().parse(args);
}

// ---- 1. a js cell builds the squat and stores it through the track host function ----
let payload;
{
	const code = `const T = rig.track(${F});
const base = rig.pose();
const bar = rig.scene.groups.barbell;
T.fill(0, ${F - 1}, f => { const p = rig.clone(base); const t = rig.ease(f / ${F - 1}, "smooth"); rig.move(p, [0, -0.3 * t, 0]); rig.plantFoot(p, "l"); rig.plantFoot(p, "r"); return p; });
T.object("barbell", 0, { pos: bar.pos, R: bar.R });
const stored = await track(T.payload());
const floor = (await measure({ what: ["penetration"] })).tables.penetration.rows.filter(r => r.against === "floor").length;
return { stored, floor, payload: T.payload() };`;
	const t0 = now(), cell = await tool.js.run({ code }, model), ms = now() - t0;
	console.log(`  js cell: ${ms.toFixed(0)} ms`);
	expect("js: the cell runs", cell.data?.ok === true && !cell.isError, cell.text);
	expect("js: track(T.payload()) stores 48 frames as r1", cell.data?.value?.stored?.revision === 1 && cell.data.value.stored.frames === F && ctx.track.revision === 1 && ctx.track.dirty === true, JSON.stringify(cell.data?.value?.stored));
	expect("js: measure from js answers its data (no floor row over 1 cm)", cell.data?.value?.floor === 0, JSON.stringify(cell.data?.value?.floor));
	expect("js: the calls line names track and measure", /calls: track \d+ ms, measure \d+ ms/.test(cell.text), cell.text);
	payload = cell.data?.value?.payload;
}

// ---- 2. the MCP layer keeps the whole payload (the objects map is not stripped) ----
{
	const parsed = handlers.parse("track", JSON.parse(JSON.stringify(payload)));
	expect("mcp: the track schema keeps rot, hips and the objects map of a set", parsed.op === "set" && parsed.rot.length === F * B * 4 && parsed.hips.length === F * 3 && parsed.objects?.barbell?.pos?.length === F * 3 && parsed.objects.barbell.quat.length === F * 4,
		JSON.stringify({ op: parsed.op, rot: parsed.rot?.length, objects: Object.keys(parsed.objects ?? {}) }));
	const info = await handlers.track(handlers.parse("track", { op: "info" }), {});
	expect("mcp: a handler call answers a text block", info.content?.[0]?.type === "text" && /track r1: 48 frames/.test(info.content[0].text) && !info.isError, JSON.stringify(info));
	const bad = await handlers.measure({ from: 40, to: 10 }, {});
	expect("mcp: a tool error becomes an isError result", bad.isError === true && bad.content[0].type === "text", JSON.stringify(bad));
}

// ---- 3. commit installs through the registry ----
let installed;
{
	const commit = await tool.track.run({ op: "commit", label: "integration squat" }, model);
	installed = takes.get("char-a");
	expect("commit: one run_action motion.v4.install with a receipt", actions.join() === "motion.v4.install" && commit.data.receiptId === "receipt-1" && commit.data.frames === F && ctx.track.dirty === false, JSON.stringify({ actions, data: commit.data }));
	expect("commit: the installed take carries spec.raw and 48 frames", installed?.frames === F && installed.spec?.raw?.schema === "cozyclay.raw-track.v1" && installed.spec.label === "integration squat", JSON.stringify(installed?.spec && { ...installed.spec, raw: Boolean(installed.spec.raw) }));
}

// ---- 4. measure: no floor penetration over 1 cm ----
{
	const t0 = now(), m = await tool.measure.run({}, model), ms = now() - t0;
	const floor = m.data.tables.penetration.rows.filter(r => r.against === "floor");
	console.log(`  measure: ${ms.toFixed(0)} ms, ${m.text.length} chars`);
	expect("measure: no floor penetration over 1 cm", floor.length === 0, JSON.stringify(floor.slice(0, 3)));
	expect("measure: both feet hold the floor", ["heel_l", "heel_r"].every(end => m.data.tables.contacts.runs.some(r => r.end === end && r.against === "floor")), JSON.stringify(m.data.tables.contacts.runs.slice(0, 4)));
	expect("measure: text under 6,000 chars", m.text.length <= 6000, String(m.text.length));
}

// ---- 5. qa runs and says information only ----
{
	const t0 = now(), qa = await tool.qa.run({}, model), ms = now() - t0;
	console.log(`  qa: ${ms.toFixed(0)} ms, ${qa.data.total} issues`);
	expect("qa: runs and says it is information only", qa.text.startsWith("QA (information only; it never blocks).") && Number.isInteger(qa.data.total) && !("ok" in qa.data), qa.text.slice(0, 200));
}

// ---- 6. render: one judge sheet through the v4_render live query ----
{
	const t0 = now(), r = await tool.render.run({}, model), ms = now() - t0;
	const size = pngSize(r.images?.[0]?.data ?? "");
	console.log(`  render: ${ms.toFixed(0)} ms, sheet ${size}`);
	expect("render: one image, a PNG of the judge sheet size", r.images?.length === 1 && r.images[0].mimeType === "image/png" && size?.[0] === 2000 && size?.[1] === 1124, `${r.images?.length} ${size}`);
	expect("render: the clean store did not commit again", actions.length === 1 && r.data.committed !== true, JSON.stringify({ actions, committed: r.data.committed }));
	expect("render: the live query went to the turn's workspace with a timeout", commands.length === 1 && commands[0].handle === "ws-1" && commands[0].options?.timeoutMs > 0, JSON.stringify(commands));
}

// ---- 7. save, reload through the raw hook, bench take.json ----
{
	const source = normalizeTakeSource(JSON.parse(JSON.stringify({ ...takeSource(installed, BARBELL), takeId: "t1" })));
	const reloaded = compileTakeSource(source);
	expect("reload: compileTakeSource uses the raw hook and gives the same rot and hips bytes", reloaded && sameBytes(reloaded.rot, installed.rot) && sameBytes(reloaded.hips, installed.hips) && reloaded.frames === F);
	const doc = JSON.parse(JSON.stringify({ app: "cozyclay", kind: "project", version: 5, scenes: { version: 5, activeSceneId: "s1", scenes: [{ id: "s1", objects: BARBELL,
		stage: { characters: [{ ...character, motionTake: { ...takeSource(installed, BARBELL), takeId: "t1" } }] } }] } }));
	const take = rawTakeJson(doc, { characterId: "char-a", objects: BARBELL_SET_OBJECTS, source: { set: "squat" } });
	const rows = take.characters["char-a"]?.bones ?? [];
	expect("take.json: 48 frames of 65 bone matrices", take.frames === F && rows.length === F && rows.every(frame => frame.length === 65 && frame.every(m => m.length === 16)), `${take.frames} ${rows.length}`);
}

await toolSet.close();
if (failures) {
	console.log(`FAIL ${failures} check(s)`);
	process.exit(1);
}
console.log("PASS v4 integration");
