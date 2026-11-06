// Bench: each spec x mode (base = compiler only; fill modes through the main fill route) x reps -> layer 1 + layer 2 metrics.
// usage: MAIN=<tree> node bench.mjs <out.json> [modes] [reps] [specs]
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
const M = process.env.MAIN;
const { compileSpec } = await import(M + "/src/motion3/pipeline.js");
const { skeletonFor } = await import(M + "/src/motion3/rigs/index.js");
const { motionScene } = await import(M + "/src/motion3/scene.js");
const { fillRequest } = await import(M + "/mcp/motionbricks/service.mjs");
const { runCompileJob } = await import(M + "/src/motion3/compile-job.js");
const SET = process.env.SET ?? "set";
process.on("unhandledRejection", e => console.error("UNHANDLED", e));
const [outFile, modesArg = "base,fill,exact,playground", repsArg = "3", specsArg] = process.argv.slice(2);
const MODES = modesArg.split(","), REPS = Number(repsArg);
const names = specsArg ? specsArg.split(",") : readdirSync(SET).filter(f => f.endsWith(".json")).map(f => f.slice(0, -5));
const OVER = /^(COLLIDE|BODY|SELF|FACE)$/;
const isFill = k => typeof k.src === "string" && k.src.startsWith("fill");
function metrics(r, authored) {
	const by = {}; for (const g of r.qa.groups) by[g.kind] = (by[g.kind] ?? 0) + (g.count ?? 1);
	const sum = re => Object.entries(by).filter(([k]) => re.test(k)).reduce((a, [, v]) => a + v, 0);
	let reach = 0, reachAt = null;
	for (const k of authored) for (const ch of ["root", "foot_l", "foot_r", "hand_l", "hand_r"]) {
		const want = k.set?.[ch], got = r.out.baked?.[ch]?.[k.f];
		if (!Array.isArray(want) || !Array.isArray(got)) continue;
		const d = Math.hypot(want[0] - got[0], want[1] - got[1], want[2] - got[2]); if (d > reach) { reach = d; reachAt = `${ch}@f${k.f}`; }
	}
	const L = r.observations?.life ?? {};
	return { qaTotal: r.qa.total, groups: r.qa.groups.length, overlap: sum(OVER), slide: sum(/^SLIDE$/), pop: sum(/^(POP|FLIP)$/), float: sum(/^FLOAT$/), held: sum(/^HELD_OBJECT_DRIFT$/),
		keyGoal: sum(/^(KEY|GOAL)$/), other: r.qa.total - sum(/^(COLLIDE|BODY|SELF|FACE|SLIDE|POP|FLIP|FLOAT|HELD_OBJECT_DRIFT|KEY|GOAL)$/), byKind: by,
		reachCm: +(reach * 100).toFixed(1), reachAt, sync: L.sync?.[0] ?? null, jerkP95: L.jerk?.[0] ?? null, jerkSpikes: L.jerk?.[2] ?? null, twinArms: L.arms?.[0] ?? null, twinLegs: L.legs?.[0] ?? null,
		dead: L.dead?.[0] ?? null, lead: L.lead?.[0] ?? null, flags: L.flags ?? [], frames: r.out.frameCount };
}
const rows = [];
for (const name of names) {
	const t = JSON.parse(readFileSync(`${SET}/${name}.json`, "utf8"));
	const sk = skeletonFor(t.rig), scene = motionScene(t.scene);
	const spec = { ...t.spec, keys: (t.spec.keys ?? []).filter(k => !isFill(k) && k.src !== "pass") };
	const authored = spec.keys;
	for (const mode of MODES) for (let rep = 0; rep < (mode === "base" ? 1 : REPS); rep++) {
		const t0 = Date.now();
		try {
			let s = spec, fill = null;
			if (mode !== "base") {
				const args = { spec, objects: t.scene, model: t.rig };
				if (mode === "exact") args.timing = "exact"; else if (mode === "playground") args.timing = "playground"; else if (mode === "free") args.timing = "free"; else if (mode === "retime") args.timing = "retime";
				else if (mode.startsWith("cand")) Object.assign(args, JSON.parse(process.env[mode.toUpperCase()] ?? "{}"));
				const f = await fillRequest(args); s = f.spec;
				const gaps = f.gaps ?? [];
				fill = { gaps: gaps.length, filled: gaps.filter(g => g.keys !== undefined && !g.dropped).length, skipped: gaps.filter(g => g.skipped).length, dropped: gaps.filter(g => g.dropped).length,
					wants: gaps.filter(g => g.modelWants && g.f).map(g => [g.f[1] - g.f[0], g.modelWants]), fillKeys: s.keys.filter(isFill).length, guides: f.guides?.length ?? null, fillMs: f.ms ?? null, dropReasons: gaps.filter(g => g.dropped || g.skipped).map(g => String(g.dropped ?? g.skipped)) };
			}
			const r = compileSpec(s, { sk, scene });
			const raw = metrics(r, authored);
			// what the user gets: motion.compile's install path (repair 2 rounds + thinning; playground installs without both, motion3-fill.js)
			// mirrors motion3-fill.js: playground installs without repair or thinning; with NATIVE_NOTHIN=1 every native fill skips thinning
			const playground = mode === "playground", nativeFill = mode !== "base" && mode !== "fill" && process.env.NATIVE_NOTHIN === "1";
			const j = runCompileJob({ model: t.rig, scene, spec: s, repair: playground ? undefined : { rounds: 2 }, installing: true, thin: playground || nativeFill ? false : undefined, hintLimitMs: 0 });
			const ri = compileSpec(j.stored, { sk, scene });
			rows.push({ name, mode, rep, ms: Date.now() - t0, fill, ...raw, inst: metrics(ri, authored) });
		} catch (e) { rows.push({ name, mode, rep, ms: Date.now() - t0, error: String(e.message).slice(0, 200) }); }
		const x = rows.at(-1); console.log(name, mode, rep, x.error ?? `qa ${x.qaTotal} ov ${x.overlap} slide ${x.slide} pop ${x.pop} reach ${x.reachCm} sync ${x.sync} spikes ${x.jerkSpikes} | inst qa ${x.inst?.qaTotal} ov ${x.inst?.overlap} slide ${x.inst?.slide} sync ${x.inst?.sync} spikes ${x.inst?.jerkSpikes} | fill ${JSON.stringify(x.fill)}`);
	}
}
writeFileSync(outFile, JSON.stringify(rows, null, 1));
