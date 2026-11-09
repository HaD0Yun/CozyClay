#!/usr/bin/env node
// v4 render (design 3.4): cameras, frame picks, the label font, the editor sheet and the tool, over
// fixtures built with takeOut (fk inside) plus the Out additions; the editor ports and the track
// store are small fakes.
import { deflateSync } from "node:zlib";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { takeOut } from "../../src/motion3/physics-frames.js";
import { quatFromMat, sub, add, scale, len, dot } from "../../src/motion3/compiler/math.js";
import { solePoints } from "../../src/motion3/qa/geometry.js";
import { projectPoint } from "../../src/motion3/views.js";
import { judgeCameras, trackingCameras, closeUpCamera, lookAt } from "../../src/motion-v4/render/cameras.js";
import { pickFrames } from "../../src/motion-v4/render/events.js";
import { paintLabel } from "../../src/motion-v4/render/font.js";
import { renderV4Sheet } from "../../src/motion-v4/render/editor-render.js";
import { createRenderTool } from "../../bin/agent/v4/render-tool.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
async function throws(name, fn, pattern) {
	try { await fn(); expect(name, false, "did not throw"); } catch (error) { expect(name, pattern.test(error.message), error.message); }
}

const sk = skeletonFor("y-bot-tpose"), B = sk.names.length, I = sk.index, REST = sk.restLocalRot.map(quatFromMat);
const G = 9.8, FPS = 24, T0 = 20, T1 = 34, F = 56, Y0 = sk.restWorldPos[I.Hips][1], V0 = (G * (T1 - T0)) / FPS / 2;
// A standing jump: rest pose, hips ballistic from T0 to T1 (apex at T0 + 7), 3 cm forward a frame in the air.
const jumpHips = f => {
	const t = (Math.min(Math.max(f, T0), T1) - T0) / FPS;
	return [0, f > T0 && f < T1 ? Y0 + V0 * t - (G * t * t) / 2 : Y0, 0.03 * (Math.min(Math.max(f, T0), T1) - T0)];
};
function makeTake(frames, hipsAt) {
	const rot = new Float32Array(frames * B * 4), hips = new Float32Array(frames * 3);
	for (let f = 0; f < frames; f++) { for (let b = 0; b < B; b++) rot.set(REST[b], (f * B + b) * 4); hips.set(hipsAt(f), f * 3); }
	return { schema: "cozyclay.take.v3", fps: FPS, frameCount: frames, rig: "y-bot-tpose", bones: sk.names.slice(), rot, hips, objects: {},
		placement: { position: [0, 0, 0], yaw: 0 }, spec: { schema: "cozyclay.motion-spec.v1", fps: FPS, frames } };
}
// Out = takeOut plus diag/c and ctx.objectsAt (design 2.4).
function outOf(take, records = []) {
	const out = takeOut(take, records);
	for (const fr of out.frames) { fr.diag = {}; fr.c = {}; }
	out.ctx.objectsAt = out.objectsAt;
	return out;
}
const base = { rot: 0, rotX: 0, rotZ: 0, path: null, attach: null, hidden: false, color: "#9e9e9e", footprint: { width: 1, depth: 1 }, height: 1, supportY: 1 };
// A crate between the side camera (+X) and the character.
const CRATE = [{ ...base, id: "crate", name: "Crate", renderer: "cube", x: 1.3, y: 0, z: 0, scaleX: 0.3, scaleY: 1, scaleZ: 0.8, parent: null }];
const jump = outOf(makeTake(F, jumpHips), CRATE);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// 1. Judge cameras on a hand-made box: joints at the corners of one box, a crate beside it, the position inside.
{
	const box = [[-0.4, 0, -0.3], [0.4, 1.8, 0.3]], P = [0, 1].flatMap(x => [0, 1].flatMap(y => [0, 1].map(z => [box[x][0], box[y][1], box[z][2]])));
	const crate = { pos: [1, 0, 0.2], R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], half: [0.2, 0.25, 0.25] };
	const fake = { frames: Array.from({ length: 5 }, () => ({ s: { P } })), objectsAt: () => ({ crate }), ctx: {} };
	const cams = judgeCameras(fake, { aspect: 16 / 9, position: [0, 0, 0] }), [side, front] = cams;
	const lo = [-0.65, -0.25, -0.55], hi = [1.45, 2.05, 0.7], corners = [0, 1].flatMap(x => [0, 1].flatMap(y => [0, 1].map(z => [[lo, hi][x][0], [lo, hi][y][1], [lo, hi][z][2]])));
	const W = 960, H = 540, edge = cam => Math.max(...corners.map(c => { const q = projectPoint(cam, c, W, H); return q ? Math.max(Math.abs(q[0] - W / 2) - W / 2, Math.abs(q[1] - H / 2) - H / 2) : Infinity; }));
	expect("judge: two cameras named side and front", cams.length === 2 && side.name === "side" && front.name === "front");
	for (const cam of cams) {
		expect(`judge ${cam.name}: all 8 box corners inside the frame`, edge(cam) < 0, `worst ${edge(cam).toFixed(2)} px past the edge`);
		const tight = { ...cam, eye: add(cam.target, scale(sub(cam.eye, cam.target), 1 / 1.08)) };
		expect(`judge ${cam.name}: without the 1.08 margin the tightest corner sits on the edge within 1 px`, Math.abs(edge(tight)) <= 1, `${edge(tight).toFixed(3)} px`);
		expect(`judge ${cam.name}: 35 mm lens on a 36 mm sensor (fov ${cam.fovDeg.toFixed(2)})`, near(cam.tanH, 18 / 35, 1e-9) && near(cam.fovDeg, 32.27, 0.01));
	}
	expect("judge side: its eye has the largest x", side.eye[0] > front.eye[0] && corners.every(c => side.eye[0] > c[0]), `side ${side.eye} front ${front.eye}`);
	expect("judge front: eye x > 0 and z > 0", front.eye[0] > 0 && front.eye[2] > 0, `${front.eye}`);
}

