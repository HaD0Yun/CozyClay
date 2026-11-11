import * as THREE from "three";
import { createSurfaceSampler } from "./physics-surface.js";

// Contact measurement for motion verification: support sites, inferred
// contact spans and the floor/slide/float metrics. It never edits a take.
export const SUPPORT_SITES = [
	{ id: "leftFoot", label: "Left foot", ko: "왼발", bone: "LeftFoot", chain: "leftFoot", kind: "foot", match: /Left(Foot|Toe)/ },
	{ id: "rightFoot", label: "Right foot", ko: "오른발", bone: "RightFoot", chain: "rightFoot", kind: "foot", match: /Right(Foot|Toe)/ },
	{ id: "leftHand", label: "Left hand", ko: "왼손", bone: "LeftHand", chain: "leftHand", kind: "hand", match: /LeftHand/ },
	{ id: "rightHand", label: "Right hand", ko: "오른손", bone: "RightHand", chain: "rightHand", kind: "hand", match: /RightHand/ },
	{ id: "leftKnee", label: "Left knee", ko: "왼무릎", bone: "LeftLeg", chain: "leftFoot", kind: "knee", match: /Left(UpLeg|Leg)$/ },
	{ id: "rightKnee", label: "Right knee", ko: "오른무릎", bone: "RightLeg", chain: "rightFoot", kind: "knee", match: /Right(UpLeg|Leg)$/ },
];
export const PHYSICS_LIMITS = Object.freeze({ root: 0.18, pull: 0.10, tilt: Math.PI / 60, floor: 0.005, slide: 0.015, float: 0.025 });
const quantile = (a, t) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s[Math.floor((s.length - 1) * t)] ?? 0; };

export function copyPhysicsKeys(keys) {
	return new Map([...keys].map(([f, entries]) => [f, new Map([...entries].map(([id, k]) => [id, {
		...k, q: k.q?.map((q) => q.clone()) ?? null, p: k.p?.clone() ?? null,
		...(k.baseQ ? { baseQ: k.baseQ.map((q) => q.clone()) } : {}),
		...(k.basePos ? { basePos: k.basePos.clone() } : {}),
		...(k.chainP ? { chainP: k.chainP.map((p) => p.clone()) } : {}),
		...(k.correctionRange ? { correctionRange: { ...k.correctionRange } } : {}),
	}]))]));
}
export function physicsKeyStamp(keys) {
	return JSON.stringify([...keys].sort((a, b) => a[0] - b[0]).map(([f, e]) => [f, [...e].sort(([a], [b]) => a.localeCompare(b)).map(([id, k]) => [id, k.p?.toArray(), k.q?.map((q) => q.toArray()), k.basePos?.toArray(), k.baseQ?.map((q) => q.toArray()), k.keepTranslations, k.chainP?.map((p) => p.toArray()), k.correctionRange])]));
}

/** Measured skin, shared exact transforms; never a cached bind-pose sole. */
export function createSupportSampler(rig) { return createSurfaceSampler(rig, SUPPORT_SITES); }

function sitePoint(row, site) {
	return site.kind === "foot" ? (row.toes?.[site.id] ?? row.support[site.id]?.position) : row.support[site.id]?.position;
}

