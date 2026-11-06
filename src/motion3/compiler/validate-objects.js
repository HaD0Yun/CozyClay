// Validation of spec.objects (C3): a hinge { pivot, axis?, channel } or a carry { prop, grab?,
// release?, at?, along?, visible?, level?, keys? }. Both take a body or a group (Empty) id; at/along
// pin the palm offset (a group: its root; without them a group keeps its grab-frame offset); keys
// (C14) pose a carried object while it is in hand (rot, or aim + roll: C16). A switch { visible?,
// level? } (C15: no prop, no hinge field) takes any record, a light or an effect too, and moves
// nothing; so does a follow { follow, offset?, aim?, visible?, level? } (C16), which rides a point
// of the body. A free entry { keys?, fall?, visible?, level? } (C17: no prop, no follow, no hinge field) moves a body or a
// group on its own: world pose keys over the whole take, and gravity falls; a carry takes fall too, before its grab
// or from its release on. Fields: schema/fields.js OBJECT_FIELDS, OBJECT_KEY_FIELDS, FALL_FIELDS. See validate.js.
import { isVec3, fmt, didYouMean, CARRY_GRASPS } from "./vocab.js";
import { objectOk } from "./validate-common.js";
import { OBJECT_FIELDS, OBJECT_KEY_FIELDS, FALL_FIELDS, SPRING_FIELDS } from "../schema/fields.js";
import { SPRING } from "./spring.js";
import { isSwitch, isFollow, movesRecord } from "../carried.js";
import { isFree } from "../free-motion.js";
import { checkRef } from "../refs.js";
import { partsOf } from "../object-pose.js";

const KEY = "{ f, pos: [x, y, z], rot: [x, y, z, w] } or { f, pos, aim: [x, y, z], roll? }", FALL = "{ at, onto?, bounce?, tumble?, v? }";
const isQuat = q => Array.isArray(q) && q.length === 4 && q.every(Number.isFinite) && Math.abs(Math.hypot(...q) - 1) <= 0.01;
const isDir = v => isVec3(v) && Math.hypot(...v) > 1e-9;

/** A key's rotation: rot (a unit quaternion) or aim (a world direction for its +Y) with an optional roll (degrees about it), not both. */
function keyTurnOk(err, kat, k) {
	if (k.rot !== undefined && k.aim !== undefined) return err(`${kat} gives both rot and aim; give one: rot [x, y, z, w], or aim [x, y, z] (the world direction its +Y points) with roll`);
	if (k.aim === undefined) {
		if (k.roll !== undefined) err(`${kat}.roll turns the object about aim; give aim [x, y, z] with it, or leave roll out (rot fixes the roll)`);
		if (k.lean !== undefined) err(`${kat}.lean lets the compiler lean aim; give aim [x, y, z] with it (rot is used exactly)`);
		if (!isQuat(k.rot)) err(`${kat}.rot must be a unit quaternion [x, y, z, w], got ${fmt(k.rot)}${k.rot === undefined ? "; or give aim [x, y, z], the world direction its +Y points" : ""}`);
		return;
	}
	if (!isDir(k.aim)) err(`${kat}.aim must be a non-zero world direction [x, y, z] for the object's +Y (a bat: knob to barrel), got ${fmt(k.aim)}`);
	if (k.roll !== undefined && !Number.isFinite(k.roll)) err(`${kat}.roll must be degrees about aim (a number), got ${fmt(k.roll)}`);
	if (k.lean !== undefined && !(Number.isFinite(k.lean) && k.lean >= 0 && k.lean <= 45)) err(`${kat}.lean must be the most degrees the compiler may lean aim (0..45), got ${fmt(k.lean)}`);
}

