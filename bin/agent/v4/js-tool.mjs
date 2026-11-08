// The v4 `js` tool: a persistent QuickJS session for the whole conversation with the rig library
// preloaded as the global `rig`, and the other v4 tools as host functions (track, measure,
// render, qa). Images those return inside a cell are attached to the js result.
import { rigLibrarySource } from "../../../src/motion-v4/rig/library.js";
import { createJsSession } from "./js-session.mjs";

const MAX_IMAGES = 8;
const TEXT_BUDGET = 12000;

const INPUT_SCHEMA = {
	type: "object", additionalProperties: false, required: ["code"],
	properties: {
		code: { type: "string", description: "Body of an async function. await works. Top-level declarations that start a line persist to later calls." },
		timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
	},
};

const DESCRIPTION = `Run JavaScript in a persistent session (QuickJS) that lasts the whole conversation. code is the body of an async function: await works, return a value to see it.
State: top-level declarations that start a line (const, let, var, function, class) persist to later calls; so does anything you assign to globalThis. One name per line: "const a = 1, b = 2" keeps only a, and destructuring is not kept. Closures keep their state. Indented declarations stay local. rig, track, measure, render and qa are never overwritten by a kept name. console.log lines come back as stdout. One call runs at a time; default timeout 120 s (timeoutMs up to 600000). A timeout resets the session (kept names are gone, rig comes back).
Host tools: await track(args), await measure(args), await render(args), await qa(args) take the same arguments as the direct tools and return their data (a failure throws). Images from render inside a cell are attached to this result (at most ${MAX_IMAGES}).
Units: metres, +Y up, floor y = 0, 24 fps, frames from 0. The character faces +Z at yaw 0 and +X is its left. Quaternions [x, y, z, w]; rotation matrices row-major 3x3 acting on column vectors. Angles in degrees.

The global rig (the motion subject's rig, 65 bones):
Types: pose = { q: [[x,y,z,w]] local quat per bone, hips: [x,y,z] world Hips joint } (the Hips quat is its world rotation); state = { P: [[x,y,z]], R: [3x3] } world per bone, from rig.fk(pose). A bone is a name ("LeftForeArm") or an index. side "l" | "r". chain "arm_l" | "arm_r" | "leg_l" | "leg_r". Functions that take a pose change it in place and return it (IK returns a report).
Facts: rig.bones (names), rig.index[name], rig.parent[i], rig.children[i], rig.length(bone) (to its child), rig.limits (elbow/knee fold max, wrist flex/dev/twist), rig.placement { position, yaw }, rig.fps, rig.scene { objects: { id: { pos (base pivot, bottom centre), R, half, ancestors } }, groups: { id: { pos, R, children } } }.
Pose and FK:
- rig.pose(): rest T-pose at the character's placement. rig.clone(pose). rig.fk(pose) -> state. rig.world(pose, bone) -> { p, R }.
- rig.local(pose, bone) / rig.setLocal(pose, bone, q): local quat. rig.setRot(pose, bone, R or q): set the world rotation, children follow. rig.rotate(pose, bone, axis, deg): turn a bone about a world axis through its joint. rig.move(pose, [dx,dy,dz]): shift the hips.
- rig.aim(pose, bone, target, { up }?): point the bone's axis (to its child) at a world point with the least twist; up turns its rest up toward a world direction.
- rig.axes(pose) -> { fwd, up, left }: body axes from the hips.
IK:
- rig.ik2(pose, chain, target, { pole, limits = true, end }?) -> { reached, error, fold }: analytic two-bone IK. Wrist or ankle to target; elbow or knee bends toward pole (a world point; default elbows back and down, knees forward); fold (deg between the two segments, 0 straight) clamped to the limits and always the anatomical way; end = world rotation (3x3 or quat) for the hand or foot, else the hand/foot keeps its local rotation. An unreachable target leaves the limb straight toward it with reached false.
- rig.plantFoot(pose, side, { point, normal = [0,1,0], yaw, pole }?): IK so heel and ball lie on the plane through point (default: the floor under the foot), toes along yaw (deg, 0 = +Z, 90 = +X; default the current toe heading), toes flat, knee toward the toes.
- rig.plantHand(pose, side, { point, normal = [0,1,0], forward, pole, gap = 0.02 }?): IK so the palm centre sits gap m off the surface at point, the palm facing it, fingers along forward.
Body (on a state):
- rig.palm(state, side) -> { p centre, n the way the palm faces, d fingers, l thumb side }. Rest palms face down.
- rig.sole(state, side) -> { heel, ball, tip, n down normal }: the QA sole points (on the skin).
- rig.com(state) -> [x,y,z] mass-weighted centre of mass; rig.segments(state) -> [{ id, mass, p }].
- rig.xcom(com0, com1, { fps = 24, ground = 0, g = 9.8 }?) -> { xcom: [x, z], v: [vx, vz], omega }: extrapolated COM (Hof); keep it inside the support for balance.
Motion:
- rig.ease(t, kind): linear, in, out, inOut, smooth, smoother. rig.hermite(p0, p1, m0, m1, t) (numbers or arrays).
- rig.curve(keys, f): keys [{ f, v, m? }] (v number or array, m per frame); Catmull-Rom tangents where m is absent; held past the ends.
- rig.slerp(qa, qb, t). rig.blend(poseA, poseB, t, { bones }?): per-bone slerp, hips lerp.
- rig.ballistic(p0, v0, t, g = 9.8): position after t seconds. rig.launch(p0, p1, T, g) -> v0 that lands on p1 after T s. rig.arc(p0, p1, apex) -> { v0, T } for an arc whose top is at height apex.
- rig.compose(a, b), rig.relative(a, b): rigid poses { pos, R } (also { pos, quat } and rig.world's { p, R }; a * b, a^-1 * b), e.g. carry an object with a hand: rel = rig.relative(rig.world(pose, "RightHand"), objPose) at the grab, then rig.compose(rig.world(pose, "RightHand"), rel) each frame.
- rig.v (add sub scale dot cross len dist norm lerp angle), rig.m (I mul apply T fromAxisAngle(axis, deg) align between), rig.q (mul conj norm slerp fromMat toMat fromAxisAngle(axis, deg) fromEuler([x,y,z] deg, "XYZ") between(a, b) apply).
Track:
- const T = rig.track(F): T.set(f, pose), T.get(f), T.fill(a, b, f => pose), T.object(id, f, { pos, R or quat }) (world pose of a record's base pivot; unset frames hold the last set one), T.payload() -> { op: "set", ... }, T.patch(a, b, bones?) -> { op: "patch", ... }. Every frame must be set before payload().
- await track(T.payload()) stores it; await track(T.patch(40, 60, ["LeftArm", "LeftForeArm"])) changes part of it; rig.fromTrack(await track({ op: "get" })) gives a builder of the stored track.
Pattern: const base = rig.pose(); const T = rig.track(48); T.fill(0, 47, f => { const p = rig.clone(base); const t = rig.ease(f / 47, "smooth"); rig.move(p, [0, -0.3 * t, 0]); rig.plantFoot(p, "l"); rig.plantFoot(p, "r"); return p; }); await track(T.payload());`;

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}... (${s.length} chars; return less or log what you need)` : s);
function stdoutText(lines) {
	const all = lines.join("\n");
	return all.length > 10000 ? `${all.slice(0, 8000)}\n... [${all.length - 10000} chars cut] ...\n${all.slice(-2000)}` : all;
}

/** What the model reads for one cell. */
function cellText(r, dropped) {
	const out = [];
	if (r.reset) out.push(r.reset);
	if (r.ok) out.push(`ok, ${r.ms} ms.${r.kept.length ? ` kept: ${r.kept.join(", ")}` : ""}`);
	else {
		const e = r.error ?? {}, at = e.line ? ` at line ${e.line}${e.column ? `:${e.column}` : ""}` : "";
		out.push(`error${at}: ${e.name ?? "Error"}: ${e.message ?? ""}`);
		if (r.kept.length) out.push(`kept: ${r.kept.join(", ")}`);
	}
	if (r.calls.length) out.push(`calls: ${r.calls.map(c => `${c.name} ${c.ms} ms${c.ok ? "" : " failed"}`).join(", ")}`);
	if (r.images.length) out.push(`images: ${r.images.length - dropped} attached${dropped ? `; ${dropped} dropped (at most ${MAX_IMAGES} per call)` : ""}`);
	if (r.stdout.length) out.push(`stdout:\n${stdoutText(r.stdout)}`);
	if (r.ok) out.push(`return: ${clip(JSON.stringify(r.value) ?? "null", 2000)}`);
	const text = out.join("\n");
	return text.length > TEXT_BUDGET ? `${text.slice(0, TEXT_BUDGET - 40)}\n... [text cut at ${TEXT_BUDGET} chars]` : text;
}

/** createJsTool({ facts, host, timeoutMs, loadSandbox }) -> V4Tool & { close() } */
export function createJsTool({ facts, host = {}, timeoutMs = 120000, loadSandbox } = {}) {
	if (!facts?.names) throw new Error("createJsTool: rig facts are required");
	const session = createJsSession({ prelude: `globalThis.rig = ${rigLibrarySource(facts)};`, host, ...(loadSandbox ? { loadSandbox } : {}) });
	return {
		name: "js",
		description: DESCRIPTION,
		inputSchema: INPUT_SCHEMA,
		async run(args, call = {}) {
			const code = args?.code;
			if (typeof code !== "string" || !code.trim()) throw new Error("js: code must be a non-empty string (the body of an async function).");
			const limit = args.timeoutMs ?? timeoutMs;
			if (!Number.isInteger(limit) || limit < 1000 || limit > 600000) throw new Error("js: timeoutMs must be a whole number from 1000 to 600000.");
			const r = await session.run(code, { timeoutMs: limit, signal: call?.signal });
			const { images, ...data } = r, shown = images.slice(0, MAX_IMAGES);
			return { data, text: cellText(r, images.length - shown.length), ...(shown.length ? { images: shown } : {}), ...(r.ok ? {} : { isError: true }) };
		},
		close: () => session.close(),
	};
}
