// Shared by the MotionBricks experiments: the pinned NVlabs/motionbricks assets (cached locally, never committed: the sample
// clips are under the NVIDIA Sample Data Evaluation License) and a BVH reader that yields SOMA model-space poses.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SOMA_JOINTS } from "../../src/motion3/bricks/soma.js";
import { mul, apply } from "../../src/motion3/compiler/math.js";

const COMMIT = "54fc563aeaaf819a753d72cc9fdc6713989cdd43";
export const RAW = `https://raw.githubusercontent.com/NVlabs/motionbricks/${COMMIT}/`, MEDIA = `https://media.githubusercontent.com/media/NVlabs/motionbricks/${COMMIT}/`;
const CACHE = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "cozyclay", "motionbricks", "soma-clips");
const DEG = Math.PI / 180;
export const resolve = (base, rel) => { const parts = base.split("/").slice(0, -1); for (const p of rel.split("/")) { if (p === "..") parts.pop(); else if (p !== ".") parts.push(p); } return parts.join("/"); };
export async function cached(url, name) {
	mkdirSync(CACHE, { recursive: true });
	const file = join(CACHE, name);
	if (!existsSync(file)) { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url}`); writeFileSync(file, await r.text()); }
	return readFileSync(file, "utf8");
}

/** BVH -> { joints: [{ name, parent, offset, channels }], frames: number[][], dt }. */
export function parseBvh(text) {
	const lines = text.split(/\r?\n/), joints = [], stack = [];
	let i = 0;
	for (; i < lines.length; i++) {
		const l = lines[i].trim();
		if (l.startsWith("MOTION")) break;
		let m;
		if ((m = /^(ROOT|JOINT)\s+(\S+)/.exec(l))) { joints.push({ name: m[2], parent: stack.at(-1) ?? -1, offset: [0, 0, 0], channels: [] }); stack.push(joints.length - 1); }
		else if (l.startsWith("End Site")) stack.push(-2);
		else if (l === "}") stack.pop();
		else if ((m = /^OFFSET\s+(.+)/.exec(l)) && stack.at(-1) >= 0) joints[stack.at(-1)].offset = m[1].split(/\s+/).map(Number);
		else if ((m = /^CHANNELS\s+\d+\s+(.+)/.exec(l))) joints[stack.at(-1)].channels = m[1].split(/\s+/);
	}
	const n = Number(/Frames:\s*(\d+)/.exec(lines[i + 1])[1]), dt = Number(/Frame Time:\s*([\d.]+)/.exec(lines[i + 2])[1]);
	const frames = lines.slice(i + 3, i + 3 + n).map(l => l.trim().split(/\s+/).map(Number));
	return { joints, frames, dt };
}

const rot = (axis, a) => { const c = Math.cos(a), s = Math.sin(a); return axis === "X" ? [[1, 0, 0], [0, c, -s], [0, s, c]] : axis === "Y" ? [[c, 0, s], [0, 1, 0], [-s, 0, c]] : [[c, -s, 0], [s, c, 0], [0, 0, 1]]; };

/** World rotations (SOMA model space) and the Hips position (m) of one BVH frame. */
export function bvhPose(bvh, t) {
	const f = Math.max(0, Math.min(bvh.frames.length - 1, Math.round(t / bvh.dt))), row = bvh.frames[f];
	const W = [], Pw = [];
	let k = 0;
	bvh.joints.forEach((j, idx) => {
		let R = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
		const p = [...j.offset];
		for (const ch of j.channels) {
			const v = row[k++];
			if (ch.endsWith("position")) p["XYZ".indexOf(ch[0])] = v;
			else R = mul(R, rot(ch[0], v * DEG));
		}
		const pos = j.channels.some(c => c.endsWith("position")) ? p : j.offset;
		const parentR = j.parent < 0 ? [[1, 0, 0], [0, 1, 0], [0, 0, 1]] : W[j.parent], parentP = j.parent < 0 ? [0, 0, 0] : Pw[j.parent];
		W[idx] = mul(parentR, R);
		const o = apply(parentR, pos);
		Pw[idx] = [parentP[0] + o[0], parentP[1] + o[1], parentP[2] + o[2]];
	});
	const byName = Object.fromEntries(bvh.joints.map((j, idx) => [j.name, idx]));
	const R = SOMA_JOINTS.map(n => W[byName[n]]);
	const root = Pw[byName.Hips].map(v => v / 100);
	return { root, R };
}

