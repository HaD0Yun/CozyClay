// A contact sheet of a lowvis clip with no browser: a small software rasterizer in pure Node.
//   renderSheet(clip, { frames, view, focus }) -> { png, width, height, ms, frames, view, figurePx }
//   drawSheet (the same, raw pixels), stackSheets and encodePng are the parts, for a caller that stacks sheets.
// Every cell shows one frame with the same camera. The figure is the box look (figure.mjs), props are boxes or
// balls, faces are flat shaded by their normal, a depth buffer sorts them, every box gets a dark outline, the floor
// has a 1 m grid and soft drop shadows. A red line runs 0.5 m along +X and a blue one along +Z from the world origin.
// The figure's right arm and leg are drawn darker so left and right read in a still. A character with a scale is drawn
// that large, one with a tint in that colour (clip.js); one without a tint gets a colour of the sheet's own.
// props: "outline" draws every prop as its edges alone (hidden where something is in front of them), so a body inside
// or behind a prop shows. A focus entry { joint, of } frames that joint of that character close.
import { crc32, deflateSync } from "node:zlib";
import { paintLabel } from "../../motion-v4/render/font.js";
import { JOINT_COUNT, qMul, qRotate } from "../rig17.js";
import { jointPoints, propEdges } from "./outline.mjs";
import { FIGURE_PARTS } from "./figure.mjs";

const FOV = 26; // the viewer's (src/lowvis/viewer/main.js), with its view directions
export const VIEWS = {
	three: { dir: [0.62, 0.5, 1], up: [0, 1, 0] },
	front: { dir: [0, 0.06, 1], up: [0, 1, 0] },
	side: { dir: [1, 0.06, 0], up: [0, 1, 0] },
	top: { dir: [0, 1, 0], up: [0, 0, -1] }, // +X to the right, +Z down the sheet
};
const BACKGROUND = [232, 229, 223], FLOOR = [199, 201, 202], GRID = [146, 150, 153];
// an untinted figure in the Studio's colours by its place in the clip: the first the blockout grey, the others the
// cast colours in turn (src/stage-startup-defaults.js defaultCharacterColour, copied: src/lowvis imports no Studio module)
const GREY = [194, 198, 200], CAST = [[143, 168, 194], [169, 191, 152], [199, 154, 166], [201, 183, 164]], PROP = [176, 170, 160];
const LIGHT = norm([-0.45, 1, 0.55]);
const SS = 2, GAP = 4, NEAR = 0.05;
const CORNERS = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
// faces as corner indices, counter-clockwise seen from outside, with their normal in the box frame
const FACES = [[[1, 2, 6, 5], [1, 0, 0]], [[0, 4, 7, 3], [-1, 0, 0]], [[3, 7, 6, 2], [0, 1, 0]], [[0, 1, 5, 4], [0, -1, 0]], [[4, 5, 6, 7], [0, 0, 1]], [[0, 3, 2, 1], [0, 0, -1]]];

function norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The camera that frames `points` (flat xyz, each padded by `pad` m) as large as the cell allows: the viewer's fit. */
function fitCamera(points, view, aspect, pad = 0.3) {
	const dir = norm(view.dir), right = norm(cross(view.up, dir)), up = cross(dir, right);
	const ty = Math.tan(FOV * Math.PI / 360), tx = ty * aspect;
	let xa = -Infinity, xb = -Infinity, ya = -Infinity, yb = -Infinity;
	for (let i = 0; i < points.length; i += 3) {
		const v = [points[i], points[i + 1], points[i + 2]], x = dot(v, right), y = dot(v, up), z = dot(v, dir) + pad;
		xa = Math.max(xa, x + pad + z * tx); xb = Math.max(xb, -x + pad + z * tx);
		ya = Math.max(ya, y + pad + z * ty); yb = Math.max(yb, -y + pad + z * ty);
	}
	return { dir, right, up, tx, ty, D: Math.max((xa + xb) / (2 * tx), (ya + yb) / (2 * ty)) * 1.03, cx: (xa - xb) / 2, cy: (ya - yb) / 2 };
}

const propAt = (p, f) => { const k = p.pos.length === 3 ? 0 : f; return { c: [p.pos[k * 3], p.pos[k * 3 + 1], p.pos[k * 3 + 2]], q: [p.quat[k * 4], p.quat[k * 4 + 1], p.quat[k * 4 + 2], p.quat[k * 4 + 3]] }; };

