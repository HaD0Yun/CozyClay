// Bones, poses and forward kinematics of the rig library.
// pose = { q: [[x, y, z, w]] local quaternion per bone, hips: [x, y, z] world Hips joint }; the Hips
// local quaternion is its world rotation. state = { P: [[x, y, z]], R: [3x3] } world, per bone.
// Self-contained factory (see lib-math.js): it uses only its arguments M (mathLib()) and facts (rigFacts()).
export function fkLib(M, facts) {
	const { add, sub, norm, dot, scale } = M.v, { mul, apply, T } = M.m, { fromMat, toMat } = M.q;
	const names = facts.names, B = names.length, parent = facts.parent, children = facts.children;
	const index = {};
	names.forEach((n, i) => { index[n] = i; });
	const HIPS = index.Hips;
	const restPos = facts.restLocalPos, restQ = facts.restLocalQuat;
	const restR = facts.restWorldQuat.map(toMat);
	// parents before children
	const order = [], seen = new Array(B).fill(false);
	const visit = i => { if (seen[i]) return; if (parent[i] >= 0) visit(parent[i]); seen[i] = true; order.push(i); };
	for (let i = 0; i < B; i++) visit(i);

	/** Bone index from a name ("LeftHand", "mixamorig:LeftHand") or an index. */
	function bi(bone) {
		if (typeof bone === "number" && Number.isInteger(bone) && bone >= 0 && bone < B) return bone;
		const name = typeof bone === "string" ? bone.replace(/^mixamorig:/, "") : bone;
		if (typeof name === "string" && index[name] !== undefined) return index[name];
		throw new Error(`unknown bone ${JSON.stringify(bone)}; bones: ${names.join(", ")}`);
	}
	/** Where bone i's axis ends: its first child, for a hand the middle finger's knuckle (motion3 body.js axisEnd). */
	const axisChild = i => (/Hand$/.test(names[i]) ? index[names[i].replace(/Hand$/, "HandMiddle1")] : children[i][0]);
	function checkPose(p) {
		if (!p || !Array.isArray(p.q) || p.q.length !== B || !Array.isArray(p.hips)) throw new Error(`a pose is { q: ${B} local quaternions, hips: [x, y, z] }`);
		return p;
	}
	const clone = p => ({ q: checkPose(p).q.map(x => x.slice()), hips: p.hips.slice() });
	const yawQ = deg => [0, Math.sin(deg * M.DEG / 2), 0, Math.cos(deg * M.DEG / 2)];
	/** Rest pose at the character's placement. */
	function pose() {
		const { position, yaw } = facts.placement, q = restQ.map(x => x.slice());
		q[HIPS] = M.q.mul(yawQ(yaw), restQ[HIPS]);
		const hips = add(position, M.q.apply(yawQ(yaw), facts.restWorldPos[HIPS]));
		return { q, hips };
	}
	/** World state of every bone (the same math as motion3 skeleton.js fk). */
	function fk(p) {
		checkPose(p);
		const P = [], R = [];
		for (const j of order) {
			const pj = parent[j], Lr = toMat(p.q[j]);
			if (pj < 0) { R[j] = Lr; P[j] = p.hips.slice(); continue; }
			R[j] = mul(R[pj], Lr);
			P[j] = add(P[pj], apply(R[pj], restPos[j]));
		}
		return { P, R };
	}
	/** World { p, R } of one bone, walking only its ancestors. */
	function world(p, bone) {
		const i = bi(bone), chain = [];
		for (let j = i; j >= 0; j = parent[j]) chain.unshift(j);
		let R = null, P = null;
		for (const j of chain) {
			const Lr = toMat(p.q[j]);
			if (!R) { R = Lr; P = p.hips.slice(); continue; }
			P = add(P, apply(R, restPos[j]));
			R = mul(R, Lr);
		}
		return { p: P, R };
	}
	const parentR = (p, i) => (parent[i] < 0 ? M.m.I() : world(p, parent[i]).R);
	function setLocal(p, bone, q) {
		if (!Array.isArray(q) || q.length !== 4) throw new Error("setLocal: q is [x, y, z, w]");
		p.q[bi(bone)] = M.q.norm(q);
		return p;
	}
	const local = (p, bone) => p.q[bi(bone)].slice();
	/** Set a bone's world rotation; its children follow. */
	function setRot(p, bone, R) {
		const i = bi(bone), W = Array.isArray(R[0]) ? R : toMat(R);
		p.q[i] = fromMat(mul(T(parentR(p, i)), W));
		return p;
	}
	/** Turn a bone about a world axis through its joint by deg degrees. */
	const rotate = (p, bone, axis, deg) => setRot(p, bone, mul(M.m.fromAxisAngle(axis, deg), world(p, bone).R));
	/** A direction fixed to bone i that points along restDir in the rest pose. */
	const carried = (R, i, restDir) => apply(R, apply(T(restR[i]), restDir));
	/** Point the bone's axis (to its child) at a world point with the least twist; up: turn its rest up (rest forward for a vertical bone) toward this direction. */
	function aim(p, bone, target, opts = {}) {
		const i = bi(bone), c = axisChild(i);
		if (c === undefined) throw new Error(`aim: ${names[i]} has no child to aim with`);
		const w = world(p, i), axis = norm(apply(w.R, restPos[c])), want = norm(sub(target, w.p));
		if (!opts.up) return setRot(p, i, mul(M.m.between(axis, want), w.R));
		const restAxis = norm(apply(restR[i], restPos[c])), ref = Math.abs(restAxis[1]) > 0.8 ? [0, 0, 1] : [0, 1, 0];
		return setRot(p, i, mul(M.m.align(axis, carried(w.R, i, ref), want, opts.up), w.R));
	}
	/** Body axes from the hips: fwd (the facing), up and left, world. */
	function axes(p) {
		const H = mul(toMat(p.q[HIPS]), T(restR[HIPS])), fwd = apply(H, [0, 0, 1]), up = apply(H, [0, 1, 0]);
		return { fwd, up, left: apply(H, [1, 0, 0]) };
	}
	/** Translate the whole pose (moves the hips). */
	const move = (p, delta) => { p.hips = add(p.hips, delta); return p; };
	const length = bone => facts.lengths[bi(bone)];
	const projOff = (v, n) => sub(v, scale(n, dot(v, n)));
	return { B, HIPS, names, index, parent, children, order, restR, restPos, restQ, bi, axisChild, checkPose, carried, projOff,
		pose, clone, fk, world, parentR, setLocal, local, setRot, rotate, aim, axes, move, length };
}
