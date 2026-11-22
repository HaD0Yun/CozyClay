// A message the user sends to a run that is still going (a steer), on a pi Agent loop (agent-runner.mjs, the lowvis
// motion writer src/lowvis/pi/harness.mjs). The message goes into the Agent's steering queue; the loop reads that queue
// between steps (after a step's tool results, before the next model call) and puts the message into the model's
// context as a user message. The caller is told which happened to each message, by the id it gave:
//   received(id): the message is in the context the next model call reads (the Agent's message_end for it);
//   dropped(id):  the run ended first; the message is taken back out of the queue, so it never reaches a later run.
// A run that already ended takes nothing: steer() answers false.
//   const inbox = createSteerInbox({ received, dropped });
//   inbox.steer(text, images, id)   // before or after attach(agent)
//   inbox.attach(agent)             // once the run's Agent exists
//   inbox.close()                   // when the run ends, however it ends (idempotent)

/** images: pi image parts, [{ type: "image", data, mimeType }]. */
export function createSteerInbox({ received = () => {}, dropped = () => {} } = {}) {
	const waiting = new Map(), held = [];
	let agent = null, closed = false, unsubscribe = null;
	return {
		steer(text, images = [], id = null) {
			if (closed) return false;
			const message = { role: "user", content: [{ type: "text", text }, ...images], timestamp: Date.now() };
			waiting.set(message, id);
			if (agent) agent.steer(message); else held.push(message);
			return true;
		},
		attach(next) {
			if (closed || agent) return;
			agent = next;
			unsubscribe = agent.subscribe(event => {
				if (event.type !== "message_end" || !waiting.has(event.message)) return;
				const id = waiting.get(event.message);
				waiting.delete(event.message);
				received(id);
			});
			for (const message of held.splice(0)) agent.steer(message);
		},
		close() {
			if (closed) return;
			closed = true;
			unsubscribe?.();
			if (waiting.size) agent?.clearSteeringQueue();
			const left = [...waiting.values()];
			waiting.clear(); held.length = 0;
			for (const id of left) dropped(id);
		},
	};
}
