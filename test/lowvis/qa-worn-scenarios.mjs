// A probe of test/lowvis/qa-install-browser.mjs (QA_PROBE=worn): objects a joint carries, in a real Studio turn with the
// scripted agent and writer. A hat rides the Head all clip (attached at the install); a badge rides the chest, then goes
// to the Head (a tracked object). With the draft the agent is told which drawn body part carries each, its size and the
// box it spans in the object's frame; a look edit and the install answer the gap between that drawn part and the drawn
// look: how far apart, or how deep the look is in the part (a look round the part is at it), also after the hat's place
// on its bone is set by hand. Every number is computed again here from the meshes the page draws (the figure's own
// part on that joint and the object's meshes), with box distances of this file's own, not the gap query's.
//   COZYCLAY_FIGURE=cube QA_PROBE=worn [QA_WORN_SCALE=0.5|3] node test/lowvis/qa-install-browser.mjs
// QA_WORN_SCALE: the character's scale (default 1); the objects and places grow with it, the hat sinks 42 mm at any scale.
import { LOOK_SOLIDS } from "../../src/lowvis/looks/solids.js";
import { lookBody } from "../../src/lowvis/studio/figure.js";

const S = Number(process.env.QA_WORN_SCALE || 1), FIGURE = process.env.COZYCLAY_FIGURE || "block", JOINT = { Head: 4, Spine2: 2 };
// the drawn head's top over the Head joint: off the look's own solids, at the look's body
const TOP = S * lookBody(FIGURE) * Math.max(...LOOK_SOLIDS[FIGURE]().filter(o => o.joint === JOINT.Head).flatMap(o => o.v.map(p => p[1])));
const HAT = [0.24, 0.08, 0.26].map(v => v * S), BADGE = [0.06, 0.06, 0.02].map(v => v * S);
const slab = (size, base) => ({ version: 1, parts: [{ id: "slab", shape: "box", size, position: [0, base + size[1] / 2, 0], roundness: 0 }] });
const brim = lift => slab([0.26 * S, 0.05 * S, 0.28 * S], lift);

/** The page's own reading at the frame it shows: the largest drawn mesh on joint `joint` of the character's look and the
 *  object's drawn meshes, each as a box (its geometry's bounds, as drawn) in the object's own frame (its base pivot and
 *  turn, no scale): the body part's size and the box its corners span, and the gap of the two boxes (surface points of
 *  each against the other's box: minus how deep the look's are in the part; else 0 when the part's are in the look;
 *  else the least distance). */
