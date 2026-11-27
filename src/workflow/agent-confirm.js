// The agent asked for a command that needs the user's own yes (exposure "confirm", src/studio-actions.js), and the
// Studio's command bus refused it with CONFIRMATION_REQUIRED and said so (command-bus.js emits confirmation.required for
// an agent request: a plain turn, the main agent's quick_edit or a dispatched task alike). For the commands listed here
// the Agent panel shows an approval card (AgentWaitCards.jsx ConfirmCard): Export mints a token for that exact request
// and runs it through the bus (command-bus.js runConfirmed), Cancel declines it. Either answer reaches the model with
// the user's next message, as a <studio-note> after their text; a restored transcript shows the message without it.

// Only the export is offered. Deleting a scene or saving the project stay refused: the first cannot be undone and the
// second needs a file picker only the user's own click can open.
const CONFIRM_CARD_ACTIONS = new Set(["export.shotVideo"]);
const NOTE = /\n\n<studio-note>[\s\S]*<\/studio-note>$/;

/** What the card says it exports: { kind: "timeline" | "shot" | "current", name }. */
function subjectOf(args, context) {
	if (args?.scope === "timeline") return { kind: "timeline" };
	const shot = args?.shotId ? (context?.shots ?? []).find((row) => row?.id === args.shotId) : null;
	if (shot) return { kind: "shot", name: String(shot.name || shot.id) };
	return args?.shotId ? { kind: "shot", name: String(args.shotId) } : { kind: "current" };
}

/**
 * The approval card for a bus confirmation.required event { id, args, reason }, or null: an unlisted command, or the
 * same request already waiting on the user (an agent that asked twice gets one question).
 */
export function confirmCard(items, request, context, newId) {
	const action = request?.id;
	if (!CONFIRM_CARD_ACTIONS.has(action)) return null;
	const args = request.args && typeof request.args === "object" && !Array.isArray(request.args) ? request.args : {};
	const open = (item) => item.kind === "confirm" && ["pending", "running"].includes(item.state) && item.action === action && JSON.stringify(item.args) === JSON.stringify(args);
	if (items.some(open)) return null;
	return { kind: "confirm", id: newId(), action, args, subject: subjectOf(args, context), reason: typeof request.reason === "string" ? request.reason : "", state: "pending" };
}

/** The user's text without the note a confirmation answer added to it (a restored transcript). */
export const withoutConfirmNote = (text) => String(text ?? "").replace(NOTE, "");

const label = (item) => `${item.action}${item.subject.kind === "shot" ? ` of shot "${item.subject.name}"` : item.subject.kind === "timeline" ? " of the whole timeline" : ""}`;

/**
 * The store's side of the cards. `runConfirmed(action, args)` is the host's trusted adapter (the Studio's command
 * bus); without one the card says the Studio is not there to run it.
 */
export function createConfirmControls({ items, setItems, patch, runConfirmed, context, newId }) {
	let notes = [];
	const find = (id) => items().find((item) => item.kind === "confirm" && item.id === id);
	const update = (id, fields) => patch((item) => item.kind === "confirm" && item.id === id, fields);
	return {
		ask(request) {
			const card = confirmCard(items(), request, context(), newId);
			if (card) setItems((list) => [...list, card]);
		},
		/** The answers since the last message, as the note the next message carries; taking them clears them. */
		takeNote() {
			if (!notes.length) return "";
			const note = `\n\n<studio-note>${notes.join(" ")}</studio-note>`;
			notes = [];
			return note;
		},
		clear() { notes = []; },
		async approve(id) {
			const item = find(id);
			if (!item || !["pending", "failed"].includes(item.state)) return;
			update(id, { state: "running", error: null });
			try {
				if (typeof runConfirmed !== "function") throw new Error("The Studio is not open here, so nothing can run the export.");
				const receipt = await runConfirmed(item.action, item.args);
				if (!receipt || receipt.ok === false) throw new Error(receipt?.message || "The export did not run.");
				const fileName = receipt.output?.fileName ?? null;
				update(id, { state: "done", fileName });
				notes.push(`The user approved the ${label(item)} you asked for and it ran${fileName ? `: ${fileName}` : ""}.`);
			} catch (error) {
				update(id, { state: "failed", error: String(error?.message || error) });
			}
		},
		decline(id) {
			const item = find(id);
			if (!item || !["pending", "failed"].includes(item.state)) return;
			update(id, { state: "declined", error: null });
			notes.push(`The user declined the ${label(item)} you asked for; do not request it again unless they ask.`);
		},
	};
}