/** What the camera must keep in frame: joints (and the floor under the hips) of the characters, corners of the props. */
function framePoints(clip, frames, focus) {
	const pts = [], all = !focus?.length, want = id => all || focus.includes(id);
	if (!all) pts.push(...jointPoints(clip, frames, focus));
	const fs = all ? Array.from({ length: Math.ceil(clip.frameCount / 2) }, (_, k) => k * 2) : frames;
	for (const c of clip.characters) {
		if (!want(c.id)) continue;
		for (const f of fs) {
			const o = f * JOINT_COUNT * 3;
			for (let j = 0; j < JOINT_COUNT; j++) pts.push(c.pos[o + j * 3], c.pos[o + j * 3 + 1], c.pos[o + j * 3 + 2]);
			pts.push(c.pos[o], 0, c.pos[o + 2]);
		}
	}
	for (const p of clip.props ?? []) {
		if (!want(p.id)) continue;
		const r = Math.max(0.02, Math.hypot(...p.size) / 2 - 0.25); // the fit pads every point by more than the rest
		for (const f of p.pos.length === 3 ? [0] : fs) {
			const { c } = propAt(p, f);
			for (let k = 0; k < 8; k++) pts.push(c[0] + (k & 1 ? r : -r), Math.max(0, c[1] + (k & 2 ? r : -r)), c[2] + (k & 4 ? r : -r));
		}
	}
	if (!pts.length) pts.push(-1, 0, -1, 1, 0, 1, 0, 1.8, 0);
	return pts;
}

/** One cell's buffers and the drawing calls on them. Screen points are [x, y, 1 / depth]. */
function createCell(W, H, cam) {
	const rgb = new Uint8Array(W * H * 3), zb = new Float32Array(W * H), ids = new Uint16Array(W * H), mask = new Uint8Array(W * H);
	const toCam = v => [dot(v, cam.right) - cam.cx, dot(v, cam.up) - cam.cy, cam.D - dot(v, cam.dir)];
	const toScreen = c => [(0.5 + 0.5 * c[0] / (c[2] * cam.tx)) * W, (0.5 - 0.5 * c[1] / (c[2] * cam.ty)) * H, 1 / c[2]];
	const project = v => { const c = toCam(v); return c[2] > NEAR ? toScreen(c) : null; };
	/** Scanline fill of a convex polygon. paint(index, 1/depth) decides what a covered pixel becomes. */
	const fill = (pts, paint) => {
		let y0 = Infinity, y1 = -Infinity;
		for (const p of pts) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
		const ya = Math.max(0, Math.ceil(y0 - 0.5)), yb = Math.min(H - 1, Math.floor(y1 - 0.5));
		for (let y = ya; y <= yb; y++) {
			const yc = y + 0.5;
			let xl = Infinity, xr = -Infinity, wl = 0, wr = 0;
			for (let i = 0; i < pts.length; i++) {
				const a = pts[i], b = pts[(i + 1) % pts.length];
				if ((a[1] <= yc) === (b[1] <= yc)) continue;
				const t = (yc - a[1]) / (b[1] - a[1]), x = a[0] + t * (b[0] - a[0]), w = a[2] + t * (b[2] - a[2]);
				if (x < xl) { xl = x; wl = w; }
				if (x > xr) { xr = x; wr = w; }
			}
			if (xl > xr) continue;
			const xa = Math.max(0, Math.ceil(xl - 0.5)), xb = Math.min(W - 1, Math.floor(xr - 0.5)), dw = xr > xl ? (wr - wl) / (xr - xl) : 0;
			for (let x = xa, i = y * W + xa; x <= xb; x++, i++) paint(i, wl + (x + 0.5 - xl) * dw);
		}
	};
	const set = (i, c) => { rgb[i * 3] = c[0]; rgb[i * 3 + 1] = c[1]; rgb[i * 3 + 2] = c[2]; };
	const solid = (pts, color, id) => fill(pts, (i, w) => { if (w > zb[i]) { zb[i] = w; ids[i] = id; set(i, color); } });
	/** A polygon in world space, clipped at the near plane, painted with no depth test (the floor). */
	const flat = (world, color) => {
		const cs = world.map(toCam), out = [];
		for (let i = 0; i < cs.length; i++) {
			const a = cs[i], b = cs[(i + 1) % cs.length];
			if (a[2] > NEAR) out.push(a);
			if ((a[2] > NEAR) !== (b[2] > NEAR)) { const t = (NEAR - a[2]) / (b[2] - a[2]); out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), NEAR]); }
		}
		if (out.length >= 3) fill(out.map(toScreen), i => set(i, color));
	};
	/** A world-space line of `width` pixels, clipped at the near plane, no depth test. */
	const line = (a, b, color, width = SS) => {
		let ca = toCam(a), cb = toCam(b);
		if (ca[2] <= NEAR && cb[2] <= NEAR) return;
		if (ca[2] <= NEAR) [ca, cb] = [cb, ca];
		if (cb[2] <= NEAR) { const t = (NEAR - ca[2]) / (cb[2] - ca[2]); cb = [ca[0] + t * (cb[0] - ca[0]), ca[1] + t * (cb[1] - ca[1]), NEAR]; }
		const p = toScreen(ca), q = toScreen(cb), dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy);
		if (l < 1e-6 || l > 1e5) return;
		const nx = -dy / l * width / 2, ny = dx / l * width / 2;
		fill([[p[0] + nx, p[1] + ny, 0], [q[0] + nx, q[1] + ny, 0], [q[0] - nx, q[1] - ny, 0], [p[0] - nx, p[1] - ny, 0]], i => set(i, color));
	};
	return { rgb, zb, ids, mask, project, toCam, fill, solid, flat, line, set };
}

