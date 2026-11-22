// A motion of a plain Studio turn as work of its own (motion-door.mjs): the motion writer's run does not hang on the
// turn that started it. A stopped or failed turn leaves it (leave): the writer goes on, and what needs the Studio (the
// draft's stand-ins, the install) waits for a turn that takes it over (adopt: a later turn's motion_result), so nothing
// is installed while no turn runs. The turn that holds it is its seat: { hold, mark, rollback, sceneOf, invoke,
// workspaceHandle }, the scene's holder, the turn transaction and the turn's editor actions.

/** A motion's state: { seat, first (the turn that started it), last, stop, held, changed, installed, settled, ended (the writer has ended: its install is
 *  asked for), wentIn (the turn its install went through in), collected, told, scene, turn (the id of the turn that
 *  started it), row, offer, adopt, leave }. */
export function createJob({ seat, scene, row, turn = null }) {
	const waiting = [];
	const job = {
		seat, first: seat, last: seat, stop: new AbortController(), held: null, changed: new Set(), installed: false, settled: false, ended: false, wentIn: null, collected: false, told: false, scene, turn, row, offer: null,
		/** A turn takes the motion over: its install and draft run there, its compiles show on that turn's rows. */
		adopt(next) { job.seat = job.last = next; job.row = null; for (const resolve of waiting.splice(0)) resolve(next); },
		/** The turn that held it has ended without it: nothing waits on that turn any more. */
		leave() { job.seat = null; job.row = null; },
		wait: resolve => waiting.push(resolve),
	};
	return job;
}

/** The turn that holds the motion, once there is one. */
const seatOf = job => (job.seat ? Promise.resolve(job.seat) : new Promise(job.wait));

const LEFT = Symbol("left");
/**
 * Runs a motion's install in the turn that holds it: it waits for one (and again when that turn ended while the install
 * waited for the scene), holds the scene alone under that turn's mark, and is rolled back when the Studio refused it. The
 * writer has ended once the install is asked for: motion_result no longer answers the draft (told). With another scene
 * open than the motion's it throws an Error with code "scene": the run keeps the motion out and offers it (motion-run.mjs).
 */
export async function installIn(job, install) {
	job.told = job.ended = true;
	for (;;) {
		const s = await seatOf(job);
		const done = await s.hold(async () => {
			if (job.seat !== s) return LEFT;
			try {
				if (s.sceneOf() !== job.scene) throw Object.assign(new Error("Another scene is open than the one the motion was written in"), { code: "scene" });
				await s.mark();
				try { const out = await install(); job.wentIn = s; return out; } catch (error) { if (error?.code === "studio") await s.rollback(); throw error; }
			} finally { job.installed = true; }
		});
		if (done !== LEFT) return done;
	}
}

/**
 * At the start of a user's turn (value: its sessionId's key, turnId, editNote): the user's edit of their last message
 * cut that turn from the conversation (session-rewind.mjs editNote). A motion that turn started was asked for with words
 * the user has replaced, so its writer is stopped and nothing of it is installed; a motion of an earlier turn stays.
 * turns: conversation -> the id of its last user turn.
 */
export function cutWith(jobs, turns, key, value) {
	const left = jobs.get(key);
	if (value.editNote && left && left.turn === turns.get(key)) { left.stop.abort(); jobs.delete(key); }
	turns.set(key, value.turnId ?? null);
}

/** What the agent of a later turn is told of a motion an earlier turn of the conversation left uncollected, or null. */
export function jobNote(job) {
	if (job.collected) return null;
	const state = job.wentIn ? "was installed in that turn; motion_result answers its result" : job.settled || job.ended ? "has ended and nothing of it is installed; motion_result answers it" : "is still being written and nothing of it is installed; motion_result waits for it and answers it";
	return `Studio motion observation: a motion that an earlier turn of this conversation started ${state}.`;
}
