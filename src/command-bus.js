// The Studio command runner. The registry owns declarations/implementations;
// the editor ports own native state/history, and the existing journal owns
// idempotency. Synchronous UI actions stay synchronous (including user gestures).
import { StudioProtocolError, StudioSchemas, validateStudioSchema, validateReceipt, validateStudioIdentity, refusalCode } from './studio-agent-protocol.js';
import { agentTurnControls, markAgentTurn, turnEditPoint, recordTurnEdit, undoTurnEdit } from './agent-turn-mark.js';
import { createBusTasks, GESTURE_FREE_TASK_CONTROLS } from './bus-tasks.js'; import { uiTransactionOpen } from './studio-busy.js';
import { createHistoryReceipts, noteRefusal, noteUndone } from './command-bus-telemetry.js';

export { withCommandHistory } from './command-history.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (code, message) => { throw new StudioProtocolError(code, message); };
const mapResult = (value, success, failure) => value?.then ? value.then(success, failure) : success(value);
const toastWarnings = toasts => toasts.slice(-12).map(toast => ({ code: 'STUDIO_TOAST', message: [...toast.message].slice(0, 120).join('') }));

export function createCommandBus({ registry, ports }) {
  const pending = new Map(), transactions = new Map(), jobs = new Map(), listeners = new Set();
  const confirmations = new Map(), historyReceipts = createHistoryReceipts(ports);
  let agentTurn = null;
  const tasks = createBusTasks({ ports, emit: event => emit(event) });
  function exposure(entry, args, request) {
    if (request.origin === 'ui') return;
    if (entry.exposure === 'ui-only') fail('CAPABILITY_MISSING', entry.uiOnlyHint ?? 'This command is available only from the Studio UI.');
    if (entry.id === 'load_scenes') {
      const ids = scenes => [...new Set(scenes.map(scene => scene.id))].sort();
      if (same(ids(args.document.scenes), ids(registry.state().scenes))) return;
    } else if (entry.exposure !== 'confirm' || entry.requiresConfirmation?.(registry.state(), args) === false) return;
    const token = confirmations.get(request.confirmationToken);
    if (!token || token.id !== entry.id || !same(token.args, args) || !same(token.host, ports.read().host) || token.expires < (ports.now ?? Date.now)()) fail('CONFIRMATION_REQUIRED', entry.confirmationReason ?? 'This command needs user confirmation.');
    confirmations.delete(request.confirmationToken);
  }
  const emit = event => { for (const listener of listeners) listener(event); ports.emit?.(event); };
  const identifier = StudioSchemas.TargetGuard.properties.targetId;
  const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
  const argsSchema = { type: 'object', properties: {}, required: [], additionalProperties: true };
  const controls = {
    ...agentTurnControls(object, identifier), ...tasks.controls(object, identifier),
    'run.begin': object({ id: identifier, args: argsSchema }),
    'run.update': object({ txId: identifier, args: argsSchema }),
    'run.commit': object({ txId: identifier }),
    'run.cancel': object({ txId: identifier }),
    'job.await': { ...object({ jobId: identifier }), properties: { jobId: identifier, timeoutMs: { type: 'integer', minimum: 1, maximum: 300_000, default: 30_000 } } },
    'job.cancel': object({ jobId: identifier }),
    'edit.undo': { ...object({ receiptId: identifier }), required: [] },
    'edit.redo': { ...object({ receiptId: identifier }), required: [] },
  };
  const clear = timer => (ports.clearTimeout ?? clearTimeout)(timer);
  function cancelTransaction(tx, expired = false, reason = new StudioProtocolError('CANCELLED', 'Transaction was cancelled.')) {
    transactions.delete(tx.txId); clear(tx.timer); if (tx.workTimer !== undefined) clear(tx.workTimer); tx.controller.abort(reason);
    tx.session.cancel({ restore: same(tx.before.host, ports.read().host) });
    emit({ type: 'transaction.cancelled', txId: tx.txId, expired });
  }
  function renew(tx) {
    if (tx.timer !== undefined) clear(tx.timer);
    tx.timer = (ports.setTimeout ?? setTimeout)(() => cancelTransaction(tx, true), ports.transactionIdleMs ?? 30_000);
  }
  function control(id, args, request, before) {
    if (id.startsWith('task.')) return tasks.control(id, args, request, before, agentTurn ? 'Finish the agent turn first.' : transactions.size > Number(uiTransactionOpen(transactions)) ? 'Finish the open command transaction first.' : null);
    if (id.startsWith('agent.turn.')) {
      if (request.origin !== 'agent' || request.turnId !== args.turnId) fail('CAPABILITY_MISSING', 'Only the owning agent turn can control this transaction.');
      if (id === 'agent.turn.begin') {
        if (agentTurn || transactions.size || tasks.size) fail('TARGET_BUSY', 'Finish the open transaction first.');
        agentTurn = { txId: args.turnId, before, affectedIds: new Set(), toasts: [], session: null };
        return transactionReceipt(id, agentTurn, request, before);
      }
      if (agentTurn?.txId !== args.turnId) fail('STALE_TARGET', 'The agent turn is no longer open.');
      const turn = agentTurn;
      // A script's mark, and the rollback to it that keeps the turn open (agent-turn-mark.js).
      if (id === 'agent.turn.mark' || id === 'agent.turn.rollback') return transactionReceipt(id, markAgentTurn(id, turn), request, before);
      // A rolled-back turn restores every owner it touched and leaves no entry.
      if (id === 'agent.turn.cancel') { agentTurn = null; turn.session?.cancel(); return transactionReceipt(id, turn, request, before); }
      try { turn.historyEntryId = turn.session?.commit().historyEntryId; }
      catch (error) { turn.session?.cancel(); throw error; }
      finally { agentTurn = null; }
      return transactionReceipt(id, turn, request, turn.before);
    }
    // Every Studio turn opens a turn transaction (#715), so "undo the last thing" arrives inside one. Until the
    // turn has authored (no session yet) history traversal is safe: the undo lands as its own entry (#735).
    // After that the turn owns the frontier: its own agent may undo its newest edit (agent-turn-mark.js).
    const traversal = id === 'edit.undo' || id === 'edit.redo', scoped = traversal && tasks.traversal(id, args, request, before, id === 'edit.undo' ? ports.history?.(false) : null);
    if (scoped) return scoped;
    if (agentTurn && !id.startsWith('job.') && !(traversal && !agentTurn.session)) { if (id === 'edit.undo' && request.turnId === agentTurn.txId) return validateReceipt(undoTurnEdit(agentTurn, args, request, before, () => ports.read())); fail('TARGET_BUSY', 'Finish the agent turn before traversing history or opening another transaction.'); }
    if (traversal) {
      const redo = id === 'edit.redo', historyEntryId = ports.history?.(redo);
      const previous = args.receiptId ? ports.receipt(args.receiptId) : historyReceipts.get(historyEntryId)
        ?? (historyEntryId ? { receiptId: historyEntryId, host: before.host, affectedIds: [before.host.sceneId],
          undo: { historyEntryId, entries: 1, canUndoDirect: true } } : null);
      if (!args.receiptId && !previous) return validateReceipt({ ok: true, status: 'noop', action: id,
        commandId: request.commandId, receiptId: crypto.randomUUID(), host: before.host, authored: false, mutated: false,
        revision: { before: before.revision, after: before.revision }, affectedIds: [], delta: [],
        checks: { coverage: 'native-history-restoration' }, undo: null, warnings: [] });
      if (!previous?.undo || !ports.isRetained(previous)) fail('UNDO_EXPIRED', 'The receipt no longer has a retained history entry.');
      if (!same(previous.host, before.host)) fail('STALE_SCENE', 'The receipt belongs to another document.');
      if (redo ? historyEntryId !== previous.undo.historyEntryId : !ports.canUndo(previous)) fail('UNDO_CONFLICT', 'Another edit owns the history boundary.');
      (redo ? ports.redo : ports.undo)();
      const after = ports.read(), ids = previous.affectedIds;
      const restoredTargets = ids.map(targetId => ({ ...before.host, targetId, token: ports.readTarget?.(targetId) ?? `removed-${crypto.randomUUID()}` }));
      return validateReceipt({ ok: true, status: redo ? 'applied' : 'undone', commandId: request.commandId, receiptId: crypto.randomUUID(), host: before.host,
        authored: true, revision: { before: before.revision, after: after.revision }, affectedIds: ids,
        delta: ids.slice(0, 8).map(targetId => ({ id: targetId, after: { token: restoredTargets.find(t => t.targetId === targetId).token } })),
        checks: { coverage: 'native-history-restoration' }, undo: { ...previous.undo, canUndoDirect: redo }, warnings: [],
        ...(redo ? { action: id, mutated: true } : { undoneReceiptId: previous.receiptId, restoredTargets }),
        ...(ids.length > 8 ? { detailCursor: request.commandId } : {}) });
    }
    if (id.startsWith('job.')) {
      const job = jobs.get(args.jobId);
      if (!job || !same(job.host, before.host)) fail('STALE_TARGET', 'Job is not in this document.');
      if (id === 'job.cancel' && !job.outcome) job.controller.abort(new StudioProtocolError('CANCELLED', 'Job was cancelled.'));
      let timer;
      const wait = id === 'job.await' && !job.outcome ? Promise.race([job.completion, new Promise((_, reject) => {
        timer = (ports.setTimeout ?? setTimeout)(() => reject(new StudioProtocolError('TIMEOUT', 'Job is still running.')), args.timeoutMs);
      })]) : job.completion;
      return wait.then(value => validateReceipt({ ...value, commandId: request.commandId, ...(value.ok ? { receiptId: crypto.randomUUID() } : {}), jobId: job.id })).finally(() => { if (timer !== undefined) clear(timer); });
    }
    let tx;
    if (id === 'run.begin') {
      if (transactions.size) fail('TARGET_BUSY', 'Finish or cancel the open command transaction first.');
      const prepared = registry.prepare(args.id, args.args);
      exposure(prepared.entry, prepared.args, request);
      if (prepared.entry.kind !== 'mutation') fail('INVALID_ARGUMENT', 'Only mutations can open a transaction.');
      tx = { txId: crypto.randomUUID(), entry: prepared.entry, before, origin: request.origin, targetId: prepared.args.characterId ?? null, controller: new AbortController(),
        session: ports.beginAction(prepared.entry.undoDomain, prepared.args.characterId ?? null), affectedIds: new Set(), toasts: [] };
      transactions.set(tx.txId, tx); renew(tx);
    } else {
      tx = transactions.get(args.txId);
      if (!tx || !same(tx.before.host, before.host)) fail('STALE_TARGET', 'Transaction is no longer open in this document.');
      if (request.origin !== tx.origin) fail('TARGET_BUSY', 'This transaction belongs to another origin.');
      if (tx.updating && id !== 'run.cancel') fail('TARGET_BUSY', 'A transaction update is still running.');
      if (id === 'run.update') {
        const prepared = registry.prepare(tx.entry.id, args.args);
        if (tx.entry.undoDomain === 'motion' && prepared.args.characterId !== tx.targetId) fail('INVALID_ARGUMENT', 'A motion transaction keeps its original target.');
        const shown = [], release = ports.captureToasts?.(toast => shown.push(typeof toast === 'string' ? { message: toast } : toast));
        const context = { origin: request.origin, signal: tx.controller.signal, check() {
          tx.controller.signal.throwIfAborted();
          if (!transactions.has(tx.txId) || !same(tx.before.host, ports.read().host)) fail('STALE_TARGET', 'Transaction is no longer current.');
        } };
        const finish = result => {
          release?.(); clear(tx.workTimer); tx.updating = false; context.check();
          if (shown.length && ports.read().revision === before.revision) fail('TARGET_NOT_READY', shown.at(-1).message);
          for (const target of result.affectedIds) tx.affectedIds.add(target);
          tx.toasts.push(...shown);
          renew(tx); return transactionReceipt(id, tx, request, before);
        };
        const rejected = error => {
          release?.(); clear(tx.workTimer); tx.updating = false;
          if (!(error instanceof StudioProtocolError) && shown.length && ports.read().revision === before.revision) error = new StudioProtocolError('TARGET_NOT_READY', shown.at(-1).message);
          if (transactions.has(tx.txId)) cancelTransaction(tx);
          throw error;
        };
        try {
          tx.updating = true; clear(tx.timer);
          tx.workTimer = (ports.setTimeout ?? setTimeout)(() => cancelTransaction(tx, true, new StudioProtocolError('TIMEOUT', `${tx.entry.id} exceeded its deadline.`)), tx.entry.timeoutMs ?? 30_000);
          const updated = tx.session.run(() => registry.invoke(tx.entry, prepared.args, context));
          if (!updated?.then) return finish(updated);
          const cancelled = new Promise((_, reject) => tx.controller.signal.addEventListener('abort', () => reject(tx.controller.signal.reason), { once: true }));
          return Promise.race([updated, cancelled]).then(finish, rejected);
        } catch (error) { return rejected(error); }
      }
      if (id === 'run.cancel') cancelTransaction(tx);
      if (id === 'run.commit') {
        transactions.delete(tx.txId); clear(tx.timer);
        try { tx.historyEntryId = tx.session.commit().historyEntryId; }
        catch (error) { tx.session.cancel({ restore: false }); throw error; }
      }
    }
    return transactionReceipt(id, tx, request, id === 'run.commit' ? tx.before : before);
  }
  function transactionReceipt(id, tx, request, before) {
    const after = ports.read();
    return validateReceipt({ ok: true, status: 'completed', kind: 'transaction', commandId: request.commandId, receiptId: crypto.randomUUID(), host: before.host,
      action: id, txId: tx.txId, authored: Boolean(tx.historyEntryId), revision: { before: before.revision, after: after.revision },
      affectedIds: [...tx.affectedIds], delta: [], checks: { coverage: 'wire-transaction' }, warnings: toastWarnings(tx.toasts),
      undo: tx.historyEntryId ? { historyEntryId: tx.historyEntryId, entries: 1, canUndoDirect: true } : null });
  }
  // a refusal may list every problem of the request at once (a motion spec: up to 12 lines), so it keeps 2000 characters
  function refusal(request, before, error, mutated) {
    const changed = mutated ?? (ports.read().revision !== before.revision);
    return validateReceipt({ ok: false, commandId: request.commandId, host: before.host,
      code: refusalCode(error), phase: changed ? 'commit' : 'admission', affectedIds: [], expectedTargets: [], currentTargets: [],
      mutated: changed, preserved: { authoredState: changed ? 'changed' : 'unchanged' }, recovery: { action: 'inspect', retryAllowed: false },
      message: [...String(error.message || error)].slice(0, 2000).join('') });
  }
  /** Findings first, toasts after; past the schema's twelve, say how many were left out. */
  const receiptWarnings = (findings = [], toasts = [], omitted = 0, limit = 12) => {
    const all = [...(omitted ? [{ code: 'READBACK_TRUNCATED', count: omitted, message: `Readback lists 8 of ${8 + omitted} affected ids; inspect_studio scope entities with ids for the rest.` }] : []), ...findings, ...toastWarnings(toasts)];
    return all.length <= limit ? all : [...all.slice(0, limit - 1), { code: 'WARNINGS_TRUNCATED', count: all.length - limit + 1, message: `${all.length - limit + 1} more warnings omitted.` }];
  };
  function receipt(entry, request, before, result, historyEntryId, toasts = [], turn = null) {
    const after = ports.read(), changed = after.revision !== before.revision;
    // A turn's transaction is the undo entry only for a command that changed the scene: a read-only
    // job inside an agent turn (sculpt.compare) has nothing to undo.
    const retainedHistoryEntryId = historyEntryId ?? (changed ? turn?.txId : null) ?? null;
    if (entry.kind === 'mutation' && changed && !historyEntryId && !turn) fail('UNCERTAIN_APPLY', `${entry.id} changed the scene without one undoable entry.`);
    const completed = entry.kind === 'job' || entry.kind === 'document' || (entry.kind === 'mutation' && changed && (turn || after.revision > before.revision + 1));
    const ids = completed || changed ? result.affectedIds : entry.kind === 'transient' ? [before.host.sceneId] : [];
    if (turn && changed) for (const id of ids) { turn.affectedIds.add(id); turn.mark?.since.add(id); }
    const build = level => validateReceipt({ ok: true, commandId: request.commandId, receiptId: crypto.randomUUID(), host: before.host,
      action: entry.id, summary: result.summary, status: completed ? 'completed' : entry.kind === 'transient' ? 'transient' : changed ? 'applied' : 'noop',
      authored: changed, ...(completed ? { kind: entry.kind, ...(result.output === undefined ? {} : { output: result.output }), ...(same(before.host, after.host) ? {} : { nextHost: after.host }) } : entry.kind === 'transient' ? { view: { before: before.viewRevision ?? 0, after: after.viewRevision ?? 0 } } : { mutated: changed }),
      revision: { before: before.revision, after: after.revision }, affectedIds: ids,
      delta: ids.slice(0, 8).map(id => ({ id, after: ports.readback?.(id, after, level > 0) ?? { removed: true } })),
      // The command's own measurements (an arrangement's overlap evidence) ride beside the coverage tag.
      checks: { coverage: `studio-action:${entry.id}`, ...result.checks }, warnings: receiptWarnings(result.warnings, toasts, Math.max(0, ids.length - 8), level > 1 ? 4 : 12),
      undo: retainedHistoryEntryId ? { historyEntryId: retainedHistoryEntryId, entries: 1, canUndoDirect: !turn } : null, ...(ids.length > 8 ? { detailCursor: request.commandId } : {}) });
    // Full readback and warnings are richer than the 8 KiB receipt always allows; shed the extras
    // (box and children, then all but the first warnings) rather than fail an edit that was applied.
    for (let level = 0; ; level++) {
      try { return build(level); }
      catch (error) { if (level >= 2 || error?.code !== 'INVALID_RECEIPT' || !/8 KiB/.test(error.message)) throw error; }
    }
  }
  function run(id, args = {}, options = {}) {
    const request = { origin: 'ui', commandId: crypto.randomUUID(), ...options };
    if (request.origin === 'ui' && (id === 'edit.undo' || id === 'edit.redo')) ports.finishHistoryGesture?.();
    const before = ports.read(), journal = ports.journal();
    if (agentTurn && !same(agentTurn.before.host, before.host)) {
      agentTurn.session?.cancel({ restore: false }); agentTurn = null;
    }
    const turn = request.origin === 'agent' && request.turnId === agentTurn?.txId ? agentTurn : null, task = tasks.of(request, id);
    // The command a transaction control runs (a drag's run.commit is its entry's), for telemetry.
    const action = id === 'run.begin' ? args?.id : id.startsWith('run.') ? transactions.get(args?.txId)?.entry.id : undefined;
    const recordAction = (domain, invoke, targetId, nested = false) => {
      if (!turn) return ports.recordAction(domain, invoke, targetId, nested);
      // Enrol each owner in the existing composed session. Do not commit (or
      // cancel the parent on a tool refusal) at an individual command boundary.
      turn.session ??= ports.beginAction(domain, targetId);
      const result = turn.session.run(() => ports.beginAction(domain, targetId).run(invoke));
      return { result, historyEntryId: null };
    };
    let begun = false, releaseToasts, timer, foregroundTimer, job, applied = false, committedHistoryId;
    const controller = new AbortController();
    const clearTimer = () => { if (timer !== undefined) clear(timer); if (foregroundTimer !== undefined) clear(foregroundTimer); };
    const toasts = [];
    const toastRefusal = () => toasts.length && ports.read().revision === before.revision ? new StudioProtocolError('TARGET_NOT_READY', toasts.at(-1).message) : null;
    const remember = value => {
      if (job?.background) {
        const commandId = job.completionCommandId ??= crypto.randomUUID();
        journal.begin(commandId);
        value = validateReceipt({ ...value, commandId, jobId: job.id });
      }
      const recorded = journal.record(value);
      historyReceipts.remember(recorded, { id, origin: request.origin, action, args });
      ports.remember?.(recorded); return recorded;
    };
    const rejected = error => {
      clearTimer();
      releaseToasts?.(); releaseToasts = null;
      if (!(error instanceof StudioProtocolError)) error = toastRefusal() ?? error;
      if (request.origin === 'ui' && error.uiMessage) ports.showRefusal?.(error.uiMessage);
      const value = refusal(request, before, error, job ? applied : undefined);
      // Session friction and studio:refused, by who asked and what (command-bus-telemetry.js).
      noteRefusal(value, request.origin, action ?? id, registry.ids?.().includes(action ?? id) === true);
      const recorded = begun ? remember(value) : value;
      if (job && !job.completion) { job.outcome = recorded; job.completion = Promise.resolve(recorded); emit({ type: 'job.completed', jobId: job.id, receipt: recorded }); }
      return recorded;
    };
    try {
      if (request.origin !== 'ui' && !same(validateStudioIdentity(request.host), before.host)) fail('STALE_SCENE', 'The live document changed.');
      if (request.turnId && !turn && id !== 'agent.turn.begin') fail('STALE_TARGET', 'The agent turn is no longer open.');
      const signature = JSON.stringify({ id, args, ...request });
      if (!journal.begin(request.commandId, signature)) return journal.get(request.commandId) ?? pending.get(request.commandId) ?? refusal(request, before, new StudioProtocolError('UNCERTAIN_APPLY', 'Command is still executing.'));
      begun = true;
      const prepared = controls[id] ? { args: validateStudioSchema(controls[id], args) } : registry.prepare(id, args);
      const { entry, args: validated } = prepared;
      if (request.origin !== 'ui') {
        // Job controls observe/cancel an admitted identity; completion itself
        // can advance the revision while their wire request is in transit.
        // Document identity and the job's own publication fence still apply.
        // A readOnly action (declared data, e.g. motion.qa) only measures: no revision or gesture fence, the host check above still holds.
        if (!task && !id.startsWith('task.') && !entry?.readOnly && !['job.await', 'job.cancel', 'agent.turn.mark', 'agent.turn.rollback', 'agent.turn.finish', 'agent.turn.cancel'].includes(id) && request.expectedRevision !== before.revision) fail('STALE_SCENE', 'Authored state changed; obtain fresh intent.');
        if (!entry?.readOnly && before.busy && !turn && !transactions.has(validated.txId) && !id.startsWith('job.') && !GESTURE_FREE_TASK_CONTROLS.has(id)) fail('TARGET_BUSY', 'Finish the current editor gesture first.');
      }
      if (controls[id]) return mapResult(control(id, validated, request, before), remember, rejected);
      if (transactions.size) fail('TARGET_BUSY', 'Finish or cancel the open command transaction first.');
      if (turn && entry.kind === 'document') fail('TARGET_BUSY', 'Finish the agent turn before changing documents.');
      exposure(entry, validated, request);
      const scoped = tasks.admit(task, entry, validated, request, before);
      releaseToasts = ports.captureToasts?.(toast => toasts.push(typeof toast === 'string' ? { message: toast } : toast));
      const domain = entry.domain ?? entry.undoDomain;
      const targetId = entry.target?.(validated, before) ?? validated.characterId ?? validated.shotId ?? validated.objectId;
      let token = targetId ? ports.readTarget?.(targetId) : null;
      let domainRevision = domain ? before.domainRevisions?.[domain] : null;
      const rebase = () => {
        const current = ports.read();
        token = targetId ? ports.readTarget?.(targetId) : null;
        domainRevision = domain ? current.domainRevisions?.[domain] : null; if (scoped?.keys.length) tasks.rebase(scoped);
      };
      const nestedIds = new Set();
      // callId: the agent's tool call (a script's nested commands share it), for motion.compile's stop rule (repair-watch.js)
      const context = { origin: request.origin, signal: controller.signal, taskId: request.taskId ?? null, turnId: request.turnId ?? null, callId: typeof request.callId === 'string' ? request.callId : null,
        check() {
          controller.signal.throwIfAborted();
          const current = ports.read();
          // Name the fence that tripped: the three share one code, and a bare "something changed" leaves the user and the agent guessing.
          if (!same(current.host, before.host)) fail('STALE_TARGET', 'The open document or scene changed while the job was running.');
          if (domain && !task && current.domainRevisions?.[domain] !== domainRevision) fail('STALE_TARGET', `The ${domain} data changed while the job was running (revision ${domainRevision} to ${current.domainRevisions?.[domain]}); an edit landed between the request and its result.`);
          // Inside a task the fence is the task's own keys (bus-tasks.js moved): another task's layer of the target is not a change under it.
          const moved = scoped?.keys.length ? tasks.moved(scoped) : targetId && ports.readTarget?.(targetId) !== token ? [targetId] : []; if (moved.length) fail('STALE_TARGET', `${moved.join(', ')} changed while the job was running.`);
        },
        commit(apply) {
          context.check();
          if (!domain) fail('INVALID_ARGUMENT', 'A committing job must declare its domain.');
          const recorded = recordAction(domain, apply, targetId ?? null);
          if (recorded?.then) fail('INVALID_ARGUMENT', 'Job publication must be synchronous; prepare before commit.');
          committedHistoryId = recorded.historyEntryId; applied ||= Boolean(committedHistoryId);
          if (job) rebase();
          return recorded.result;
        },
        run(nestedId, nestedArgs = {}) {
          if (job) context.check(); else controller.signal.throwIfAborted();
          const nested = registry.prepare(nestedId, nestedArgs); exposure(nested.entry, nested.args, request);
          const invoke = () => registry.invoke(nested.entry, nested.args, context);
          const value = nested.entry.kind === 'mutation' ? recordAction(nested.entry.undoDomain, invoke, nested.args.characterId ?? null, true) : { result: invoke() };
          // Only the synchronous owned step may advance the fence. Never absorb
          // an external edit while an asynchronous nested step is suspended;
          // its later publication must itself use context.run/commit.
          if (job) rebase();
          return mapResult(value, recorded => mapResult(recorded.result, result => {
            if (job) { context.check(); rebase(); applied ||= Boolean(recorded.historyEntryId); }
            for (const target of result.affectedIds) nestedIds.add(target);
            return result;
          }));
        },
      };
      if (entry.kind === 'job') { job = { id: crypto.randomUUID(), host: before.host, controller, background: false }; jobs.set(job.id, job); }
      timer = (ports.setTimeout ?? setTimeout)(() => {
        const error = new StudioProtocolError('TIMEOUT', `${entry.id} exceeded its deadline.`);
        controller.abort(error);
      }, job && entry.background === true ? 300_000 : entry.timeoutMs ?? 30_000);
      // The race observes expiry even if a backend ignores cancellation.
      const invoke = () => {
        const value = registry.invoke(entry, validated, context);
        if (!value?.then) return value;
        const deadline = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
        return Promise.race([value, deadline]);
      };
      const point = turnEditPoint(turn), value = entry.kind === 'mutation' ? recordAction(entry.undoDomain, invoke, validated.characterId ?? null) : { result: invoke(), historyEntryId: null };
      const finish = ({ result, historyEntryId }) => mapResult(result, output => {
        clearTimer();
        releaseToasts?.(); releaseToasts = null;
        const refused = output?.output === undefined ? toastRefusal() : null; // a job that answered was not refused by a toast that showed meanwhile
        if (refused) throw refused;
        return tasks.record(scoped, recordTurnEdit(turn, point, remember(receipt(entry, request, before, { ...output, affectedIds: [...new Set([...output.affectedIds, ...nestedIds])] }, historyEntryId ?? committedHistoryId, toasts, turn))));
      });
      const finished = value?.then ? value.then(finish) : finish(value);
      const answer = finished?.then ? finished.catch(rejected) : finished;
      if (job) {
        job.completion = Promise.resolve(answer).then(outcome => { job.outcome = outcome; emit({ type: 'job.completed', jobId: job.id, receipt: outcome }); return outcome; });
        const detach = () => {
          job.background = true;
          const current = ports.read();
          return journal.record(validateReceipt({ ok: true, commandId: request.commandId, receiptId: crypto.randomUUID(), host: before.host,
            action: entry.id, status: 'started', kind: 'job', jobId: job.id, authored: false, revision: { before: current.revision, after: current.revision },
            affectedIds: [], delta: [], checks: { coverage: `studio-action:${entry.id}` }, warnings: [], undo: null }));
        };
        if (answer?.then && request.wait === false) return detach();
        if (answer?.then && entry.background === true) {
          const foreground = Promise.race([job.completion, new Promise(resolve => {
            foregroundTimer = (ports.setTimeout ?? setTimeout)(() => resolve(detach()), entry.timeoutMs ?? 30_000);
          })]).finally(() => pending.delete(request.commandId));
          pending.set(request.commandId, foreground);
          return foreground;
        }
      }
      if (answer?.then) { const settled = (job?.completion ?? answer).finally(() => pending.delete(request.commandId)); pending.set(request.commandId, settled); return settled; }
      return answer;
    } catch (error) { return rejected(error); }
  }
  // noteUndone: edit:undone for the user's own undo (domains/scene-undo.js), which reaches it through the bus.
  return { run, noteUndone, uiGesture: () => uiTransactionOpen(transactions), // the user's own drag holds a transaction (studio-busy.js)
    // Trusted UI adapter only: wire callers can consume, never mint a token.
    confirm(id, args = {}) { const prepared = registry.prepare(id, args), token = crypto.randomUUID(); confirmations.set(token, { id, args: prepared.args, host: ports.read().host, expires: (ports.now ?? Date.now)() + 300_000 }); return token; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { agentTurn?.session?.cancel(); agentTurn = null; tasks.dispose(); for (const tx of transactions.values()) cancelTransaction(tx); for (const job of jobs.values()) if (!job.outcome) job.controller.abort(new StudioProtocolError('CANCELLED', 'Studio closed.')); listeners.clear(); } };
}
