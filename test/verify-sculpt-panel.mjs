#!/usr/bin/env node
/**
 * verify-sculpt-panel (#739): the Sculpt mode side panel renders every run state from props
 * alone — idle, running, done and failed — with the controls the run controller relies on.
 *
 * The panel is JSX that imports its stylesheet. A module loader hook hands `.jsx` through
 * Vite's oxc transform (the same one the build uses) and stubs `.css` imports.
 */
import assert from "node:assert/strict";
import { register } from "node:module";

const hook = `
let transform;
export async function initialize({ viteUrl }) { ({ transformWithOxc: transform } = await import(viteUrl)); }
export async function load(url, context, nextLoad) {
	if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
	if (!url.endsWith(".jsx")) return nextLoad(url, context);
	const { readFileSync } = await import("node:fs");
	const { fileURLToPath } = await import("node:url");
	const path = fileURLToPath(url);
	const { code } = await transform(readFileSync(path, "utf8"), path, { lang: "jsx", jsx: { runtime: "automatic" } });
	return { format: "module", source: code, shortCircuit: true };
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, { data: { viteUrl: import.meta.resolve("vite") } });

// locale.js reads localStorage once at import; without one it is English.
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement: h } = await import("react");
const { default: SculptPanel } = await import("../src/panels/SculptPanel.jsx");

const baseRun = { stage: "idle", round: 0, maxRounds: 3, iou: null, targetIou: 0.92, elapsedMs: 0, sheetDataUrl: null, message: null, error: null };
const noop = () => {};
const render = (props) => renderToStaticMarkup(h(SculptPanel, {
	run: baseRun, reference: null, onReference: noop, onStart: noop, onCancel: noop, onPlaceInScene: noop,
	canStart: true, startRefusal: null, sculptName: null, hidden: false, ...props,
}));
const tag = (html, testid) => html.match(new RegExp(`<[a-z]+[^>]*data-testid="${testid}"[^>]*>`))?.[0] ?? null;
const reference = { dataUrl: "data:image/png;base64,AAAA", name: "hero.png" };
const sheet = "data:image/png;base64,BBBB";

/* ---------------------------------------------------------------- idle --- */
{
	const html = render({});
	assert.ok(tag(html, "sculpt-dropzone"), "empty reference shows the drop zone");
	assert.match(html, /Drop or paste a reference image/);
	assert.match(tag(html, "sculpt-dropzone"), /role="button"/);
	assert.match(tag(html, "sculpt-dropzone"), /tabindex="0"/, "drop zone is keyboard reachable");
	assert.match(tag(html, "sculpt-reference-input"), /accept="image\/png,image\/jpeg,image\/webp"/);
	assert.ok(tag(html, "sculpt-start"), "Start shows when idle");
	assert.doesNotMatch(tag(html, "sculpt-start"), /disabled/, "Start is enabled when canStart and no refusal");
	assert.equal(tag(html, "sculpt-cancel"), null, "no Cancel when idle");
	assert.equal(tag(html, "sculpt-progress"), null, "no progress before a run");
	assert.equal(tag(html, "sculpt-sheet-toggle"), null, "no sheet toggle without a sheet");
	assert.match(tag(html, "sculpt-place"), /disabled/, "Place in scene needs a sculpt");
	assert.match(html, /Fix details by chatting with the Agent \(⌘B\) while the sculpt is selected\./);
	assert.equal(tag(html, "sculpt-start-refusal"), null);

	const refused = render({ canStart: false, startRefusal: "Sign in with ChatGPT in the Agent panel first." });
	assert.match(tag(refused, "sculpt-start"), /disabled=""/, "Start is disabled with a refusal");
	assert.match(tag(refused, "sculpt-start"), /aria-describedby="sculpt-start-refusal"/);
	assert.match(refused, /data-testid="sculpt-start-refusal">Sign in with ChatGPT in the Agent panel first\.</);
	assert.match(tag(render({ canStart: true, startRefusal: "Busy" }), "sculpt-start"), /disabled=""/, "a refusal alone disables Start");
	assert.match(tag(render({ canStart: false }), "sculpt-start"), /disabled=""/, "canStart false disables Start");

	const filled = render({ reference });
	assert.equal(tag(filled, "sculpt-dropzone"), null, "a reference replaces the drop zone");
	assert.match(filled, /<img src="data:image\/png;base64,AAAA" alt="Reference: hero\.png"/);
	assert.match(tag(filled, "sculpt-reference-replace"), /aria-label="Replace reference image"/);
	assert.ok(!/<section[^>]*hidden/.test(filled));
	assert.match(render({ hidden: true }), /<section[^>]*hidden=""/, "hidden hides the panel");
	console.log("PASS sculpt panel: idle (drop zone, reference, Start, refusal)");
}

/* ------------------------------------------------------------- running --- */
{
	const html = render({ reference, sculptName: "Hero sculpt", run: { ...baseRun, stage: "score", round: 2, iou: 0.81, elapsedMs: 74_000, sheetDataUrl: sheet, message: "Scoring 4 candidates" } });
	assert.equal(tag(html, "sculpt-start"), null, "no Start while running");
	assert.ok(tag(html, "sculpt-cancel"), "Cancel while running");
	const steps = [...html.matchAll(/<li class="sculpt-step" data-state="(\w+)" data-stage="(\w+)"( aria-current="step")?>/g)].map((m) => [m[2], m[1], Boolean(m[3])]);
	assert.deepEqual(steps, [["measure", "complete", false], ["draft", "complete", false], ["score", "current", true], ["refine", "pending", false]]);
	assert.match(html, /data-testid="sculpt-round">Round 2 \/ 3</);
	assert.match(html, /data-testid="sculpt-iou">0\.810<span class="sculpt-iou-target"> \/ 0\.920</);
	assert.match(html, /role="meter"[^>]*aria-valuenow="0\.81"/);
	assert.match(html, /--sculpt-iou:0\.81;--sculpt-target:0\.92/);
	assert.ok(tag(html, "sculpt-iou-target"), "target marker renders");
	assert.match(html, /data-testid="sculpt-elapsed">1:14</);
	assert.match(html, /Scoring 4 candidates/);
	assert.match(tag(html, "sculpt-sheet-toggle"), /aria-pressed="true"/, "the sheet shows, open, as soon as one exists");
	assert.ok(tag(html, "sculpt-sheet"), "the open sheet renders the image");
	assert.match(tag(html, "sculpt-place"), /disabled/, "no placing while running");
	assert.match(tag(html, "sculpt-reference-replace"), /disabled/, "reference is locked while running");
	console.log("PASS sculpt panel: running (stepper, round, IoU bar + target, Cancel)");
}

/* ---------------------------------------------------- live narration --- */
{
	const since = Date.now() - 42_000;
	const run = {
		...baseRun, stage: "refine", round: 2, iou: 0.742, elapsedMs: 95_000, message: "streamed agent text",
		waiting: { what: "refine", label: "Agent is weighing fixes", since, expectMs: 35_000 },
		history: [{ round: 1, iou: 0.7 }, { round: 1, iou: 0.742 }],
		candidates: [{ label: "limb-spread", iou: 0.77, delta: 0.028 }, { label: "taller-body", iou: 0.75, delta: 0.008 }, { label: "bad", iou: null, delta: null, refused: true }],
		activity: [{ id: 1, atMs: 1000, kind: "step", text: "Measuring the reference outline" }, { id: 2, atMs: 61000, kind: "warn", text: "Recipe refused: parts[ear].roundness. The agent is fixing it." }, { id: 3, atMs: 95000, kind: "score", text: "Scored IoU 0.742 (+0.042)" }],
		outline: { widthToHeight: 0.93, rows: [{ y: 0.1, spans: [[-0.2, -0.05], [0.1, 0.25]] }], box: { left: 0.05, top: 0.02, width: 0.9, height: 0.96, aspect: 1.07 } },
	};
	const html = render({ reference, run });
	const now = tag(html, "sculpt-now");
	assert.match(now, /data-what="refine"/);
	assert.doesNotMatch(now, /data-over/, "42 s against a usual 35 s is still within 1.5x");
	assert.match(html, /Agent is weighing fixes/);
	assert.match(html, /data-testid="sculpt-now-time">4[12]s</, "the wait counts from waiting.since");
	assert.match(html, /usually ~35s/);
	const slow = render({ reference, run: { ...run, waiting: { ...run.waiting, since: Date.now() - 90_000 } } });
	assert.match(tag(slow, "sculpt-now"), /data-over="true"/);
	assert.match(slow, /taking longer than usual/);
	assert.match(html, /aria-label="Match by round: 0\.700, 0\.742"/);
	assert.match(html, /data-testid="sculpt-delta" data-sign="up">\+0\.042</);
	const race = [...html.matchAll(/<li class="sculpt-race-row"([^>]*)>/g)].map((m) => m[1]);
	assert.equal(race.length, 3);
	assert.match(race[0], /data-leader="true"/, "the best candidate leads");
	assert.match(race[2], /data-refused="true"/);
	assert.match(html, /\+0\.028/);
	assert.equal([...html.matchAll(/class="sculpt-log-row" data-kind="(\w+)"/g)].map((m) => m[1]).join(","), "step,warn,score");
	assert.match(html, /<span class="sculpt-log-time">1:35<\/span>/);
	assert.doesNotMatch(html, /streamed agent text/, "the log replaces the raw message line");
	assert.equal([...html.matchAll(/class="sculpt-scan-span"/g)].length, 2, "each measured span is drawn over the reference");
	assert.equal(tag(html, "sculpt-scanline"), null, "no scan line once the outline is in");
	const measuring = render({ reference, run: { ...baseRun, stage: "measure", waiting: { what: "measure", label: "Measuring the reference outline", since: Date.now(), expectMs: 1500 } } });
	assert.ok(tag(measuring, "sculpt-scanline"), "a scan line sweeps the reference while measuring");
	const done = render({ reference, run: { ...run, stage: "done", waiting: null } });
	assert.equal(tag(done, "sculpt-now"), null, "nothing is awaited once done");
	console.log("PASS sculpt panel: live narration (wait line, trail, race, log, scan)");
}

/* ------------------------------------------------------- model picker --- */
{
	const modelPicker = {
		state: "ready", model: "openai-codex/gpt-6-astra", effort: null, onModel: noop, onEffort: noop,
		providers: [
			{ id: "openai-codex", label: "ChatGPT", signedIn: true, models: [{ key: "openai-codex/gpt-6-astra", label: "GPT-6 Astra" }] },
			{ id: "anthropic", label: "Anthropic", signedIn: false, models: [{ key: "anthropic/opus", label: "Opus" }] },
		],
		models: [{ id: "openai-codex/gpt-6-astra", label: "GPT-6 Astra", efforts: ["low", "medium", "high"], defaultEffort: "medium" }, { id: "anthropic/opus", label: "Opus" }],
	};
	const html = render({ reference, modelPicker });
	assert.match(html, /<optgroup label="ChatGPT"><option value="openai-codex\/gpt-6-astra" selected="">GPT-6 Astra<\/option><\/optgroup>/);
	assert.match(html, /<option value="anthropic\/opus" disabled="">Opus — add key<\/option>/, "a provider without a credential lists its models disabled");
	assert.match(html, /<option value="" selected="">Default \(medium\)<\/option><option value="medium">medium<\/option><option value="low">low<\/option><option value="high">high<\/option>/);
	assert.doesNotMatch(tag(html, "sculpt-model-select"), /disabled/);
	const running = render({ reference, modelPicker, run: { ...baseRun, stage: "draft" } });
	assert.match(tag(running, "sculpt-model-select"), /disabled=""/, "the model is locked while a run is out");
	assert.match(tag(running, "sculpt-effort-select"), /disabled=""/);
	assert.match(running, /locked while running/);
	const loading = render({ modelPicker: { state: "loading", providers: [], models: [], model: "" } });
	assert.match(loading, /Loading models…/);
	assert.equal(tag(loading, "sculpt-effort-select"), null, "no effort without a model");
	assert.match(render({ modelPicker: { state: "failed", providers: [], models: [], model: "" } }), /No model available/);
	assert.equal(tag(render({}), "sculpt-model"), null, "no picker without a model list");
	console.log("PASS sculpt panel: model picker (grouped, keyless disabled, effort, locked while running)");
}

/* ---------------------------------------------------------- blueprint --- */
{
	const layout = [{ view: "front", label: "Front", x: 0, y: 0 }, { view: "side", label: "Left side", x: 0.5, y: 0 }];
	const base = { state: "idle", pose: "keep", notes: "", prompt: "Make an orthographic model sheet", sheet: null, error: null, layout, onPose: noop, onNotes: noop, onGenerate: noop, onCancel: noop };
	assert.equal(tag(render({ blueprint: base }), "sculpt-blueprint"), null, "no blueprint step before a reference");
	const idle = render({ reference, blueprint: base });
	assert.match(idle, /Generate blueprint/);
	assert.doesNotMatch(tag(idle, "sculpt-blueprint-generate"), /disabled/);
	assert.match(idle, /<option value="keep" selected="">Pose: as in the reference<\/option><option value="neutral">Pose: neutral rest pose<\/option>/);
	assert.match(idle, /<summary>Request sent to the image model<\/summary><pre>Make an orthographic model sheet<\/pre>/, "the exact request is visible");
	const waiting = render({ reference, blueprint: { ...base, state: "generating", startedAt: Date.now() - 12_000 } });
	assert.ok(tag(waiting, "sculpt-blueprint-wait"));
	assert.match(waiting, /Drawing the four-view sheet/);
	assert.match(waiting, /<span class="sculpt-now-time">1[12]s<\/span>/);
	assert.ok(tag(waiting, "sculpt-blueprint-cancel"));
	assert.equal(tag(waiting, "sculpt-blueprint-generate"), null);
	assert.match(tag(waiting, "sculpt-blueprint-pose"), /disabled=""/, "the pose is locked while drawing");
	const ready = render({ reference, blueprint: { ...base, state: "ready", sheet: { dataUrl: "data:image/png;base64,SHEET", width: 1536, height: 1024, ms: 48_000 } } });
	assert.match(ready, /Generate again/);
	assert.match(ready, /<img src="data:image\/png;base64,SHEET" alt="Generated four-view model sheet"\/>/);
	assert.match(ready, /<span class="sculpt-sheet-tag" style="left:50%;top:0%">Left side<\/span>/, "each view is tagged where the layout puts it");
	assert.match(ready, /1536×1024 · 48s/);
	assert.match(tag(ready, "sculpt-blueprint-download"), /download="sculpt-blueprint.png"/);
	const failed = render({ reference, blueprint: { ...base, error: "This account cannot generate images." } });
	assert.match(failed, /data-testid="sculpt-blueprint-error"[^>]*>This account cannot generate images\.</);
	const refused = render({ reference, blueprint: { ...base, refusal: "Sign in with ChatGPT in the Agent panel to generate a blueprint." } });
	// #970: without a ChatGPT token App passes a refusal and the button is not shown at all; with one it is.
	assert.equal(tag(refused, "sculpt-blueprint-generate"), null, "no Generate button without a ChatGPT token");
	assert.doesNotMatch(refused, /Generate blueprint/);
	assert.ok(tag(refused, "sculpt-blueprint-refusal"));
	assert.ok(tag(idle, "sculpt-blueprint-generate"), "the button is shown when there is no refusal (a ChatGPT token exists)");
	const dropped = render({ reference, blueprint: { ...base, state: "ready", sheet: { dataUrl: "data:image/png;base64,SHEET", width: 1536, height: 1024, notices: ["Back view dropped: No subject found in the reference."] } } });
	assert.match(dropped, /data-testid="sculpt-blueprint-notices"[^>]*>Back view dropped: No subject found in the reference\.</, "a dropped view says so");
	assert.equal(tag(ready, "sculpt-blueprint-notices"), null, "no notice when every view was kept");
	assert.match(tag(render({ reference, blueprint: base, run: { ...baseRun, stage: "draft" } }), "sculpt-blueprint-generate"), /disabled=""/, "no new sheet while a sculpt run is out");
	console.log("PASS sculpt panel: blueprint (pose, notes, visible request, wait, sheet with view tags, errors)");
}

/* ---------------------------------------------------------------- done --- */
{
	const html = render({ reference, sculptName: "Hero sculpt", run: { ...baseRun, stage: "done", round: 1, iou: 0.945, elapsedMs: 41_000, sheetDataUrl: sheet } });
	assert.ok(tag(html, "sculpt-start"), "Start returns when done");
	assert.equal(tag(html, "sculpt-cancel"), null);
	assert.ok([...html.matchAll(/data-state="complete"/g)].length === 4 && !/aria-current/.test(html), "every stage complete, none current");
	assert.match(html, /title="Silhouette match \(IoU\)">Final match</);
	assert.match(html, /data-testid="sculpt-done"[^>]*>Done — IoU 0\.945</);
	assert.match(html, /data-reached="true"/, "IoU at or above target marks the bar reached");
	assert.ok(tag(html, "sculpt-sheet-toggle"));
	const place = tag(html, "sculpt-place");
	assert.doesNotMatch(place, /disabled/, "Place in scene enabled once a sculpt exists");
	assert.match(place, /aria-label="Place Hero sculpt in scene"/);
	console.log("PASS sculpt panel: done (final IoU, Place in scene, sheet toggle)");
}

/* -------------------------------------------------------------- failed --- */
{
	const html = render({ reference, run: { ...baseRun, stage: "failed", round: 1, iou: 0.42, elapsedMs: 9_000, error: "The model returned no recipe." } });
	assert.match(html, /data-testid="sculpt-error"[^>]*>The model returned no recipe\.</);
	assert.match(tag(html, "sculpt-error"), /role="alert"/);
	assert.ok(tag(html, "sculpt-start"), "Start is offered again after a failure");
	assert.equal(tag(html, "sculpt-cancel"), null);
	assert.match(tag(html, "sculpt-place"), /disabled/, "nothing to place without a sculpt");
	assert.ok(!/aria-current/.test(html), "a failed run has no current stage");

	const cancelled = render({ reference, run: { ...baseRun, stage: "cancelled", round: 1 } });
	assert.ok(tag(cancelled, "sculpt-cancelled"));
	assert.ok(tag(cancelled, "sculpt-start"));
	console.log("PASS sculpt panel: failed and cancelled");
}

/* ----------------------------------------------------------- part tree --- */
{
	const tree = [
		{ id: "head", shape: "blob", depth: 0, parent: null, mirror: false },
		{ id: "eye", shape: "blob", depth: 1, parent: "head", mirror: true },
	];
	assert.equal(tag(render({ parts: { tree, selected: null, onSelect: noop } }), "sculpt-part-tree"), null, "no tree without a sculpt");
	const html = render({ sculptName: "Hero sculpt", parts: { tree, selected: { partId: "eye", mirrored: true }, onSelect: noop } });
	assert.ok(tag(html, "sculpt-part-tree"), "a sculpt lists its parts");
	const rows = [...html.matchAll(/<button[^>]*data-testid="sculpt-part-row"[^>]*>/g)].map((match) => match[0]);
	assert.equal(rows.length, 2);
	assert.match(rows[0], /data-part="head"/);
	assert.match(rows[0], /aria-pressed="false"/);
	assert.match(rows[1], /aria-pressed="true"/, "the selected part's row is pressed");
	assert.match(rows[1], /data-mirrored="true"/, "a mirror-copy pick marks the source row");
	assert.match(rows[1], /--sculpt-part-depth:1/, "a child is indented by its depth");
	assert.match(html, /mirror copy/);
	assert.match(html, /blob ×2/, "a mirrored part says it draws twice");
	assert.match(html, />W move · E rotate · R scale</, "a selected part names its gizmo keys");
	assert.match(html, /title="W move · E rotate · R scale \(Shift: uniform\) · Esc to deselect"/);
	assert.equal(tag(html, "sculpt-part-notice"), null, "no notice until the gizmo has one");
	const refused = render({ sculptName: "Hero sculpt", parts: { tree, selected: { partId: "eye", mirrored: false }, onSelect: noop, notice: "Edit refused: Recipe refused at parts[eye].size" } });
	assert.match(refused, /data-testid="sculpt-part-notice"[^>]*>Edit refused: Recipe refused at parts\[eye\]\.size</, "a refused gizmo edit shows its reason");
	// A cutter is never drawn, so its row is listed but cannot be selected for the gizmo.
	const cut = render({ sculptName: "Hero sculpt", parts: { tree: [...tree, { id: "notch", shape: "box", depth: 1, parent: "head", mirror: false, cutter: true }], selected: null, onSelect: noop } });
	const notch = [...cut.matchAll(/<button[^>]*data-testid="sculpt-part-row"[^>]*>/g)].map((match) => match[0]).find((row) => /data-part="notch"/.test(row));
	assert.match(notch, /disabled=""/, "a cutter row is disabled");
	assert.match(notch, /data-cutter="true"/);
	assert.match(notch, /title="A cutter is not drawn: it cuts its parent\. Ask the agent to change it\."/, "the row says why");
	console.log("PASS sculpt panel: part tree");
}
