// Whether the Agent pane is folded when the Studio opens. It opens unfolded: the agent is how most work starts, and a
// first visitor who never finds the pane never asks it anything. What the author last chose is kept for this address.
// On a narrow window the pane is one of the panels that take turns (StudioShell folds it to show another), so there it
// starts folded until asked for, and a fold or an unfold there is not a choice to keep.
const AGENT_PANE_KEY = "cozyclay.shell.agent-pane.v1", NARROW = "(max-width: 1000px)";
const narrowWindow = () => globalThis.matchMedia?.(NARROW).matches === true;

/** The pane's fold at start: the stored choice, else folded only on a narrow window. */
export function agentPaneFolded(storage = globalThis.localStorage, narrow = narrowWindow()) {
	try {
		const stored = storage?.getItem(AGENT_PANE_KEY);
		if (stored === "folded" || stored === "open") return stored === "folded";
	} catch { /* a blocked store has no choice kept */ }
	return narrow;
}

/** Keeps the author's choice (on a wide window) and answers it, so a state setter can take the call as its value. */
export function rememberAgentPane(folded, storage = globalThis.localStorage, narrow = narrowWindow()) {
	if (narrow) return folded;
	try {
		storage?.setItem(AGENT_PANE_KEY, folded ? "folded" : "open");
	} catch (error) {
		console.warn(`[cozyclay] could not store ${AGENT_PANE_KEY}`, error);
	}
	return folded;
}
