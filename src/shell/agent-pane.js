// Whether the Agent pane is folded when the Studio opens. It opens unfolded: the agent is how most work starts, and a
// first visitor who never finds the pane never asks it anything. What the author last chose is kept for this address.
// On a narrow window the pane is one of the panels that take turns (StudioShell folds it to show another), so there it
// starts folded until asked for (also when the choice kept from a wide window is "open"), and a fold or an unfold there
// is not a choice to keep. The pane that is open at start leaves the keyboard with the stage (AgentPanel.jsx).
const AGENT_PANE_KEY = "cozyclay.shell.agent-pane.v1", NARROW = "(max-width: 1000px)";
const narrowWindow = () => globalThis.matchMedia?.(NARROW).matches === true;
// The landing page's playground (?embed=playground) shows no pane, yet shares the Studio's address and its Cmd/Ctrl+B:
// what that key flips there is nobody's choice.
const noPane = (location = globalThis.location) => new URLSearchParams(location?.search ?? "").has("embed");

/** The pane's fold at start: folded on a narrow window, else the stored choice, else open. */
export function agentPaneFolded(storage = globalThis.localStorage, narrow = narrowWindow()) {
	if (narrow) return true;
	try {
		return storage?.getItem(AGENT_PANE_KEY) === "folded";
	} catch { /* a blocked store has no choice kept */ }
	return false;
}

/** Keeps the author's choice (on a wide window with a pane) and answers it, so a state setter can take the call as its value. */
export function rememberAgentPane(folded, storage = globalThis.localStorage, narrow = narrowWindow()) {
	if (narrow || noPane()) return folded;
	try {
		storage?.setItem(AGENT_PANE_KEY, folded ? "folded" : "open");
	} catch (error) {
		console.warn(`[cozyclay] could not store ${AGENT_PANE_KEY}`, error);
	}
	return folded;
}
