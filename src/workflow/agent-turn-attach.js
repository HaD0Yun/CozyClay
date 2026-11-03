// A Studio turn the sidecar still runs after the panel reloaded mid-turn (the panel had lost it: its message vanished
// and the next send was refused as busy). The panel reads its events from the first one until it ends, and shows its
// message again in place of what the transcript had persisted of it.

const RETRY_MS = 500;

/** Streams turn `turnId`'s events to onEvent until the turn ends; a dropped stream resumes after the last event seen,
 * never twice. A refusal before any event throws with its status. */
export async function attachStudioTurn({ fetchImpl, url, parse, attempts }, turnId, onEvent, signal) {
	let cursor = 0, terminal = false;
	const receive = (event) => {
		if (event?.type === "execution_telemetry" || event?.type === "execution_tool_started") return;
		if (Number.isFinite(event?.eventSeq)) { if (event.eventSeq <= cursor) return; cursor = event.eventSeq; }
		if (event?.type === "done") terminal = true;
		onEvent(event);
	};
	for (let attempt = 0; !terminal && !signal?.aborted && attempt <= attempts; attempt += 1) {
		let response;
		// A rejected fetch (a network blip) is retried like a dropped stream: the sidecar turn may still be running.
		try { response = await fetchImpl(url(`/agent/turn/${encodeURIComponent(turnId)}/events?after=${cursor}`), { headers: { accept: "text/event-stream" }, credentials: "same-origin", signal }); }
		catch (error) { if (signal?.aborted) return; if (attempt >= attempts) throw error; await new Promise((resolve) => setTimeout(resolve, RETRY_MS)); continue; }
		if (!response?.ok || !response.body) { if (!attempt) throw Object.assign(new Error(`${response?.status}`), { status: response?.status }); break; }
		const reader = response.body.getReader(), decoder = new TextDecoder();
		let buffer = "";
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				const parsed = parse(buffer + decoder.decode(value, { stream: true }));
				buffer = parsed.tail;
				for (const event of parsed.events) receive(event);
			}
			for (const event of parse(`${buffer}\n`).events) receive(event);
		} catch { if (signal?.aborted) return; } finally { reader.releaseLock(); }
	}
}

/** The transcript with the resumed turn's message at its end: what the sidecar had persisted of that turn (its message
 * and the steps after it) goes, since the turn's events bring all of it back. */
export function resumedItems(items, text, newId) {
	const shown = String(text ?? "").trim(), at = shown ? items.findLastIndex((item) => item.kind === "user" && item.text === shown) : -1;
	return [...(at >= 0 ? items.slice(0, at) : items), ...(shown ? [{ kind: "user", id: newId(), text: shown, attachFrame: false, attachments: [] }] : [])];
}