/** objects.<id>.keys (C14): whole frames inside grab..release (free, C17: the whole take), one per frame, a world position and a unit quaternion. */
function validateKeys(err, unknown, at, o, frames, free = false) {
	if (!Array.isArray(o.keys)) return err(`${at}.keys must be an array of ${KEY}`);
	const last = Number.isInteger(frames) ? frames - 1 : Infinity, lo = free ? 0 : o.grab ?? 0, hi = free ? last : o.release ?? last, seen = new Map();
	o.keys.forEach((k, i) => {
		const kat = `${at}.keys[${i}]`;
		if (!k || typeof k !== "object" || Array.isArray(k)) return err(`${kat} must be ${KEY}, got ${fmt(k)}`);
		for (const f of Object.keys(k)) if (!OBJECT_KEY_FIELDS.includes(f)) unknown(`${kat} has unknown field "${f}"${didYouMean(f, OBJECT_KEY_FIELDS)}; a key is ${KEY}`);
		if (!Number.isInteger(k.f)) err(`${kat}.f must be a whole frame, got ${fmt(k.f)}`);
		else if (k.f < lo || k.f > hi) err(free ? `${kat}.f = ${k.f} is outside the take (0..${hi})` : `${kat}.f = ${k.f} is outside grab..release (${lo}..${hi}); keys pose a carried object only while it is in hand (drop its prop to move it on its own, C17)`);
		else if (seen.has(k.f)) err(`${kat}.f = ${k.f}: keys[${seen.get(k.f)}] is at that frame already; one key per frame`);
		else seen.set(k.f, i);
		if (!isVec3(k.pos)) err(`${kat}.pos must be [x, y, z], the world position of the object's base (a group: its root), got ${fmt(k.pos)}`);
		keyTurnOk(err, kat, k);
	});
}

/** An object: ref a follow entry may use: one no follow entry moves (else it would follow itself). */
function stillRef(spec, err, scene, at, ref) {
	const id = /^object:(.+?)(?:\.(?:center|top|base))?$/s.exec(ref)?.[1];
	if (id === undefined) return;
	const movers = partsOf(scene, id).flatMap(p => [p, ...(scene.objects[p].ancestors ?? [])].find(k => movesRecord(spec.objects?.[k])) ?? []);
	const by = movers.find(k => isFollow(spec.objects[k]));
	if (by) err(`${at} "${ref}": "${id}" moves with the follow entry objects.${by}; a follow entry rides a joint, landmark, prop or anchor point, or an object no follow entry moves`);
}

/** follow (C16): a point ref, offset along the record's own axes, aim "face" | "up" | [x, y, z] | a point ref. */
function validateFollow(spec, err, ctx, at, o) {
	if (checkRef(spec, err, ctx, `${at}.follow`, o.follow)) stillRef(spec, err, ctx.scene, `${at}.follow`, o.follow);
	if (o.offset !== undefined && !isVec3(o.offset)) err(`${at}.offset must be [x, y, z], metres along the record's own axes after aim (+Y along aim), got ${fmt(o.offset)}`);
	const aim = o.aim;
	if (aim === undefined || aim === "face" || aim === "up") return;
	if (Array.isArray(aim)) { if (!isDir(aim)) err(`${at}.aim must be a non-zero world direction [x, y, z], got ${fmt(aim)}`); return; }
	if (typeof aim !== "string" || !/^[a-z]+:/.test(aim)) return err(`${at}.aim must be "face", "up", a world direction [x, y, z] or a point ref (toward it), where the record's +Y points; got ${fmt(aim)}`);
	if (checkRef(spec, err, ctx, `${at}.aim`, aim)) stillRef(spec, err, ctx.scene, `${at}.aim`, aim);
}

function frameOk(err, at, v, frames) {
	if (v === undefined) return true;
	if (Number.isInteger(v) && v >= 0 && (!Number.isInteger(frames) || v < frames)) return true;
	err(`${at} must be a whole frame 0..${Number.isInteger(frames) ? frames - 1 : "frames-1"}, got ${fmt(v)}`);
	return false;
}

