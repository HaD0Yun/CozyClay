// The agent-facing words of the motion actions (src/commands/motion3.js): each action's description.
// Lane P owns the wording; the code only reads these constants. The procedure lives in the Studio
// system prompt and the field tables in motion.describe, so these strings say only what each action takes and answers.
export const MOTION_ACTION_HELP = {
	compile: "Bake a spec on the rig and run QA. install: true installs (default), false or \"never\" changes nothing, \"ifClean\" if qa.ok or it beats the take on. "
		+ "Send spec, or base (an answered specId) + optional patch (JSON Patch); base alone or patch: [] re-measures (new probes). "
		+ "Address array items by field, not index: /keys/@f=120/set/hand_l (add creates the key at f120), remove /keys/@f=120, { op: \"move\", from: \"/keys/@f=120\", path: \"/keys/@f=132\" }, "
		+ "/use/@skill=reach&f0=40, /goals/@name=<name>, /objects/<id>/keys/@f=40. "
		+ "spec = { schema: \"cozyclay.motion-spec.v1\", fps: 24, frames (number or \"auto\"), ... }; any number may be { range: [lo, hi] } (searched). "
		+ "probes (at most 16; spec.probes too, never stored): { name, distance: [ref, ref] | position: ref, frames, every? }. "
		+ "Refs need a prefix (joint: prop: anchor: landmark: object: person:; goals[].moved: a bare id too) and take loose bone names; spec.checks need exact ones. "
		+ "repair: { rounds } (1-8, default 4) applies group patches while severity drops. "
		+ "qa judges only what is broken; speed, balance and bends are observations unless checks.limits names them. "
		+ "Answers brief (qa, misses, top groups: a script returns it as is), frames, installed, stuck (when to stop), specId, qa { ok, total, goals, groups (GOAL first, then severity; cause, hint, repair patch?) }, observations (asked: skill ends, contacts, goal points), delta (with base), repair, probes, timeline, fixed, search, skills. more: motion.report pages the rest.",
	fill: "MotionBricks generates the transition between two poses for each gap between authored key poses (at most 46 frames); author 2-4 poses (armw on), then call this instead of plain interpolation. "
		+ "Send spec (keys may name a pose: { f, pose: \"sit_floor\" }) or base + patch; gaps become keys marked src: \"fill\", then it compiles, runs QA and installs like motion.compile (plus output.fill). "
		+ "at: re-fills only the gaps beside that frame. timing: exact (keeps the key frames), retime or playground (the model sets the pace; output.fill.moved), free. Needs the dev server; topic fill.",
	primitive: "A run-up and a vault (one hand on the block) or a jump over a scene block, played from a MotionBricks Smart Primitive: the take crosses the block along +Z at x lane (default the block's centre), hand: left (default) or right plants, "
		+ "keeps its own hand and foot contacts and clears the block, then compiles and installs as is (no repair). The block stands on the floor, 0.3-1 m tall, unturned. Opt-in on the dev server (COZYCLAY_MB_PRIMITIVES=1).",
	qa: "Measure the character's installed take again against the scene as it is now (objects may have moved). Optional checks replace the spec's checks and its skills' checks. "
		+ "Answers specId and qa as motion.compile does (goals, ranked groups with cause, hint and patch); output.more pages with motion.report. Changes nothing.",
	sample: "World positions (metres) of named bones of the installed take at up to 64 frames. Bone names may be loose (any case, a mixamorig: prefix, aliases such as hips or hand_l); an unknown one answers a did-you-mean. "
		+ "Before a take is installed, use motion.compile probes instead. Changes nothing.",
	describe: "The motion spec reference. topic essentials: all a first spec needs, { types (every field of every topic, one line each; objects, channels and reachGrip "
		+ "say what fields mean), skills (typed args, needs, frames, adds), notes }. topic spec, skills, anchors, props, objects, checks, goals, probes, channels, refs, fix or fill: "
		+ "{ topic, schema, example, notes }; skills lists the skills, with name one skill's args and a use example. topic examples answers whole specs that compile. "
		+ "topics: [topic | { topic, name? }] answers several at once: { topics, more (asks that did not fit) }. Changes nothing.",
	keyObject: "Key an object the installed take moves (objectId) at frame, then compile and install it whatever QA says (a user edit, one undo). "
		+ "A carried object takes pos [x, y, z] and rot [x, y, z, w], or aim [x, y, z] (its +Y) and roll?: its base's world pose (a group: its root), grab..release only (objects.<id>.keys); the hand follows. "
		+ "A hinge takes angle (degrees) or rot (its turn about the axis). remove: true deletes the key at frame. Refused where the take neither holds nor hinges it (drag it then). "
		+ "Answers keyed and the motion.compile output; REACH \"<id>: n cm off its keys\": what the hand missed.",
	report: "Page through the parts of a motion.compile or motion.qa answer that did not fit (output.more): specId names the answer (or characterId: its installed take's); part is groups (the default), timeline or probes, from the item index to start at; "
		+ "answers { specId, part, from, items, next } (next = the index to ask for next, null at the end). Changes nothing.",
};
