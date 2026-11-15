// The editor's answers to the turn transaction (bin/agent/studio-turn-transaction.mjs): every Studio turn whose
// context has a scene runs between agent.turn.begin and agent.turn.finish (mark / rollback / cancel inside it), sent
// as run_action frames. A fake live hub that models an editor wraps its command with withTurnControls: the controls
// are answered as an editor answers an unauthored turn and recorded in `log`; every other command reaches the fake.
export const isTurnControl = (name, payload) => name === "run_action" && /^agent\.turn\.(begin|finish|mark|rollback|cancel)$/.test(String(payload?.args?.action ?? ""));

export function turnControlReceipt(payload) {
	return { ok: true, status: "applied", commandId: payload?.commandId, action: payload.args.action, authored: false };
}

/** The hub with its command answering the turn controls; log collects each control's action id in order. */
export function withTurnControls(hub, log = []) {
	const command = hub.command;
	return Object.assign(hub, {
		command(name, payload, ...rest) {
			if (isTurnControl(name, payload)) { log.push(payload.args.action); return Promise.resolve(turnControlReceipt(payload)); }
			return command.call(this, name, payload, ...rest);
		},
	});
}