/** Brightness of a face with world normal n: sky and ground light plus the sun. */
const shade = n => 0.6 + 0.16 * (0.5 + 0.5 * n[1]) + 0.3 * Math.max(0, dot(n, LIGHT));
const tint = (c, k) => [Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k)];

/** The boxes and balls of frame f: { c, q, size, color, ball }. */
function sceneAt(clip, f) {
	const list = [];
	clip.characters.forEach((ch, n) => {
		const base = ch.tint ? [1, 3, 5].map(k => parseInt(ch.tint.slice(k, k + 2), 16)) : n ? CAST[(n - 1) % CAST.length] : GREY, o =f * JOINT_COUNT, s = ch.scale ?? 1;
		for (const part of FIGURE_PARTS) {
			const i = (o + part.joint) * 3, k = (o + part.joint) * 4, q = [ch.quat[k], ch.quat[k + 1], ch.quat[k + 2], ch.quat[k + 3]], d = qRotate(q, part.off);
			list.push({ c: [ch.pos[i] + d[0] * s, ch.pos[i + 1] + d[1] * s, ch.pos[i + 2] + d[2] * s], q: qMul(q, part.q), size: s === 1 ? part.size : part.size.map(v => v * s), color: tint(base, part.dark ? 0.42 : part.right ? 0.72 : 1) });
		}
	});
	for (const p of clip.props ?? []) if (p.shown?.[f] !== 0) list.push({ ...propAt(p, f), size: p.size, color: PROP, ball: p.shape === "sphere", prop: true }); // not on the frames the clip hides it
	return list;
}

