// A motion of a plain Studio turn as work of its own (motion-door.mjs): the motion writer's run does not hang on the
// turn that started it. A stopped or failed turn leaves it (leave): the writer goes on, and what needs the Studio (the
// draft's stand-ins, the install) waits for a turn that takes it over (adopt: a later turn's motion_result), so nothing
// is installed while no turn runs. The turn that holds it is its seat: { hold, mark, rollback, sceneOf, invoke,
// workspaceHandle }, the scene's holder, the turn transaction and the turn's editor actions.

/** A motion's state: { seat, last, stop, held, changed, installed, settled, ended (the writer has ended: its install is
 *  asked for), collected, told, scene, row, compiles, offer, adopt, leave }. */
export function createJob({ seat, scene, row }) {
	const waiting = [];
	const job = {
		seat, last: seat, stop: new AbortController(), held: null, changed: new Set(), installed: false, settled: false, ended: false, collected: false, told: false, scene, row, compiles: 0, offer: null,
		/** A turn takes the motion over: its install and draft run there, its compiles show on that turn's rows. */
		adopt(next) { job.seat = job.last = next; job.row = null; for (const resolve of waiting.splice(0)) resolve(next); },
		/** The turn that held it has ended without it: nothing waits on that turn any more. */
		leave() { job.seat = null; job.row = null; },
		wait: resolve => waiting.push(resolve),
	};
	return job;
}

/** The turn that holds the motion, once there is one. */
export const seatOf = job => (job.seat ? Promise.resolve(job.seat) : new Promise(job.wait));

/** What the agent of a later turn is told of a motion an earlier turn of the conversation left, or null. */
export function jobNote(job) {
	if (job.collected) return job.offer ? "Studio motion observation: the last motion result of this conversation answered installed false with a compiled motion; motion_result { install: true } installs it." : null;
	const state = job.settled || job.ended ? "has ended; its result is not collected and nothing of it is installed" : `is still being written (${job.compiles} compile${job.compiles === 1 ? "" : "s"} so far); nothing of it is installed until a turn collects it`;
	return `Studio motion observation: a motion that an earlier turn of this conversation started ${state}. motion_result answers it and installs it then when the writer answered for it; motion_result { stop: true } stops the writer, only when the user asks for that.`;
}
