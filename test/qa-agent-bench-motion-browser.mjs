#!/usr/bin/env node
// Real-model interaction bench S6-S10 (docs/qa/agent-bench.md, "Interaction scenarios"): each scenario opens its
// pre-built scene (test/fixtures/bench) in a fresh Chrome profile of its own, sends its one-line request to the
// Studio Agent, waits for the turn, exports the document and measures the installed take with the bench's
// assertions (test/bench). Scenarios run in parallel, one Chrome each, against one running Studio. One JSON row
// per model x scenario is merged into <out>/<label>.json; a failed scenario is a row, not a crash.
//
// node test/qa-agent-bench-motion-browser.mjs --scenarios S6,S7,S8,S9,S10 --model cliproxy/claude-opus-5-5 \
//   --effort high --url http://127.0.0.1:5180/app/ --cdp 9395 --out /tmp/cozyclay-agent-bench-motion --label baseline
// Options: --headed (visible windows), --keep (leave the Chromes open), --timeout-min N (per turn, default 60).
// Uses a real model and a live Studio; it is not part of npm test.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawnOwned, terminateOwned } from "../tools/process-supervisor.mjs";
import { fixturePath } from "./bench/motion-fixtures.mjs";
import { activeScene, trackOf } from "./bench/motion-track.mjs";
import { SCENARIOS, scoreScenario } from "./bench/motion-scenarios.mjs";

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback; };
const flag = name => process.argv.includes(`--${name}`);
const scenarios = arg("scenarios", Object.keys(SCENARIOS).join(",")).split(",").map(s => s.trim()).filter(Boolean);
const model = arg("model", "cliproxy/claude-opus-5-5"), effort = arg("effort", "high");
const url = arg("url", "http://127.0.0.1:5180/app/"), cdpBase = Number(arg("cdp", "9395"));
const out = arg("out", "/tmp/cozyclay-agent-bench-motion"), label = arg("label", "baseline");
const turnMs = Number(arg("timeout-min", "60")) * 60_000, headed = flag("headed"), keep = flag("keep");
const sessions = process.env.COZYCLAY_AGENT_SESSIONS || `${homedir()}/.config/cozyclay/agent-sessions`;
const chromePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean).find(existsSync);
const modelSlug = model.replace(/[^a-z0-9.]+/gi, "-");
const commit = execFileSync("git", ["log", "-1", "--format=%h", "--abbrev=8"], { encoding: "utf8" }).trim();
const unknown = scenarios.filter(id => !SCENARIOS[id]);
if (unknown.length) throw new Error(`unknown scenarios ${unknown.join(", ")}; known: ${Object.keys(SCENARIOS).join(", ")}`);
if (!chromePath) throw new Error("Google Chrome/Chromium not found; set CHROME_PATH");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (id, ...rest) => console.log(new Date().toISOString().slice(11, 19), id, ...rest);

/** A CDP session on the first page of a Chrome at `port`. */
async function connect(port) {
	const deadline = Date.now() + 30_000;
	for (;;) {
		try {
			const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === "page" && t.webSocketDebuggerUrl);
			if (page) {
				const ws = new WebSocket(page.webSocketDebuggerUrl);
				await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
				let next = 1; const pending = new Map();
				ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
				const send = (method, params = {}) => new Promise(res => { const id = next++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
				const ev = async expr => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "evaluation failed"); return r.result?.result?.value; };
				return { ws, send, ev };
			}
		} catch { /* Chrome is still starting */ }
		if (Date.now() > deadline) throw new Error(`no Chrome page on CDP ${port}`);
		await sleep(300);
	}
}

const waitFor = async (ev, expr, ms) => { for (const t0 = Date.now(); Date.now() - t0 < ms;) { if (await ev(expr).catch(() => false)) return true; await sleep(500); } return false; };
const BUSY = `[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Stop' && b.offsetParent)`;

