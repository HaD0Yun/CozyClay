// The Auto Pose tool's behaviour for one character: press, live drag and turn with coalesced
// solves, release, per-handle switches and the whole-pose actions. Every change of the pose goes through the host's
// IK drag path (`host.solve("poser", null, write)` then `host.dragEnd()`), so a release is keyed like any Pose mode
// drag: an IK key at the playhead without a take, the preview-then-apply flow with one. One release = one undo step.
import { dragSends, HANDLES } from "../handles.js";
import { afterDrag, canMove, forgetLeft, initialHandles, LOOK_AHEAD, pressHandles, resetLookAt, setEnabled, setHoldsRotation, setHeld, setTolerance } from "./handle-state.js";
import { writePose } from "../retarget.js";
import { bonesForPose, copyPose, holdUnkeyed, flipPose, pastePose, restBones } from "./pose-ops.js";
import { getPoserState, updatePoserState } from "./poser-store.js";
import { POSER_KEY_TRACKS, sameSignature } from "./rig-bridge.js";
import { checkSolve, liftToFloor, REACH_MARGIN } from "./solve-guard.js";
import { createSolveLoop } from "./solve-loop.js";

// Handle state per character, kept while the page lives so switching characters or tools keeps each one's handles.
const states = new Map();
const JOINT_OF = Object.fromEntries(HANDLES.map((h) => [h.id, h.joint]));
const TIMING_KEEP = 600;
// A release waits this long for the last solve; a solve that never answers must not hold the tool forever.
const RELEASE_WAIT_MS = 4000;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);

/**
 * `bridge`: rig-bridge.js; `poser`: createPoser(); `host`: `{ solve(kind, track, write), dragEnd() }` (the motion
 * domain's ikSolve / ikDragEnd). Returns the controller the viewport handles and the panel call.
 */
