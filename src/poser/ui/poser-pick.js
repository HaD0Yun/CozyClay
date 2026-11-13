// Screen-space picking for Auto Pose handles and turn rings. Pure: callers project 3D points to pixels first.

/** Extra reach past a handle's projected edge, in pixels. */
export const PICK_MARGIN_PX = 6;
/** How near a press must land to a turn ring's drawn line, in pixels. */
const RING_PICK_PX = 8;

/**
 * The handle a press at (x, y) grabs. Candidates: `{ id, x, y, reach, enabled }` (projected centre and reach in px).
 * Nearest wins among those in reach; an enabled handle wins a near tie against a switched-off one.
 */
export function pickHandle(candidates, x, y) {
	let best = null, bestScore = Infinity;
	for (const c of candidates) {
		const gap = Math.hypot(c.x - x, c.y - y);
		if (gap > c.reach) continue;
		const score = gap - (c.enabled ? 4 : 0);
		if (score < bestScore) { best = c; bestScore = score; }
	}
	return best;
}

/** Distance in px from (x, y) to the segment (ax, ay)-(bx, by). */
function segmentGap(x, y, ax, ay, bx, by) {
	const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
	const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
	return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/**
 * The turn ring a press grabs. `rings`: `{ axis, points: [[x, y, inFront], ...] }` with each ring's sampled outline
 * in px, closed; `inFront` false for samples behind the camera (skipped). Nearest ring within `tolerance` wins.
 */
export function pickRing(rings, x, y, tolerance = RING_PICK_PX) {
	let best = null, bestGap = tolerance;
	for (const ring of rings) {
		const pts = ring.points;
		for (let i = 0; i < pts.length; i += 1) {
			const a = pts[i], b = pts[(i + 1) % pts.length];
			if (!a[2] || !b[2]) continue;
			const gap = segmentGap(x, y, a[0], a[1], b[0], b[1]);
			if (gap <= bestGap) { best = ring.axis; bestGap = gap; }
		}
	}
	return best;
}
