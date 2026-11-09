// Which engine runs a Studio turn, by its model key (models.mjs): v4 in one Claude Code session, v4 on the pi loop,
// or neither, and then the route goes on with the Studio engine.
// A pi Agent keeps the system prompt it was made with, and one pi runner serves one Studio conversation. So when a
// conversation moves between the Studio engine and v4 on the pi loop, the other engine's runner is closed here and
// the turn makes a new one: the stored history stays, the prompt and the tools are the new engine's.
import { isV4Model, isV4PiModel } from "./models.mjs";

/**
 * runV4Turn({ value, session, studioRunners, makeRunner, turns, ...turn }) -> true when a v4 engine ran the turn,
 * false when the route runs it with the Studio engine.
 * studioRunners: the route's Map of Studio sessionId -> pi runner; makeRunner() -> a new pi runner for the route.
 * turn: what the engines take (send, close, res, controller, studioTools, hub, sessionStore, models, env, clock,
 * studioIdentity, admission). turns { sdk, pi } replace the two turn functions (tests).
 */
export async function runV4Turn({ value, session, studioRunners, makeRunner, turns = {}, ...turn }) {
	if (isV4Model(value.model)) return (turns.sdk ?? (await import("./studio-turn.mjs")).runV4StudioTurn)({ value, session, ...turn });
	const engine = isV4PiModel(value.model) ? "v4pi" : "studio";
	if (session.modelSession && (session.piEngine ?? "studio") !== engine) {
		await studioRunners.get(value.sessionId)?.close?.();
		studioRunners.delete(value.sessionId);
		session.modelSession = null;
	}
	session.piEngine = engine;
	if (engine === "studio") return false;
	const runnerFor = async sessionId => {
		let runner = studioRunners.get(sessionId);
		if (!runner) { runner = await makeRunner(); studioRunners.set(sessionId, runner); }
		return runner;
	};
	return (turns.pi ?? (await import("./pi-turn.mjs")).runV4PiStudioTurn)({ value, session, ...turn, runnerFor });
}
