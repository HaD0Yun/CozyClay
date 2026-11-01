// When the editor counts as mid-gesture for an agent or task command: the bus then refuses it with
// TARGET_BUSY "Finish the current editor gesture first." (command-bus.js, studio-app-binding.js admit) and the
// sidecar waits for the gesture to end (bin/agent/studio-busy-wait.mjs).
//
// Busy only while the user is authoring something a command could collide with:
//   - a pointer drag that edits: every one opens a UI-origin `run.begin` transaction on the bus (objects, cast,
//     shots, motion and stage gestures), open until its commit or cancel;
//   - an IK body drag; a recording.
// Never busy: playback, scrubbing the timeline, a camera orbit, selection or any other click, scrolling a panel.
// An open document session that is not the user's (the object store's present differing from its live objects
// while an agent turn, a transaction or an async action holds it) is not a gesture either.

/** The busy predicate over what the editor holds right now. */
export function studioBusy({ uiTransaction = false, ikBodyDrag = false, recording = null } = {}) {
	return Boolean(uiTransaction || ikBodyDrag || recording);
}

/** A bus's open transactions (a Map of { origin }) include one the user's own gesture opened. */
export function uiTransactionOpen(transactions) {
	for (const tx of transactions.values()) if (tx.origin === "ui") return true;
	return false;
}
