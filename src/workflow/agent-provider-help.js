// The words and choices around a provider that stopped a turn or a sign-in that stopped waiting (#1043, #1044):
// pure, so the agent panel's cards and the login list share them and the tests read them without a DOM.
import { modelIsSelectable } from "./agent-client.js";

/** What the ChatGPT sign-in's waiting step ended on (#1044), in words for the signed-out card; null for none. */
export const SIGN_IN_FAILURE_COPY = Object.freeze({
	timeout: "The sign-in page waited 10 minutes without an answer and stopped.",
	callback_error: "The sign-in page came back without a session (declined, or the code could not be exchanged).",
	port_busy: "Another program is using the sign-in ports (1455 and 1457). Close other sign-in windows or tools.",
});

/** "in 9 min" / "in 40 s" until `until` (an ISO time), or null when there is none. */
export function formatWaitLeft(until, now = Date.now()) {
	const target = Date.parse(until ?? "");
	if (!Number.isFinite(target)) return null;
	const seconds = Math.max(0, Math.round((target - now) / 1000));
	return seconds >= 60 ? `${Math.ceil(seconds / 60)} min` : `${seconds} s`;
}

/** Where a rate-limited turn can go next (#1043): the first model of ANOTHER provider that holds a credential,
 * as `{ model, provider, label }`, or null when the limited provider is the only one connected. */
export function otherProviderModel(providers, models, current, limited = String(current ?? "").split("/")[0]) {
	const list = Array.isArray(providers) ? providers : [];
	const entry = (Array.isArray(models) ? models : []).find((candidate) => {
		const provider = String(candidate?.id ?? "").split("/")[0];
		return provider && provider !== limited && list.some((row) => row.id === provider && row.signedIn) && modelIsSelectable(list, candidate.id);
	});
	if (!entry) return null;
	const provider = entry.id.split("/")[0];
	return { model: entry.id, provider, label: list.find((row) => row.id === provider)?.label || provider };
}

/** A provider's name as the model list labels it, else its id. */
export function providerLabel(providers, id) {
	return (Array.isArray(providers) ? providers : []).find((row) => row.id === id)?.label || id || "The model provider";
}
