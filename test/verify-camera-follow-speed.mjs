#!/usr/bin/env node
// A shot's camera keeps a subject of any speed in its framing, and a walk is
// filmed as it was. A: a follow shot, a rail that follows and a rail aimed at
// the subject, over a straight run, a 90° corner and a stop at 1.4 to 40 m/s:
// the follow distance is exact and the subject stays near the frame centre
// (the old fixed 2.8 m/s steering cap and the lead in seconds let it leave the
// picture). B: tracks of walking subjects are the ones the code made before
// the change (test/fixtures/camera-follow-walk-tracks.json: every 6th frame of
// the camera before this change), and the corner walk the old cap was tuned on
// pans no harder.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildFollowTrack, buildRail, buildRailFollowTrack } from "../src/camera-follow.js";
import { WORLD } from "../src/world-scale.js";

const FPS = 24, DEG = 180 / Math.PI, AIM_H = 1.35, SIDE = 3;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** a run along +z for `seconds`, then on along +z, round a corner to +x, or stopped */
function path(kind, v, seconds = 3) {
	const n = seconds * FPS, pts = Array.from({ length: n }, (_, f) => ({ x: 0, z: (v * f) / FPS })), end = pts.at(-1);
	for (let f = 1; f <= n; f += 1) {
		pts.push(kind === "straight" ? { x: 0, z: end.z + (v * f) / FPS } : kind === "corner" ? { x: (v * f) / FPS, z: end.z } : { ...end });
	}
	return pts;
}
/** angle between the lens axis and the subject's chest, degrees */
function offCentre(sample, point) {
	const f = [-Math.sin(sample.yaw) * Math.cos(sample.pitch), Math.sin(sample.pitch), -Math.cos(sample.yaw) * Math.cos(sample.pitch)];
	const d = [point.x - sample.pos.x, AIM_H - sample.pos.y, point.z - sample.pos.z];
	return Math.acos(Math.min(1, (f[0] * d[0] + f[1] * d[1] + f[2] * d[2]) / Math.hypot(...d))) * DEG;
}
/** a rail drawn SIDE metres to the left of the path, densely so the corner stays a corner */
function railBeside(subject) {
	const points = [];
	for (const f of [...Array.from({ length: Math.ceil(subject.length / 6) }, (_, i) => i * 6), subject.length - 1]) {
		const a = subject[Math.max(0, f - 1)], b = subject[Math.min(subject.length - 1, f + 1)], len = Math.hypot(b.x - a.x, b.z - a.z);
		if (len < 1e-9) break;
		points.push({ x: subject[f].x - ((b.z - a.z) / len) * SIDE, z: subject[f].z + ((b.x - a.x) / len) * SIDE });
	}
	return buildRail(points.filter((p, i) => i === 0 || Math.hypot(p.x - points[i - 1].x, p.z - points[i - 1].z) > 0.05));
}

/* ---------------------------------------------------------------- A --- */
const rows = [];
for (const kind of ["straight", "corner", "stop"]) for (const v of [1.4, 2.8, 5, 10, 20, 40]) {
	const subject = path(kind, v), moving = kind === "stop" ? subject.slice(0, 3 * FPS) : subject;
	const follow = buildFollowTrack(subject, FPS);
	// the Studio's default dolly cap is the world's fastest dolly (camera-block.js), which is no cap
	const rail = buildRailFollowTrack(moving, FPS, railBeside(moving), { maxDollySpeed: WORLD.dollySpeed });
	const aimRail = buildRail([{ x: -SIDE, z: 3 * v - 0.5 }, { x: -SIDE, z: 3 * v + 0.5 }]);
	const aimed = buildRailFollowTrack(subject.map((p) => ({ ...p, y: AIM_H })), FPS, aimRail, { aimPerFrame: true, distanceInfluence: 0, pitchOffsetDeg: 0 });
	const worst = (track, of) => Math.max(...track.map((sample, f) => of(sample, f)));
	const distanceError = worst(follow, (s, f) => Math.abs(Math.hypot(s.pos.x - subject[f].x, s.pos.z - subject[f].z) - 3));
	const row = { kind, v, distanceError, follow: worst(follow, (s, f) => offCentre(s, subject[f])), rail: worst(rail, (s, f) => offCentre(s, moving[f])), aimed: worst(aimed, (s, f) => offCentre(s, subject[f])) };
	rows.push(row);
	assert.ok(distanceError < 1e-6, `${kind} ${v} m/s: the follow camera holds its distance (${distanceError})`);
	// the rail beside the path keeps abreast of the subject within two frames of its travel (plus the rounded corner)
	const railError = worst(rail, (s, f) => Math.abs(Math.hypot(s.pos.x - moving[f].x, s.pos.z - moving[f].z) - SIDE));
	assert.ok(railError <= (kind === "corner" ? 0.9 : 0) + (2 * v) / FPS, `${kind} ${v} m/s: the rail keeps abreast (${railError.toFixed(3)} m)`);
	for (const shot of ["follow", "rail", "aimed"]) assert.ok(row[shot] < 15, `${kind} ${v} m/s: the ${shot} shot keeps the subject within 15° of the centre (${row[shot].toFixed(2)}°)`);
}

