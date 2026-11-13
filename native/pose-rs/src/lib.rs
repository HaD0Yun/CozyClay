// pose()'s bone edits (src/motion3/compiler/pose.js, limbs.js, skeleton.js rotateSubtree) for pose-wasm.js.
// Every float op keeps the JS evaluation order so results match bit for bit; sin/cos/acos are
// imported from the host's Math, hypot is V8's (Kahan-summed, normalised by the largest term).

type V = [f64; 3];
type M = [[f64; 3]; 3];

#[link(wasm_import_module = "m")]
extern "C" {
	fn sin(x: f64) -> f64;
	fn cos(x: f64) -> f64;
	fn acos(x: f64) -> f64;
}

const PI: f64 = core::f64::consts::PI;
const ELBOW_FOLD: f64 = 145.0;
const ELBOW_STOP: f64 = 150.0;
const KNEE_FOLD: f64 = 150.0;
const KNEE_STOP: f64 = 160.0;

const ARM: usize = 0;
const FOREARM: usize = 1;
const HAND: usize = 2;
const UPLEG: usize = 3;
const LEG: usize = 4;
const FOOT: usize = 5;
const TOE: usize = 6;
const TOE_END: usize = 7;
const MIDDLE1: usize = 8;
const INDEX1: usize = 9;
const PINKY1: usize = 10;
const PHALANX: usize = 11;
const THUMB4: usize = 26;
pub const K: usize = 27;

struct Rig {
	n: usize,
	sub_start: Vec<i32>,
	sub_idx: Vec<i32>,
	rest_p: Vec<V>,
	rest_r: Vec<M>,
	bones: Vec<i32>,
	chest: usize,
	hips: usize,
}

static mut RIG: Option<Rig> = None;
static mut P: Vec<f64> = Vec::new();
static mut R: Vec<f64> = Vec::new();
static mut DIRTY: Vec<u8> = Vec::new();
static mut IO: [f64; 64] = [0.0; 64];

#[allow(static_mut_refs)]
fn rig() -> &'static Rig { unsafe { RIG.as_ref().unwrap() } }

#[allow(static_mut_refs)]
fn gp(j: usize) -> V { unsafe { [P[j * 3], P[j * 3 + 1], P[j * 3 + 2]] } }
#[allow(static_mut_refs)]
fn sp(j: usize, v: V) { unsafe { P[j * 3] = v[0]; P[j * 3 + 1] = v[1]; P[j * 3 + 2] = v[2]; } }
#[allow(static_mut_refs)]
fn gr(j: usize) -> M { unsafe { let o = j * 9; [[R[o], R[o + 1], R[o + 2]], [R[o + 3], R[o + 4], R[o + 5]], [R[o + 6], R[o + 7], R[o + 8]]] } }
#[allow(static_mut_refs)]
fn sr(j: usize, m: &M) { unsafe { let o = j * 9; for i in 0..3 { for c in 0..3 { R[o + i * 3 + c] = m[i][c]; } } } }
#[allow(static_mut_refs)]
fn io(i: usize) -> f64 { unsafe { IO[i] } }
fn iov(i: usize) -> V { [io(i), io(i + 1), io(i + 2)] }

fn js_max(a: f64, b: f64) -> f64 {
	if a.is_nan() || b.is_nan() { return f64::NAN; }
	if a == 0.0 && b == 0.0 { return if a.is_sign_negative() && b.is_sign_negative() { -0.0 } else { 0.0 }; }
	if a > b { a } else { b }
}
fn js_min(a: f64, b: f64) -> f64 {
	if a.is_nan() || b.is_nan() { return f64::NAN; }
	if a == 0.0 && b == 0.0 { return if a.is_sign_negative() || b.is_sign_negative() { -0.0 } else { 0.0 }; }
	if a < b { a } else { b }
}
fn clamp(x: f64, lo: f64, hi: f64) -> f64 { js_min(hi, js_max(lo, x)) }
fn truthy(x: f64) -> bool { x != 0.0 && !x.is_nan() }

fn hypot3(a: f64, b: f64, c: f64) -> f64 {
	let v = [a, b, c];
	let mut max = 0.0f64;
	let mut nan = false;
	let mut abs = [0.0f64; 3];
	for i in 0..3 {
		if v[i].is_nan() { nan = true; } else { abs[i] = v[i].abs(); if abs[i] > max { max = abs[i]; } }
	}
	if max == f64::INFINITY { return f64::INFINITY; }
	if nan { return f64::NAN; }
	if max == 0.0 { return 0.0; }
	let mut sum = 0.0f64;
	let mut comp = 0.0f64;
	for i in 0..3 {
		let n = abs[i] / max;
		let summand = n * n - comp;
		let pre = sum + summand;
		comp = (pre - sum) - summand;
		sum = pre;
	}
	sum.sqrt() * max
}

