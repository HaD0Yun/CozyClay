// Which engine runs a Studio turn, by its model key (models.mjs): v4 in one Claude Code session, v4 on the pi loop,
// or neither, and then the route goes on with the Studio engine.
// One pi runner serves one Studio conversation, and its pi Agent keeps what it was made with: its system prompt,
// and the history it read from the session store then. So when the engine of a conversation changes, the pi runner
// it has is closed here. The next pi turn makes a new one over the stored history, which holds every engine's turns
// (the Claude Code turn mirrors its messages there), with its own prompt and tools.
import { isV4Model, isV4PiModel } from "./models.mjs";

/**
 * runV4Turn({ value, session, studioRunners, makeRunner, turns, ...turn }) -> true when a v4 engine ran the turn,
 * false when the route runs it with the Studio engine.
 * studioRunners: the route's Map of Studio sessionId -> pi runner; makeRunner() -> a new pi runner for the route.
 * turn: what the engines take (send, close, res, controller, studioTools, hub, sessionStore, models, env, clock,
 * studioIdentity, admission). turns { sdk, pi } replace the two turn functions (tests).
 * session.turnEngine is the engine of the conversation's last turn: "studio", "v4" (Claude Code) or "v4pi".
 */
export async function runV4Turn({ value, session, studioRunners, makeRunner, turns = {}, ...turn }) {
	const engine = isV4Model(value.model) ? "v4" : isV4PiModel(value.model) ? "v4pi" : "studio";
	if (session.modelSession && (session.turnEngine ?? "studio") !== engine) {
		await studioRunners.get(value.sessionId)?.close?.();
		studioRunners.delete(value.sessionId);
		session.modelSession = null;
	}
	session.turnEngine = engine;
	if (engine === "studio") return false;
	if (engine === "v4") return (turns.sdk ?? (await import("./studio-turn.mjs")).runV4StudioTurn)({ value, session, ...turn });
	const runnerFor = async sessionId => {
		let runner = studioRunners.get(sessionId);
		if (!runner) { runner = await makeRunner(); studioRunners.set(sessionId, runner); }
		return runner;
	};
	return (turns.pi ?? (await import("./pi-turn.mjs")).runV4PiStudioTurn)({ value, session, ...turn, runnerFor });
}