const reading = (cid, oid, joint) => `(() => {
	const rig = window.__cozyclay.rigs[${JSON.stringify(cid)}] ?? Object.values(window.__cozyclay.rigs).find(r => r?.parent); let root = rig; while (root.parent) root = root.parent;
	const looks = []; root.traverse(n => { if (n.userData?.characterPick !== undefined && n.children.length === 17) looks.push(n); });
	const look = looks.find(n => n.userData.characterPick === ${JSON.stringify(cid)} || n.userData.characterPick?.id === ${JSON.stringify(cid)}) ?? (looks.length === 1 ? looks[0] : null);
	let group = null; root.traverse(n => { if (!group && n.userData?.sceneObjectId === ${JSON.stringify(oid)} && !n.userData.ghost) group = n; });
	if (!look || !group) return { error: "not found", looks: looks.length, group: !!group };
	const m = x => x.matrixWorld.elements, app = (e, p) => [e[0] * p[0] + e[4] * p[1] + e[8] * p[2] + e[12], e[1] * p[0] + e[5] * p[1] + e[9] * p[2] + e[13], e[2] * p[0] + e[6] * p[1] + e[10] * p[2] + e[14]];
	const g = m(group), sx = Math.hypot(g[0], g[1], g[2]), sy = Math.hypot(g[4], g[5], g[6]), sz = Math.hypot(g[8], g[9], g[10]);
	const ax = [[g[0] / sx, g[1] / sx, g[2] / sx], [g[4] / sy, g[5] / sy, g[6] / sy], [g[8] / sz, g[9] / sz, g[10] / sz]], o = [g[12], g[13], g[14]];
	const own = p => { const d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]]; return ax.map(a => a[0] * d[0] + a[1] * d[1] + a[2] * d[2]); };
	const boxOf = mesh => { mesh.geometry.computeBoundingBox(); const b = mesh.geometry.boundingBox, e = m(mesh), lo = [b.min.x, b.min.y, b.min.z], hi = [b.max.x, b.max.y, b.max.z];
		const c = own(app(e, lo.map((v, k) => (v + hi[k]) / 2))), axes = [0, 1, 2].map(k => { const u = own(app(e, lo.map((v, i) => (i === k ? hi[i] : (v + hi[i]) / 2)))); return u.map((v, i) => v - c[i]); });
		const h = axes.map(a => Math.hypot(...a)); return { c, u: axes.map((a, k) => a.map(v => v / (h[k] || 1))), h }; };
	const part = []; look.children[${JOINT[joint] ?? -1}].traverse(n => { if (n.isMesh && n.visible && n.geometry?.attributes?.position) part.push(n); });
	const P = part.map(boxOf).sort((a, b) => b.h[0] * b.h[1] * b.h[2] - a.h[0] * a.h[1] * a.h[2])[0];
	const drawn = []; const walk = n => { if (!n.visible) return; if (n.isMesh && n.layers.isEnabled(0)) drawn.push(n); for (const c of n.children) if (!c.userData?.sceneObjectId) walk(c); }; for (const c of group.children) walk(c);
	const L = drawn.map(boxOf);
	const sd = (p, B) => { const d = [p[0] - B.c[0], p[1] - B.c[1], p[2] - B.c[2]], q = B.u.map((u, k) => Math.abs(u[0] * d[0] + u[1] * d[1] + u[2] * d[2]) - B.h[k]); return Math.hypot(...q.map(v => Math.max(v, 0))) + Math.min(0, Math.max(...q)); };
	const surface = B => { const out = [], N = 24; for (let k = 0; k < 3; k++) for (const s of [-1, 1]) for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) { const a = (k + 1) % 3, b = (k + 2) % 3, w = [0, 0, 0]; w[k] = s; w[a] = 2 * i / N - 1; w[b] = 2 * j / N - 1; out.push([0, 1, 2].map(x => B.c[x] + B.u[0][x] * w[0] * B.h[0] + B.u[1][x] * w[1] * B.h[1] + B.u[2][x] * w[2] * B.h[2])); } return out; };
	let near = Infinity, sunk = 0, about = false;
	for (const p of surface(P)) { const v = Math.min(...L.map(B => sd(p, B))); if (v < 0) about = true; else near = Math.min(near, v); }
	for (const B of L) for (const p of surface(B)) { const v = sd(p, P); if (v < 0) sunk = Math.max(sunk, -v); else near = Math.min(near, v); }
	const corners = []; for (const i of [-1, 1]) for (const j of [-1, 1]) for (const k of [-1, 1]) corners.push([0, 1, 2].map(x => P.c[x] + P.u[0][x] * i * P.h[0] + P.u[1][x] * j * P.h[1] + P.u[2][x] * k * P.h[2]));
	return { size: P.h.map(v => 2 * v), lo: [0, 1, 2].map(k => Math.min(...corners.map(p => p[k]))), hi: [0, 1, 2].map(k => Math.max(...corners.map(p => p[k]))), gap: sunk > 0 ? -sunk : about ? 0 : near, meshes: { part: part.length, look: drawn.length } };
})()`;

const num = text => text.match(/-?\d+(\.\d+)?/g).map(Number);
/** The drawn part of one contact row: { size, lo, hi } read off its text. */
function partOf(line, who, joint) {
	const row = line.split("; ").find(r => r.includes(`${who} ${joint} `) && r.includes("its drawn part"));
	const m = /its drawn part ([\d.]+) x ([\d.]+) x ([\d.]+) m spans \[([^\]]+)\] to \[([^\]]+)\]/.exec(row ?? "");
	return m ? { row, size: [m[1], m[2], m[3]].map(Number), lo: num(m[4]), hi: num(m[5]) } : null;
}
/** The gap a gap line tells for one carried part, in mm (+ off the part, - the look inside it), or null when not told (within 0.03 m). */
function gapOf(line, who, joint) {
	const m = new RegExp(`${who} ${joint}'s drawn part f[\\d-]+: (?:(\\d+) mm from the drawn look|the drawn look (\\d+) mm inside it)`).exec(line ?? "");
	return m ? (m[1] ? Number(m[1]) : -Number(m[2])) : null;
}