export function createPoserController({ characterId, bridge, poser, host }) {
	let handles = states.get(characterId) ?? initialHandles();
	let written = null, session = null;
	const stats = { solves: [], rejected: 0, refused: 0, failed: 0, dropped: 0 };
	const sk = poser.skeleton, facts = bridge.facts;

	function publish(extra = {}) {
		states.set(characterId, handles);
		if (getPoserState().characterId === characterId) updatePoserState({ handles, ...extra });
	}

	/** Places and turns the user left belong to the pose Auto Pose wrote; an undo or a frame change makes them stale. */
	function checkStale() {
		if (written && !sameSignature(written, bridge.signature())) { handles = forgetLeft(handles); written = null; }
	}

	function poseNow() {
		const pose = bridge.readPose(), head = bridge.jointPoser(6), G = pose.G;
		return {
			pose, jointAt: (j) => bridge.jointPoser(j), turnAt: (j) => Array.from(G.subarray(9 * j, 9 * j + 9)),
			lookHome: [head[0] + LOOK_AHEAD * G[9 * 6 + 2], head[1] + LOOK_AHEAD * G[9 * 6 + 5], head[2] + LOOK_AHEAD * G[9 * 6 + 8]],
		};
	}

	// The host refuses a write meant for a rig that is no longer the active character's (a switch while a solve ran),
	// so this answers whether the bones were written; nothing unwritten is ever keyed.
	function write(bones) {
		let wrote = false;
		host.solve("poser", null, (touch) => {
			wrote = true;
			bridge.write(bones);
			for (const id of POSER_KEY_TRACKS) touch(id);
		}, { rig: bridge.rig });
		return wrote;
	}
	function finish(wrote) {
		if (!wrote) return;
		host.dragEnd();
		written = bridge.signature();
	}

	// One solve: the poser's full solve, then the write again with the bones no key stores held (pose-ops.js HELD_JOINTS), then
	// the guard (solve-guard.js): a result that would throw the body or pull a held handle away is not written.
	async function solve(job) {
		const sends = dragSends(job.handles, job.drag), result = await poser.solve(sends, bridge.character);
		if (!result.ok) return result;
		result.bones = liftToFloor(facts, writePose(facts, { joints: result.joints, G: holdUnkeyed(facts, result.G, job.session.keep) }, result.effectors).bones).bones;
		result.guard = checkSolve(facts, result, { sends, drag: job.drag, press: job.session.press });
		return result;
	}
	// guard distances are on the body at its own size; the panel shows them as the stage sees them
	const stageCm = (cm) => (cm == null ? null : cm * bridge.stature);
	const hintOf = (hint, detail = null) => { const s = getPoserState(); if (s.hint !== hint || JSON.stringify(s.detail) !== JSON.stringify(detail)) updatePoserState({ hint, detail }); };

	const loop = createSolveLoop(solve, {
		onResult(result, job) {
			if (!result.ok) { stats.rejected += 1; hintOf(result.reason); return; }
			if (session !== job.session) return;
			if (!result.guard.ok) { stats.refused += 1; hintOf(result.guard.reason, { id: result.guard.id ?? null, cm: stageCm(result.guard.cm) }); return; }
			if (!write(result.bones)) return;
			job.session.wrote = true;
			job.session.applied = job.drag;
			stats.solves.push({ ...result.timings, at: performance.now(), errAfterCm: result.errAfterCm, belowFloorCm: result.belowFloorCm });
			if (stats.solves.length > TIMING_KEEP) stats.solves.shift();
			const reach = result.guard.reach;
			if (reach) hintOf("out-of-reach", { id: reach.id, cm: stageCm(reach.cm) });
			else hintOf(result.warnings[0] ?? null);
		},
		onError(error) { stats.failed += 1; hintOf("solve-failed", { message: String(error?.message ?? error) }); },
	});

	/**
	 * End a session that outlived its gesture (a lost pointer release, a solve that never answered): what it wrote
	 * is keyed, queued solves are dropped. Nothing else can start while one is open.
	 */
	function dropSession() {
		if (!session) return;
		const s = session;
		session = null;
		loop.clear();
		stats.dropped += 1;
		finish(s.wrote);
	}

	/** Pose facts at the start of a gesture, for the guard: the root, and each held handle's distance from its place. */
	function pressFacts(state, id) {
		const miss = {};
		for (const [hid, h] of Object.entries(state)) if (h.enabled && h.held && h.place && hid !== "lookAt") miss[hid] = dist(bridge.jointPoser(JOINT_OF[hid]), h.place);
		return { root: bridge.jointPoser(0), place: id ? state[id]?.place ?? null : null, miss };
	}

	/** Start a drag or turn of handle `id`. A new press always wins over a leftover session. */
	function press(id) {
		dropSession();
		checkStale();
		handles = pressHandles(handles, poseNow());
		// dragging a switched-off handle switches it on, so it sends from the first move
		const base = handles[id] && !handles[id].enabled ? setEnabled(handles, id, true).state : handles;
		session = { id, pressTurn: handles[id]?.turn ?? null, target: null, turn: null, wrote: false, applied: null, base, keep: bridge.heldLocals(), press: pressFacts(base, id) };
		updatePoserState({ selected: id });
		return true;
	}
	const request = (drag) => loop.request({ handles: session.base, drag, session });

	async function release() {
		const s = session;
		if (!s) return;
		await within(loop.idle(), RELEASE_WAIT_MS);
		if (session !== s) return;
		session = null;
		loop.clear();
		finish(s.wrote);
		if (s.wrote) {
			// the handle stays where the body could take it: a target out of reach snaps back onto its joint
			let target = s.applied?.target ?? null;
			if (target && s.id !== "lookAt" && dist(bridge.jointPoser(JOINT_OF[s.id]), target) > REACH_MARGIN) target = bridge.jointPoser(JOINT_OF[s.id]);
			handles = afterDrag(handles, { id: s.id, target, turn: s.applied?.turn ?? null, pressTurn: s.pressTurn });
		}
		publish();
	}

	/** Re-solve from the pose as it stands with no handle dragged (after switching a handle off). */
	async function settle() {
		dropSession();
		checkStale();
		handles = pressHandles(handles, poseNow());
		const s = session = { id: null, wrote: false, keep: bridge.heldLocals(), press: pressFacts(handles, null) };
		loop.request({ handles, drag: { id: null }, session: s });
		await within(loop.idle(), RELEASE_WAIT_MS);
		if (session !== s) return;
		session = null;
		finish(s.wrote);
		publish();
	}

	/** Write a whole pose as one keyed, undoable step (after ending any leftover session). */
	function commit(bones) {
		dropSession();
		if (!bones.every((b) => [...b.quaternion, ...b.position].every(Number.isFinite))) { hintOf("not-finite"); return false; }
		const wrote = write(liftToFloor(facts, bones).bones);
		finish(wrote);
		return wrote;
	}

	return {
		characterId, bridge, stats,
		get handles() { return handles; },
		get dragging() { return session?.id ?? null; },
		get dragTarget() { return session?.target ?? null; },
		get busy() { return loop.busy; },
		/** Drop places and turns left on a pose that changed elsewhere (called every frame by the handles). */
		refreshStale() { const before = handles; checkStale(); if (handles !== before) publish(); },
		press, release,
		move(target) { if (!session) return; session.target = target; request({ id: session.id, target, turn: session.turn ?? undefined }); },
		// a held handle turns in place: it keeps sending its place while the turn is sent
		turn(turn) { if (!session) return; session.turn = turn; const s = session.base[session.id]; request({ id: session.id, turn, target: s?.held && canMove(session.id) && session.id !== "lookAt" ? s.place : undefined }); },
		select(id) { updatePoserState({ selected: id }); },
		setEnabled(id, on) {
			const next = setEnabled(handles, id, on);
			handles = next.state;
			publish();
			if (next.resolve) return settle();
		},
		setHeld(id, on) { handles = setHeld(handles, id, on); publish(); },
		setTolerance(id, value, options) { handles = setTolerance(handles, id, value, options); publish(); },
		setHoldsRotation(id, on) { handles = setHoldsRotation(handles, id, on); publish(); },
		resetLookAt() { handles = resetLookAt(handles); publish(); },
		/** Back to T-pose: bones to rest, handles to their start state. */
		reset() { if (commit(restBones(facts, { skipHeld: true }))) { handles = initialHandles(); written = bridge.signature(); publish({ hint: null, detail: null }); } },
		flip() { if (commit(bonesForPose(facts, flipPose(sk, facts, bridge.readPose()), bridge.heldLocals()))) { handles = forgetLeft(handles); written = bridge.signature(); publish(); } },
		copy() { updatePoserState({ clipboard: copyPose(facts, bridge.readPose(), characterId) }); },
		paste({ reversed = false } = {}) {
			const clip = getPoserState().clipboard;
			if (!clip) return false;
			const pose = pastePose(sk, facts, clip, bridge.readPose(), { reversed, source: characterId });
			if (!commit(bonesForPose(facts, pose, bridge.heldLocals()))) return false;
			handles = forgetLeft(handles);
			written = bridge.signature();
			publish();
			return true;
		},
	};
}