// 2. Tracking cameras: eye minus the smoothed hips is one constant offset.
{
	const frames = [0, 6, 20, 27, 34, 45, 55], cams = trackingCameras(jump, frames);
	const hips = jump.frames.map(fr => fr.s.P[I.Hips]), smooth = f => { const w = hips.slice(Math.max(0, f - 6), Math.min(F, f + 7)); return scale(w.reduce(add, [0, 0, 0]), 1 / w.length); };
	const offsets = cams.map((c, i) => sub(c.eye, smooth(frames[i])));
	expect("track: eye minus smoothed hips constant across frames", offsets.every(o => len(sub(o, offsets[0])) < 1e-9), JSON.stringify(offsets));
	expect("track: offset is 4 m to the body's left (+X) and 0.3 m up", len(sub(offsets[0], [4, 0.3, 0])) < 1e-4, `${offsets[0]}`);
	expect("track: target is the smoothed hips", cams.every((c, i) => len(sub(c.target, smooth(frames[i]))) < 1e-9));
	expect("track: one camera per frame, fov 32.3", cams.length === frames.length && near(cams[0].fovDeg, 32.27, 0.01));
}

// 3. Close-ups: the palm or the ball of the foot at the tile centre, the eye within 1 m.
for (const [end, point] of [["hand_l", s => scale(add(s.P[I.LeftHand], s.P[I.LeftHandMiddle1]), 0.5)], ["hand_r", s => scale(add(s.P[I.RightHand], s.P[I.RightHandMiddle1]), 0.5)], ["foot_r", s => solePoints(sk, s, "Right").ball]]) {
	const f = 27, cam = closeUpCamera(jump, f, end), p = point(jump.frames[f].s), q = projectPoint(cam, p, 400, 400);
	expect(`close-up ${end}: target within 2 px of the tile centre`, q && Math.hypot(q[0] - 200, q[1] - 200) <= 2, `${q}`);
	expect(`close-up ${end}: eye within 1 m, raised, on the limb's side`, len(sub(cam.eye, p)) <= 1 && cam.eye[1] > p[1] && Math.sign(cam.eye[0] - p[0]) === (end.endsWith("_l") ? 1 : -1), `${cam.eye}`);
}