function drawCell(cell, W, H, cam, clip, f, bounds, outline = false) {
	const { rgb, zb, ids, mask } = cell;
	for (let i = 0; i < W * H; i++) { rgb[i * 3] = BACKGROUND[0]; rgb[i * 3 + 1] = BACKGROUND[1]; rgb[i * 3 + 2] = BACKGROUND[2]; }
	zb.fill(0); ids.fill(0); mask.fill(0);
	const [x0, x1, z0, z1] = bounds;
	cell.flat([[x0 - 40, 0, z0 - 40], [x1 + 40, 0, z0 - 40], [x1 + 40, 0, z1 + 40], [x0 - 40, 0, z1 + 40]], FLOOR); // the floor runs past the grid
	for (let x = x0; x <= x1; x++) cell.line([x, 0, z0], [x, 0, z1], GRID);
	for (let z = z0; z <= z1; z++) cell.line([x0, 0, z], [x1, 0, z], GRID);
	const items = sceneAt(clip, f);
	// drop shadows: every box's corners slid along the light onto the floor, one darkening per pixel
	for (const it of items) {
		const pts = [];
		for (const k of CORNERS) {
			const v = qRotate(it.q, [k[0] * it.size[0] / 2, k[1] * it.size[1] / 2, k[2] * it.size[2] / 2]), y = Math.max(0, it.c[1] + v[1]);
			const s = cell.project([it.c[0] + v[0] - LIGHT[0] * y / LIGHT[1], 0, it.c[2] + v[2] - LIGHT[2] * y / LIGHT[1]]);
			if (s) pts.push(s);
		}
		if (pts.length >= 3) cell.fill(hull(pts), i => { mask[i] = 1; });
	}
	for (let i = 0; i < W * H; i++) if (mask[i]) { rgb[i * 3] *= 0.84; rgb[i * 3 + 1] *= 0.84; rgb[i * 3 + 2] *= 0.84; }
	cell.line([0, 0.004, 0], [0.5, 0.004, 0], [200, 60, 50], SS * 2);
	cell.line([0, 0.004, 0], [0, 0.004, 0.5], [50, 90, 200], SS * 2);
	const eye = [0, 1, 2].map(k => cam.right[k] * cam.cx + cam.up[k] * cam.cy + cam.dir[k] * cam.D);
	items.forEach((it, n) => {
		const id = n + 1;
		if (outline && it.prop) return;
		if (it.ball) {
			const c = cell.toCam(it.c), r = it.size[0] / 2;
			if (c[2] - r <= NEAR) return;
			const sx = (0.5 + 0.5 * c[0] / (c[2] * cam.tx)) * W, sy = (0.5 - 0.5 * c[1] / (c[2] * cam.ty)) * H, sr = r / (c[2] * cam.tx) * W / 2;
			for (let y = Math.max(0, Math.floor(sy - sr)); y <= Math.min(H - 1, Math.ceil(sy + sr)); y++) for (let x = Math.max(0, Math.floor(sx - sr)); x <= Math.min(W - 1, Math.ceil(sx + sr)); x++) {
				const u = (x + 0.5 - sx) / sr, v = -(y + 0.5 - sy) / sr, d2 = u * u + v * v;
				if (d2 > 1) continue;
				const nz = Math.sqrt(1 - d2), w = 1 / (c[2] - nz * r), i = y * W + x;
				if (w <= zb[i]) continue;
				const nw = [0, 1, 2].map(k => cam.right[k] * u + cam.up[k] * v + cam.dir[k] * nz);
				zb[i] = w; ids[i] = id; cell.set(i, tint(it.color, shade(nw)));
			}
			return;
		}
		const world = CORNERS.map(k => { const v = qRotate(it.q, [k[0] * it.size[0] / 2, k[1] * it.size[1] / 2, k[2] * it.size[2] / 2]); return [it.c[0] + v[0], it.c[1] + v[1], it.c[2] + v[2]]; });
		const screen = world.map(cell.project);
		if (screen.some(s => !s)) return;
		for (const [corners, normal] of FACES) {
			const n = qRotate(it.q, normal), a = world[corners[0]];
			if (dot(n, [eye[0] - a[0], eye[1] - a[1], eye[2] - a[2]]) <= 0) continue;
			cell.solid(corners.map(k => screen[k]), tint(it.color, shade(n)), id);
		}
	});
	// outline: a pixel whose right or lower neighbour belongs to another box
	for (let y = 0; y < H - 1; y++) for (let x = 0, i = y * W; x < W - 1; x++, i++) {
		if (ids[i] === ids[i + 1] && ids[i] === ids[i + W]) continue;
		rgb[i * 3] *= 0.38; rgb[i * 3 + 1] *= 0.38; rgb[i * 3 + 2] *= 0.38;
	}
	if (outline) for (const it of items) if (it.prop) propEdges(cell, cam, it, tint(it.color, 0.45), SS * 1.5);
}

/** Convex hull of screen points (monotone chain). */
function hull(pts) {
	const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]), turn = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
	const half = list => { const h = []; for (const q of list) { while (h.length >= 2 && turn(h.at(-2), h.at(-1), q) <= 0) h.pop(); h.push(q); } h.pop(); return h; };
	return [...half(p), ...half(p.reverse())];
}

