import { createContext, useContext, useMemo } from 'react';
import { StudioProtocolError } from './studio-agent-protocol.js';

export const AppContext = createContext(null);
// Reading `bus` refreshes the studio binding (it serializes the whole scene), so a panel must not read it while it
// renders: playback re-renders panels every frame. The hook hands back a stable handle that opens the bus per call.
export function useBus() {
  const app = useContext(AppContext);
  return useMemo(() => ({ run: (...args) => app.bus.run(...args), subscribe: (...args) => app.bus.subscribe(...args) }), [app]);
}

const ref = current => ({ current });

// Stores own the document and its snapshots. The facade owns only the ordered
// relationship between their committed sessions, never a second state history.
export function createAppContext({
  characters: charactersRef = ref(null), scenes: scenesRef = ref(null),
  motion: motionRef = ref(null), state: liveStateRef = ref(null), getBus, notify,
} = {}) {
  const storeDomains = new Map(), domainBegins = new WeakMap(), observedStores = new WeakSet();
  const entries = new Map();
  let past = [], future = [], activeComposition = null, historyRevision = 0;
  let currentPorts = {};
  const storeDomain = domain => storeDomains.get(domain);
  const registeredDomains = () => [...storeDomains.values()];
  const ports = { storeDomain, storeDomains: registeredDomains }, actionPorts = { storeDomain, storeDomains: registeredDomains };
  const fail = (code, message) => { throw new StudioProtocolError(code, message); };
  const memberRetained = row => storeDomain(row.name) === row.handle && row.store.isRetained(row.id);
  const retained = entry => entry.members.every(memberRetained);
  const frontier = redo => redo ? future[0] : past.at(-1);
  const ready = (entry, redo) => !activeComposition && entry === frontier(redo) && retained(entry)
    && entry.members.every(row => redo ? row.store.canRedo() && row.store.history().future[0]?.historyEntryId === row.id : row.store.canUndo(row.id));
  function prune() {
    // The oldest store snapshot has no pre-image, but is still a boundary.
    // Keep it (and partially expired compositions) so traversal cannot skip
    // an unundoable newer transition to reach an older owner.
    for (const [id, entry] of entries) if (!entry.members.some(row => {
      if (storeDomain(row.name) !== row.handle) return false;
      const history = row.store.history();
      return row.store.isRetained(row.id) || (history.past[0] ?? history.present).historyEntryId === row.id;
    })) entries.delete(id);
    past = past.filter(entry => entries.has(entry.id));
    future = future.filter(entry => entries.has(entry.id));
  }
  function step(entry, redo) {
    if (!entry || !ready(entry, redo)) return false;
    const revision = ports.revision?.current;
    for (const row of redo ? entry.members : [...entry.members].reverse()) (redo ? row.store.redo : row.store.undo)();
    if (redo) { future.shift(); past.push(entry); }
    else { past.pop(); future.unshift(entry); }
    historyRevision++;
    // Multiple owners publish synchronously, but traversal is one authored
    // transition at the binding boundary.
    if (revision !== undefined) ports.revision.current = revision + 1;
    return true;
  }
  function remember(members) {
    if (!members.length) return { historyEntryId: null };
    const id = members.length === 1 ? members[0].id : crypto.randomUUID();
    if (entries.has(id)) return { historyEntryId: id };
    for (const entry of future) entries.delete(entry.id);
    future = [];
    const entry = { id, members };
    entry.handle = members.length === 1 ? members[0].handle : {
      documentStore: { isRetained: wanted => wanted === id && entries.has(id) && retained(entry) },
      canUndo: wanted => (wanted === undefined || wanted === id) && ready(entry, false),
      stepHistory: redo => step(entry, redo),
    };
    entries.set(id, entry); past.push(entry); historyRevision++; prune();
    return { historyEntryId: id };
  }
  function beginAction(domain, targetId = null, nested = false) {
    if (activeComposition) {
      if (!activeComposition.running && !nested) fail('TARGET_BUSY', 'A composed document transaction is already open.');
      const parent = activeComposition;
      parent.touch(domain, targetId);
      return { run: parent.run, commit: () => ({ historyEntryId: null }), cancel: parent.cancel };
    }
    const members = new Map();
    let closed = false;
    const check = () => { if (closed) fail('STALE_TARGET', 'The composed document transaction is closed.'); };
    const session = {
      running: 0,
      touches: handle => members.has(handle),
      touch(name, targetId) {
        check();
        const handle = storeDomain(name);
        if (!handle) fail('CAPABILITY_MISSING', `No document owner is registered for ${name}.`);
        if (!members.has(handle)) members.set(handle, { name, handle, store: handle.documentStore,
          session: domainBegins.get(handle)(targetId) });
      },
      run(fn) {
        check(); session.running++;
        try { return [...members.values()].reduceRight((next, row) => () => row.session.run(next), fn)(); }
        finally { session.running--; }
      },
      commit() {
        check();
        const changed = [...members.values()].flatMap(row => {
          const result = row.session.commit();
          return result.historyEntryId ? [{ name: row.name, handle: row.handle, store: row.store, id: result.historyEntryId }] : [];
        });
        closed = true; activeComposition = null;
        return remember(changed);
      },
      // A savepoint inside the open composition (a script inside an agent turn): rollback(point)
      // restores each owner to it, and an owner first touched after it to where it began. The
      // composition stays open, so edits made before the savepoint still land with it.
      savepoint() { check(); return new Map([...members].map(([handle, row]) => [handle, row.session.mark()])); },
      rollback(point = new Map()) { check(); for (const [handle, row] of [...members].reverse()) row.session.rollback(point.get(handle)); },
      cancel(options) {
        if (closed) return false;
        closed = true; activeComposition = null;
        for (const row of [...members.values()].reverse()) row.session.cancel(options);
        return true;
      },
    };
    activeComposition = session;
    try { session.touch(domain, targetId); }
    catch (error) { session.cancel(); throw error; }
    return session;
  }
  function recordAction(domain, run, targetId = null, nested = false) {
    const session = beginAction(domain, targetId, nested);
    const done = result => ({ result, ...session.commit() });
    const failed = error => { session.cancel(); throw error; };
    try { const result = session.run(run); return result?.then ? result.then(done, failed) : done(result); }
    catch (error) { return failed(error); }
  }

  return {
    // composing(): a composed transaction is open, so a write must join it (nested) instead of opening its own
    beginAction, recordAction, notify, storeDomain, composing: () => Boolean(activeComposition),
    storeDomainForReceipt(receipt) {
      const entry = entries.get(receipt?.undo?.historyEntryId);
      return entry && retained(entry) ? entry.handle : undefined;
    },
    storeDomains: registeredDomains,
    registerStoreDomain(name, handle) {
      const store = handle.documentStore;
      if (store && !observedStores.has(store)) {
        observedStores.add(store);
        const committed = result => {
          if (result.historyEntryId && !activeComposition) remember([{ name, handle, store, id: result.historyEntryId }]);
          return result;
        };
        const begin = store.beginAction, record = store.recordAction;
        store.beginAction = (...args) => {
          const session = begin(...args);
          return { ...session, commit: () => committed(session.commit()) };
        };
        store.recordAction = (...args) => {
          const result = record(...args);
          return result?.then ? result.then(committed) : committed(result);
        };
      }
      if (handle.beginAction && !domainBegins.has(handle)) {
        domainBegins.set(handle, handle.beginAction.bind(handle));
        handle.beginAction = targetId => beginAction(name, targetId);
        handle.stepHistory = redo => {
          const entry = frontier(redo);
          return entry?.handle === handle && step(entry, redo);
        };
        if (handle.load) {
          const load = handle.load.bind(handle);
          handle.load = (...args) => {
            if (activeComposition?.touches(handle)) activeComposition.cancel();
            const result = load(...args); prune(); return result;
          };
        }
      }
      storeDomains.set(name, handle);
      return () => {
        if (activeComposition?.touches(handle)) activeComposition.cancel();
        if (storeDomain(name) === handle) storeDomains.delete(name);
        prune();
      };
    },
    nextStoreHistory(redo) {
      prune();
      const entry = frontier(redo);
      return entry && ready(entry, redo) ? entry.handle : undefined;
    },
    historyEntry(redo = false) {
      const entry = frontier(redo);
      return entry && ready(entry, redo) ? entry.id : null;
    },
    loadStoreDomains(slices) {
      const loaded = new Set();
      for (const [name, domain] of storeDomains) if (domain.load) {
        domain.load(domain.sceneSlice ? domain.sceneSlice(slices) : slices[name]);
        loaded.add(name);
      }
      return loaded;
    },
    forRender(shared) { return Object.create(this, { shared: { value: shared } }); },
    // A change counter for project save checkpoints, not undo arbitration.
    get undoClock() { return historyRevision; },
    live: Object.freeze({
      get state() { return liveStateRef.current; },
      get characters() { return charactersRef.current; },
      get scenes() { return scenesRef.current; },
      get motion() { return motionRef.current; },
    }),
    publishLive(value) { liveStateRef.current = value; },
    patchLive(patch) { Object.assign(liveStateRef.current, patch); },
    patchTimeline(patch) { Object.assign(liveStateRef.current.timeline, patch); },
    publishCharacters(value) { charactersRef.current = value; },
    publishScenes(value) { scenesRef.current = value; },
    publishMotion(value) { motionRef.current = value; },
    get bus() { return getBus(); },
    ports, actionPorts,
    updatePorts(next) {
      currentPorts = next;
      for (const key of Object.keys(next)) {
        if (key === 'revision') ports[key] = next[key];
        else if (!ports[key]) ports[key] = (...args) => currentPorts[key](...args);
      }
    },
    updateActionPorts(next) { Object.assign(actionPorts, next); },
  };
}
