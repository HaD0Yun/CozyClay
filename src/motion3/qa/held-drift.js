// A held object that leaves the hand (a user session: a box keyed to move while the arms faded off it
// floated 0.6-0.8 m from the hands and scored 5 problems, fewer than a take whose box followed the hand), as plain issues:
//   HELD_OBJECT_DRIFT "<id>: hand 62.0 cm from it while it moves": at a frame where spec object <id> moves (its first
//   box more than MOVE m from the frame before) and some hand holds it (a hand on an object anchor of <id> at weight >= 0.5,
//   or the hand that carries it), the nearest such hand is more than DRIFT m from its grip point (the anchor's point, or
//   the carried object's surface). One group per object (the numbers in the subject do not split it).
// Let-go exemption: no issue within LET_GO frames after a release key of <id>, or after a hand's anchor weight on <id>
// leaves its hold (the last frame at >= HOLD before it falls under 0.5). A throw lets go by fading the anchor while the
// object flies on its keys: in a bench throw take the ball's anchor weight is 1 at f66, 0.9 / 0.65 / 0.35 / 0.1 at f67-70
// and 0 at f71, and the ball was 58 cm from the hand at f68 (L+2). LET_GO = 6 covers that whole 5-frame fade plus a frame.
// Not an ifClean blocker: it counts as one group like any other.
import { add, scale, sub, len } from "../compiler/math.js";
import { resolveAnchor } from "../compiler/anchors.js";
import { objectBoxesAt, handOf } from "../object-pose.js";
import { sdBox } from "./geometry.js";

const DRIFT = 0.25, MOVE = 0.002, LET_GO = 6, HOLD = 0.99, SIDE = { l: "Left", r: "Right" };
const ANCHOR_W = /^w_(.+)_([lr])$/;

/** The object anchors of `id` a hand leads with at frame c (weight >= 0.5): [{ name, k, ch }]. */
const holdsOf = (anchors, id, c) => Object.entries(c).flatMap(([ch, w]) => {
	const m = ANCHOR_W.exec(ch), a = m && anchors[m[1]];
	return m && w >= 0.5 && a?.kind === "object" && a.object === id ? [{ name: m[1], k: m[2], ch }] : [];
});

/** Absolute frames where a hand lets go of `id`: its release key, and each last frame at hold weight before an anchor of it falls under 0.5. */
function letGoFrames(out, id, anchors) {
	const f0 = out.f0 ?? 0, at = new Set(), release = out.ctx.spec.objects[id]?.release;
	if (Number.isFinite(release)) at.add(release);
	const chs = new Set(out.frames.flatMap(fr => Object.keys(fr.c).filter(ch => { const m = ANCHOR_W.exec(ch); return m && anchors[m[1]]?.kind === "object" && anchors[m[1]].object === id; })));
	for (const ch of chs) {
		let held = null;
		out.frames.forEach((fr, i) => {
			const w = fr.c[ch] ?? 0;
			if (w >= HOLD) held = i + f0;
			else if (w < 0.5 && held !== null) { at.add(held); held = null; }
		});
	}
	return [...at];
}

export function heldDriftIssues(sk, out) {
	const { ctx } = out, anchors = ctx.spec.anchors ?? {}, f0 = out.f0 ?? 0, I = sk.index, issues = [];
	const palm = (s, k) => scale(add(s.P[I[`${SIDE[k]}HandIndex2`]], s.P[I[`${SIDE[k]}HandMiddle2`]]), 0.5);
	for (const id of Object.keys(ctx.spec.objects ?? {})) {
		const letGo = letGoFrames(out, id, anchors), excused = f => letGo.some(L => f > L && f <= L + LET_GO);
		let prev = null;
		for (let i = 0; i < out.frames.length; i++) {
			const f = i + f0, boxes = objectBoxesAt(out, id, f), now = boxes?.length ? boxes[0].pos : null, moved = prev && now && len(sub(now, prev)) > MOVE;
			prev = now;
			if (!moved || excused(f)) continue;
			const { s, c, diag } = out.frames[i], carrier = handOf(out, id, f);
			let best = carrier ? Math.max(0, Math.min(...boxes.map(b => sdBox(palm(s, carrier), b)))) : Infinity;
			for (const { name, k } of holdsOf(anchors, id, c)) {
				let p;
				try { p = resolveAnchor(ctx, name, s, { ...diag, frame: f }, c); } catch { continue; }
				best = Math.min(best, len(sub(palm(s, k), p)), len(sub(s.P[I[`${SIDE[k]}Hand`]], p)));
			}
			if (Number.isFinite(best) && best > DRIFT) issues.push({ kind: "HELD_OBJECT_DRIFT", msg: `${id}: hand ${(best * 100).toFixed(1)} cm from it while it moves`, frame: i, value: +best.toFixed(4), limit: DRIFT });
		}
	}
	return issues;
}

/** explain.js: the object left the hand; where to key. */
export const heldDriftHints = {
	HELD_OBJECT_DRIFT(X, g) {
		const id = g.subject.split(":")[0], hold = holdsOf(X.spec.anchors ?? {}, id, X.fr(g.worstFrame).c)[0];
		const keep = hold ? `keep ${hold.ch} and armw_${hold.k} at 1 through f${g.first}-f${g.last}` : `put a hand on ${id} through f${g.first}-f${g.last}`;
		return { cause: hold ? X.cause(`armw_${hold.k}`, g.worstFrame) : `objects.${id}.keys`, hint: `${id} left the hand while it moves (f${g.first}-f${g.last}): ${keep}, or carry ${id} (prop + grab/release) so it follows the hand` };
	},
};
