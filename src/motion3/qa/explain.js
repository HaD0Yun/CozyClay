// Actionable QA: every issue group gets a `cause` (the spec element most responsible: a key and
// channel, an anchor, a fit, a generator step, a skill) and a `hint` (what to change, with a
// direction and an amount in world metres or degrees, at a frame). Hints are derived from the
// geometry of the worst frame and from the keys that bracket it. A hint function returns
// { cause, hint, fix? }; fix rides on the group unseen (non-enumerable) for qa/patch.js.
import { keyReachHints } from "./key-reach.js";
import { contactHints } from "./hints-contact.js";
import { motionHints } from "./hints-motion.js";
import { objectHints } from "./hints-object.js";
import { goalHints } from "./hints-goal.js";
import { wristHints } from "./wrist-checks.js";
import { loadHints } from "../load.js";
import { graspHints } from "./hints-grasp.js";
import { fingerHints } from "./finger-checks.js";
import { heldDriftHints } from "./held-drift.js";
import { attachPatches } from "./patch.js";

const HINTS = { ...keyReachHints, ...contactHints, ...motionHints, ...objectHints, ...goalHints, ...wristHints, ...loadHints, ...graspHints, ...fingerHints, ...heldDriftHints };

function keyTable(out) {
	const byCh = new Map();
	for (const k of out.keys ?? []) for (const ch of Object.keys(k.set ?? {})) {
		if (!byCh.has(ch)) byCh.set(ch, []);
		byCh.get(ch).push({ f: k.f, src: k.src ?? "keys", step: k.step?.includes(ch), ...(k.fill ? { fill: true } : {}) });
	}
	for (const list of byCh.values()) list.sort((a, b) => a.f - b.f);
	return byCh;
}

/** The context every hint function reads: frames by absolute index, keys, drivers. */
function context(sk, out, spec) {
	const table = keyTable(out);
	const X = {
		sk, out, spec, I: sk.index,
		fr: f => out.frames[Math.max(0, Math.min(out.frames.length - 1, f - (out.f0 ?? 0)))],
		rel: f => Math.max(0, Math.min(out.frames.length - 1, f - (out.f0 ?? 0))),
		keys: ch => table.get(ch) ?? [],
		bracket(ch, f) {
			const list = X.keys(ch);
			let prev = null, next = null;
			for (const k of list) { if (k.f <= f) prev = k; else { next = k; break; } }
			return { prev, next };
		},
		/** "keys[12] f200 hand_r" when a key sits within 2 frames, else the two keys around f. */
		cause(ch, f) {
			const { prev, next } = X.bracket(ch, f);
			if (!prev && !next) return `${ch} (not keyed)`;
			const near = prev && f - prev.f <= 2 ? prev : next && next.f - f <= 2 ? next : null;
			if (near) return `${near.src} f${Math.round(near.f)} ${ch}${near.fill ? " (a MotionBricks fill key: patch the authored key at either end of this gap, or set fill: false; do not nudge fill keys by millimetres)" : ""}`;
			if (!next) return `${ch} held since ${prev.src} f${Math.round(prev.f)}`;
			if (!prev) return `${ch} before ${next.src} f${Math.round(next.f)}`;
			return `${ch} between ${prev.src} f${Math.round(prev.f)} and ${next.src === prev.src ? "" : `${next.src} `}f${Math.round(next.f)}`;
		},
		/** What drives hand k at frame f: an anchor weight, the hand target, or the FK arm. */
		hand(k, f) {
			const c = X.fr(f).c;
			if (!(c[`armw_${k}`] > 0.5)) return { label: `arm ${k} (FK: aswing_${k}/abend_${k}, or armw_${k} 1 and hand_${k})`, ch: `aswing_${k}` };
			let best = null;
			for (const [ch, w] of Object.entries(c)) {
				const mm = /^w_(.+)_([lr])$/.exec(ch);
				if (mm && mm[2] === k && w > 0.5 && (!best || w > best.w)) best = { w, anchor: mm[1], ch };
			}
			if (!best) return { label: `hand_${k}`, ch: `hand_${k}` };
			const fit = (spec.fits ?? []).findIndex(ft => ft.anchor === best.anchor && ft.side === k);
			return { label: `anchor ${best.anchor}`, ch: best.ch, anchor: best.anchor, fit: fit >= 0 ? fit : null };
		},
	};
	return X;
}

/** Adds cause + hint (+ patch) to the first `limit` groups (mutates and returns them); userSpec is what patches address. */
export function explainGroups(sk, out, spec, groups, { limit = 16, userSpec } = {}) {
	if (!groups.length) return groups;
	const X = context(sk, out, spec);
	for (const g of groups.slice(0, limit)) {
		try {
			const r = HINTS[g.kind]?.(X, g);
			if (r) { g.cause = r.cause; g.hint = r.hint; }
			if (r?.fix) Object.defineProperty(g, "fix", { value: r.fix, enumerable: false, configurable: true });
		} catch (error) {
			g.cause = "unknown"; g.hint = `no hint (${error.message})`;
		}
	}
	return attachPatches(groups, { X, userSpec });
}
