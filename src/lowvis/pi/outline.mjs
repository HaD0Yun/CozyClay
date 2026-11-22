// The parts of a contact sheet (render.mjs) that let the writer look closer: a prop drawn as its edges alone, so a body
// inside or behind it shows, and the points that frame one joint of a body close.
import { JOINTS, JOINT_COUNT, qRotate } from "../rig17.js";

const CORNERS = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];

// A world-space line of `width` pixels drawn only where nothing nearer is (the cell's depth buffer as it stands);
// a line with an end behind the camera is left out.
function edge(cell, a, b, color, width) {
	const p = cell.project(a), q = cell.project(b);
	if (!p || !q) return;
	const dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy);
	if (l < 1e-6 || l > 1e5) return;
	const nx = -dy / l * width / 2, ny = dx / l * width / 2;
	cell.fill([[p[0] + nx, p[1] + ny, p[2]], [q[0] + nx, q[1] + ny, q[2]], [q[0] - nx, q[1] - ny, q[2]], [p[0] - nx, p[1] - ny, p[2]]], (i, w) => { if (w >= cell.zb[i] * 0.999) cell.set(i, color); });
}

/** A prop { c, q, size, ball } as lines in a cell: a box's 12 edges; a ball's outline as the camera sees it and its
 *  ring about the vertical. Drawn after everything else, so a body in front hides them. */
export function propEdges(cell, cam, it, color, width) {
	if (it.ball) {
		const r = it.size[0] / 2, ring = (u, v) => Array.from({ length: 32 }, (_, k) => { const a = k / 32 * 2 * Math.PI; return [0, 1, 2].map(i => it.c[i] + r * (u[i] * Math.cos(a) + v[i] * Math.sin(a))); });
		for (const pts of [ring(cam.right, cam.up), ring([1, 0, 0], [0, 0, 1])]) pts.forEach((p, k) => edge(cell, p, pts[(k + 1) % pts.length], color, width));
		return;
	}
	const corner = CORNERS.map(k => { const w = qRotate(it.q, [k[0] * it.size[0] / 2, k[1] * it.size[1] / 2, k[2] * it.size[2] / 2]); return [it.c[0] + w[0], it.c[1] + w[1], it.c[2] + w[2]]; });
	for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) if (CORNERS[a].filter((v, k) => v !== CORNERS[b][k]).length === 1) edge(cell, corner[a], corner[b], color, width);
}

/** The points that frame the focus entries { joint, of } (the others are ids): each joint's place on the frames
 *  shown, as a box a hand's length (0.12 m times the body's scale) around it. Flat xyz. */
export function jointPoints(clip, frames, focus) {
	const pts = [];
	for (const { joint, of } of focus.filter(e => typeof e === "object")) {
		const c = clip.characters.find(ch => ch.id === of), j = JOINTS.indexOf(joint), r = 0.12 * (c.scale ?? 1);
		for (const f of frames) { const o = (f * JOINT_COUNT + j) * 3; for (let k = 0; k < 8; k++) pts.push(c.pos[o] + (k & 1 ? r : -r), c.pos[o + 1] + (k & 2 ? r : -r), c.pos[o + 2] + (k & 4 ? r : -r)); }
	}
	return pts;
}