/** objects.<id>.fall (C17): { at, onto?, bounce?, tumble? } or a list, each on its own frame; a carry falls only out of hand. */
function validateFalls(err, unknown, at, o, { frames, scene, carry }) {
	const list = Array.isArray(o.fall) ? o.fall : [o.fall], seen = new Set();
	if (!list.length) err(`${at}.fall is an empty list; give ${FALL} or a list of them`);
	list.forEach((fl, i) => {
		const fat = Array.isArray(o.fall) ? `${at}.fall[${i}]` : `${at}.fall`;
		if (!fl || typeof fl !== "object" || Array.isArray(fl)) return err(`${fat} must be ${FALL} (at: the frame it starts to fall), got ${fmt(fl)}`);
		for (const k of Object.keys(fl)) if (!FALL_FIELDS.includes(k)) unknown(`${fat} has unknown field "${k}"${didYouMean(k, FALL_FIELDS)}; a fall is ${FALL}`);
		if (fl.at === undefined) err(`${fat}.at must be the whole frame it starts to fall`);
		else if (frameOk(err, `${fat}.at`, fl.at, frames)) {
			if (seen.has(fl.at)) err(`${fat}.at = ${fl.at}: another fall starts on that frame`);
			seen.add(fl.at);
			const g = o.grab ?? 0, r = o.release;
			if (carry && fl.at >= g && (r === undefined || fl.at < r)) err(`${fat}.at = ${fl.at} is while it is in hand (grab ${g}..release ${r ?? "end"}); a carried object falls before its grab or from its release on`);
		}
		if (fl.onto !== undefined) objectOk(err, scene, `${fat}.onto`, fl.onto, { groups: true });
		if (fl.bounce !== undefined && !(Number.isFinite(fl.bounce) && fl.bounce >= 0 && fl.bounce <= 0.6)) err(`${fat}.bounce must be 0..0.6 (the share of its landing speed it bounces back with; 0 lands dead), got ${fmt(fl.bounce)}`);
		if (fl.v !== undefined && !((carry && fl.v === "hand") || isVec3(fl.v))) err(`${fat}.v must be [vx, vy, vz] m/s (the velocity it leaves with)${carry ? " or \"hand\" (the velocity the hand gives it at the release)" : ""}, got ${fmt(fl.v)}`);
		if (fl.tumble !== undefined && typeof fl.tumble !== "boolean") err(`${fat}.tumble must be true (it rolls to rest on a stable face, the default) or false (it drops straight down as it was), got ${fmt(fl.tumble)}`);
	});
}

/** objects.<id>.spring: { length?, stiffness?, damping? }, each a number in its SPRING range (a larger stiffness would blow the fixed-step solver up). */
function validateSpring(err, unknown, at, o) {
	const sp = o.spring, SPR = "{ length?, stiffness?, damping? }";
	if (!sp || typeof sp !== "object" || Array.isArray(sp)) return err(`${at}.spring must be ${SPR}, got ${fmt(sp)}`);
	for (const k of Object.keys(sp)) if (!SPRING_FIELDS.includes(k)) unknown(`${at}.spring has unknown field "${k}"${didYouMean(k, SPRING_FIELDS)}; a spring is ${SPR}`);
	const what = { length: "string or rod length, m", stiffness: "how fast it swings back, 1/s^2", damping: "how soon it settles, 1 = no overshoot" };
	for (const k of SPRING_FIELDS) {
		const v = sp[k], { min, max } = SPRING[k];
		if (v !== undefined && !(Number.isFinite(v) && v >= min && v <= max)) err(`${at}.spring.${k} must be ${min}..${max} (${what[k]}), got ${fmt(v)}`);
	}
}

/** A grasp that starts like the given one (4+ letters: "sphere" -> spherical), else the nearest by edit distance. */
const prefixLen = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i += 1; return i; };
function graspHint(given) {
	// support is no carry's: it holds a box in both hands, each on its own object anchor (compiler/anchors.js supportAt)
	if (given === "support") return "; support holds a box in both hands: reachGrip each hand onto an object anchor with grasp support";
	const text = String(given), best = CARRY_GRASPS.reduce((a, b) => (prefixLen(b, text) > prefixLen(a, text) ? b : a));
	return prefixLen(best, text) >= 4 ? `; did you mean "${best}"?` : didYouMean(text, CARRY_GRASPS);
}

/** mass (kg): what the object weighs, for the arm that holds it (#816). */
function massOk(err, at, o) {
	if (o.mass !== undefined && !(Number.isFinite(o.mass) && o.mass >= 0.01 && o.mass <= 60)) err(`${at}.mass must be kg in 0.01..60, got ${fmt(o.mass)}`);
}

