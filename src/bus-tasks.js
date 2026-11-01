// Tasks: several agents editing one scene at once (parallel Studio tasks, P1; plan in docs). A task holds a scope of
// keys (bus-task-scopes.js) instead of the whole-scene turn lock: its commands write only inside it, each command
// commits as its own short entry (the per-command write lock is the document's own composition), and admission reads
// the scope's target tokens, not the scene revision, so another task's edit elsewhere never makes it stale. Before a
// key's first write the task keeps its pre-image (ports.snapshotTarget); cancel and undo-task put the pre-images back
// as one new entry (ports.restoreTargets), which touches no other task's keys. A mark and rollback (a script's start)
// and undo_edit of the task's newest edit restore the same way. The user's own edits are never refused: the task's
// next command on a target the user changed answers STALE_TARGET once. Ctrl+Z stops at a running task's entry.
// A single agent turn (agent.turn.*) is untouched: tasks and a turn never run together.
import { StudioProtocolError, validateReceipt } from './studio-agent-protocol.js';
import { commandKeys, keyOfId, scopeConflict, isScopeKey, layerOf, expandScope, keysOverlap } from './bus-task-scopes.js';

const fail = (code, message) => { throw new StudioProtocolError(code, message); };
const VERBS = ['begin', 'requestScope', 'mark', 'rollback', 'finish', 'cancel', 'undo'];
const FINISHED_KEPT = 32;
/** Task controls that write no document (they grant, mark or close a scope): admitted mid-gesture, so a begin or finish never waits on the user's drag. */
export const GESTURE_FREE_TASK_CONTROLS = new Set(['task.begin', 'task.requestScope', 'task.mark', 'task.finish']);
// A holder the board no longer runs (its run ended without task.finish: a crash, a lost frame) and that sent nothing for this
// long is released when another task's begin needs its keys, instead of answering SCOPE_BUSY forever.
const ORPHAN_IDLE_MS = 30_000;
const listOf = keys => [...keys].slice(0, 6).join(', ') + (keys.length > 6 ? ` and ${keys.length - 6} more` : '');

