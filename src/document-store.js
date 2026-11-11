// Each domain owns immutable authored slices here. The facade composes sessions
// across stores; neither this store nor its callers restore native snapshots.
import { createHistory, pushHistory, undoHistory, redoHistory } from './history.js';
import { StudioProtocolError } from './studio-agent-protocol.js';
import { copyAuthoredIntent, deepFreeze } from './store/authored-intent.js';

const fail = (code, message) => { throw new StudioProtocolError(code, message); };

export function createDocumentStore({ owned = {}, dev = import.meta.env?.DEV ?? true, copyIntent = copyAuthoredIntent } = {}) {
  const freeze = value => dev ? deepFreeze(value) : value;
  // Every value a copy made is the store's own: a later write reuses it rather than copying it again.
  const kept = new WeakSet();
  const copy = value => freeze(copyIntent(value, new Set(), kept));
  let slices = copy(owned);
  let snapshot = freeze({ revision: 0, domainRevisions: Object.fromEntries(Object.keys(owned).map(domain => [domain, 0])), slices });
  let history = createHistory({ historyEntryId: null, snapshot: slices });
  let active = null, running = 0;
  const listeners = new Set();
  const owns = domain => Object.hasOwn(slices, domain);
  function requireOwner(domain) {
    if (!owns(domain)) fail('CAPABILITY_MISSING', `No document slice is owned for ${domain}.`);
  }
  function publish(next) {
    const changed = Object.keys(slices).filter(domain => slices[domain] !== next[domain]);
    if (!changed.length) return;
    const domainRevisions = { ...snapshot.domainRevisions };
    for (const domain of changed) domainRevisions[domain]++;
    slices = freeze(next);
    snapshot = freeze({ revision: snapshot.revision + 1, domainRevisions, slices });
    for (const listener of listeners) listener();
  }
  function beginAction(domain) {
    requireOwner(domain);
    if (active) fail('TARGET_BUSY', 'A document transaction is already open.');
    const before = slices;
    const check = () => { if (active !== session) fail('STALE_TARGET', 'Document transaction is no longer current.'); };
    const session = {
      // Permission ends at the synchronous publication boundary, not when an
      // async preparation finishes. Jobs explicitly re-enter through commit.
      run(fn) { check(); running++; try { return fn(); } finally { running--; } },
      touch(domain) { check(); requireOwner(domain); },
      update(domain, update) { return session.run(() => write(domain, update)); },
      // A point inside the open transaction (a script's start in an agent turn): rollback(mark)
      // restores it and the transaction stays open; rollback() restores where it began.
      mark() { check(); return slices; },
      rollback(mark = before) { check(); publish(mark); },
      cancel({ restore = true } = {}) {
        if (active !== session) return false;
        active = null;
        if (restore) publish(before);
        return true;
      },
      commit() {
        check(); active = null;
        if (!Object.keys(slices).some(key => slices[key] !== before[key])) return { historyEntryId: null };
        const historyEntryId = crypto.randomUUID();
        history = pushHistory(history, { historyEntryId, snapshot: slices });
        return { historyEntryId };
      },
    };
    active = session;
    return session;
  }
  function recordAction(domain, fn, targetId = null, nested = false) {
    if (nested && active) {
      active.touch(domain);
      const result = active.run(fn);
      return result?.then ? result.then(result => ({ result, historyEntryId: null })) : { result, historyEntryId: null };
    }
    const session = beginAction(domain);
    const done = result => ({ result, ...session.commit() });
    const failed = error => { session.cancel(); throw error; };
    try { const result = session.run(fn); return result?.then ? result.then(done, failed) : done(result); }
    catch (error) { return failed(error); }
  }
  function write(domain, update) {
    requireOwner(domain);
    if (dev && !running) throw new TypeError(`A store-owned ${domain} write requires a bus run.`);
    if (!active) return recordAction(domain, () => write(domain, update)).result;
    if (!running) fail('TARGET_BUSY', 'A document transaction owns this write.');
    const next = typeof update === 'function' ? update(slices[domain]) : update;
    if (next !== slices[domain]) publish({ ...slices, [domain]: copy(next) });
    return slices[domain];
  }
  // The oldest snapshot has no retained pre-image. Its id cannot promise Undo.
  const retainedEntries = () => [...(history.past.length ? [...history.past.slice(1), history.present] : []), ...history.future];
  function step(redo) {
    if (active) fail('TARGET_BUSY', 'Finish the document transaction before traversing history.');
    const entry = redo ? history.future[0] : history.present;
    const next = (redo ? redoHistory : undoHistory)(history);
    if (!next) return null;
    history = next; publish(history.present.snapshot);
    return entry;
  }
  return {
    owns, read: domain => { requireOwner(domain); return slices[domain]; }, write, beginAction, recordAction,
    dispose() { active?.cancel(); listeners.clear(); },
    undo: () => step(false), redo: () => step(true),
    canUndo: id => !active && history.past.length > 0 && (id === undefined || history.present.historyEntryId === id),
    canRedo: () => !active && history.future.length > 0,
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    isRetained: id => Boolean(id && retainedEntries().some(entry => entry.historyEntryId === id)),
    history: () => freeze(history),
    depths: () => ({ past: history.past.length, future: history.future.length }),
  };
}

// Compatibility for object producers with token-based drags. There is no
// separate object history: every preview, cancellation and traversal uses the
// document store. Immutable producer arrays retain their reference contract.
export function createSceneHistoryStore(initialObjects, { onObjects, onCommit } = {}) {
  const store = createDocumentStore({ owned: { objects: initialObjects }, dev: false, copyIntent: value => value });
  const read = () => store.read('objects');
  store.subscribe(() => onObjects?.(read()));
  let active = null, sequence = 0;
  function close(commit, notify = true) {
    const current = active; active = null;
    if (commit) {
      current.session.commit();
      if (notify) onCommit?.(current.before, read());
    } else current.session.cancel();
  }
  function settle(notify = true) {
    if (!active) return;
    const cancel = active.cancel;
    close(true, notify); cancel?.();
  }
  return {
    get objects() { return read(); },
    present: () => store.history().present.snapshot.objects,
    applyAtomic(fn) {
      settle();
      const before = read();
      store.recordAction('objects', () => store.write('objects', fn));
      if (before !== read()) onCommit?.(before, read());
    },
    begin(owner, cancel) {
      settle();
      active = { token: ++sequence, owner, cancel, before: read(), session: store.beginAction('objects') };
      return active.token;
    },
    applyIn(token, fn) { if (active?.token === token) active.session.update('objects', fn); },
    end(token, { commit }) { if (active?.token !== token) return false; close(commit); return true; },
    settle,
    undo() { settle(false); return store.undo() ? read() : null; },
    redo() { settle(false); return store.redo() ? read() : null; },
    canUndo: store.canUndo, canRedo: store.canRedo, depths: store.depths,
  };
}