/** visible and level name channels (C15): visible shows the record above 0.5, level scales its light, glow and effect rate. */
function channelsOk(err, at, o) {
	if (o.visible !== undefined && (typeof o.visible !== "string" || !o.visible)) err(`${at}.visible must name a channel (shown above 0.5)`);
	if (o.level !== undefined && (typeof o.level !== "string" || !o.level)) err(`${at}.level must name a channel (the record's level 0..4: 0 dark, 1 as authored; it scales its light, glow and effect rate)`);
}

export function validateObjects(spec, err, { sk, scene, frames = spec.frames, unknown = err }) {
	for (const [id, o] of Object.entries(spec.objects ?? {})) {
		const at = `objects.${id}`, kind = o?.prop !== undefined ? "carry" : isFollow(o) ? "follow" : isFree(o) ? "free" : isSwitch(o) ? "switch" : "hinge", fields = OBJECT_FIELDS[kind];
		// a switch and a follow take any record (a light, an effect); the others a body or a group
		if ((kind !== "switch" && kind !== "follow") || !scene?.others?.[id]) objectOk(err, scene, at, id, { groups: true });
		if (kind === "hinge" && o?.spring !== undefined) err(`${at}.spring: spring is not for hinged objects; a hinge turns only by its channel (give spring to a carry or a free entry)`);
		for (const f of Object.keys(o ?? {})) if (!fields.includes(f) && !(kind === "hinge" && (f === "keys" || f === "fall" || f === "spring"))) unknown(`${at} (${kind}) has unknown field "${f}"${didYouMean(f, fields)}; fields: ${fields.join(", ")}`);
		massOk(err, at, o);
		if (kind === "follow") {
			validateFollow(spec, err, { sk, scene }, at, o);
			channelsOk(err, at, o);
			continue;
		}
		if (kind === "switch") {
			if (o.visible === undefined && o.level === undefined) err(`${at} needs visible or level (a channel): a switch shows, hides or dims "${id}" without moving it; a carry needs prop, a hinge pivot and channel`);
			channelsOk(err, at, o);
			continue;
		}
		if (kind === "free") {
			if (o.keys !== undefined) validateKeys(err, unknown, at, o, frames, true);
			if (o.fall !== undefined) validateFalls(err, unknown, at, o, { frames, scene, carry: false });
			if (o.spring !== undefined) validateSpring(err, unknown, at, o);
			channelsOk(err, at, o);
			continue;
		}
		if (kind === "carry") {
			if (!spec.props?.[o.prop]) err(`${at}.prop "${o.prop}" is not in spec.props`);
			for (const f of ["at", "along"]) if (o[f] !== undefined && !isVec3(o[f])) err(`${at}.${f} must be [d, l, n] along the palm axes, got ${fmt(o[f])}`);
			if (o.grasp !== undefined && !CARRY_GRASPS.includes(o.grasp)) err(`${at}.grasp must be one of ${CARRY_GRASPS.join(", ")}${graspHint(o.grasp)}, got ${fmt(o.grasp)}`);
			channelsOk(err, at, o);
			if (frameOk(err, `${at}.grab`, o.grab, frames) && frameOk(err, `${at}.release`, o.release, frames)
				&& o.grab !== undefined && o.release !== undefined && !(o.grab < o.release)) err(`${at}: grab (${o.grab}) must come before release (${o.release})`);
			if (o.keys !== undefined) validateKeys(err, unknown, at, o, frames);
			if (o.fall !== undefined) validateFalls(err, unknown, at, o, { frames, scene, carry: true });
			if (o.spring !== undefined) validateSpring(err, unknown, at, o);
			continue;
		}
		if (o?.keys !== undefined || o?.fall !== undefined) err(`${at}: a hinge turns by its channel "${o.channel}", keyed in spec.keys; keys and fall move an object with no pivot, axis or channel (C17), or a carried one (prop)`);
		if (!isVec3(o?.pivot)) err(`${at}.pivot must be [x, y, z] (world hinge point), got ${fmt(o?.pivot)}`);
		if (o?.axis !== undefined && (!isVec3(o.axis) || Math.hypot(...o.axis) < 1e-9)) err(`${at}.axis must be a non-zero [x, y, z], got ${fmt(o.axis)}`);
		if (typeof o?.channel !== "string" || !o.channel) err(`${at}.channel must name the angle channel (degrees)`);
	}
}
