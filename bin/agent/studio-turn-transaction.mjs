// The editor transaction a Studio run holds while its model works.
//
// A single turn (the default): one user message is one editor transaction. Every Studio turn whose editor reports a
// previsMode opens agent.turn.begin and closes agent.turn.finish, so all of its mutations land as ONE history entry and
// one receipt frame. A context without a previsMode runs unwrapped (an editor that predates turn transactions).
//
// A task (parallel Studio tasks, P2): the run holds task.begin { taskId, scope, reads, title } instead, so other tasks
// edit other keys of the same scene meanwhile. Its commands carry the taskId and commit one by one (src/bus-tasks.js).
// A stopped task cancels (its keys go back to where they were); a task that ends, even on an error, finishes and keeps
// what it did. A task whose Studio went away (the browser reloaded) is neither: the editor that held it is gone.
//
// mark() records where a script starts; rollback() undoes only the edits after it and keeps the run open, so earlier
// edits still land.
import { randomUUID } from "node:crypto";
import { waitOutGesture } from "./studio-busy-wait.mjs";

// The Studio went away (a reload, a closed tab): no editor answers, or it went while a command ran (UNCERTAIN_APPLY: the
// command may or may not have landed; mcp/live-hub.mjs).
export const LOST_STUDIO = new Set(["LIVE_HUB_UNAVAILABLE", "STALE_HANDLE", "NO_EDITOR", "UNCERTAIN_APPLY"]);

export function studioTransaction({ hub, context, turnId, admission, task = null, signal, plain = false, onWait }) {
	// The main agent holds no transaction (plain): its one quick edit opens a task of its own.
	const wrapped = !plain && Boolean(task || context.scene?.previsMode);
	const host = Object.fromEntries(["workspaceId", "documentEpoch", "sceneId", "sceneEpoch"].map(key => [key, context.host[key]]));
	const verb = name => task ? `task.${name === "begin" ? "begin" : name}` : `agent.turn.${name}`;
	// A control the user's drag refuses (a task's cancel or rollback writes its keys back) waits for the drag to end.
	const control = async (name, extra = {}) => (await waitOutGesture(async () => {
		const args = task ? { taskId: task.taskId, ...extra } : { turnId };
		const receipt = await hub.command("run_action", {
			name: "run_action", args: { action: verb(name), args }, ...(task ? { taskId: task.taskId } : { turnId }),
			// a scene action of this run may have opened another scene: the controls follow the host the tools adopted
			commandId: randomUUID(), host: admission.host ?? host, expectedRevision: admission.revision,
		}, context.host.workspaceHandle);
		if (!receipt.ok) throw Object.assign(new Error(receipt.message), { code: receipt.code });
		return receipt;
	}, { onWait })).result;
	const owner = task ? "taskId" : "turnId", id = task ? task.taskId : turnId;
	const open = async () => {
		await control("begin", task ? { scope: task.scope, ...(task.reads?.length ? { reads: task.reads } : {}), ...(task.title ? { title: task.title.slice(0, 120) } : {}), ...(task.live ? { live: task.live() } : {}) } : {});
		admission[owner] = id;
	};
	return {
		mark: async () => (admission[owner] === id ? control("mark") : null),
		async rollback() {
			if (admission[owner] !== id) return null;
			const receipt = await control("rollback");
			await admission.refresh();
			return receipt;
		},
		run: start => async function* (input) {
			if (!wrapped) { yield* start(input); return; }
			await open();
			let terminal, lost = false, finishError = null;
			try {
				for await (const frame of start(input)) {
					if (frame.type === "tool.done" && !frame.ok && LOST_STUDIO.has(String(frame.error ?? "").split(":")[0])) lost = true;
					if (frame.type === "done") terminal = frame; else yield frame;
				}
			} finally {
				// Finish only the transaction this run opened (a rollback keeps it open).
				if (admission[owner] === id) {
					delete admission[owner];
					const stopped = task && (signal?.aborted || input?.signal?.aborted);
					if (!(task && (lost || task.lost))) {
						try {
							const receipt = await control(stopped ? "cancel" : "finish");
							if (receipt.authored || task) yield { type: "receipt", receipt };
						} catch (error) {
							// The editor that held the task is gone: there is nothing left to finish.
							if (!task || !LOST_STUDIO.has(error.code)) finishError = error;
						}
					}
				}
			}
			if (finishError) throw finishError;
			if (terminal) yield terminal;
		},
	};
}