export function createBusTasks({ ports, emit }) {
	const open = new Map(), finished = new Map(), entryTask = new Map();
	// A character layer has its own token (its fields only), so another task's edit of her other layers never makes it
	// stale; an editor without layer reads falls back to the whole character's.
	const tokenOf = key => {
		const of = layerOf(key);
		if (of?.layer) return ports.readLayer?.(key) ?? ports.readTarget?.(of.id) ?? 'absent';
		const [kind, id] = key.split(/:(.*)/s);
		if (id !== undefined) return ports.readTarget?.(id) ?? 'absent';
		const state = ports.read();
		return kind === 'scene' ? `r${state.revision}` : `${kind}:${state.domainRevisions?.[kind === 'timeline' ? 'shot' : kind] ?? 0}`;
	};
	const snapshot = key => ({ key, value: ports.snapshotTarget ? ports.snapshotTarget(key) : fail('CAPABILITY_MISSING', 'This editor cannot snapshot task targets.') });
	// A scene key has no restorable value (documents have no undo): it is left as it is and said so.
	function restore(task, values, action) {
		task.skipped = values.filter(v => v.value === null).map(v => v.key);
		values = values.filter(v => v.value !== null);
		if (!values.length) return null;
		if (!ports.restoreTargets) fail('CAPABILITY_MISSING', 'This editor cannot restore task targets.');
		const { historyEntryId = null } = ports.restoreTargets(values) ?? {};
		if (historyEntryId) entryTask.set(historyEntryId, task.taskId);
		task.restored = [...new Set(values.map(({ key }) => layerOf(key)?.id ?? (key.includes(':') ? key.slice(key.indexOf(':') + 1) : ports.read().host.sceneId)))];
		for (const { key } of values) task.tokens.set(key, tokenOf(key));
		emit?.({ type: `task.${action}`, taskId: task.taskId, keys: values.map(v => v.key) });
		return historyEntryId;
	}
	// A plain character:<id> is held as its four layers: the commands name layers, and each layer keeps its own token.
	function grant(task, scope, live = null) {
		const bad = scope.find(key => !isScopeKey(key));
		if (bad !== undefined) fail('INVALID_ARGUMENT', `"${bad}" is not a scope key: object:<id>, character:<id> (or one layer: character:<id>:placement, :take, :ik, :props), shot:<id>, stage, timeline or scene.`);
		const keys = expandScope(scope);
		if (live) releaseOrphans(task.taskId, keys, live);
		const conflict = scopeConflict(task.taskId, keys, open);
		if (conflict) fail('SCOPE_BUSY', `${conflict}; wait for it, or ask for what is free.`);
		for (const key of keys) if (!task.keys.has(key)) { task.keys.add(key); task.tokens.set(key, tokenOf(key)); }
	}
	// live: the task ids the sidecar's board still runs. A holder not among them, idle past ORPHAN_IDLE_MS, finishes (keeps its edits).
	function releaseOrphans(taskId, keys, live) {
		const at = (ports.now ?? Date.now)();
		for (const other of [...open.values()]) {
			if (other.taskId === taskId || live.includes(other.taskId) || at - other.lastAt < ORPHAN_IDLE_MS) continue;
			if (![...other.keys].some(held => keys.some(key => keysOverlap(key, held)))) continue;
			open.delete(other.taskId);
			emit?.({ type: 'task.released', taskId: other.taskId, by: taskId, reason: 'its run ended without finishing' });
		}
	}
	function receipt(id, task, request, before, { historyEntryId = null, affectedIds = [], output, warnings = [] } = {}) {
		const after = ports.read();
		if (task.skipped?.length) warnings = [...warnings, { code: 'SCOPE_NOT_RESTORED', message: `Left as they are (a document change has no undo): ${listOf(task.skipped)}.` }];
		task.skipped = null;
		return validateReceipt({ ok: true, status: 'completed', kind: 'transaction', commandId: request.commandId, receiptId: crypto.randomUUID(), host: before.host,
			action: id, txId: task.taskId, authored: Boolean(historyEntryId), revision: { before: before.revision, after: after.revision },
			affectedIds: historyEntryId && !affectedIds.length ? task.restored : affectedIds, delta: [],
			checks: { coverage: 'task-scope' }, warnings, undo: historyEntryId ? { historyEntryId, entries: 1, canUndoDirect: false } : null,
			output: { scope: [...task.keys], ...output } });
	}
	const ownerOf = (request, taskId) => { if (request.origin !== 'agent' || request.taskId !== taskId) fail('CAPABILITY_MISSING', 'Only the owning task can control it.'); };
	return {
		get size() { return open.size; },
		controls: (object, identifier) => Object.fromEntries(VERBS.map(verb => [`task.${verb}`,
			verb === 'begin' || verb === 'requestScope'
				? { ...object({ taskId: identifier, scope: { type: 'array', items: { type: 'string' }, maxItems: 64 } }), properties: { taskId: identifier, scope: { type: 'array', items: { type: 'string' }, maxItems: 64 }, reads: { type: 'array', items: { type: 'string' }, maxItems: 64 }, title: { type: 'string', maxLength: 120 }, live: { type: 'array', items: { type: 'string' }, maxItems: 64 } } }
				: object({ taskId: identifier })])),
		/** The open task a request names (null without one); a request naming a closed task is refused. */
		of(request, id) {
			if (!request.taskId) return null;
			const task = open.get(request.taskId);
			if (!task && !id.startsWith('task.')) fail('STALE_TARGET', `Task ${request.taskId} is not open.`);
			if (task) task.lastAt = (ports.now ?? Date.now)();
			return task ?? null;
		},
		/** task.* controls. `busy` says why no task may begin (an agent turn or a command transaction is open). */
		control(id, args, request, before, busy) {
			if (id === 'task.undo') {
				const task = finished.get(args.taskId) ?? fail('UNDO_EXPIRED', `Task ${args.taskId} is not a finished task this editor still holds.`);
				// A key moved when its token did and its content did too: a later task undone first puts the same content back
				// under a new token, and that is not a change.
				const moved = [...task.final].filter(([key, { token, value }]) => tokenOf(key) !== token && JSON.stringify(snapshot(key).value) !== value).map(([key]) => key);
				if (moved.length) fail('UNDO_CONFLICT', `Changed since the task finished: ${listOf(moved)}; undo those first or edit by hand.`);
				const historyEntryId = restore(task, [...task.pre.values()], 'undone');
				finished.delete(args.taskId);
				return receipt(id, task, request, before, { historyEntryId, affectedIds: task.affectedIds });
			}
			ownerOf(request, args.taskId);
			if (id === 'task.begin') {
				if (busy) fail('TARGET_BUSY', busy);
				// Its owner begins it again after its run was cut off while this editor stayed (a hub timeout read as a lost
				// Studio): it resumes with its pre-images and edits, so a cancel still restores; the cut-off run's mark is gone.
				const held = open.get(args.taskId);
				if (held) {
					grant(held, args.scope);
					for (const key of held.keys) held.tokens.set(key, tokenOf(key));
					held.mark = null; held.lastAt = (ports.now ?? Date.now)();
					emit?.({ type: 'task.scope', taskId: held.taskId, scope: [...held.keys] });
					return receipt(id, held, request, before, { output: { resumed: true } });
				}
				if (finished.has(args.taskId)) fail('INVALID_ARGUMENT', `Task ${args.taskId} already exists.`);
				const task = { taskId: args.taskId, title: args.title ?? '', keys: new Set(), reads: new Set(args.reads ?? []), tokens: new Map(), pre: new Map(), edits: [], notices: [], affectedIds: [], lastAt: (ports.now ?? Date.now)() };
				grant(task, args.scope, Array.isArray(args.live) ? args.live : null);
				open.set(task.taskId, task);
				emit?.({ type: 'task.begun', taskId: task.taskId, scope: [...task.keys] });
				return receipt(id, task, request, before);
			}
			const task = open.get(args.taskId) ?? fail('STALE_TARGET', `Task ${args.taskId} is not open.`);
			if (id === 'task.requestScope') { grant(task, args.scope); emit?.({ type: 'task.scope', taskId: task.taskId, scope: [...task.keys] }); return receipt(id, task, request, before); }
			if (id === 'task.mark') { task.mark = { values: [...task.keys].map(snapshot), keys: new Set(task.keys) }; return receipt(id, task, request, before); }
			if (id === 'task.rollback') {
				const mark = task.mark ?? fail('STALE_TARGET', 'The task has no mark to roll back to.');
				task.mark = null;
				const after = [...task.keys].filter(key => !mark.keys.has(key)).map(key => task.pre.get(key) ?? snapshot(key));
				const historyEntryId = restore(task, [...mark.values, ...after], 'rolledBack');
				task.edits = task.edits.filter(edit => edit.mark !== mark);
				return receipt(id, task, request, before, { historyEntryId });
			}
			open.delete(task.taskId);
			if (id === 'task.cancel') {
				const historyEntryId = restore(task, [...task.pre.values()], 'cancelled');
				return receipt(id, task, request, before, { historyEntryId, affectedIds: task.affectedIds });
			}
			task.final = new Map([...task.pre.keys()].map(key => [key, { token: tokenOf(key), value: JSON.stringify(snapshot(key).value) }]));
			finished.set(task.taskId, task);
			while (finished.size > FINISHED_KEPT) finished.delete(finished.keys().next().value);
			emit?.({ type: 'task.finished', taskId: task.taskId });
			return receipt(id, task, request, before, { affectedIds: task.affectedIds, output: { edits: task.edits.length } });
		},
		/**
		 * Admits a command: a task writes only inside its scope, on targets nobody else changed since it last looked; a
		 * wire caller outside any task may not write a running task's keys; the UI always may. Answers the point a
		 * task's edit restores to (undo_edit of it), after keeping each key's first pre-image.
		 */
		admit(task, entry, args, request, before) {
			if (!task && !open.size) return null;
			const keys = entry?.id ? commandKeys(entry.id, args, before, entry) : [];
			// The user's own edit is never refused; a running task whose scope it touches hears of it (the panel's card).
			if (!task && request.origin === 'ui') { for (const other of open.values()) { const mine = keys.filter(key => [...other.keys].some(held => keysOverlap(key, held))); if (mine.length) emit?.({ type: 'task.userEdit', taskId: other.taskId, keys: mine }); } return null; }
			if (!task) {
				const held = keys.find(key => scopeConflict(null, [key], open));
				if (held) fail('SCOPE_BUSY', `${scopeConflict(null, [held], open)}; this command waits for that task.`);
				return null;
			}
			const outside = keys.filter(key => !task.keys.has(key));
			if (outside.length) fail('SCOPE_DENIED', `Outside this task's scope: ${listOf(outside)}. Ask for it with task.requestScope, or leave it to the task that holds it.`);
			const moved = keys.filter(key => task.tokens.has(key) && tokenOf(key) !== task.tokens.get(key));
			if (moved.length) {
				for (const key of moved) task.tokens.set(key, tokenOf(key));
				fail('STALE_TARGET', `${listOf(moved)} changed outside this task (the user, or an undo) since it last looked; read it again, then retry.`);
			}
			for (const key of keys) if (!task.pre.has(key)) task.pre.set(key, snapshot(key));
			return { task, keys, values: keys.map(snapshot), mark: task.mark, fence: new Map(keys.map(key => [key, tokenOf(key)])) };
		},
		/**
		 * A task's job fences on its own keys, not the whole target: another task placing the character while this one
		 * compiles her take is not a change under the compile. moved(point) names what changed since admit or rebase(point).
		 */
		moved: point => [...point.fence].filter(([key, token]) => tokenOf(key) !== token).map(([key]) => key),
		rebase(point) { for (const key of point.fence.keys()) point.fence.set(key, tokenOf(key)); },
		/** Files a task's receipt: ids it created join its scope, it may be undone newest first, readers hear of it. */
		record(point, recorded) {
			if (!point || !recorded?.ok) return recorded;
			const { task } = point, state = ports.read(), warnings = [];
			let grew = false;
			// A character the task holds one layer of is its own: the command was admitted on that layer.
			for (const id of recorded.affectedIds ?? []) {
				const key = keyOfId(id, state);
				if (!key || [...task.keys].some(held => keysOverlap(key, held))) continue;
				if (scopeConflict(task.taskId, [key], open)) { warnings.push({ code: 'SCOPE_DENIED', message: `${key} changed outside the task's scope.` }); continue; }
				for (const made of expandScope([key])) { task.keys.add(made); grew = true; if (!point.keys.includes(made)) { task.pre.set(made, { key: made, value: undefined }); point.values.push({ key: made, value: undefined }); } }
			}
			if (grew) emit?.({ type: 'task.scope', taskId: task.taskId, scope: [...task.keys] });
			for (const key of task.keys) task.tokens.set(key, tokenOf(key));
			if (recorded.authored) {
				task.edits.push({ receiptId: recorded.receiptId, values: point.values, keys: point.keys, mark: point.mark });
				task.affectedIds = [...new Set([...task.affectedIds, ...recorded.affectedIds])];
				if (recorded.undo?.historyEntryId) entryTask.set(recorded.undo.historyEntryId, task.taskId);
				for (const other of open.values()) for (const key of point.keys) if (other !== task && [...other.reads].some(read => keysOverlap(read, key))) {
					other.notices.push({ code: 'DEPENDENCY_CHANGED', message: `${key}, which this task reads, was changed by task ${task.taskId}.` });
					emit?.({ type: 'task.dependencyChanged', taskId: other.taskId, key, by: task.taskId });
				}
			}
			const heard = task.notices.splice(0);
			return heard.length || warnings.length ? { ...recorded, warnings: [...recorded.warnings, ...warnings, ...heard].slice(0, 12) } : recorded;
		},
		/** History traversal: undo_edit of a task's newest edit inside it; the UI's undo stops at a running task's entry. */
		traversal(id, args, request, before, frontier) {
			const task = request.taskId ? open.get(request.taskId) : null;
			if (task && id === 'edit.undo') {
				const at = task.edits.findIndex(edit => edit.receiptId === args.receiptId);
				if (at < 0) fail('TARGET_BUSY', `Inside a task, undo_edit takes the receiptId of the task's own newest edit${task.edits.length ? ` (now ${task.edits.at(-1).receiptId})` : ''}.`);
				if (at < task.edits.length - 1) fail('UNDO_CONFLICT', `Later edits of this task come after it; undo them first, newest first: ${task.edits.slice(at + 1).reverse().map(edit => edit.receiptId).join(', ')}.`);
				const edit = task.edits.pop(), historyEntryId = restore(task, edit.values, 'editUndone');
				return receipt(id, task, request, before, { historyEntryId, output: { undoneReceiptId: edit.receiptId } });
			}
			const owner = open.get(entryTask.get(frontier));
			if (!task && owner) fail('TARGET_BUSY', `The last edit belongs to running task ${owner.taskId}${owner.title ? ` (${owner.title})` : ''}; cancel or undo it from that task.`);
			return null;
		},
		dispose() { open.clear(); finished.clear(); entryTask.clear(); },
	};
}
