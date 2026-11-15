#!/usr/bin/env node
// A page to try the pi harness by hand: type a request, the model writes the scene, the viewer plays it.
//   node --env-file=<cliproxy env> tools/lowvis/pi/try.mjs [--port 5201] [--viewer 5199] [--live 5399] [--model claude-opus-5-5] [--effort medium] [--variant tilt] [--look block]
// Starts the vite dev server for the viewer on --viewer (or uses one that answers there). Each try is a run of
// tools/lowvis/pi/run.mjs named try-<time>; its record is lowvis-out/pi/<name>/run.json.
// The same server answers the Studio's lowvis panel: http://127.0.0.1:<viewer>/app/?lowvis=<port> is the Studio with a
// request box, and a finished try plays on the Studio stage (src/lowvis/studio/). The dev server gets --live as its
// live hub port, so this Studio never joins the hub of another Studio on the default port.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2), opt = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) opt[argv[i].slice(2)] = argv[++i];
const ROOT = resolve(import.meta.dirname, "../../.."), PORT = Number(opt.port ?? 5201), VIEW = Number(opt.viewer ?? 5199);
const MODEL = opt.model ?? "claude-opus-5-5", EFFORT = opt.effort ?? "medium", VARIANT = opt.variant ?? "tilt", LOOK = opt.look ?? "block";
const PI = join(ROOT, "lowvis-out/pi"), running = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const answers = async () => { try { return (await fetch(`http://127.0.0.1:${VIEW}/lowvis/`)).ok; } catch { return false; } };

if (!(await answers())) {
	// tools/dev-full.mjs: the dev server with the Studio's agent sidecar (the Agent box) and its live hub. The sidecar
	// keeps its sessions and sign-ins in a folder of its own, not in the user's CozyClay config. The direct key of the
	// motion writer is listed in its model picker (COZYCLAY_MOTION_DIRECT, bin/agent/motion-engine.mjs).
	const vite = spawn(process.execPath, [join(ROOT, "tools/dev-full.mjs"), "--port", String(VIEW), "--host", "127.0.0.1"],
		{ cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, COZYCLAY_MOTION_DIRECT: "on", COZYCLAY_LIVE_PORT: String(opt.live ?? 5399), COZYCLAY_CONFIG_DIR: process.env.COZYCLAY_CONFIG_DIR ?? join(ROOT, "lowvis-out/studio-config") } });
	process.on("exit", () => vite.kill("SIGTERM"));
	for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
	for (let i = 0; !(await answers()); i++) { if (vite.exitCode !== null || i > 600) throw new Error(`the viewer server did not start on ${VIEW}`); await sleep(100); }
}

const record = name => { const f = join(PI, name, "run.json"); try { return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null; } catch { return null; } };
const state = name => {
	if (running.has(name)) return { name, request: running.get(name).request, state: "running", seconds: Math.round((Date.now() - running.get(name).at) / 1000) };
	const r = record(name);
	if (!r) return { name, state: "unknown" };
	const ok = !!r.final && !(r.infraError && !r.modelCalls);
	return { name, request: r.request, state: ok ? "done" : "failed", seconds: Math.round((r.wallMs ?? 0) / 1000), compiles: r.compiles, report: r.report ?? "", missing: r.missing ?? "", error: r.infraError?.message ?? "",
		viewer: ok ? `http://127.0.0.1:${VIEW}/lowvis/?panels=pi/${name}:${LOOK}` : null };
};
const tries = () => readdirSync(PI).filter(n => n.startsWith("try-")).sort().reverse().slice(0, 30).map(state);