/** Tool calls, compiles (each motion.compile action, or each one a script names), errors and the last reply of a session. */
function sessionStats(id) {
	const file = `${sessions}/${id}.jsonl`;
	if (!id || !existsSync(file)) return { toolCalls: null, reply: null };
	const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
	const results = new Map(rows.filter(r => r.message?.role === "toolResult").map(r => [r.message.toolCallId, r.message]));
	const calls = rows.filter(r => r.message?.role === "assistant").flatMap(r => (r.message.content ?? []).filter(c => c.type === "toolCall"));
	const byTool = {}; let compiles = 0, errors = 0;
	for (const c of calls) {
		byTool[c.name] = (byTool[c.name] ?? 0) + 1;
		const args = JSON.stringify(c.arguments ?? {}), res = results.get(c.id), text = (res?.content ?? []).map(x => x.text ?? "").join("");
		compiles += c.arguments?.action === "motion.compile" ? 1 : c.name === "script" ? (args.match(/motion\.compile/g) ?? []).length : 0;
		if (res?.isError || /"ok":false/.test(text.slice(0, 300))) errors++;
	}
	const reply = rows.filter(r => r.message?.role === "assistant").map(r => (r.message.content ?? []).filter(x => x.type === "text").map(x => x.text).join("\n").trim()).filter(Boolean).at(-1) ?? null;
	return { toolCalls: calls.length, byTool, compiles, errors, reply };
}

/** Set pieces the agent moved, resized or removed (fixture ids only). */
function setChanges(fixture, doc) {
	const after = new Map((activeScene(doc)?.objects ?? []).map(o => [o.id, o]));
	const moved = (o, a) => a.parent !== o.parent || ["x", "y", "z", "rot", "scaleX", "scaleY", "scaleZ"].some(k => Math.abs((a[k] ?? 0) - (o[k] ?? 0)) > 1e-6);
	return activeScene(fixture).objects.filter(o => !after.has(o.id) || moved(o, after.get(o.id))).map(o => (after.has(o.id) ? o.id : `${o.id} (removed)`));
}