fn add(a: V, b: V) -> V { [a[0] + b[0], a[1] + b[1], a[2] + b[2]] }
fn sub(a: V, b: V) -> V { [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
fn scale(a: V, s: f64) -> V { [a[0] * s, a[1] * s, a[2] * s] }
fn dot(a: V, b: V) -> f64 { a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
fn cross(a: V, b: V) -> V { [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }
fn len(a: V) -> f64 { hypot3(a[0], a[1], a[2]) }
fn norm(a: V) -> V { let l = len(a); if l > 1e-12 { [a[0] / l, a[1] / l, a[2] / l] } else { [0.0, 0.0, 0.0] } }
fn mul(a: &M, b: &M) -> M {
	let mut c = [[0.0; 3]; 3];
	for i in 0..3 { for j in 0..3 { c[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]; } }
	c
}
fn apply(r: &M, v: V) -> V {
	[r[0][0] * v[0] + r[0][1] * v[1] + r[0][2] * v[2], r[1][0] * v[0] + r[1][1] * v[1] + r[1][2] * v[2], r[2][0] * v[0] + r[2][1] * v[1] + r[2][2] * v[2]]
}
fn tr(r: &M) -> M { [[r[0][0], r[1][0], r[2][0]], [r[0][1], r[1][1], r[2][1]], [r[0][2], r[1][2], r[2][2]]] }
fn cols(a: V, b: V, c: V) -> M { [[a[0], b[0], c[0]], [a[1], b[1], c[1]], [a[2], b[2], c[2]]] }
fn rad(d: f64) -> f64 { d * PI / 180.0 }
fn rx(d: f64) -> M { let t = rad(d); let (c, s) = unsafe { (cos(t), sin(t)) }; [[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]] }
fn ry(d: f64) -> M { let t = rad(d); let (c, s) = unsafe { (cos(t), sin(t)) }; [[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]] }
fn rz(d: f64) -> M { let t = rad(d); let (c, s) = unsafe { (cos(t), sin(t)) }; [[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]] }
fn axis_rot(ax: V, d: f64) -> M {
	let [x, y, z] = norm(ax);
	let t = rad(d);
	let (c, s) = unsafe { (cos(t), sin(t)) };
	let k = 1.0 - c;
	[[c + x * x * k, x * y * k - z * s, x * z * k + y * s], [y * x * k + z * s, c + y * y * k, y * z * k - x * s], [z * x * k - y * s, z * y * k + x * s, c + z * z * k]]
}
fn frame(d: V, p: V) -> M {
	let a = norm(d);
	let mut b = sub(p, scale(a, dot(p, a)));
	if len(b) < 1e-9 {
		b = sub([0.0, 1.0, 0.0], scale(a, a[1]));
		if len(b) < 1e-9 { b = sub([1.0, 0.0, 0.0], scale(a, a[0])); }
	}
	b = norm(b);
	cols(a, b, cross(a, b))
}
fn align(d0: V, p0: V, d1: V, p1: V) -> M { mul(&frame(d1, p1), &tr(&frame(d0, p0))) }

#[allow(static_mut_refs)]
fn rotate(b: usize, pivot: V, m: &M) {
	let rg = rig();
	for t in rg.sub_start[b] as usize..rg.sub_start[b + 1] as usize {
		let j = rg.sub_idx[t] as usize;
		sp(j, add(pivot, apply(m, sub(gp(j), pivot))));
		sr(j, &mul(m, &gr(j)));
		unsafe { DIRTY[j] = 1; }
	}
}
fn rotate_own(b: usize, m: &M) { rotate(b, gp(b), m); }

fn bone(side: usize, k: usize) -> i32 { rig().bones[side * K + k] }
fn ub(side: usize, k: usize) -> usize { bone(side, k) as usize }

fn carried(b: usize, rest_dir: V) -> V { apply(&gr(b), apply(&tr(&rig().rest_r[b]), rest_dir)) }

fn reach_at(a: f64, b: f64, deg: f64) -> f64 { (a * a + b * b + 2.0 * a * b * unsafe { cos((deg * PI) / 180.0) }).sqrt() }
fn flexion_at(a: f64, b: f64, d: f64) -> f64 { (unsafe { acos(clamp((d * d - a * a - b * b) / (2.0 * a * b), -1.0, 1.0)) } * 180.0) / PI }
fn arm_reach(a: f64, b: f64, d: f64, fold: f64, stop: f64) -> f64 {
	let k = reach_at(a, b, fold);
	if d >= k { return d; }
	let w = k - reach_at(a, b, stop);
	if d > k - 2.0 * w { d + ((k - d) * (k - d)) / (4.0 * w) } else { k - w }
}
fn elbow_fold(a: f64, b: f64, deg: f64) -> f64 { flexion_at(a, b, arm_reach(a, b, reach_at(a, b, deg), ELBOW_FOLD, ELBOW_STOP)) }
fn fold_point(s: V, t: V, a: f64, b: f64, back: V, fold: f64, stop: f64) -> Option<V> {
	let k = reach_at(a, b, fold);
	let d = len(sub(t, s));
	if d >= k { return None; }
	let r = arm_reach(a, b, d, fold, stop);
	let m = scale(back, reach_at(a, b, stop));
	let c = add(s, m);
	let e = sub(t, c);
	let u = if len(e) > 1e-9 { norm(e) } else { scale(back, -1.0) };
	let em = dot(u, m);
	Some(add(c, scale(u, -em + js_max(0.0, em * em - dot(m, m) + r * r).sqrt())))
}

#[no_mangle]
pub extern "C" fn io_ptr() -> *mut f64 { core::ptr::addr_of_mut!(IO) as *mut f64 }
#[no_mangle]
#[allow(static_mut_refs)]
pub extern "C" fn p_ptr() -> *mut f64 { unsafe { P.as_mut_ptr() } }
#[no_mangle]
#[allow(static_mut_refs)]
pub extern "C" fn r_ptr() -> *mut f64 { unsafe { R.as_mut_ptr() } }
#[no_mangle]
#[allow(static_mut_refs)]
pub extern "C" fn dirty_ptr() -> *mut u8 { unsafe { DIRTY.as_mut_ptr() } }
#[no_mangle]
pub extern "C" fn alloc(bytes: usize) -> *mut u8 { let mut v = Vec::<u8>::with_capacity(bytes); let p = v.as_mut_ptr(); core::mem::forget(v); p }

/// sub_start: n+1 i32 offsets into sub_idx; rest_p: n*3; rest_r: n*9 row-major; bones: 2*K i32 (see the consts, -1 absent)
#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn init(n: usize, sub_start: *const i32, sub_len: usize, sub_idx: *const i32, rest_p: *const f64, rest_r: *const f64, bones: *const i32, chest: usize, hips: usize) {
	let ss = core::slice::from_raw_parts(sub_start, n + 1).to_vec();
	let si = core::slice::from_raw_parts(sub_idx, sub_len).to_vec();
	let rp = core::slice::from_raw_parts(rest_p, n * 3);
	let rr = core::slice::from_raw_parts(rest_r, n * 9);
	RIG = Some(Rig {
		n, sub_start: ss, sub_idx: si,
		rest_p: (0..n).map(|j| [rp[j * 3], rp[j * 3 + 1], rp[j * 3 + 2]]).collect(),
		rest_r: (0..n).map(|j| { let o = j * 9; [[rr[o], rr[o + 1], rr[o + 2]], [rr[o + 3], rr[o + 4], rr[o + 5]], [rr[o + 6], rr[o + 7], rr[o + 8]]] }).collect(),
		bones: core::slice::from_raw_parts(bones, 2 * K).to_vec(), chest, hips,
	});
	if P.len() < n * 3 { P = vec![0.0; n * 3]; R = vec![0.0; n * 9]; DIRTY = vec![0; n]; }
}

#[no_mangle]
#[allow(static_mut_refs)]
pub extern "C" fn rest() {
	let rg = rig();
	for j in 0..rg.n { sp(j, rg.rest_p[j]); sr(j, &rg.rest_r[j]); unsafe { DIRTY[j] = 1; } }
}

#[no_mangle]
pub extern "C" fn rot1(b: usize, axis: u32, deg: f64) {
	let m = match axis { 0 => rx(deg), 1 => ry(deg), _ => rz(deg) };
	rotate_own(b, &m);
}

#[no_mangle]
pub extern "C" fn rot_xyz(b: usize, yaw: f64, pitch: f64, roll: f64) { rotate_own(b, &mul(&ry(yaw), &mul(&rx(pitch), &rz(roll)))); }

#[no_mangle]
pub extern "C" fn spread(nb: usize, b0: usize, b1: usize, yaw: f64, pitch: f64, roll: f64, k: f64) {
	for &b in [b0, b1][..nb].iter() { rotate_own(b, &mul(&ry(yaw / k), &mul(&rx(pitch / k), &rz(roll / k)))); }
}

#[no_mangle]
#[allow(static_mut_refs)]
pub extern "C" fn shift(has_root: u32) {
	let rg = rig();
	let h = gp(rg.hips);
	let root = if has_root != 0 { iov(0) } else { h };
	let s = sub(root, h);
	for j in 0..rg.n { sp(j, add(gp(j), s)); unsafe { DIRTY[j] = 1; } }
}

/// io[0..3] target, io[3..6] pole, io[6..9] rest bend; stop 0 none, 1 elbow, 2 knee
#[no_mangle]
pub extern "C" fn two_bone(root: usize, mid: usize, end: usize, stop: u32) -> f64 {
	let rg = rig();
	let (target, pole, rest_bend) = (iov(0), iov(3), iov(6));
	let (rt, m, e) = (gp(root), gp(mid), gp(end));
	let a = len(sub(m, rt));
	let b = len(sub(e, m));
	let folded = match stop {
		1 => fold_point(rt, target, a, b, carried(rg.chest, [0.0, 0.0, -1.0]), ELBOW_FOLD, ELBOW_STOP),
		2 => fold_point(rt, target, a, b, carried(rg.hips, [0.0, 1.0, 0.0]), KNEE_FOLD, KNEE_STOP),
		_ => None,
	};
	let (w, inside) = match folded { Some(w) => (w, len(sub(w, target))), None => (target, 0.0) };
	let v = sub(w, rt);
	let d = len(v);
	let u = scale(v, 1.0 / js_max(d, 1e-9));
	let dc = clamp(d, (a - b).abs() + 1e-4, (a + b) * 0.9995);
	let l = (a * a - b * b + dc * dc) / (2.0 * dc);
	let h = js_max(a * a - l * l, 0.0).sqrt();
	let pv = norm(sub(pole, scale(u, dot(pole, u))));
	let mn = add(rt, add(scale(u, l), scale(pv, h)));
	let p0 = carried(root, rest_bend);
	rotate(root, rt, &align(sub(m, rt), p0, sub(mn, rt), pv));
	let p1 = carried(mid, rest_bend);
	let tn = add(rt, scale(u, dc));
	let pm = gp(mid);
	rotate(mid, pm, &align(sub(gp(end), pm), p1, sub(tn, pm), pv));
	if truthy(inside) { inside } else { d - dc }
}

/// io[0..3] target; leg 0 arm chain (Arm, ForeArm, Hand), 1 leg chain (UpLeg, Leg, Foot)
#[no_mangle]
pub extern "C" fn asked_fold(side: usize, leg: u32) -> f64 {
	let (u, m, e) = if leg != 0 { (UPLEG, LEG, FOOT) } else { (ARM, FOREARM, HAND) };
	let (s, el, w) = (gp(ub(side, u)), gp(ub(side, m)), gp(ub(side, e)));
	flexion_at(len(sub(el, s)), len(sub(w, el)), len(sub(iov(0), s)))
}

/// io[9..18] the tilt frame's R when has_tilt
#[no_mangle]
pub extern "C" fn orient_foot(side: usize, yaw_deg: f64, pitch_deg: f64, has_tilt: u32, tilt_yaw: f64) {
	let rg = rig();
	let (foot, toe) = (ub(side, FOOT), ub(side, TOE));
	let restv = sub(rg.rest_p[toe], rg.rest_p[foot]);
	let tilt: M = [[io(9), io(10), io(11)], [io(12), io(13), io(14)], [io(15), io(16), io(17)]];
	let want = if has_tilt != 0 { apply(&tilt, apply(&ry(yaw_deg - tilt_yaw), apply(&rx(pitch_deg), restv))) } else { apply(&ry(yaw_deg), apply(&rx(pitch_deg), restv)) };
	let up = if has_tilt != 0 { apply(&tilt, [0.0, 1.0, 0.0]) } else { [0.0, 1.0, 0.0] };
	let pf = gp(foot);
	rotate(foot, pf, &align(sub(gp(toe), pf), carried(foot, [0.0, 1.0, 0.0]), want, up));
	let tip = bone(side, TOE_END);
	if has_tilt == 0 && pitch_deg > 0.0 && tip >= 0 {
		let pt = gp(toe);
		let seg = sub(gp(tip as usize), pt);
		let flat = [seg[0], 0.0, seg[2]];
		if len(flat) > 1e-6 { rotate(toe, pt, &align(seg, [0.0, 1.0, 0.0], flat, [0.0, 1.0, 0.0])); }
	}
}

fn palm_axes(side: usize) -> (V, V, V) {
	let h = gp(ub(side, HAND));
	let d = norm(sub(gp(ub(side, MIDDLE1)), h));
	let mut l = sub(gp(ub(side, INDEX1)), gp(ub(side, PINKY1)));
	l = norm(sub(l, scale(d, dot(l, d))));
	(d, l, cross(d, l))
}

#[no_mangle]
pub extern "C" fn limit_fold(side: usize) {
	let (a, fa) = (ub(side, ARM), ub(side, FOREARM));
	let pfa = gp(fa);
	let up = sub(pfa, gp(a));
	let down = sub(gp(ub(side, HAND)), pfa);
	let deg = (unsafe { acos(clamp(dot(norm(up), norm(down)), -1.0, 1.0)) } * 180.0) / PI;
	let n = cross(up, down);
	if deg > ELBOW_FOLD && len(n) > 1e-12 { rotate(fa, pfa, &axis_rot(n, elbow_fold(len(up), len(down), deg) - deg)); }
}

#[no_mangle]
pub extern "C" fn wrist(side: usize, twist: f64, flex: f64) {
	if !truthy(twist) && !truthy(flex) { return; }
	let (h, fa) = (ub(side, HAND), ub(side, FOREARM));
	let ax_t = norm(sub(gp(h), gp(fa)));
	let (_, l, _) = palm_axes(side);
	let ax_f = norm(sub(l, scale(ax_t, dot(l, ax_t))));
	rotate_own(h, &axis_rot(ax_f, clamp(flex, -70.0, 70.0)));
	rotate_own(h, &axis_rot(ax_t, clamp(twist, -85.0, 85.0)));
}

/// io[0..4] spread (Index, Middle, Ring, Pinky), io[4..19] curls (Index..Pinky, Thumb x3 phalanges), io[19..23] thumb wrap
#[no_mangle]
pub extern "C" fn fingers(side: usize) {
	let sign = if side == 0 { -1.0 } else { 1.0 };
	for f in 0..4 {
		let sp_deg = io(f);
		let j = bone(side, PHALANX + f * 3);
		if truthy(sp_deg) && j >= 0 { let (_, _, n) = palm_axes(side); rotate_own(j as usize, &axis_rot(n, sp_deg)); }
	}
	for f in 0..5 {
		for k in 0..3 {
			let j = bone(side, PHALANX + f * 3 + k);
			if j < 0 { continue; }
			let (d, l, _) = palm_axes(side);
			let ax = if f == 4 && k == 0 { d } else { l };
			rotate_own(j as usize, &axis_rot(ax, sign * io(4 + f * 3 + k)));
		}
	}
	let wrap = [io(19), io(20), io(21), io(22)];
	if wrap.iter().any(|&w| truthy(w)) { wrap_thumb(side, sign, wrap); }
}

fn wrap_thumb(side: usize, sign: f64, [oppose, across, flex2, flex3]: [f64; 4]) {
	let j = |k: usize| bone(side, if k == 4 { THUMB4 } else { PHALANX + 12 + k - 1 });
	if j(1) < 0 { return; }
	let (d, _, n) = palm_axes(side);
	let j1 = j(1) as usize;
	rotate_own(j1, &axis_rot(d, sign * oppose));
	rotate_own(j1, &axis_rot(n, across));
	for (k, deg) in [(2usize, flex2), (3usize, flex3)] {
		let jk = j(k) as usize;
		let pk = gp(jk);
		let ax = norm(cross(norm(sub(gp(j(k + 1) as usize), pk)), n));
		rotate(jk, pk, &axis_rot(ax, sign * deg));
	}
}

#[no_mangle]
pub extern "C" fn swivel(side: usize, deg: f64) {
	let (a, h) = (ub(side, ARM), ub(side, HAND));
	let m = axis_rot(sub(gp(h), gp(a)), deg);
	rotate_own(a, &m);
	rotate_own(h, &tr(&m));
}
