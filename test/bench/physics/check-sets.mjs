#!/usr/bin/env node
// PR 1 check (docs/qa/physics-bench.md): every set opens at the same coordinates in both tools.
//   node test/bench/physics/check-sets.mjs [--sets 1,5] [--out dir] [--blender path] [--fbx path] [--port 6300]
// Builds each set's CozyClay document and .blend, opens the documents in a headless Studio (cclay live inspect gives
// each object's world bounds), reads the .blend bounds from build_scene.py, and compares both with the bounds the
// set itself implies. Pass: every object and the character root within 1 mm in both tools. Exit 1 otherwise.
// It also writes each set's two request texts (<id>.request-<tool>.txt) for review. The Studio half runs as
// `--studio-child` under tools/qa-browser.mjs.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cozyclayDoc } from "./build-cozyclay.mjs";
import { loadSets, requestText } from "./sets.mjs";
import { cclayLive, connectPage, laneEnv, openDocument, startStudio, underBrowser } from "./studio.mjs";

const HERE = new URL(".", import.meta.url).pathname, REPO = join(HERE, "../../..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const TOL = 0.001;
const sets = loadSets((arg("sets", "") || "").split(",").filter(Boolean));
const out = arg("out") ?? mkdtempSync(join(tmpdir(), "physics-sets-"));
mkdirSync(out, { recursive: true });

/** The world bounds a set implies, in set axes: a body is centre ± size/2, a group the union of its children. */
function expectedBounds(set) {
	const b = {};
	for (const o of set.objects.filter(o => o.shape !== "group")) b[o.id] = { min: o.center.map((c, i) => c - o.size[i] / 2), max: o.center.map((c, i) => c + o.size[i] / 2) };
	for (const g of set.objects.filter(o => o.shape === "group")) {
		const kids = set.objects.filter(k => k.parent === g.id).map(k => b[k.id]);
		b[g.id] = { min: [0, 1, 2].map(i => Math.min(...kids.map(k => k.min[i]))), max: [0, 1, 2].map(i => Math.max(...kids.map(k => k.max[i]))) };
	}
	return b;
}

const xyz = p => [p.x, p.y, p.z];
const err = (a, b) => Math.max(...[0, 1, 2].map(i => Math.abs(a[i] - b[i])));
const boxErr = (a, b) => (a && b ? Math.max(err(a.min, b.min), err(a.max, b.max)) : Infinity);

async function studioChild() {
	const hub = Number(arg("hub")), page = await connectPage();
	for (const set of sets) {
		const doc = JSON.parse(readFileSync(join(out, `${set.id}.cclayproject`), "utf8"));
		let entities = [], problems;
		try {
			problems = (await openDocument(page, doc)).problems;
			const want = set.objects.map(o => o.id);
			const ready = async () => { entities = cclayLive(hub, "inspect", "--scope", "entities", "--limit", "32").entities ?? []; return want.every(id => entities.some(e => e.id === id)) && entities.some(e => e.id === set.character.id && e.capabilities?.rigReady); };
			for (let t0 = Date.now(); !(await ready()) && Date.now() - t0 < 60_000;) await new Promise(r => setTimeout(r, 1000));
		} catch (e) { problems = String(e.message); }
		writeFileSync(join(out, `${set.id}.studio.json`), JSON.stringify({ problems, entities }, null, 1));
		console.log(set.id, "studio entities", entities.length, problems ? `problems ${JSON.stringify(problems).slice(0, 200)}` : "");
	}
	page.close();
}

async function main() {
	const blender = arg("blender", process.env.BLENDER ?? "/opt/blender-5.2.0-linux-x64/blender");
	const fbx = arg("fbx", join(REPO, "public/models/y-bot-tpose.fbx")), port = Number(arg("port", "6300"));
	for (const set of sets) {
		writeFileSync(join(out, `${set.id}.cclayproject`), `${JSON.stringify(cozyclayDoc(set), null, "\t")}\n`);
		for (const tool of ["cozyclay", "blender"]) writeFileSync(join(out, `${set.id}.request-${tool}.txt`), requestText(set, tool));
		execFileSync(blender, ["-b", "--factory-startup", "--python", join(HERE, "blender/build_scene.py"), "--",
			join(HERE, "sets", `${set.id}.json`), fbx, join(out, `${set.id}.blend`), join(out, `${set.id}.blender.json`)], { stdio: "ignore", timeout: 300_000 });
		if (!existsSync(join(out, `${set.id}.blender.json`))) throw new Error(`${set.id}: build_scene.py wrote no bounds`);
	}
	const env = laneEnv(join(out, "config"), port + 1);
	const studio = await startStudio({ port, env, log: join(out, "dev.log") });
	try {
		const code = await underBrowser({ port, cdpPort: port + 2, env, script: new URL(import.meta.url).pathname,
			args: ["--studio-child", "--hub", String(port + 1), "--out", out, "--sets", sets.map(s => s.id).join(",")], log: join(out, "browser.log") });
		if (code !== 0) throw new Error(`studio child exited ${code}, see ${join(out, "browser.log")}`);
	} finally { await studio.stop(); }
	let worst = 0;
	const rows = [];
	for (const set of sets) {
		const want = expectedBounds(set), bl = JSON.parse(readFileSync(join(out, `${set.id}.blender.json`), "utf8"));
		const st = JSON.parse(readFileSync(join(out, `${set.id}.studio.json`), "utf8")), byId = new Map(st.entities.map(e => [e.id, e]));
		for (const o of set.objects) {
			const s = byId.get(o.id)?.bounds, sb = s && { min: xyz(s.min), max: xyz(s.max) };
			rows.push({ set: set.id, id: o.id, studio: boxErr(sb, want[o.id]), blender: boxErr(bl.objects[o.id], want[o.id]) });
		}
		const sc = byId.get(set.character.id)?.position;
		rows.push({ set: set.id, id: set.character.id, studio: sc ? err(xyz(sc), set.character.position) : Infinity, blender: err(bl.character.position, set.character.position) });
		if (st.problems?.length) rows.at(-1).note = JSON.stringify(st.problems).slice(0, 120);
	}
	for (const r of rows) {
		worst = Math.max(worst, r.studio, r.blender);
		console.log(`${r.set.padEnd(22)} ${r.id.padEnd(18)} studio ${(r.studio * 1000).toFixed(2).padStart(8)} mm  blender ${(r.blender * 1000).toFixed(2).padStart(8)} mm  ${r.studio <= TOL && r.blender <= TOL ? "OK" : "FAIL"} ${r.note ?? ""}`);
	}
	writeFileSync(join(out, "check-sets.json"), JSON.stringify(rows, null, 1));
	console.log(`${sets.length} sets, ${rows.length} rows, worst ${(worst * 1000).toFixed(3)} mm, tolerance ${TOL * 1000} mm: ${worst <= TOL ? "PASS" : "FAIL"} (${out})`);
	process.exit(worst <= TOL ? 0 : 1);
}

if (process.argv.includes("--studio-child")) await studioChild();
else await main();