export async function scenarios(t) {
	const { turn, writer, agent, gate, pass, report, assert, waitFor, sleep, evaluate, hub } = t;
	let who = null;
	writer.plan = {
		end: "report", variant: 0, gate1: "worn-w1",
		make: w => {
			who = w.id;
			return {
				scene: { frames: 72, characters: [{ id: w.id, at: w.at, heading: w.heading ?? 0, ...(S === 1 ? {} : { scale: S }) }], props: [{ id: "hat", size: HAT, at: [w.at[0], 1.6 * S, w.at[1]], moves: true }, { id: "badge", size: BADGE, at: [w.at[0], 1.2 * S, w.at[1] + 0.12 * S], moves: true }] },
				// the hat's box sinks 42 mm into the drawn head; the badge rides the chest, then goes to the head over the
				// ride's default frames
				spec: { [w.id]: [[0, "idle"], [30, "walk", { to: [w.at[0], w.at[1] + 0.8] }]], hat: [[0, "ride", { joint: "Head", of: w.id, at: [0, TOP + HAT[1] / 2 - 0.042, 0.012 * S] }]], badge: [[0, "ride", { joint: "Spine2", of: w.id, at: [0, 0, 0.12 * S] }], [36, "ride", { joint: "Head", of: w.id, at: [0.08 * S, 0.1 * S, 0.13 * S] }]] },
			};
		},
	};
	const from = agent.results.length;
	const running = turn("put the hat on", [["motion"], ["result"], ["gate", "worn-a1"], ["result"], ...[0, 1, 2, 3, 4, 5].map(k => ["gate", `worn-b${k}`])], { wait: false });
	const draft = await waitFor(() => agent.results.slice(from).find(r => r.name === "motion_result" && r.value?.draft === true)?.value, "the draft", 120_000);
	const hatLine = (draft.contacts ?? []).find(l => l.startsWith("hat (")), badgeLine = (draft.contacts ?? []).find(l => l.startsWith("badge ("));
	assert.ok(hatLine && badgeLine, `the draft names both: ${JSON.stringify(draft.contacts)}`);
	const hat = /^hat \((\S+)\)/.exec(hatLine)[1], badge = /^badge \((\S+)\)/.exec(badgeLine)[1], told = { hat: partOf(hatLine, who, "Head"), badge: partOf(badgeLine, who, "Spine2") };
	assert.ok(told.hat && told.badge, `each names its carrying part: ${hatLine} | ${badgeLine}`);
	pass(`draft: ${hatLine} | ${badgeLine}`);
	// the agent gives the hat a flat look on the stand-in's base (it sinks into the drawn head): the edit answers the gap
	agent.program.unshift(["call", "run_action", { action: "object.sculpt", args: { id: hat, recipe: brim(0) } }]);
	gate("worn-a1").open();
	const edit = await waitFor(() => agent.results.slice(from).find(r => r.name === "run_action")?.value, "the look edit", 60_000);
	const editGap = gapOf(edit.motionFit?.objects?.find(o => o.id === hat)?.gaps, who, "Head");
	assert.ok(editGap != null && editGap < -30, `the edit tells the hat's look inside the drawn head: ${JSON.stringify(edit.motionFit)}`);
	pass(`look edit: ${edit.motionFit.objects.find(o => o.id === hat).gaps}`);
	gate("worn-w1").open();
	const done = await waitFor(() => agent.results.slice(from).filter(r => r.name === "motion_result" && r.value?.draft !== true).at(-1)?.value, "the installed result", 120_000);
	assert.equal(done.installed, true);
	assert.ok((done.attached ?? []).some(a => a.id === hat), `the hat is attached to the bone: ${JSON.stringify(done.attached)}`);
	const installHat = gapOf((done.gaps ?? []).find(l => l.startsWith(`hat (${hat})`)), who, "Head"), installBadge = gapOf((done.gaps ?? []).find(l => l.startsWith(`badge (${badge})`)), who, "Spine2");
	await sleep(500);
	const page = { hat: await evaluate(reading(who, hat, "Head")), badge: await evaluate(reading(who, badge, "Spine2")) };
	assert.ok(!page.hat.error && !page.badge.error, `the page's meshes: ${JSON.stringify(page)}`);
	// the told part against the page's own reading: size and span within the rows' 0.01 m, gaps within 3 mm
	const within = (a, b, d) => a.every((v, k) => Math.abs(v - b[k]) <= d);
	assert.ok(within(told.hat.size, page.hat.size, 0.006) && within(told.hat.lo, page.hat.lo, 0.011) && within(told.hat.hi, page.hat.hi, 0.011), `hat's drawn head: told ${JSON.stringify(told.hat)}, page ${JSON.stringify(page.hat)}`);
	assert.ok(within(told.badge.size, page.badge.size, 0.006) && within(told.badge.lo, page.badge.lo, 0.011) && within(told.badge.hi, page.badge.hi, 0.011), `badge's drawn chest: told ${JSON.stringify(told.badge)}, page ${JSON.stringify(page.badge)}`);
	assert.ok(installHat != null && Math.abs(installHat - page.hat.gap * 1000) <= 3 && Math.abs(editGap - installHat) <= 3, `hat gap: edit ${editGap}, install ${installHat}, page ${page.hat.gap * 1000}`);
	// the badge: told when the page reads it more than 0.03 m off or in (at scale 0.5 it is 18 mm off: within, not told)
	assert.ok(Math.abs(page.badge.gap) > 0.033 ? installBadge != null && Math.abs(installBadge - page.badge.gap * 1000) <= 3 : Math.abs(page.badge.gap) < 0.027 && installBadge == null, `badge gap: install ${installBadge}, page ${page.badge.gap * 1000}`);
	pass(`install: ${done.gaps.join(" | ")}; page: hat ${(page.hat.gap * 1000).toFixed(1)} mm, badge ${(page.badge.gap * 1000).toFixed(1)} mm`);
	// after the install: looks, and the hat's place on its bone set by hand, each told as the page reads it (within
	// 0.03 m: not told). At scale 0.5 the hat's stand-in is a cube (a box under 0.05 m tall), whose recipes the Studio
	// draws otherwise than asked: told and page still agree.
	const onBone = ((await hub.command("describe", {}))?.objects ?? []).find(o => o?.id === hat), after = [];
	for (const [what, action, args] of [
		["the brim lifted 50 mm clears the drawn head", "object.sculpt", { id: hat, recipe: brim(0.05) }],
		["a thin plate inside the drawn head: the look in the part", "object.sculpt", { id: hat, recipe: slab([0.1 * S, 0.01, 0.1 * S], 0) }],
		["a box round the drawn head: the part in the look, so at it", "object.sculpt", { id: hat, recipe: slab([0.5 * S, 0.6 * S, 0.5 * S], -0.3 * S) }],
		["the brim on the base again", "object.sculpt", { id: hat, recipe: brim(0) }],
		["the hat moved 40 mm down its bone by hand", "object.update", { id: hat, patch: { y: onBone.y - 0.04 } }],
		["and 100 mm up it", "object.update", { id: hat, patch: { y: onBone.y + 0.1 } }],
	]) {
		const edits = agent.results.filter(r => r.name === "run_action").length;
		agent.program.unshift(["call", "run_action", { action, args }]);
		gate(`worn-b${after.length}`).open();
		const fit = (await waitFor(() => agent.results.filter(r => r.name === "run_action")[edits]?.value, what, 60_000)).motionFit;
		await sleep(500);
		const read = await evaluate(reading(who, hat, "Head")), told = gapOf(fit?.objects?.find(o => o.id === hat)?.gaps, who, "Head");
		assert.ok(Math.abs(read.gap) > 0.033 ? told != null && Math.abs(told - read.gap * 1000) <= 3 : Math.abs(read.gap) > 0.027 || told == null, `${what}: told ${told}, page ${read.gap}; ${JSON.stringify(fit)}`);
		after.push({ what, told, page: read.gap });
	}
	await running;
	pass(`after the install (told | page, mm): ${after.map(x => `${x.what}: ${x.told ?? "not told"} | ${(x.page * 1000).toFixed(1)}`).join("; ")}`);
	report.worn = { scale: S, draft: draft.contacts, edit: edit.motionFit, install: { contacts: done.contacts, gaps: done.gaps, attached: done.attached }, after, page, told };
}
