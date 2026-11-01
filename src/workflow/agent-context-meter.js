// The agent panel's context readout: how much of the selected model's context window the latest model request used.
// The sidecar sends one `context` frame per finished request (bin/agent/agent-runner.mjs): `tokens` is that request's
// prompt (input + cache read + cache write), `window` the model's catalog contextWindow, or null when the catalog has none.

/** A token count as the panel prints it: 512, 9.6k, 96k, 1.0M. */
export function compactTokens(count) {
	const value = Math.max(0, Math.round(Number(count) || 0));
	if (value < 1000) return String(value);
	if (value < 9950) return `${(value / 1000).toFixed(1)}k`;
	const thousands = Math.round(value / 1000);
	if (thousands < 1000) return `${thousands}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

/** The readout for a `context` frame, or null when there is nothing to show. `hot` marks a request past 80% of the window. */
export function contextMeter(frame) {
	const tokens = Number(frame?.tokens);
	if (!Number.isFinite(tokens) || tokens <= 0) return null;
	const window = Number(frame?.window);
	const used = compactTokens(tokens);
	if (!Number.isFinite(window) || window <= 0) return { used, window: null, percent: null, hot: false, text: `CTX ${used}` };
	const ratio = tokens / window;
	const percent = Math.round(ratio * 100);
	const total = compactTokens(window);
	return { used, window: total, percent, hot: ratio > 0.8, text: `CTX ${used} / ${total} (${percent}%)` };
}
