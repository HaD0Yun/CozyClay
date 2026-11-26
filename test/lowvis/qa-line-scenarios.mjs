// A probe of test/lowvis/qa-install-browser.mjs (QA_PROBE=line): a line (engine-simple/line.js)
// in a real Studio turn with the scripted agent and writer. The writer's scene has a rope tied to a post and held in the
// character's right hand while it walks away; the install makes one object per segment, each moved by the take; the
// scene the next request shows has the rope as one line prop, not its segments, and outside the props' count.
//   QA_PROBE=line QA_PORT=5195 QA_LIVE_PORT=5395 QA_CDP_PORT=9342 node test/lowvis/qa-install-browser.mjs
// Every scene and spec here is made up for this check.
const SEGMENTS = 30;
export async function scenarios({ turn, writer, snapshot, shot, pass, report, assert, evaluate, sleep }) {
	const make = (who, shown) => {
		report.shown = shown.props;
		const scene = { frames: 96, characters: [{ id: who.id, at: [0, 0], heading: -90 }], props: [{ id: "post", size: [0.2, 1.2, 0.2], at: [1.5, 0.6, 0] }, { id: "rope", line: { length: 3, thick: 0.04 }, at: [0.4, 0.8, 0] }] };
		const spec = { rope: [[0, "tie", { at: 3, to: { on: "post", at: [0, 0.6, 0] } }]], [who.id]: [[0, "hold", { prop: "rope", hand: "R", at: 0.2 }], [14, "walk", { to: [-1.2, 0.2] }], [70, "release", { prop: "rope", hand: "R" }]] };
		return { scene, spec };
	};
	writer.plan = { end: "report", make };
	const r = await turn("tie the rope to the post and walk off with its end", [["motion"], ["result"], ["result"]]);
	const done = r.filter(x => x.name === "motion_result" && !x.isError && x.value.draft !== true).at(-1)?.value;
	assert.equal(done?.installed, true, `installed: ${JSON.stringify(done).slice(0, 1500)}`);
	const s = await snapshot(), segs = s.objects.filter(o => /^rope~\d{2}$/.test(o.name)), take = s.characters.find(c => c.take)?.take;
	assert.equal(segs.length, SEGMENTS, "one object per segment");
	report.objects = s.objects.length; report.segments = segs.length; report.takeChars = take?.chars;
	pass(`install: the 3 m rope is ${segs.length} segment objects in the saved scene document, moved by the take (${take?.chars} chars)`);
	for (const t of [0, 40, 80]) {
		await evaluate(`window.__cozyclay.setFrame(${t})`); await sleep(400);
		await shot(`line-f${t}`);
	}
	pass("shots: line-f0, line-f40, line-f80");
	// the scene the next request shows: the rope as one line, not as segments
	writer.plan = { end: "report", make };
	await turn("make the rope a bit longer", [["motion"], ["result"], ["result"]]);
	const lines = report.shown.filter(p => p.line), pieces = report.shown.filter(p => /~\d{2}$/.test(p.id));
	assert.equal(pieces.length, 0, "no segment is told as a prop");
	assert.deepEqual(lines.map(p => [p.id, p.line.length, p.line.thick]), [["rope", 3, 0.04]], `the rope is told as one line: ${JSON.stringify(lines)}`);
	const again = await snapshot();
	assert.equal(again.objects.filter(o => /^rope~\d{2}$/.test(o.name)).length, SEGMENTS, "a second install moves the same segments, makes none more");
	report.objectsAfter = again.objects.length;
	pass(`read back: the rope is one line prop ${JSON.stringify(lines[0])}; a second install keeps ${SEGMENTS} segments (${again.objects.length} objects in all)`);
}
