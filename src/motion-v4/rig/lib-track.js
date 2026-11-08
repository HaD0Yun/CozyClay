// Dense track builder of the rig library: every bone on every frame, plus object world poses.
// payload() and patch() give the arguments of the track tool's "set" and "patch"; numbers are
// rounded to 1e-6 so the JSON stays small. Layout: rot[(f * bones + b) * 4 + k], hips[f * 3 + k]
// (a patch counts f from `from` and b over its own bone list).
// Self-contained factory (see lib-math.js): it uses only M (mathLib()), K (fkLib()) and facts.
export function trackLib(M, K, facts) {
	const B = K.B;
	const r6 = x => Math.round(x * 1e6) / 1e6;
	const frameRuns = list => {
		const runs = [];
		for (const f of list) {
			const last = runs[runs.length - 1];
			if (last && last[1] === f - 1) last[1] = f;
			else runs.push([f, f]);
		}
		return runs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ");
	};

	function builder(F) {
		if (!Number.isInteger(F) || F < 1 || F > 2400) throw new Error("rig.track(F): F is a whole number of frames, 1 to 2400");
		const rot = new Float64Array(F * B * 4), hips = new Float64Array(F * 3), done = new Uint8Array(F), objects = {};
		const frameOk = (f, what) => {
			if (!Number.isInteger(f) || f < 0 || f >= F) throw new Error(`${what}: frame ${f} is outside 0-${F - 1}`);
		};
		const self = {
			frames: F,
			bones: K.names.slice(),
			/** Write a pose at frame f. */
			set(f, pose) {
				frameOk(f, "track.set");
				K.checkPose(pose);
				for (let b = 0; b < B; b++) for (let k = 0; k < 4; k++) rot[(f * B + b) * 4 + k] = pose.q[b][k];
				for (let k = 0; k < 3; k++) hips[f * 3 + k] = pose.hips[k];
				done[f] = 1;
				return self;
			},
			/** The pose at frame f (a fresh copy). */
			get(f) {
				frameOk(f, "track.get");
				if (!done[f]) throw new Error(`track.get: frame ${f} is not set`);
				const q = [];
				for (let b = 0; b < B; b++) { const o = (f * B + b) * 4; q.push([rot[o], rot[o + 1], rot[o + 2], rot[o + 3]]); }
				return { q, hips: [hips[f * 3], hips[f * 3 + 1], hips[f * 3 + 2]] };
			},
			has: f => Number.isInteger(f) && f >= 0 && f < F && done[f] === 1,
			/** set(f, fn(f)) for every frame a..b. */
			fill(a, b, fn) {
				frameOk(a, "track.fill");
				frameOk(b, "track.fill");
				for (let f = a; f <= b; f++) {
					const pose = fn(f);
					if (!pose) throw new Error(`track.fill: the function returned no pose at frame ${f}`);
					self.set(f, pose);
				}
				return self;
			},
			/** World pose of record id at frame f: { pos, R } or { pos, quat }. Unset frames hold the nearest set frame before them (the first set frame before it). */
			object(id, f, pose) {
				frameOk(f, "track.object");
				if (typeof id !== "string" || !id) throw new Error("track.object: id is a record id");
				const quat = pose?.quat ? M.q.norm(pose.quat) : pose?.R ? M.q.fromMat(pose.R) : null;
				if (!Array.isArray(pose?.pos) || !quat) throw new Error("track.object: pose is { pos: [x, y, z], R: 3x3 } or { pos, quat: [x, y, z, w] }");
				const o = objects[id] ??= { pos: new Float64Array(F * 3), quat: new Float64Array(F * 4), done: new Uint8Array(F) };
				for (let k = 0; k < 3; k++) o.pos[f * 3 + k] = pose.pos[k];
				for (let k = 0; k < 4; k++) o.quat[f * 4 + k] = quat[k];
				o.done[f] = 1;
				return self;
			},
			/** { op: "set", frames, rot, hips, objects } for the track tool. */
			payload() {
				const missing = [];
				for (let f = 0; f < F; f++) if (!done[f]) missing.push(f);
				if (missing.length) throw new Error(`track.payload: frames ${frameRuns(missing)} are not set (set or fill them first)`);
				return { op: "set", frames: F, rot: Array.from(rot, r6), hips: Array.from(hips, r6), objects: objectRange(0, F - 1) };
			},
			/** { op: "patch", from, to, bones, rot, hips, objects } for frames a..b and some bones (default all). */
			patch(a, b, bones) {
				frameOk(a, "track.patch");
				frameOk(b, "track.patch");
				if (b < a) throw new Error("track.patch: from must be <= to");
				const list = (bones ?? K.names).map(K.bi), out = [], hp = [];
				for (let f = a; f <= b; f++) {
					if (!done[f]) throw new Error(`track.patch: frame ${f} is not set`);
					for (const i of list) for (let k = 0; k < 4; k++) out.push(r6(rot[(f * B + i) * 4 + k]));
					for (let k = 0; k < 3; k++) hp.push(r6(hips[f * 3 + k]));
				}
				return { op: "patch", from: a, to: b, bones: list.map(i => K.names[i]), rot: out, hips: hp, objects: objectRange(a, b) };
			},
		};
		function objectRange(a, b) {
			const res = {};
			for (const [id, o] of Object.entries(objects)) {
				let first = -1;
				for (let f = 0; f < F && first < 0; f++) if (o.done[f]) first = f;
				const pos = [], quat = [];
				let src = first;
				for (let f = 0; f <= b; f++) {
					if (o.done[f]) src = f;
					if (f < a) continue;
					const s = f < first ? first : src;
					for (let k = 0; k < 3; k++) pos.push(r6(o.pos[s * 3 + k]));
					for (let k = 0; k < 4; k++) quat.push(r6(o.quat[s * 4 + k]));
				}
				res[id] = { pos, quat };
			}
			return res;
		}
		return self;
	}

	/** A builder from await track({ op: "get" }); bones the get left out keep their rest rotation. */
	function fromTrack(data) {
		if (!data || !Array.isArray(data.rot) || !Array.isArray(data.hips)) throw new Error("fromTrack: pass the data of track({ op: \"get\" })");
		const from = data.from ?? 0, to = data.to ?? (data.hips.length / 3 + from - 1), list = (data.bones ?? K.names).map(K.bi), n = list.length;
		if (data.rot.length !== (to - from + 1) * n * 4) throw new Error("fromTrack: rot length does not match from, to and bones");
		const T_ = builder(to + 1);
		for (let f = from; f <= to; f++) {
			const q = K.restQ.map(x => x.slice()), j = f - from;
			list.forEach((i, k) => { const o = (j * n + k) * 4; q[i] = [data.rot[o], data.rot[o + 1], data.rot[o + 2], data.rot[o + 3]]; });
			T_.set(f, { q, hips: [data.hips[j * 3], data.hips[j * 3 + 1], data.hips[j * 3 + 2]] });
		}
		for (const [id, o] of Object.entries(data.objects ?? {})) {
			for (let f = from; f <= to; f++) {
				const j = f - from;
				T_.object(id, f, { pos: o.pos.slice(j * 3, j * 3 + 3), quat: o.quat.slice(j * 4, j * 4 + 4) });
			}
		}
		return T_;
	}
	return { track: builder, fromTrack, fps: facts.fps };
}
