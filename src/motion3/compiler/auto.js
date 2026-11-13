// The walk's automatic rules outside the walk (#1080) and the gaze toward a target (#1081), on the baked channels before
// the frames are solved (compile.js rebake). spec.auto: undefined = all on, false = all off, { knee, foot, arms, look }
// each true | false. A rule fills only a channel nobody keys (the agent or a skill: the walk keys its feet and arms, a
// sit its knee poles, and a held key value is a choice too), so a spec that keys a channel keeps it exactly as before.
//   foot   a foot whose ankle target stands still on the ground (PLANT m/s) is planted: it keeps the heading it landed
//          with (fyaw); between plants it turns to the heading of its next landing, for a step that lifts LIFT m and
//          travels STEP m or more (a foot slid along the floor keeps the body's heading, the old default). Its pitch is
//          left flat: a heel roll on a keyed ankle path (not the walk's, which pivots the ankle on the ball) put the ball on
//          the floor while the ankle still moved (the h-sit fixture: 4 SLIDE groups)
//   knee   the knee points over its foot: the pole turns with the heading the foot rule set against the body's (knee_*)
//   arms   an arm free for the whole take (no key puts it on IK or a target, it holds nothing) swings against its own leg
//          while the hips travel (aswing, abend)
//   look   spec.look [{ f, at }]: at "object:<id>" | "anchor:<name>" | [x, y, z] | null; head_yaw and head_pitch turn the
//          head to it each frame (an object where its keys, hinge or fall put it), eased over TURN frames between
//          targets; while a look is set it decides the head, null hands the head back to its keys
import { ry, apply, sub, add, clamp } from "./math.js";

const PLANT = 0.25, STEP = 0.05, LIFT = 0.03, SWING_GAIN = 55, SWING_MAX = 22, TRAVEL = 0.15, TURN = 8;
export const smooth = x => x * x * (3 - 2 * x);
const deg = r => (r * 180) / Math.PI;
const wrap = a => a - 360 * Math.round(a / 360);

function autoOptions(auto) {
	if (auto === false) return { knee: false, foot: false, arms: false, look: false };
	const a = auto && typeof auto === "object" ? auto : {};
	return { knee: a.knee !== false, foot: a.foot !== false, arms: a.arms !== false, look: a.look !== false };
}

/** Per channel, the frames its keys own: [first, last] key frame. */
function spans(keys) {
	const s = new Map();
	for (const k of keys ?? []) for (const ch of Object.keys(k.set ?? {})) {
		const [a, b] = s.get(ch) ?? [Infinity, -Infinity];
		s.set(ch, [Math.min(a, k.f), Math.max(b, k.f)]);
	}
	return s;
}

/** The rule's share at frame f for a channel its keys own over span (0 inside, easing to 1 EDGE frames outside). */
/** Sets channel ch to the rule's values when nobody keys it (span: its keys' frames, undefined when none). */
function fill(baked, ch, span, values) {
	if (!span) baked[ch] = values;
}

/** Planted runs and steps of one foot from its baked ankle target. */
function footRuns(foot, fps, groundY) {
	const n = foot.length, planted = new Array(n).fill(false), lim = PLANT / fps;
	for (let f = 0; f < n; f++) {
		const a = foot[Math.max(0, f - 1)], b = foot[Math.min(n - 1, f + 1)], v = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / Math.max(1, Math.min(n - 1, f + 1) - Math.max(0, f - 1));
		planted[f] = v < lim && foot[f][1] < groundY + 0.04;
	}
	return planted;
}

/** spec.look's target point at frame f (null: none). */
function lookPoint(ctx, at, f) {
	if (Array.isArray(at)) return at;
	if (typeof at !== "string") return null;
	const [kind, ...rest] = at.split(":"), id = rest.join(":");
	const objectPos = oid => { const box = ctx.objectsAt?.(f)?.[oid] ?? ctx.scene?.objects?.[oid]; return box?.pos ? (box.center ?? box.pos) : null; };
	if (kind === "object") return objectPos(id);
	if (kind === "anchor") {
		const a = ctx.spec.anchors?.[id];
		if (a?.kind === "world" && Array.isArray(a.p)) return a.p;
		if (a?.object) return objectPos(a.object);
	}
	return null;
}

