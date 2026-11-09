// Model usage of one run, from the CLIProxyAPI usage log both tools' requests pass through (docs/qa/physics-bench.md,
// PR 4), so tokens, price and model time come from one source for both sides. A run's requests are the ones from
// this machine (127.0.0.1) whose user agent is that tool's agent (the Studio Agent: "pi/", Claude Code: "claude-cli/")
// and that ended inside the run's window. Blender runs one at a time, so the window and the user agent tell its runs
// apart. CozyClay runs may overlap (run.mjs --lanes), and the proxy's session_id is not the agent's session id, so
// usageOfSessions reads each run's own session logs instead: on the 30 v1 CozyClay runs they gave the proxy's requests
// and every token field exactly, and its model time within 0.3%.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// USD per million tokens, claude-opus-5-5 public list price (checked 2026-11-07; it reproduces Claude Code's
// total_cost_usd and the Studio Agent session cost to the cent fraction). KRW at 1,500 per USD (plan 4.1).
// A run prices its usage at the selected model's rate; a model with no rate here is refused (run.mjs), never priced as another.
const PRICES = { "claude-opus-5-5": { date: "2026-11-07", model: "claude-opus-5-5", input: 4, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2, output: 20, krwPerUsd: 1500 } };

/** The price table for `model`; throws for a model with no rate. */
export function priceFor(model) {
	const price = PRICES[model];
	if (!price) throw new Error(`no price for model ${model}; add its rate to usage.mjs PRICES (known: ${Object.keys(PRICES).join(", ")})`);
	return price;
}
const AGENT = { cozyclay: /^pi\//, blender: /^claude-cli\// };
const LOCAL = new Set(["127.0.0.1", "::1"]);

function* records(dir, from, to) {
	// files are named by the proxy's local month: look a day either side so a run near a month edge is not missed
	const months = new Set([from - 86_400_000, from, to, to + 86_400_000].map(t => new Date(t).toISOString().slice(0, 7)));
	for (const m of months) {
		const file = join(dir, `${m}.jsonl`);
		if (!existsSync(file)) continue;
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (!line) continue;
			try { yield JSON.parse(line); } catch { /* a line still being written */ }
		}
	}
}

/** Union length (ms) of [start, end] intervals. */
function unionMs(spans) {
	let total = 0, end = -Infinity;
	for (const [a, b] of spans.sort((x, y) => x[0] - y[0])) {
		if (a > end) { total += b - a; end = b; } else if (b > end) { total += b - end; end = b; }
	}
	return total;
}

const header = (r, name) => Number(r.response_headers?.[name]?.[0]);

/** The subscription's 7-day utilization the proxy last reported in [from, to], or null. */
function last7d(dir, from, to) {
	let u = null;
	for (const r of records(dir, from, to)) { const t = Date.parse(r.timestamp), v = header(r, "Anthropic-Ratelimit-Unified-7d-Utilization"); if (t >= from && t <= to && Number.isFinite(v)) u = v; }
	return u;
}

/** True when a request from this machine was refused for the rate limit in the last `ms` (429 or status rejected). */
export function rateLimited(ms = 15 * 60_000, dir = join(homedir(), "cliproxy-usage")) {
	const to = Date.now(), from = to - ms;
	for (const r of records(dir, from, to)) {
		const t = Date.parse(r.timestamp);
		if (t < from || !LOCAL.has(r.client_ip)) continue;
		if (r.fail?.status_code === 429 || r.response_headers?.["Anthropic-Ratelimit-Unified-Status"]?.[0] === "rejected") return true;
	}
	return false;
}

/** Tokens, price (at `model`'s rate) and model time of `tool`'s requests that ended in [from, to] (ms epoch). */
export function usageOf(tool, from, to, model, dir = join(homedir(), "cliproxy-usage")) {
	const PRICE = priceFor(model);
	const t = { requests: 0, failed: 0, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, modelMs: 0, modelBusyMs: 0 };
	const spans = [];
	for (const r of records(dir, from, to)) {
		// the record's timestamp is the request's start (records are spaced by latency plus the client's gap)
		const start = Date.parse(r.timestamp);
		if (!(start >= from && start <= to) || !LOCAL.has(r.client_ip) || !AGENT[tool].test(r.user_agent ?? "")) continue;
		const k = r.tokens ?? {};
		t.requests++;
		if (r.failed) t.failed++;
		t.input += k.input_tokens ?? 0;
		t.output += k.output_tokens ?? 0;
		t.cacheRead += k.cache_read_tokens ?? 0;
		const w1h = k.cache_creation_1h_tokens ?? 0;
		t.cacheWrite1h += w1h;
		t.cacheWrite5m += Math.max(0, (k.cache_creation_tokens ?? 0) - w1h);
		t.modelMs += r.latency_ms ?? 0;
		spans.push([start, start + (r.latency_ms ?? 0)]);
	}
	return priced(t, spans, dir, from, to, PRICE);
}

/** The same totals from Studio Agent session logs (each assistant message carries its usage and durationMs; its
 * timestamp is the request's START: a median 12 ms after the tool result before it), priced at `model`'s rate. utilization7d comes from the proxy log. */
export function usageOfSessions(files, from, to, model, dir = join(homedir(), "cliproxy-usage")) {
	const t = { requests: 0, failed: 0, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, modelMs: 0, modelBusyMs: 0 };
	const spans = [];
	for (const file of files) {
		if (!existsSync(file)) continue;
		for (const line of readFileSync(file, "utf8").split("\n")) {
			let e;
			try { e = JSON.parse(line); } catch { continue; }
			const m = e?.message ?? e, u = m?.usage;
			if (m?.role !== "assistant" || !u) continue;
			t.requests++;
			if (m.stopReason === "error") t.failed++;
			t.input += u.input ?? 0;
			t.output += u.output ?? 0;
			t.cacheRead += u.cacheRead ?? 0;
			const w1h = u.cacheWrite1h ?? 0;
			t.cacheWrite1h += w1h;
			t.cacheWrite5m += Math.max(0, (u.cacheWrite ?? 0) - w1h);
			const ms = m.durationMs ?? 0, start = Number(m.timestamp ?? Date.parse(e.timestamp));
			t.modelMs += ms;
			if (Number.isFinite(start)) spans.push([start, start + ms]);
		}
	}
	return priced(t, spans, dir, from, to, priceFor(model));
}

function priced(t, spans, dir, from, to, PRICE) {
	t.modelBusyMs = unionMs(spans);
	t.utilization7d = last7d(dir, from, to);
	const usd = (t.input * PRICE.input + t.output * PRICE.output + t.cacheRead * PRICE.cacheRead + t.cacheWrite5m * PRICE.cacheWrite5m + t.cacheWrite1h * PRICE.cacheWrite1h) / 1e6;
	// the box proxy turns every cache write of a cloaked client into a 1-hour write (tested 2026-11-07: ttl absent or "5m",
	// pi or claude-cli user agent, all 1h); usd5m prices the same writes at the 5-minute rate a direct API key gets
	const usd5m = (t.input * PRICE.input + t.output * PRICE.output + t.cacheRead * PRICE.cacheRead + (t.cacheWrite5m + t.cacheWrite1h) * PRICE.cacheWrite5m) / 1e6;
	return { ...t, usd: Math.round(usd * 1e4) / 1e4, usd5m: Math.round(usd5m * 1e4) / 1e4, krw: Math.round(usd * PRICE.krwPerUsd), price: PRICE };
}
