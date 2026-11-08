// The v4 track tool: the model's handle on the conversation's TrackStore (src/motion-v4/track/store.js), read from
// ctx.track at call time. set, patch, get and clear edit or read the dense per-bone track; commit installs it on the
// character as written (the literal compile: no flow, auto, fixes, retime, repair or thinning); info sums it up.
// A direct call answers a short text; a call from js gets `data`, the store's answer.
const OPS = ["set", "patch", "commit", "info", "get", "clear"];
const numbers = { type: "array", items: { type: "number" } };
const INPUT_SCHEMA = { type: "object", additionalProperties: false, required: ["op"],
	properties: {
		op: { enum: OPS },
		frames: { type: "integer", minimum: 1, maximum: 2400 },
		rot: numbers,
		hips: numbers,
		from: { type: "integer", minimum: 0 },
		to: { type: "integer", minimum: 0 },
		bones: { type: "array", items: { type: "string" } },
		objects: { type: "object", additionalProperties: {
			type: "object", additionalProperties: false, required: ["pos", "quat"], properties: { pos: numbers, quat: numbers } } },
		label: { type: "string", maxLength: 80 } } };

const DESCRIPTION = `The motion track: every bone's LOCAL rotation and the hips' WORLD position on every frame (24 fps, metres, +Y up, frames from 0), plus world poses of scene records the character moves. It lives in the host, not in js. Usually called from js, e.g. await track(T.payload()) with a rig.track builder.
ops:
- set { frames, rot, hips, objects? }: replace the whole track. rot: frames x 65 x 4 numbers, the [x,y,z,w] local quaternion of bone b at frame f at (f*65+b)*4, bones in rig.bones order; the Hips quaternion is its world rotation. hips: frames x 3, the world Hips joint. objects: { recordId: { pos: frames x 3, quat: frames x 4 } }, the world pose of the record's base pivot (a group: its root, its parts ride along).
- patch { from, to, bones?, rot?, hips?, objects? }: overwrite frames from..to (both included). rot: (to-from+1) x bones x 4, frame by frame in the order of bones (default all 65); hips and object arrays sized to the range.
- get { from?, to?, bones? }: the numbers back (to js only).
- info: revision, frames, objects, the installed revision.
- commit { label? }: install the track on the character exactly as written. render commits a changed track by itself.
- clear: drop the track (the installed take stays until the next commit).
Quaternions are normalized. A wrong length, a zero quaternion, an unknown bone or an unknown record id is an error.`;

const NOT_INSTALLED = "Not installed yet (commit, or render commits it).";
const range = (from, to) => (from === to ? `f${from}` : `f${from}-f${to}`);
const objectsSay = ids => (ids.length ? `, objects ${ids.join(", ")}` : "");

function patchSay(args, answer) {
	const parts = [answer.bones.length ? `${answer.bones.length} bone${answer.bones.length === 1 ? "" : "s"}` : null,
		args.hips !== undefined ? "hips" : null, args.objects ? `objects ${Object.keys(args.objects).join(", ")}` : null].filter(Boolean);
	return `patched ${range(answer.from, answer.to)}, ${parts.join(", ")}`;
}

function infoSay(info) {
	if (!info.frames) return `no track yet (r${info.revision}); call track set first.`;
	const installed = info.committed ? `installed r${info.committed}${info.dirty ? ", newer changes not installed" : ""}` : "not installed yet";
	return `track r${info.revision}: ${info.frames} frames x ${info.bones} bones at ${info.fps} fps${objectsSay(info.objects)}; ${installed}.`;
}

/** createTrackTool(ctx) -> V4Tool (name "track"); ctx.track is the TrackStore. */
export function createTrackTool(ctx) {
	return { name: "track", description: DESCRIPTION, inputSchema: INPUT_SCHEMA,
		async run(args = {}) {
			const store = ctx.track, op = args?.op;
			if (!store) throw new Error("track: the track store is not ready.");
			if (!OPS.includes(op)) throw new Error(`track: op must be one of ${OPS.join(", ")}.`);
			if (op === "set") {
				const data = store.set(args);
				return { data, text: `track r${data.revision}: ${data.frames} frames${objectsSay(store.info().objects)}. ${NOT_INSTALLED}` };
			}
			if (op === "patch") {
				const data = store.patch(args);
				return { data, text: `track r${data.revision}: ${store.info().frames} frames; ${patchSay(args, data)}. ${NOT_INSTALLED}` };
			}
			if (op === "clear") {
				const data = store.clear();
				return { data, text: `track r${data.revision}: cleared. The installed take stays on the character until the next commit.` };
			}
			if (op === "commit") {
				const data = await store.commit(args.label === undefined ? {} : { label: args.label });
				return { data, text: `installed r${data.revision} on ${ctx.character.id}: ${data.frames} frames (encode ${Math.round(data.ms.encode)} ms, install ${Math.round(data.ms.install)} ms).` };
			}
			if (op === "get") {
				const data = store.get(args);
				return { data, text: `track data ${range(data.from, data.to)}, ${data.bones.length} bones (returned to js only; call get from js).` };
			}
			const data = store.info();
			return { data, text: infoSay(data) };
		} };
}