function start(request) {
	const d = new Date(), p = n => String(n).padStart(2, "0"), name = `try-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
	const child = spawn(process.execPath, [join(ROOT, "tools/lowvis/pi/run.mjs"), "--name", name, "--variant", VARIANT, "--model", MODEL, "--effort", EFFORT, request], { cwd: ROOT, stdio: "ignore" });
	running.set(name, { request, at: Date.now() });
	child.on("exit", () => running.delete(name));
	return name;
}

const PAGE = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>lowvis 써 보기</title>
<style>
	:root { --bg: #f6f5f2; --fg: #1f2123; --mute: #6a6e72; --line: #d9d8d3; --card: #ffffff; --accent: #2f5d8a; --pick: #e7eef6; }
	@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #17191b; --fg: #e6e6e3; --mute: #9a9ea2; --line: #33373a; --card: #202325; --accent: #8db4dc; --pick: #1f2c39; } }
	:root[data-theme="dark"] { --bg: #17191b; --fg: #e6e6e3; --mute: #9a9ea2; --line: #33373a; --card: #202325; --accent: #8db4dc; --pick: #1f2c39; }
	body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.6 -apple-system, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; }
	main { max-width: 1200px; margin: 0 auto; padding: 20px 16px 60px; } h1 { font-size: 20px; margin: 0 0 4px; }
	.mute { color: var(--mute); font-size: 13px; }
	form { display: flex; gap: 8px; margin: 14px 0; } textarea { flex: 1; font: inherit; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--fg); min-height: 52px; resize: vertical; }
	button { font: inherit; padding: 6px 16px; border: 1px solid var(--accent); border-radius: 8px; background: var(--accent); color: #fff; cursor: pointer; } button:disabled { opacity: .5; cursor: default; }
	.layout { display: grid; grid-template-columns: 280px minmax(0, 1fr); gap: 14px; } @media (max-width: 800px) { .layout { grid-template-columns: 1fr; } }
	ul { list-style: none; margin: 0; padding: 0; } li { padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); margin-bottom: 6px; cursor: pointer; font-size: 14px; }
	li.on { border-color: var(--accent); background: var(--pick); } li .st { font-size: 12px; color: var(--mute); display: block; }
	iframe { width: 100%; aspect-ratio: 16 / 9; border: 1px solid var(--line); border-radius: 8px; background: #000; }
	.box { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin-top: 10px; font-size: 14px; white-space: pre-wrap; }
</style></head><body><main>
<h1>lowvis 써 보기</h1>
<p class="mute">지금 버전: 사람 데이터 걷기 + 몸 전체 기울이기. 모델 ${MODEL} (effort ${EFFORT}), 블록 인형. 요청 하나에 보통 30초~1분 걸립니다. 화면을 드래그하면 카메라가 돕니다.</p>
<form id="f"><textarea id="q" placeholder="예: 의자로 걸어가서 앉았다가 일어나기"></textarea><button id="go">만들기</button></form>
<div class="layout"><ul id="list"></ul><div><iframe id="view" src="about:blank"></iframe><div id="info" class="box mute">왼쪽에서 하나를 고르거나 새 요청을 입력하세요.</div></div></div>
</main>
<script>
	let pick = null;
	const esc = s => String(s ?? "").replace(/[&<>"]/g, x => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[x]));
	const label = t => t.state === "running" ? "만드는 중 · " + t.seconds + "초" : t.state === "done" ? "완성 · " + t.seconds + "초 · 지시문 " + t.compiles + "번" : t.state === "failed" ? "실패" : "";
	function show(t) {
		pick = t.name; document.querySelectorAll("li").forEach(li => li.classList.toggle("on", li.dataset.name === pick));
		const view = document.getElementById("view"), info = document.getElementById("info");
		if (t.state === "done") { if (view.dataset.src !== t.viewer) { view.src = t.viewer; view.dataset.src = t.viewer; } info.textContent = "모델이 한 말:\\n" + t.report + (t.missing ? "\\n\\n못 한 것: " + t.missing : ""); }
		else { view.src = "about:blank"; view.dataset.src = ""; info.textContent = t.state === "failed" ? "실패했습니다: " + t.error : "만드는 중입니다 (" + t.seconds + "초)."; }
	}
	async function refresh() {
		const list = await (await fetch("/tries")).json();
		document.getElementById("list").innerHTML = list.map(t => '<li data-name="' + t.name + '">' + esc(t.request) + '<span class="st">' + label(t) + '</span></li>').join("");
		document.querySelectorAll("li").forEach(li => li.onclick = () => show(list.find(t => t.name === li.dataset.name)));
		const cur = list.find(t => t.name === pick); if (cur) show(cur);
	}
	document.getElementById("f").onsubmit = async e => {
		e.preventDefault(); const q = document.getElementById("q").value.trim(); if (!q) return;
		const go = document.getElementById("go"); go.disabled = true;
		const r = await (await fetch("/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: q }) })).json();
		go.disabled = false; document.getElementById("q").value = ""; pick = r.name; refresh();
	};
	refresh(); setInterval(refresh, 3000);
</script></body></html>`;

createServer(async (req, res) => {
	// the Studio page on the viewer server calls /tries and /run from its own origin
	const origin = [`http://127.0.0.1:${VIEW}`, `http://localhost:${VIEW}`].includes(req.headers.origin) ? { "access-control-allow-origin": req.headers.origin, "access-control-allow-headers": "content-type", vary: "origin" } : {};
	const send = (code, type, body) => { res.writeHead(code, { "content-type": type, "cache-control": "no-store", ...origin }); res.end(body); };
	if (req.method === "OPTIONS") return send(204, "text/plain", "");
	if (req.method === "GET" && req.url === "/") return send(200, "text/html; charset=utf-8", PAGE);
	if (req.method === "GET" && req.url === "/tries") return send(200, "application/json", JSON.stringify(tries()));
	if (req.method === "POST" && req.url === "/run") {
		let body = ""; for await (const chunk of req) body += chunk;
		let request = ""; try { request = String(JSON.parse(body).request ?? "").trim(); } catch {}
		if (!request) return send(400, "application/json", JSON.stringify({ error: "empty request" }));
		return send(200, "application/json", JSON.stringify({ name: start(request.slice(0, 600)) }));
	}
	send(404, "text/plain", "not found");
}).listen(PORT, "127.0.0.1", () => console.log(`try page: http://127.0.0.1:${PORT}/  studio: http://127.0.0.1:${VIEW}/app/?lowvis=${PORT}  (model ${MODEL} ${EFFORT}, variant ${VARIANT})`));
