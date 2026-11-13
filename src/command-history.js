// The object history adapter the command bus uses (moved out of command-bus.js unchanged).
import { HISTORY_LIMIT } from './history.js';
import { StudioProtocolError } from './studio-agent-protocol.js';

const fail = (code, message) => { throw new StudioProtocolError(code, message); };

// A batching/retention adapter over the existing object history owner. The
// native store still owns every snapshot and transition; this tracks only the
// retained pre-image identities needed by receipts.
export function withCommandHistory(store) {
  let past = [], future = [], group = null;
  const adapter = Object.create(store);
  const pushed = before => { if (before !== store.present()) { past.push(before); past = past.slice(-HISTORY_LIMIT); future = []; } };
  adapter.settle = (...args) => { const before = store.present(); store.settle(...args); pushed(before); };
  adapter.applyAtomic = fn => {
    if (group) { if (!group.running) fail('TARGET_BUSY', 'A command transaction owns the object history.'); return store.applyIn(group.token, fn); }
    adapter.settle(); const before = store.present(); store.applyAtomic(fn); pushed(before);
  };
  adapter.begin = (...args) => { adapter.settle(); return store.begin(...args); };
  adapter.end = (token, options) => { const before = store.present(), ended = store.end(token, options); if (options.commit) pushed(before); return ended; };
  adapter.undo = () => { adapter.settle(); const before = store.present(), restored = store.undo(); if (restored !== null) { past.pop(); future.unshift(before); } return restored; };
  adapter.redo = () => { const before = store.present(), restored = store.redo(); if (restored !== null) { past.push(before); future.shift(); } return restored; };
  adapter.beginCommand = () => {
    if (group) fail('TARGET_BUSY', 'An object command is already in progress.');
    adapter.settle(); const before = store.present();
    const current = { running: 0, token: store.begin('command-bus', () => { current.closed = true; group = null; }) }; group = current;
    const check = () => { if (current.closed) fail('STALE_TARGET', 'Native object transaction was retired.'); };
    return {
      run(fn) { check(); current.running++; try { const result = fn(); if (result?.then) return result.finally(() => { current.running--; }); current.running--; return result; } catch (error) { current.running--; throw error; } },
      commit() { check(); current.closed = true; group = null; store.end(current.token, { commit: true }); pushed(before); return before !== store.present(); },
      cancel() { if (current.closed) return false; current.closed = true; group = null; return store.end(current.token, { commit: false }); },
    };
  };
  return adapter;
}