// 4. Frame picks on the synthetic jump.
{
	const picks = pickFrames(jump, { mode: "events", count: 8 }), at = why => picks.find(p => p.why === why)?.f;
	for (const [why, truth] of [["takeoff", T0], ["apex", T0 + 7], ["landing", T1]]) expect(`events: ${why} f${at(why)} within 1 frame of f${truth}`, at(why) !== undefined && Math.abs(at(why) - truth) <= 1, JSON.stringify(picks));
	expect("events: 8 picks, ascending, at least 3 frames apart", picks.length === 8 && picks.every((p, i) => !i || p.f - picks[i - 1].f >= 3), JSON.stringify(picks));
	const even = pickFrames(jump, { mode: "even", count: 5 }).map(p => p.f);
	expect("even: 5 frames with both ends", JSON.stringify(even) === JSON.stringify([0, 14, 28, 41, 55]), `${even}`);
	expect("list: used as given, clamped", JSON.stringify(pickFrames(jump, { mode: [3, 999, 1] }).map(p => p.f)) === "[3,55,1]");
	const feet = pickFrames(jump, { mode: "events", count: 8, ends: ["sole_l", "sole_r"] });
	expect("ends: both soles off at takeoff and on at landing", ["sole_l", "sole_r"].every(e => feet.some(p => p.end === e && /off/.test(p.why) && Math.abs(p.f - T0) <= 1) && feet.some(p => p.end === e && / on floor/.test(p.why) && Math.abs(p.f - T1) <= 1)), JSON.stringify(feet));
	expect("ends: no palm contact, no picks", pickFrames(jump, { mode: "events", ends: ["palm_l", "palm_r"] }).length === 0);
	await throws("events: from after to throws", () => pickFrames(jump, { from: 30, to: 10 }), /after/);
}

// 5. The label font paints inside its strip only.
{
	const W = 140, H = 40, data = new Uint8Array(W * H * 4).fill(90), before = data.slice();
	const box = paintLabel(data, W, H, 5, 3, "f12 Takeoff:#_/.-?", { scale: 1 });
	let inside = 0, outside = 0, white = 0;
	for (let row = 0; row < H; row++) for (let x = 0; x < W; x++) {
		const i = (row * W + x) * 4, y = H - 1 - row, changed = data[i] !== before[i] || data[i + 1] !== before[i + 1] || data[i + 2] !== before[i + 2];
		const inBox = x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;
		if (changed && inBox) inside++;
		if (changed && !inBox) outside++;
		if (data[i] === 255 && inBox) white++;
	}
	expect("font: pixels change inside the strip and none outside", inside > 0 && outside === 0 && white > 20, `inside ${inside} outside ${outside} white ${white}`);
	expect("font: strip size for 18 characters at scale 1", box.width === 4 + 18 * 6 - 1 && box.height === 11, JSON.stringify(box));
}

