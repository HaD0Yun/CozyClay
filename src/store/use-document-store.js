import { useCallback, useRef, useState, useSyncExternalStore } from 'react';

// The document snapshot contains only owned slices and revision metadata.
export function useDocumentStore(store) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

// A legacy port's read must return its current React/live-ref value (stable
// until that value changes), and subscribe must notify external React writes.
// There is intentionally no legacy snapshot cache in the document store.
export function useDocumentDomain(store, domain) {
  const read = useCallback(() => store.read(domain), [store, domain]);
  return useSyncExternalStore(store.subscribe, read, read);
}

// useState whose setter schedules a render only when the value changes. An
// updater runs against the latest value set through it, so a setter called
// after every commit (an effect) never queues a no-op update (#1045).
export function useChangedState(initial) {
  const [value, render] = useState(initial);
  const latest = useRef(value);
  const [set] = useState(() => (next) => {
    const resolved = typeof next === 'function' ? next(latest.current) : next;
    if (Object.is(resolved, latest.current)) return;
    latest.current = resolved;
    render(resolved);
  });
  return [value, set];
}
