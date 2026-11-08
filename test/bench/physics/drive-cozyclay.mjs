#!/usr/bin/env node
// One CozyClay run through the Studio Agent panel (docs/qa/physics-bench.md, PR 4). Runs under tools/qa-browser.mjs
// (CDP_PORT, QA_URL) against a dev server with a fresh config home; run.mjs starts both.
//   node drive-cozyclay.mjs --dir <run dir> --hub <live port> --model cliproxy/claude-opus-5-5 --effort high --timeout-min 60
// Reads <dir>/start.cclayproject and <dir>/request.txt. Opens the document, picks the model and effort in the panel,
// sends the one request, and waits until the agent and every task it dispatched are idle and no session file has
// been written for 20 s (three 5 s polls in a row). Past the limit it presses Stop. Then it saves the document
// (doc.json), the session files, a panel screenshot, and drive.json { sentAt, endAt, timedOut, sessionIds, reply }.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cclayLive, connectPage, openDocument, waitFor } from "./studio.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const dir = arg("dir"), hub = Number(arg("hub")), model = arg("model", "cliproxy/claude-opus-5-5"), effort = arg("effort", "high");
const limitMs = Number(arg("timeout-min", "60")) * 60_000;
const SESS = join(process.env.COZYCLAY_CONFIG_DIR, "agent-sessions");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const PANE = `document.querySelector('aside[aria-label="Agent"]')`;
const BUSY = `[...(${PANE}?.querySelectorAll('button') ?? [])].some(b => b.textContent.trim() === 'Stop' && b.offsetParent)`;
const ACTIVE = `[...document.querySelectorAll(".task-row")].filter(r => ["queued","waiting","starting","running","review"].includes(r.dataset.status)).length`;

const metas = () => (existsSync(SESS) ? readdirSync(SESS).filter(f => f.endsWith(".meta.json")).map(f => { try { return JSON.parse(readFileSync(join(SESS, f), "utf8")); } catch { return null; } }).filter(Boolean) : []);
const lastWrite = id => { try { return statSync(join(SESS, `${id}.jsonl`)).mtimeMs; } catch { return 0; } };
/** The session and every task session below it. */
function family(root) {
	const all = metas(), out = [root];
	for (let i = 0; i < out.length; i++) for (const m of all) if (m.parentId === out[i] && !out.includes(m.sessionId)) out.push(m.sessionId);
	return out;
}

async function select(ev, aria, value) {
	const sel = `${PANE}?.querySelector('select[aria-label=${JSON.stringify(aria)}]')`;
	if (!(await waitFor(ev, `[...(${sel}?.options ?? [])].some(o => o.value === ${JSON.stringify(value)})`, 90_000))) throw new Error(`${aria} ${value} never appeared`);
	return ev(`(() => { const s = ${sel}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
}

const out = { model, effort, timedOut: false };
const page = await connectPage();
try {
	const { send, ev } = page;
	await openDocument(page, JSON.parse(readFileSync(join(dir, "start.cclayproject"), "utf8")));
	for (let t0 = Date.now(); Date.now() - t0 < 60_000; await sleep(1000)) if ((cclayLive(hub, "inspect", "--scope", "entities", "--limit", "32").entities ?? []).some(e => e.id === "char-a" && e.capabilities?.rigReady)) break;
	// the panel docks collapsed ("Agent · Ask the agent..."): open it through the inspector switch or the dock itself
	const INPUT = `${PANE}?.querySelector('textarea')`, SHOWN = `(() => { const a = ${INPUT}; return !!a && a.offsetParent !== null && !a.disabled; })()`;
	await ev(`(() => { const b = document.querySelector('button.inspector-agent-switch[aria-pressed="false"]') ?? [...document.querySelectorAll('button')].find(b => /Ask the agent|에이전트에게/.test(b.textContent)); b?.click(); return true; })()`);
	if (!(await waitFor(ev, SHOWN, 30_000))) throw new Error("the Agent panel did not open");
	out.modelSelected = await select(ev, "Model", model);
	out.effortSelected = await select(ev, "Reasoning effort", effort);
	const request = readFileSync(join(dir, "request.txt"), "utf8").trim();
	await ev(`(() => { ${INPUT}.focus(); return true; })()`);
	await send("Input.insertText", { text: request });
	await sleep(300);
	if ((await ev(`${INPUT}.value.length`)) < request.length) throw new Error("the request did not reach the Agent input");
	await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
	await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
	const t0 = Date.now();
	out.sentAt = t0;
	log("sent");
	if (!(await waitFor(ev, BUSY, 60_000))) throw new Error("the agent never started (no Stop button within 60 s)");
	let root = null, quiet = 0;
	for (;;) {
		await sleep(5000);
		root ??= await ev(`localStorage.getItem('cozyclay.agent.session.studio')`).catch(() => null);
		const busy = await ev(BUSY).catch(() => true), active = await ev(ACTIVE).catch(() => 1);
		const newest = root ? Math.max(...family(root).map(lastWrite)) : 0;
		quiet = !busy && !active && Date.now() - newest > 20_000 ? quiet + 1 : 0;
		if (quiet >= 3) break;
		if (Date.now() - t0 > limitMs) {
			out.timedOut = true;
			log("time limit, pressing Stop");
			await ev(`[...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Stop').forEach(b => b.click())`).catch(() => {});
			await sleep(5000);
			break;
		}
		if ((Date.now() - t0) % 300_000 < 5000) log(`running ${Math.round((Date.now() - t0) / 60000)} min, busy=${busy}, tasks=${root ? family(root).length - 1 : 0}`);
	}
	out.sessionIds = root ? family(root) : [];
	// the quiet window is not work time: the run ends at the newest session write (or at the limit)
	out.endAt = out.timedOut ? t0 + limitMs : Math.min(Date.now(), Math.max(t0, ...out.sessionIds.map(lastWrite)));
	mkdirSync(join(dir, "sessions"), { recursive: true });
	for (const id of out.sessionIds) for (const ext of [".jsonl", ".meta.json"]) { try { copyFileSync(join(SESS, id + ext), join(dir, "sessions", id + ext)); } catch { /* missing */ } }
	out.reply = await ev(`[...document.querySelectorAll('.agent-row.assistant .agent-assistant-text')].map(n => n.innerText.trim()).filter(Boolean).at(-1) ?? null`).catch(() => null);
	let doc = await ev("window.__cozyclayProject.export()");
	while (typeof doc === "string") doc = JSON.parse(doc);
	writeFileSync(join(dir, "doc.json"), JSON.stringify(doc));
	writeFileSync(join(dir, "panel.png"), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
} catch (e) {
	out.error = String(e?.message ?? e).slice(0, 800);
	log("failed:", out.error);
} finally {
	writeFileSync(join(dir, "drive.json"), JSON.stringify(out, null, 1));
	page.close();
}