/** PNG bytes of an RGBA buffer (the alpha is dropped). */
export function encodePng(rgba, width, height) {
	const raw = Buffer.alloc((width * 3 + 1) * height);
	for (let y = 0, o = 0, i = 0; y < height; y++) { raw[o++] = 0; for (let x = 0; x < width; x++, i += 4) { raw[o++] = rgba[i]; raw[o++] = rgba[i + 1]; raw[o++] = rgba[i + 2]; } }
	const chunk = (type, data) => {
		const head = Buffer.alloc(8), tail = Buffer.alloc(4);
		head.writeUInt32BE(data.length, 0); head.write(type, 4, "latin1");
		tail.writeUInt32BE(crc32(data, crc32(head.subarray(4))), 0);
		return Buffer.concat([head, data, tail]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 3 })), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * Draws frames of a clip as one sheet: { rgba, width, height, frames, view, figurePx, ms }.
 * `view`: three | side | front | top. `focus`: ids of the characters and props to frame (over the frames shown),
 * and { joint, of } for a joint of a character, framed close; none = the whole clip's travel and every prop.
 * `props`: "solid" (default) or "outline". `label` goes before the frame number of every cell.
 * `figurePx` is the height in pixels a standing figure (the smallest of the clip) has in a cell.
 */
export function drawSheet(clip, { frames, view = "three", focus, cols, cell = [384, 320], label, props = "solid" } = {}) {
	const t0 = performance.now(), F = clip.frameCount;
	const list = (frames?.length ? frames : [0]).map(f => Math.max(0, Math.min(F - 1, Math.round(f))));
	const [cw, ch] = cell, W = cw * SS, H = ch * SS, nCols = cols ?? Math.min(list.length, 4), nRows = Math.ceil(list.length / nCols);
	const close = focus?.length && focus.every(e => typeof e === "object"), points = framePoints(clip, list, focus), cam = fitCamera(points, VIEWS[view] ?? VIEWS.three, cw / ch, close ? 0.1 : 0.3);
	let xa = Infinity, xb = -Infinity, za = Infinity, zb = -Infinity, depth = 0;
	for (let i = 0; i < points.length; i += 3) { xa = Math.min(xa, points[i]); xb = Math.max(xb, points[i]); za = Math.min(za, points[i + 2]); zb = Math.max(zb, points[i + 2]); depth += cam.D - dot([points[i], points[i + 1], points[i + 2]], cam.dir); }
	const bounds = [Math.floor(xa) - 2, Math.ceil(xb) + 2, Math.floor(za) - 2, Math.ceil(zb) + 2];
	const width = nCols * cw + (nCols - 1) * GAP, height = nRows * ch + (nRows - 1) * GAP, rgba = new Uint8Array(width * height * 4).fill(255);
	const buffers = createCell(W, H, cam);
	list.forEach((f, n) => {
		drawCell(buffers, W, H, cam, clip, f, bounds, props === "outline");
		const ox = (n % nCols) * (cw + GAP), oy = Math.floor(n / nCols) * (ch + GAP), src = buffers.rgb;
		for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
			const a = ((y * SS) * W + x * SS) * 3, b = a + W * 3, o = ((oy + y) * width + ox + x) * 4;
			for (let k = 0; k < 3; k++) rgba[o + k] = (src[a + k] + src[a + 3 + k] + src[b + k] + src[b + 3 + k] + 2) >> 2;
		}
		paintLabel(rgba, width, height, ox + 6, oy + 6, `${label ? `${label} ` : ""}f${f}`, { scale: 2, pad: 3, bottomUp: false });
	});
	return { rgba, width, height, frames: list, view: VIEWS[view] ? view : "three", figurePx: Math.round(1.8 * Math.min(...clip.characters.map(c => c.scale ?? 1)) / (2 * (depth / (points.length / 3)) * cam.ty) * ch), ms: Math.round((performance.now() - t0) * 10) / 10 };
}

/** Sheets one under the other (each may have its own camera), as one { rgba, width, height }. */
export function stackSheets(sheets) {
	const width = Math.max(...sheets.map(s => s.width)), height = sheets.reduce((h, s) => h + s.height, 0) + GAP * (sheets.length - 1), rgba = new Uint8Array(width * height * 4).fill(255);
	let oy = 0;
	for (const s of sheets) { for (let y = 0; y < s.height; y++) rgba.set(s.rgba.subarray(y * s.width * 4, (y + 1) * s.width * 4), (oy + y) * width * 4); oy += s.height + GAP; }
	return { rgba, width, height };
}

/** drawSheet as PNG bytes: { png, width, height, frames, view, figurePx, ms } (ms includes the encoding). */
export function renderSheet(clip, options) {
	const t0 = performance.now(), sheet = drawSheet(clip, options), png = encodePng(sheet.rgba, sheet.width, sheet.height);
	return { ...sheet, rgba: undefined, png, ms: Math.round((performance.now() - t0) * 10) / 10 };
}