async function runScenario(id, index) {
	const port = cdpBase + index, dir = `${out}/${label}/${id}-${modelSlug}`, started = Date.now();
	mkdirSync(dir, { recursive: true });
	const fixtureText = readFileSync(new URL(`../${fixturePath(id)}`, import.meta.url), "utf8"), fixture = JSON.parse(fixtureText);
	const row = { scenario: id, title: SCENARIOS[id].title, prompt: SCENARIOS[id].prompt, model, effort, label, commit, startedAt: new Date(started).toISOString() };
	const origin = new URL(url).origin;
	const chrome = spawnOwned(chromePath, [...(headed ? [] : ["--headless=new"]), `--remote-debugging-port=${port}`, `--user-data-dir=${dir}/profile-${started}`, "--window-size=1600,1000",
		"--no-first-run", "--no-default-browser-check", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", `${origin}/favicon.ico`], { stdio: "ignore" });
	let cdp = null;
	try {
		cdp = await connect(port);
		const { send, ev } = cdp;
		await send("Page.enable");
		await sleep(800);
		await ev(`localStorage.clear(); localStorage.setItem('cozyclay.project-session.v1', JSON.stringify({ name: ${JSON.stringify(`Bench ${id} ${label}`)}, updatedAt: Date.now() })); true`);
		await send("Page.navigate", { url });
		if (!(await waitFor(ev, "Boolean(window.__cozyclay?.runStudioAction && window.__cozyclayProject?.open && window.__cozyclay?.rigA)", 120_000))) throw new Error("the Studio did not load");
		await sleep(2000);
		const opened = await ev(`window.__cozyclayProject.open(${JSON.stringify(fixtureText)}).then(r => ({ ok: r.ok, problems: r.problems ?? null }))`);
		if (!opened?.ok) throw new Error(`the fixture did not open: ${JSON.stringify(opened)}`);
		await sleep(2500);
		await ev(`(() => { const b = document.querySelector('button.studio-agent-bar') ?? [...document.querySelectorAll('button')].find(b => /Ask the agent|에이전트에게/.test(b.textContent)); b?.click(); return true; })()`);
		await sleep(1200);
		const select = (aria, value) => ev(`(() => { const s = document.querySelector('select[aria-label=${JSON.stringify(aria)}]'); if (!s) return 'missing'; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
		// The model list fills in after the provider answers (slow when several benches load at once): wait for
		// the asked model, and never run a scenario on another model.
		const hasModel = `[...(document.querySelector('select[aria-label="Model"]')?.options ?? [])].some(o => o.value === ${JSON.stringify(model)})`;
		if (!(await waitFor(ev, hasModel, 90_000))) throw new Error(`the model ${model} never appeared in the Model select`);
		row.modelSelected = await select("Model", model);
		if (row.modelSelected !== model) throw new Error(`the Model select kept ${row.modelSelected}, not ${model}`);
		await sleep(400);
		row.effortSelected = await select("Reasoning effort", effort);
		if (effort && row.effortSelected !== effort) throw new Error(`the Reasoning effort select kept ${row.effortSelected}, not ${effort}`);
		const focused = await ev(`(() => { const a = document.querySelector('aside[aria-label="Agent"] textarea') ?? document.querySelector('textarea[placeholder^="Ask the agent"]'); a?.focus(); return !!a; })()`);
		if (!focused) throw new Error("no agent input");
		await send("Input.insertText", { text: SCENARIOS[id].prompt });
		await sleep(300);
		await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
		await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
		const t0 = Date.now();
		log(id, "sent");
		await waitFor(ev, BUSY, 60_000);
		for (;;) {
			await sleep(3000);
			if (!(await ev(BUSY).catch(() => true))) break;
			if (Date.now() - t0 > turnMs) { row.timedOut = true; await ev(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Stop')?.click()`); await sleep(3000); break; }
		}
		row.turnMs = Date.now() - t0;
		row.sessionId = await ev(`localStorage.getItem('cozyclay.agent.session.studio')`);
		let doc = await ev("window.__cozyclayProject.export()");
		while (typeof doc === "string") doc = JSON.parse(doc);
		writeFileSync(`${dir}/doc.json`, JSON.stringify(doc));
		const shot = await send("Page.captureScreenshot", { format: "png" });
		writeFileSync(`${dir}/final.png`, Buffer.from(shot.result.data, "base64"));
		const track = trackOf(doc), score = scoreScenario(id, track);
		const spec = track.ok ? track.spec : null;
		Object.assign(row, sessionStats(row.sessionId), {
			qa: track.ok ? { ok: track.qa.ok, total: track.qa.total } : null,
			goals: spec ? (spec.goals ?? []).map(g => g.name ?? null) : [], setChanged: setChanges(fixture, doc),
			...score, passRate: score.total ? score.passed / score.total : 0,
		});
		log(id, `done in ${(row.turnMs / 60000).toFixed(1)} min: ${score.passed}/${score.total} assertions, QA ${row.qa?.total ?? "-"}`);
	} catch (error) {
		row.error = String(error?.message ?? error).slice(0, 500);
		log(id, "failed:", row.error);
	} finally {
		row.wallMs = Date.now() - started;
		writeFileSync(`${dir}/row.json`, JSON.stringify(row, null, 2));
		cdp?.ws.close();
		if (!keep) await terminateOwned(chrome).catch(() => {});
	}
	return row;
}

mkdirSync(out, { recursive: true });
const rows = await Promise.all(scenarios.map((id, i) => runScenario(id, i)));
const reportPath = `${out}/${label}.json`;
const kept = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")).rows.filter(r => !(r.model === model && scenarios.includes(r.scenario))) : [];
writeFileSync(reportPath, JSON.stringify({ label, updatedAt: new Date().toISOString(), rows: [...kept, ...rows] }, null, 2));
for (const r of rows) console.log(`${r.scenario}\t${r.error ? `ERROR ${r.error}` : `${r.passed}/${r.total} (${Object.entries(r.byKind ?? {}).map(([k, [p, n]]) => `${k} ${p}/${n}`).join(", ")}) qa ${r.qa?.total ?? "-"} compiles ${r.compiles ?? "-"} ${((r.turnMs ?? 0) / 60000).toFixed(1)} min`}`);
console.log("wrote", reportPath);