// 6. renderV4Sheet with fake ports: one render per cell with its camera; the renderer reuses one buffer.
{
	const tile = { width: 120, height: 80 }, calls = [], shared = new Uint8Array(tile.width * tile.height * 4);
	const ports = {
		renderFrameBuffer: (frame, view) => { calls.push({ frame, view }); shared.fill(10 + calls.length * 20); return { data: shared, width: view.output.width, height: view.output.height }; },
		encodePng: (data, sheet) => { ports.sheet = { data, sheet }; return "data:image/png;base64,AAAA"; },
	};
	const cells = [0, 1, 2, 3, 4].map(i => ({ frame: i * 3, eye: [i, 1, 5], quaternion: [0, 0, 0, 1], fovDeg: 30 + i, label: `f${i * 3} even`, ...(i % 2 ? { fade: [`box${i}`] } : {}) }));
	const answer = renderV4Sheet({ tile, columns: 3, cells: [...cells, null] }, ports);
	expect("sheet: one renderFrameBuffer call per cell", calls.length === 5, `${calls.length}`);
	expect("sheet: each call has its cell's frame, eye, quaternion, fovDeg, tile and fade", calls.every((c, i) => c.frame === cells[i].frame && c.view.eye === cells[i].eye && c.view.quaternion === cells[i].quaternion && c.view.fovDeg === cells[i].fovDeg
		&& c.view.output.width === 120 && c.view.output.height === 80 && JSON.stringify(c.view.fade) === JSON.stringify(cells[i].fade ?? [])), JSON.stringify(calls[1]?.view));
	expect("sheet: answer is tile.width x columns by rows", answer.width === 360 && answer.height === 160 && answer.cells === 5 && answer.dataUrl.startsWith("data:image/png;base64,"), JSON.stringify(answer));
	const px = (x, y) => { const s = ports.sheet.sheet, i = ((s.height - 1 - y) * s.width + x) * 4; return ports.sheet.data[i]; };
	expect("sheet: each tile keeps its own render (copied off the shared buffer)", px(60, 70) === 30 && px(180, 70) === 50 && px(300, 70) === 70 && px(60, 150) === 90 && px(180, 150) === 110, [px(60, 70), px(180, 70), px(300, 70), px(60, 150), px(180, 150)].join(","));
	expect("sheet: a null cell is an empty grey tile; labels are painted top-left", px(300, 150) === 40 && px(1, 1) !== 30, `${px(300, 150)} ${px(1, 1)}`);
	await throws("sheet: wider than 2576 px throws", () => renderV4Sheet({ tile: { width: 1000, height: 100 }, columns: 3, cells: cells.slice(0, 3) }, ports), /2576/);
	await throws("sheet: more than 32 cells throws", () => renderV4Sheet({ tile, columns: 8, cells: Array(33).fill(cells[0]) }, ports), /32/);
}