/** Fills the automatic channels into out.baked (compile.js rebake, after the head's own layers). -> { rules, frames } or null */
export function autoLayer(out, ctx) {
	const { spec, sk } = ctx, baked = out.baked, n = out.frameCount, fps = out.fps, opt = autoOptions(spec.auto);
	const own = spans(out.keys), report = {};
	const yawAt = f => baked.yaw?.[f] ?? 0;
	const groundY = sk.restWorldPos[sk.index.LeftFoot]?.[1] ?? 0.09;
	const feet = { l: baked.foot_l, r: baked.foot_r };
	const heading = {};
	if (opt.foot) for (const k of ["l", "r"]) {
		const foot = feet[k];
		if (!foot) continue;
		const planted = footRuns(foot, fps, groundY), yaw = new Array(n);
		// a planted run keeps the body's heading where it began; a step turns to its landing's
		let f = 0, held = yawAt(0);
		while (f < n) {
			if (planted[f]) { held = yawAt(f); while (f < n && planted[f]) yaw[f++] = held; continue; }
			const a = f; while (f < n && !planted[f]) f++;
			const b = f - 1, land = f < n ? yawAt(f) : yawAt(n - 1), from = held, d = wrap(land - from), L = b - a + 1;
			// a step lifts the foot (LIFT m) and travels STEP m; a foot slid along the floor keeps the old default (the body's heading, flat)
			let top = 0;
			for (let i = a; i <= b; i++) top = Math.max(top, foot[i][1] - groundY);
			const step = top >= LIFT && Math.hypot(foot[b][0] - foot[a][0], foot[b][2] - foot[a][2]) >= STEP;
			for (let i = a; i <= b; i++) {
				const u = (i - a + 0.5) / L;
				yaw[i] = step ? from + d * smooth(u) : yawAt(i);
			}
			held = step ? land : yawAt(b);
		}
		heading[k] = yaw;
		fill(baked, `fyaw_${k}`, own.get(`fyaw_${k}`), yaw);
		report.foot = (report.foot ?? 0) + planted.filter(x => !x).length;
	}
	if (opt.knee) for (const k of ["l", "r"]) {
		// only beside a foot heading the rule set: a keyed heading with an unkeyed knee is a pose the keys chose (fixture L2)
		if (!feet[k] || own.has(`fyaw_${k}`)) continue;
		const fy = baked[`fyaw_${k}`], pole = Array.from({ length: n }, (_, f) => apply(ry(clamp(wrap((fy?.[f] ?? yawAt(f)) - yawAt(f)), -70, 70)), [0, 0, 1]));
		fill(baked, `knee_${k}`, own.get(`knee_${k}`), pole);
		report.knee = true;
	}
	if (opt.arms && baked.root && feet.l && feet.r) {
		const root = baked.root, speed = Array.from({ length: n }, (_, f) => { const a = root[Math.max(0, f - 1)], b = root[Math.min(n - 1, f + 1)]; return Math.hypot(b[0] - a[0], b[2] - a[2]) * fps / Math.max(1, Math.min(n - 1, f + 1) - Math.max(0, f - 1)); });
		for (const k of ["l", "r"]) {
			// only an arm no key touches (IK, a target, a pole, its own swing or wrist): a posed arm is the keys' business (the elbow fixtures)
			if (ctx.busy?.[k] || [...own.keys()].some(ch => new RegExp(`^((armw|hand|elbow|aswing|abend|wtwist|wflex)_${k}|w_.+_${k})$`).test(ch))) continue;
			const swing = new Array(n).fill(0), bend = new Array(n).fill(0), busy = ctx.busy?.[k];
			for (let f = 0; f < n; f++) {
				const free = 1 - Math.max(clamp(baked[`armw_${k}`]?.[f] ?? 0, 0, 1), busy?.[f] ?? 0);
				const travel = clamp((speed[f] - TRAVEL) / 0.5, 0, 1), y = (yawAt(f) * Math.PI) / 180, fwd = [Math.sin(y), 0, Math.cos(y)];
				const d = (feet[k][f][0] - root[f][0]) * fwd[0] + (feet[k][f][2] - root[f][2]) * fwd[2];
				swing[f] = clamp(-SWING_GAIN * d, -SWING_MAX, SWING_MAX) * travel * free;
				bend[f] = (10 + 0.4 * Math.max(0, swing[f])) * travel * free;
			}
			// a moving average over 5 frames: the swing follows the legs without their contact jerks
			const avg = a => a.map((_, f) => { let s = 0, c = 0; for (let i = f - 2; i <= f + 2; i++) if (i >= 0 && i < n) { s += a[i]; c++; } return s / c; });
			if (swing.some(v => Math.abs(v) > 0.5)) {
				fill(baked, `aswing_${k}`, own.get(`aswing_${k}`), avg(swing));
				fill(baked, `abend_${k}`, own.get(`abend_${k}`), avg(bend));
				report.arms = true;
			}
		}
	}
	const looks = opt.look && Array.isArray(spec.look) ? spec.look.filter(l => l && Number.isInteger(l.f)).sort((a, b) => a.f - b.f) : [];
	if (looks.length) {
		const head = sk.index.Head, hips = sk.index.Hips, rel = sub(sk.restWorldPos[head], sk.restWorldPos[hips]);
		const kept = { yaw: baked.head_yaw?.slice() ?? new Array(n).fill(0), pitch: baked.head_pitch?.slice() ?? new Array(n).fill(0) };
		const anglesAt = (at, f) => {
			const p = lookPoint(ctx, at, f), root = baked.root?.[f];
			if (!p || !root) return null;
			const h = add(root, apply(ry(yawAt(f)), rel)), dw = sub(p, h), dl = apply(ry(-yawAt(f)), dw);
			const yaw = clamp(deg(Math.atan2(dl[0], dl[2])), -75, 75);
			const pitch = clamp(deg(Math.atan2(-dl[1], Math.hypot(dl[0], dl[2]))) - (baked.spine_pitch?.[f] ?? 0) - (baked.pitch?.[f] ?? 0), -45, 70);
			return [yaw, pitch];
		};
		const target = f => { let at; for (const l of looks) if (l.f <= f) at = l.at; return at; };
		const hy = new Array(n), hp = new Array(n);
		let lastSwitch = -Infinity, from = null;
		for (let f = 0; f < n; f++) {
			const at = target(f), sw = looks.find(l => l.f === f);
			if (sw && f > 0) { lastSwitch = f; from = [hy[f - 1], hp[f - 1]]; }
			const want = at === undefined || at === null ? null : anglesAt(at, f);
			const base = want ?? [kept.yaw[f], kept.pitch[f]], u = from ? smooth(Math.min(1, (f - lastSwitch) / TURN)) : 1;
			hy[f] = from ? from[0] + (base[0] - from[0]) * u : base[0];
			hp[f] = from ? from[1] + (base[1] - from[1]) * u : base[1];
		}
		baked.head_yaw = hy; baked.head_pitch = hp;
		report.look = looks.length;
	}
	return Object.keys(report).length ? report : null;
}