// A side or front framing stays where it was set: the camera no longer slides behind a subject faster than 2.8 m/s.
for (const v of [5, 10, 20, 40]) {
	const subject = path("straight", v);
	const orbitAt = (track, f) => wrap(Math.atan2(track[f].pos.x - subject[f].x, track[f].pos.z - subject[f].z)) * DEG;
	const front = buildFollowTrack(subject, FPS, { orbitOffsetDeg: 180 }), side = buildFollowTrack(subject, FPS, { orbitOffsetDeg: 90 });
	assert.ok(front.every((_, f) => Math.abs(orbitAt(front, f)) < 1), `${v} m/s: a front framing never turns round the subject`);
	// the follow step runs one frame of travel ahead, so a side framing leans toward the front by atan(v dt / distance)
	const lean = Math.atan((v / FPS) / 3) * DEG;
	assert.ok(Math.abs(orbitAt(side, side.length - 1) - (90 - lean)) < 1, `${v} m/s: a side framing holds its side (${orbitAt(side, side.length - 1).toFixed(1)}°)`);
}

/* ---------------------------------------------------------------- B --- */
const fixture = JSON.parse(readFileSync(new URL("./fixtures/camera-follow-walk-tracks.json", import.meta.url), "utf8"));
const walkPath = (kind, v) => {
	const walk = (sec) => Array.from({ length: Math.round(sec * FPS) }, (_, f) => ({ x: 0, z: (v * f) / FPS }));
	if (kind === "straight") return walk(8);
	if (kind === "stopGo") { const w = walk(4); return [...w, ...Array.from({ length: 2 * FPS }, () => w.at(-1)), ...walk(2).map((p) => ({ x: 0, z: w.at(-1).z + p.z }))]; }
	const leg = 4 * FPS, t = Array.from({ length: leg }, (_, f) => ({ x: 0, z: (v * f) / FPS })), ze = t.at(-1).z;
	for (let f = 1; f <= leg; f += 1) t.push({ x: (v * f) / FPS, z: ze });
	return t;
};
// Tolerances: up to 1.4 m/s nothing binds that bound before (fixture rounding only); to 2.8 m/s the aim's lead is
// softened where it nears the frame limit (0.41°) and a behind follow round the corner gets 13 mm from the wider steer.
const band = (v) => (v <= 1.4 ? { mm: 0.2, deg: 0.03 } : { mm: 13, deg: 0.41 });
let worstMm = 0, worstDeg = 0;
for (const entry of fixture.cases) {
	const subject = walkPath(entry.path, entry.v);
	const track = entry.shot.startsWith("follow") ? buildFollowTrack(subject, FPS, entry.params)
		: entry.shot === "rail" ? buildRailFollowTrack(subject, FPS, buildRail(entry.railPoints))
			: buildRailFollowTrack(subject.map((p) => ({ ...p, y: AIM_H })), FPS, buildRail(entry.railPoints), { aimPerFrame: true, distanceInfluence: 0, pitchOffsetDeg: 0 });
	const sampled = track.filter((_, f) => f % fixture.every === 0);
	assert.equal(sampled.length, entry.samples.length);
	let mm = 0, deg = 0;
	sampled.forEach((s, i) => {
		const [x, y, z, yaw, pitch] = entry.samples[i];
		mm = Math.max(mm, Math.hypot(s.pos.x - x, s.pos.y - y, s.pos.z - z) * 1000);
		deg = Math.max(deg, Math.abs(wrap(s.yaw - yaw)) * DEG, Math.abs(s.pitch - pitch) * DEG);
	});
	const { mm: mmBand, deg: degBand } = band(entry.v);
	assert.ok(mm <= mmBand && deg <= degBand, `${entry.shot} ${entry.path} ${entry.v} m/s: ${mm.toFixed(2)} mm, ${deg.toFixed(3)}° from the track before (allowed ${mmBand} mm, ${degBand}°)`);
	worstMm = Math.max(worstMm, mm); worstDeg = Math.max(worstDeg, deg);
}

// The corner walk the old cap was tuned on (20 fps, 1.4 m/s, verify-camera-follow.mjs): the same largest pan step
// and the same largest jerk as before the change (2.953°/frame, 567.32 m/s³).
{
	const F = 20, leg = 80, corner = Array.from({ length: leg }, (_, f) => ({ x: 0, z: (1.4 * f) / F })), ze = corner.at(-1).z;
	for (let f = 1; f <= leg; f += 1) corner.push({ x: (1.4 * f) / F, z: ze });
	const track = buildFollowTrack(corner, F);
	const step = Math.max(...track.slice(1).map((s, i) => Math.abs(wrap(s.yaw - track[i].yaw)))) * DEG;
	let jerk = 0;
	for (let i = 3; i < track.length; i += 1) {
		jerk = Math.max(jerk, Math.hypot(...["x", "z"].map((k) => track[i].pos[k] - 3 * track[i - 1].pos[k] + 3 * track[i - 2].pos[k] - track[i - 3].pos[k])) * F ** 3);
	}
	assert.ok(step <= 2.954 && jerk <= 567.33, `corner walk: ${step.toFixed(3)}°/frame, ${jerk.toFixed(2)} m/s³`);
}

const at40 = rows.filter((row) => row.v === 40);
console.log(`verify-camera-follow-speed: ok (40 m/s, worst off-centre follow ${Math.max(...at40.map((r) => r.follow)).toFixed(1)}°, rail ${Math.max(...at40.map((r) => r.rail)).toFixed(1)}°, aimed ${Math.max(...at40.map((r) => r.aimed)).toFixed(1)}°; walks within ${worstMm.toFixed(1)} mm, ${worstDeg.toFixed(2)}° of before)`);
