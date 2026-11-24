// The ChatGPT backend's own model list (codex-client.mjs listModels), read with the signed-in account's credential:
// the models that account can run. providers.mjs registers the ones pi's catalogue lacks, and the picker lists the
// account's lineup from it.

/** pi's effort name as it goes on the wire and to the panel: pi's "off" is "none" there. */
export const wireEffort = (level) => (level === "off" ? "none" : level);

/** The backend's `/models` answer in the shape of the picker's entries, in the backend's order. `hidden` marks a model
 * the backend keeps out of its own picker (`visibility: "hide"`: its internal models). */
export function liveModelsCodex(result) {
	const list = Array.isArray(result) ? result : result?.models ?? [];
	return list.map((model) => {
		const id = typeof model === "string" ? model : model.slug || model.id;
		const levels = (Array.isArray(model.supported_reasoning_levels)
			? model.supported_reasoning_levels.map((level) => (typeof level === "string" ? level : level.effort)).filter(Boolean).filter((level) => level !== "ultra").map(wireEffort)
			: []);
		const efforts = levels.length ? levels : ["none"];
		const requestedDefault = typeof model.default_reasoning_level === "string" ? wireEffort(model.default_reasoning_level) : undefined;
		const defaultEffort = efforts.includes("medium") ? "medium" : (efforts.includes(requestedDefault) ? requestedDefault : efforts[0]);
		const label = typeof model.display_name === "string" && model.display_name ? model.display_name : id;
		return { id, key: `openai-codex/${id}`, label, efforts, defaultEffort, input: ["text", "image"], ...(model.visibility === "hide" ? { hidden: true } : {}) };
	}).filter((model) => model.id);
}

/**
 * The picker's ChatGPT list for a signed-in account. `entries` are the picker's entries (pi's catalogue and the live
 * additions), `live` is `liveModelsCodex`'s answer. The account's own list is the lineup: a ChatGPT plan runs what
 * its list names and refuses a catalogue model outside it ("not supported when using Codex with a ChatGPT account").
 * So the answer is the live list's models in the backend's order, without the hidden ones; an entry keeps what it
 * has (a catalogue model: pi's name and efforts). A live list that names nothing to show leaves `entries`, less the
 * hidden models.
 */
export function accountLineup(entries, live) {
	const hidden = new Set(live.filter((model) => model.hidden).map((model) => model.id)), lineup = live.filter((model) => !model.hidden);
	const shown = entries.filter((model) => !hidden.has(model.id));
	return lineup.length ? lineup.map((entry) => shown.find((model) => model.id === entry.id)).filter(Boolean) : shown;
}