// 7. The tool over a fake ctx: commits once when dirty, sheets within the long edge, base64 without a prefix.
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
{
	const solid = new Uint8Array(1280 * 1280 * 4).fill(128), editor = { renderFrameBuffer: (frame, view) => ({ data: solid, width: view.output.width, height: view.output.height }), encodePng: pngDataUrl };
	let commits = 0, dirty = true;
	const commands = [], ctx = {
		character: { id: "char-a", model: "y-bot-tpose", position: [0, 0, 0], yaw: 0 },
		track: { get dirty() { return dirty; }, commit: async () => { commits++; dirty = false; return { revision: 3, frames: F, receiptId: "r1", ms: { encode: 1, install: 2 } }; }, out: async () => jump },
		studio: { command: async (name, args, opts) => { commands.push({ name, args, opts }); return renderV4Sheet(args, editor); } },
	};
	const tool = createRenderTool(ctx);
	expect("tool: a V4Tool named render with a description under 2,000 chars", tool.name === "render" && tool.description.length <= 2000 && tool.inputSchema.additionalProperties === false);
	const t0 = Date.now(), first = await tool.run({}, { from: "model" }), ms = Date.now() - t0;
	const size = pngSize(first.images[0]?.data ?? "");
	expect("tool: dirty store committed before the render", commits === 1 && first.data.committed === true);
	expect("tool: default judge sheet is one 2000x1124 PNG, base64 without prefix", first.images.length === 1 && !first.images[0].data.startsWith("data:") && first.images[0].mimeType === "image/png" && size?.[0] === 2000 && size?.[1] === 1124, `${size}`);
	expect("tool: command v4_render with characterId, 4 columns, 16 cells, 120 s timeout", commands[0].name === "v4_render" && commands[0].args.characterId === "char-a" && commands[0].args.columns === 4 && commands[0].args.cells.length === 16 && commands[0].opts.timeoutMs === 120000);
	expect("tool: text lists the sheet with its rows and frames", /^committed the track first: r3/.test(first.text) && /sheet 1 2000x1124: rows side \(2\), front \(2\); columns f\d+ /.test(first.text) && first.text.length <= 2000, first.text);
	expect("tool: the crate in front of the side camera is drawn see-through", commands[0].args.cells.slice(0, 8).every(c => c.fade.includes("crate")) && /see-through: crate/.test(first.text), JSON.stringify(commands[0].args.cells[0].fade));
	expect("tool: data has the sheet layout and each cell's camera", first.data.sheets[0].columns === 4 && first.data.sheets[0].rows === 4 && first.data.sheets[0].cells.length === 16 && first.data.sheets[0].cells[0].camera.eye.length === 3 && first.images[0].label.startsWith("judge f"));
	console.log(`  default judge render ${ms} ms`);
	const all = await tool.run({ views: ["judge", "track", "hands", "feet", { name: "top", eye: [0, 6, 0.3], target: [0, 1, 0.3] }], overlay: { com: true, contacts: true, trail: true } }, { from: "js" });
	const sizes = all.images.map(i => pngSize(i.data));
	expect("tool: a clean store is not committed again", commits === 1 && all.data.committed === false);
	expect("tool: every sheet's long edge <= 2000 and <= 32 cells", sizes.every(s => s && Math.max(...s) <= 2000) && commands.slice(1).every(c => c.args.cells.length <= 32), JSON.stringify(sizes));
	expect("tool: text has a line for every sheet", all.images.length >= 2 && all.images.every((_, i) => all.text.includes(`sheet ${i + 1} `)), all.text);
	expect("tool: close-up sheets use square tiles and feet show the contact frames", commands.slice(1).some(c => c.args.tile.width === 400 && c.args.tile.height === 400) && /sole_l off/.test(all.text), all.text);
	expect("tool: overlay dots reach the editor", commands.slice(1).some(c => c.args.cells.some(cell => cell?.dots?.length)));
	const wide = await tool.run({ frames: [0, 27, 55], longEdge: 2576, tile: { width: 640, height: 360 } }, {});
	const wsize = pngSize(wide.images[0].data);
	expect("tool: an explicit frame list renders those frames; longEdge 2576 notes the downscale", JSON.stringify(wide.data.sheets[0].cells.map(c => c.frame)) === "[0,27,55,0,27,55]" && wsize[0] === 1920 && /shrinks images above 2000/.test(wide.text), `${wsize} ${wide.text}`);
	const tiny = await tool.run({ frames: "even", count: 16, views: ["side", "front", "track", "hands"], tile: { width: 64, height: 64 }, labels: false }, {});
	expect("tool: 64 px tiles still split into sheets of <= 32 cells", commands.slice(-tiny.images.length).every(c => c.args.cells.length <= 32 && c.args.columns === 8) && tiny.images.length === 3, `${tiny.images.length} sheets`);
	await throws("tool: unknown view throws", () => tool.run({ views: ["top"] }, {}), /unknown view/);
	await throws("tool: from after to throws", () => tool.run({ from: 40, to: 10 }, {}), /after/);
	await throws("tool: no track throws", () => createRenderTool({ ...ctx, track: { dirty: false, out: async () => null } }).run({}, {}), /No track yet/);
	expect("lookAt: a custom camera looks along -back at its target", (c => near(dot(c.back, sub(c.eye, c.target)), len(sub(c.eye, c.target)), 1e-9))(lookAt([3, 2, 1], [0, 1, 0])));
}

console.log(failures ? `${failures} FAILED` : "all PASS");
process.exit(failures ? 1 : 0);