export function supportIntervals(samples, fps, overrides = [], floorY = 0, groundAt = null) {
	const spans = [], rejected = [], count = samples.length;
	const masks = Array.from({ length: count }, () => new Map());
	for (const site of SUPPORT_SITES) {
		const floor = quantile(samples.map((r) => r.support[site.id]?.floor), 0.08);
		const flags = samples.map((r, i) => {
			const a = samples[Math.max(0, i - 2)].support[site.id], b = samples[Math.min(count - 1, i + 2)].support[site.id], c = r.support[site.id];
			const pa = sitePoint(samples[Math.max(0, i - 2)], site), pb = sitePoint(samples[Math.min(count - 1, i + 2)], site);
			if (!a || !b || !c || !pa || !pb) return false;
			const dt = (Math.min(count - 1, i + 2) - Math.max(0, i - 2)) / fps || 1 / fps;
			const localGround = r.ground?.[site.id] ?? (groundAt ? groundAt((sitePoint(r, site) ?? c.position).x, (sitePoint(r, site) ?? c.position).z, c.position.y + 0.001) : floorY);
			return c.floor < localGround + (site.kind === "foot" ? 0.15 : 0.07)
				&& c.floor < floor + 0.055 && Math.abs(b.position.y - a.position.y) / dt < 0.25
				&& Math.hypot(pb.x - pa.x, pb.z - pa.z) / dt < 0.16;
		});
		const forced = new Set();
		for (const edit of overrides.filter((o) => o.site === site.id)) {
			for (let f = Math.max(0, edit.start); f <= Math.min(count - 1, edit.end); f += 1) {
				flags[f] = edit.mode === "plant";
				if (flags[f]) forced.add(f); else forced.delete(f);
			}
		}
		let start = -1;
		for (let f = 0; f <= count; f += 1) {
			if (flags[f] && start < 0) start = f;
			if ((f === count || !flags[f]) && start >= 0) {
				const manual = [...forced].some((i) => i >= start && i < f);
				if (f - start >= Math.max(3, Math.round(fps * 0.12)) || manual) {
					const rows = samples.slice(start, f).map((r) => sitePoint(r, site));
					const anchor = new THREE.Vector3(quantile(rows.map((r) => r.x), 0.5), 0, quantile(rows.map((r) => r.z), 0.5));
					const wander = Math.max(...rows.map((r) => Math.hypot(r.x - anchor.x, r.z - anchor.z)));
					if (site.kind === "foot") anchor.y = groundAt ? groundAt(anchor.x, anchor.z, quantile(rows.map((r) => r.y), 0.5) + 0.001) : quantile(rows.map((r) => r.y), 0.5);
					const span = { id: `${site.id}:${start}`, site: site.id, start, end: f - 1, anchor, manual, wander };
					if (wander <= PHYSICS_LIMITS.pull || manual) {
						spans.push(span);
						for (let i = start; i < f; i += 1) masks[i].set(site.id, span);
					} else rejected.push({ ...span, reason: "moving-contact" });
				}
				start = -1;
			}
		}
	}
	return { spans, masks, rejected };
}

export function physicsMetrics(samples, masks, fps, floorY = 0) {
	const m = { penetration: 0, penetrationFrame: 0, float: 0, floatFrame: 0, slide: 0, slideFrame: 0, meanSlide: 0, kneeStep: 0, kneeStepFrame: 0, kneeAcceleration: 0, rootAcceleration: 0, count: 0, surfaceMeasured: samples.every((s) => SUPPORT_SITES.slice(0, 2).every((site) => s.support[site.id]?.vertices > 0)) };
	for (let f = 0; f < samples.length; f += 1) {
		for (const [id, point] of Object.entries(samples[f].support)) if (point.vertices > 0) { const g = samples[f].ground?.[id] ?? floorY; if (g - point.floor > m.penetration) { m.penetration = g - point.floor; m.penetrationFrame = f; } }
		for (const site of SUPPORT_SITES) {
			const r = samples[f].support[site.id]; if (!r) continue;
			const ground = samples[f].ground?.[site.id] ?? floorY;
			const depth = Math.max(0, ground - r.floor);
			if (depth > m.penetration) { m.penetration = depth; m.penetrationFrame = f; }
			const span = masks[f]?.get(site.id);
			if (span) {
				const point = sitePoint(samples[f], site);
				const slide = Math.hypot(point.x - span.anchor.x, point.z - span.anchor.z);
				if (slide > m.slide) { m.slide = slide; m.slideFrame = f; }
				const gap = Math.max(0, r.floor - ground);
				if (gap > m.float) { m.float = gap; m.floatFrame = f; }
				m.meanSlide += slide; m.count += 1;
			}
		}
		for (const side of ["leftFoot", "rightFoot"]) {
			if (f > 0) {
				const step = Math.abs(samples[f].knees[side] - samples[f - 1].knees[side]);
				if (step > m.kneeStep) { m.kneeStep = step; m.kneeStepFrame = f; }
			}
			if (f > 1) {
				const a = Math.abs(samples[f].knees[side] - 2 * samples[f - 1].knees[side] + samples[f - 2].knees[side]) * fps * fps;
				if (a > m.kneeAcceleration) { m.kneeAcceleration = a; m.kneeAccelerationFrame = f; }
			}
		}
		if (f > 1) {
			const a = samples[f].root.clone().add(samples[f - 2].root).addScaledVector(samples[f - 1].root, -2).length() * fps * fps;
			if (a > m.rootAcceleration) { m.rootAcceleration = a; m.rootAccelerationFrame = f; }
		}
	}
	m.meanSlide /= m.count || 1;
	return m;
}
