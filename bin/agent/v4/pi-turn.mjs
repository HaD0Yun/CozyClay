// One Studio turn of the v4 tools on CozyClay's pi loop (agent-runner.mjs) instead of Claude Code.
// Differs from studio-turn.mjs: the turn runs through the route's pi runner on "cliproxy/claude-opus-5-5",
// with contextView "plain" (no Studio context diet or budget) and effort "high" by default; pi keeps the history.
// Shared with studio-turn.mjs: the conversation cache (ctx + tool set per Studio sessionId), the first-turn
// scene brief, the later-turn state line, the V4 system prompt and the idle retire timer.
import { toV4AgentTools } from "./pi-tools.mjs";
import { V4_SYSTEM_PROMPT } from "./prompt.mjs";
import { conversationFor, promptOf, scheduleRetire } from "./studio-turn.mjs";

const PI_MODEL = "cliproxy/claude-opus-5-5";

/**
 * runV4PiStudioTurn({ value, session, send, close, res, controller, studioTools, hub, sessionStore, runnerFor,
 *                     studioIdentity, admission, loadToolSet }) -> true (the route's env and clock ride in its runner)
 * runnerFor(sessionId) -> the route's pi runner for that Studio session. Runs one turn, ends the record with a
 * done frame, then closes the stream and clears the session's running turn the way agent-routes.mjs does.
 */
export async function runV4PiStudioTurn({ value, session, send, close, res, controller, studioTools, hub, sessionStore, runnerFor, studioIdentity, admission, loadToolSet }) {
	const signal = controller.signal;
	let done = false;
	try {
		try {
			const workspaceHandle = value.context.host.workspaceHandle;
			const describe = await hub.command("describe", {}, workspaceHandle);
			const { conversation, fresh } = await conversationFor(value.sessionId, { describe, studioTools, hub, workspaceHandle, signal }, loadToolSet);
			// First turn of this Studio conversation when pi has no stored history for it.
			const first = !(sessionStore?.read?.(value.sessionId)?.history?.length > 0);
			const prompt = promptOf({ value, ctx: conversation.ctx, describe, first, restarted: fresh && !first });
			const studioContextText = `<studio-context>\n${prompt.context}\n</studio-context>`;
			const tools = toV4AgentTools(conversation.toolSet.tools, { signal });
			const runner = await runnerFor(value.sessionId);
			session.modelSession ??= await runner.openSession(value.sessionId, { surface: "studio" });
			for await (const frame of session.modelSession.start({
				surface: "studio", sessionId: value.sessionId, model: PI_MODEL, effort: value.effort ?? "high",
				text: value.text, attachments: value.attachments, studioContextText, contextView: "plain",
				systemPrompt: V4_SYSTEM_PROMPT, tools, signal, emit: send,
				meta: { sceneName: value.context?.scene?.name ?? null, firstText: value.text }, reportCost: false,
			})) {
				if (frame?.type === "done") done = true;
				send(frame);
			}
		} catch (error) {
			if (!signal.aborted) send({ type: "error", code: typeof error?.code === "string" && error.code ? error.code : "upstream", message: String(error?.message ?? error) });
		}
		if (!done) {
			if (signal.aborted) send({ type: "error", code: "aborted", message: "The turn was stopped." });
			send({ type: "done" });
			done = true;
		}
	} finally {
		scheduleRetire(value.sessionId);
		close?.();
		if (res && !res.writableEnded) res.end();
		session.controller = null;
		session.activeTurnId = null;
		if (admission?.host?.workspaceId === value.context.host.workspaceId) session.host = studioIdentity({ ...value.context.host, ...admission.host });
	}
	return true;
}
