// The Studio conversation's budget at model-call time. A long Studio session kept every tool result, every script the
// agent wrote and every image whole, so each request carried all of them again: a 28-turn session reached 969k
// context tokens a call (median 534k), most of it old receipts (805k chars) and old scripts (607k chars). Applied to
// the provider view only (pi's transform_context, after the per-request context diet): the stored lane and the
// persisted history keep everything. Older results and images shrink to what a later call still needs (their ids and
// opening lines), but only when it pays: shortening one changes the prompt early in the conversation, and everything
// after it is written to the prompt cache again. Shortening 8 results at a time cost the 2026-11-07 physics bench 84
// such rewrites in 30 sessions, $39 of cache writes, to save $5.6 of cache reads (#1115). So the view stays as it is
// until its estimate passes `limit`; then every older result and image shrinks in one step (the newest stay whole) if
// that takes at least `room` off, and the next step waits until the view has grown by `room` again. No view passes
// `ceiling`: a step past it takes the view down to `limit`, oldest turns first, then the running turn's oldest calls.
// Estimate: text, thinking and call arguments at 3.6 characters a token, plus the system prompt and the tool
// declarations; then scaled by what the provider counted: each answer's usage gives the prompt its request really had
// (input, cache read and cache write), and the estimate of that same view turns into a ratio that holds for the
// messages after it. An image counts apart, by its pixels as the provider counts it (1600 tokens when its size cannot
// be read): the ratio is then one of text alone and stays put when a step takes images out (from one answer to the
// next it moved by up to 38% with the images inside it, 10% apart). 3.6 characters a token alone took a 291k-token
// view for 131k (Korean text, JSON results, and the running request's thinking, which the provider counts but whose
// text is empty): 96 of one session's 220 requests passed the ceiling. Replayed with the measured count, the largest
// view is 199k by the replay's token model, and its 5 steps (3 before) write 0.48M tokens again (0.46M before) while
// the smaller views read 10M fewer: $19.3 of prompt cost against $21.3 for the same replay on the 3.6 estimate at
// the 1-hour cache price that session paid ($16.3 against $19.9 at the 5-minute price), both with the marks of
// anthropic-cache.mjs.
const BUDGET = Object.freeze({ limit: 120_000, room: 40_000, ceiling: 200_000, keepResults: 10, keepImages: 3, bulky: 1200, head: 480, codeHead: 360 });
const CHARS_PER_TOKEN = 3.6, IMAGE_TOKENS = 1600, AGREE = 0.3;

const STUDIO_CONTEXT = /^<studio-context/;
const LIVE_CONTEXT = /^<studio-context>\n[\s\S]*?\n<\/studio-context>/;
const SUPERSEDED_CONTEXT = "<studio-context superseded/>";
const ID_PATTERNS = [/"(?:receiptId|receipt)"\s*:\s*"([0-9a-f-]{36})"/g, /\b(spec-[0-9a-f]{12})\b/g, /"code"\s*:\s*"([A-Z_]{4,})"/g];
const IMAGE_STAND_IN = "[An earlier image, left out of this request to save context. Ask for a fresh view if you need it.]";

const isPrompt = message => message?.role === "user" && Array.isArray(message.content) && message.content.some(part => part?.type === "text" && STUDIO_CONTEXT.test(part.text ?? ""));
const contentOf = message => (Array.isArray(message?.content) ? message.content : []);

/** A tool result's text, shortened to its opening and the ids a later call may name (receipts, spec ids, refusal codes). */
function shortResultText(text) {
	if (text.length <= BUDGET.bulky) return text;
	const ids = [...new Set(ID_PATTERNS.flatMap(pattern => [...text.matchAll(pattern)].map(match => match[1])))].slice(0, 16);
	return `${text.slice(0, BUDGET.head)} … [${text.length - BUDGET.head} more characters left out of this request${ids.length ? `; ids: ${ids.join(", ")}` : ""}]`;
}

/** A script call's code, shortened to its opening: the call stays readable, its full text stays in the stored history. */
function shortCallArguments(args) {
	if (!args || typeof args.code !== "string" || args.code.length <= BUDGET.bulky) return args;
	return { ...args, code: `${args.code.slice(0, BUDGET.codeHead)}\n/* … ${args.code.length - BUDGET.codeHead} more characters of this earlier script left out of this request */` };
}

/** The characters of a text part once a newer prompt and a newer result exist: the context diet then supersedes a
 * prompt's studio context and drops an inspect_studio result's re-embedded `context`. Only the newest of each differs. */
function settledChars(message, text) {
	if (message.role === "user") { const block = LIVE_CONTEXT.exec(text); return block ? SUPERSEDED_CONTEXT.length + weight(text) - weight(block[0]) : weight(text); }
	if (message.role !== "toolResult" || message.toolName !== "inspect_studio" || !text.includes("\"context\"")) return weight(text);
	try {
		const value = JSON.parse(text);
		if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "context")) return weight(text);
		const { context: _context, ...rest } = value;
		return weight(JSON.stringify(rest));
	} catch { return weight(text); }
}

/** A text's length in ASCII-character units: a non-ASCII character (Korean, Japanese, ...) is about one token on its
 * own, as many as 3.6 ASCII characters (one long Studio session, by the provider's count: 1.9 ASCII and 0.57 non-ASCII
 * characters a token). The measured ratio then corrects the whole estimate; this keeps it right as the mix changes. */
function weight(text) {
	let units = text.length;
	for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) > 127) units += CHARS_PER_TOKEN - 1;
	return units;
}

/** A text, thinking or call part's estimated tokens as later requests will send it (settled); an image counts apart. */
function partTokens(message, part) {
	if (part?.type === "text" && typeof part.text === "string") return settledChars(message, part.text) / CHARS_PER_TOKEN;
	if (part?.type === "thinking") return weight(String(part.thinking ?? "")) / CHARS_PER_TOKEN;
	if (part?.type === "toolCall") return (weight(String(part.name ?? "")) + weight(JSON.stringify(part.arguments ?? {}))) / CHARS_PER_TOKEN;
	return 0;
}

const imageSizes = new WeakMap();
/** An image as the provider counts it: its pixels / 750 once its longer side fits in 1568 (PNG and JPEG headers; the
 * same parts come back on every request, so each is read once). A size that cannot be read counts IMAGE_TOKENS. */
function imageTokens(part) {
	if (imageSizes.has(part)) return imageSizes.get(part);
	const bytes = Buffer.from(String(part.data ?? "").slice(0, 87_384), "base64");
	let width = 0, height = 0;
	if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString("latin1", 12, 16) === "IHDR") { width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); }
	// JPEG: the frame header (SOF0..SOF15, but not the DHT, JPG and DAC markers in that range) holds height, then width
	else if (bytes[0] === 0xff && bytes[1] === 0xd8) for (let i = 2; i + 9 < bytes.length && bytes[i] === 0xff; i += 2 + bytes.readUInt16BE(i + 2)) {
		if (bytes[i + 1] >= 0xc0 && bytes[i + 1] <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(bytes[i + 1])) { height = bytes.readUInt16BE(i + 5); width = bytes.readUInt16BE(i + 7); break; }
	}
	const fit = Math.min(1, 1568 / Math.max(width, height, 1));
	const tokens = width && height ? width * fit * height * fit / 750 : IMAGE_TOKENS;
	if (part && typeof part === "object") imageSizes.set(part, tokens);
	return tokens;
}

const callSaving = part => (weight(JSON.stringify(part.arguments)) - weight(JSON.stringify(shortCallArguments(part.arguments)))) / CHARS_PER_TOKEN;
const resultSaving = message => contentOf(message).reduce((sum, part) => sum + (part?.type === "text" && typeof part.text === "string" ? weight(part.text) - weight(shortResultText(part.text)) : 0), 0) / CHARS_PER_TOKEN;
const STAND_IN_TOKENS = IMAGE_STAND_IN.length / CHARS_PER_TOKEN;
const leftOutNote = count => `[The first ${count} messages of this session are left out of this request to save context.]`;
const gapNote = count => `[The ${count} messages after this one, this turn's earlier calls and their results, are left out of this request to save context.]`;
const NOTE_TOKENS = leftOutNote(1e6).length / CHARS_PER_TOKEN, GAP_NOTE_TOKENS = gapNote(1e6).length / CHARS_PER_TOKEN;
// What the diet sends of a message beyond its settled size: the newest prompt's studio context, the newest result's context.
const liveTokens = message => contentOf(message).reduce((sum, part) => sum + (part?.type === "text" && typeof part.text === "string" ? weight(part.text) - settledChars(message, part.text) : 0), 0) / CHARS_PER_TOKEN;

/**
 * Which results, script calls and images the view shortens, where it starts, and which of the running turn's calls it
 * leaves out (`gap`: the messages after `at`, the user message before the turn's first call, up to `end`, a later call).
 * The steps are replayed from the start of the history
 * with each message at its settled size, so a request reaches the same steps as the one before it plus at most a new one
 * at its end: between steps the view only grows at its end and the cached prefix holds.
 */
function shortenedParts(messages, fixed) {
	const results = [], images = [], calls = [], prompts = [], size = [], shots = [];
	let total = 0, pictures = 0, live = 0, liveResult = 0, next = BUDGET.limit, cutResults = 0, cutImages = 0, cutCalls = 0, from = 0, gap = null, turn = [], scale = 1, measured = false, source = null;
	const inView = index => index >= from && !(gap && index > gap.at && index < gap.end);
	// Estimated tokens in the provider's count: settled text sizes and the fixed part, times the latest measured ratio,
	// plus the tokens of the whole images (`shown`), which the provider counts by their pixels whatever the text ratio
	// is. That ratio already carries what the diet sent whole on the measured request (a studio context, an inspect
	// context); a later request no longer sees those parts, so counting them again here would move earlier steps.
	// Before any answer reports usage the estimate counts them itself.
	const real = (tokens, shown) => (tokens + fixed) * scale + shown;
	const whole = () => (measured ? 0 : live + liveResult);
	const over = bound => real(total + whole(), pictures) > bound;
	const cut = item => { size[item.index] -= item.saving; shots[item.index] -= item.shots ?? 0; if (inView(item.index)) { total -= item.saving; pictures -= item.shots ?? 0; } };
	// what shortening the items past the newest `keep` takes off, in the provider's count
	const pending = (items, done, keep) => items.slice(done, Math.max(done, items.length - keep)).reduce((sum, item) => sum + (inView(item.index) ? item.saving * scale + (item.shots ?? 0) : 0), 0);
	const cutAll = (keepResults, keepImages) => {
		for (; cutResults < results.length - keepResults; cutResults += 1) cut(results[cutResults]);
		for (; cutImages < images.length - keepImages; cutImages += 1) cut(images[cutImages]);
	};
	// One step: every older result and image shrinks, the newest stay whole, when that takes at least `room` off the view
	// (a smaller step costs a rewrite and saves little). Shortened forms and thinking still add up over hundreds of requests,
	// so a step past the ceiling shrinks all it can and takes the view down to `limit`: the oldest whole turns leave first
	// (a turn runs from its prompt to the next one), then the running turn's oldest calls with their results (its prompt
	// and its newest call stay; a call is never split from its results). Only when the prompt and the newest call alone
	// pass the ceiling do the newest results and images shrink as well.
	const step = last => {
		const ceiling = over(BUDGET.ceiling);
		if (ceiling || pending(results, cutResults, BUDGET.keepResults) + pending(images, cutImages, BUDGET.keepImages) >= BUDGET.room) cutAll(BUDGET.keepResults, BUDGET.keepImages);
		if (ceiling) {
			// The prompt and the newest call with its results pass the ceiling on their own: shrink the newest first, so no
			// earlier turn or call leaves for a size the shrinking takes off anyway.
			const newest = turn.at(-1) ?? prompts.at(-1);
			let kept = whole() + size[prompts.at(-1)], keptShots = shots[prompts.at(-1)];
			for (let i = newest; i <= last; i += 1) if (i !== prompts.at(-1)) { kept += size[i]; keptShots += shots[i]; }
			if (real(kept, keptShots) > BUDGET.ceiling) cutAll(0, 0);
			for (const at of prompts) {
				if (!over(BUDGET.limit)) break;
				if (!from && at) total += NOTE_TOKENS;
				for (; from < at; from += 1) if (inView(from)) { total -= size[from]; pictures -= shots[from]; }
				if (gap && from > gap.at) { total -= GAP_NOTE_TOKENS; gap = null; }
			}
			for (const at of turn) {
				if (!over(BUDGET.limit) || from !== prompts.at(-1)) break;
				if (at <= (gap?.end ?? turn[0])) continue;
				if (!gap) { gap = { at: turn[0] - 1, end: turn[0] }; total += GAP_NOTE_TOKENS; }
				for (; gap.end < at; gap.end += 1) { total -= size[gap.end]; pictures -= shots[gap.end]; }
			}
			if (over(BUDGET.ceiling)) cutAll(0, 0);
		}
		next = over(BUDGET.ceiling) ? real(total, pictures) + BUDGET.room : Math.min(BUDGET.ceiling, Math.max(BUDGET.limit, real(total, pictures) + BUDGET.room));
	};
	messages.forEach((message, index) => {
		// An answer's usage: the prompt its request had, by the provider's count, against this replay's estimate of that view
		// (text only: the images leave both sides). The count is one of this view only when the request was built by these
		// rules: a session recorded with other rules (an earlier budget, a view sent whole) counted a larger view, and that
		// reading would raise the ratio, take a step, raise it again and empty the view (one such session: 1 message kept
		// of 482). So a reading that leaves the last ratio by more than AGREE is not used; an answer by another model is
		// (another tokenizer), and so is the first.
		const counted = message?.role === "assistant" ? ["input", "cacheRead", "cacheWrite"].reduce((sum, key) => sum + (Number.isFinite(message.usage?.[key]) ? message.usage[key] : 0), 0) : 0;
		const ratio = (counted - pictures) / (total + fixed);
		if (counted > 0 && ratio > 0 && Number.isFinite(ratio)) {
			const model = message.model ?? null;
			if (!measured || model !== source || Math.abs(ratio / scale - 1) <= AGREE) { scale = ratio; source = model; }
			measured = true;
		}
		// An assistant message of the running turn may carry signed thinking next to its calls: only earlier turns' scripts
		// shrink, all at once when a turn starts, where the diet moves the prefix anyway. Until an answer reports usage the
		// ceiling also counts what the diet still sends whole: the running prompt's studio context, the newest result's.
		if (isPrompt(message) || (!index && message?.role === "user")) {
			prompts.push(index);
			turn = [];
			for (; cutCalls < calls.length; cutCalls += 1) cut(calls[cutCalls]);
			live = liveTokens(message);
		}
		if (message?.role === "assistant") turn.push(index);
		if (message?.role === "toolResult") liveResult = liveTokens(message);
		size[index] = 0; shots[index] = 0;
		contentOf(message).forEach((part, j) => {
			size[index] += partTokens(message, part);
			if (part?.type === "image") { const seen = imageTokens(part); shots[index] += seen; images.push({ index, key: `${index}:${j}`, saving: -STAND_IN_TOKENS, shots: seen }); }
			if (message.role === "assistant" && part?.type === "toolCall" && typeof part.arguments?.code === "string") calls.push({ index, key: `${index}:${j}`, saving: callSaving(part) });
		});
		total += size[index]; pictures += shots[index];
		if (message?.role === "toolResult") results.push({ index, saving: resultSaving(message) });
		if (real(total, pictures) > next || over(BUDGET.ceiling)) step(index);
	});
	const keys = (items, count) => new Set(items.slice(0, count).map(item => item.key ?? item.index));
	return { from, gap, results: keys(results, cutResults), calls: keys(calls, cutCalls), images: keys(images, cutImages) };
}

/** The messages a Studio request sends: older tool results, script calls and images shortened (new objects only), and
 * past the ceiling the oldest turns and the running turn's oldest calls left out, each with a note on the prompt kept. */
function budgetStudioMessages(messages, fixed) {
	const old = shortenedParts(messages, fixed);
	if (!old.from && !old.gap && !old.results.size && !old.calls.size && !old.images.size) return messages;
	const view = messages.map((message, index) => {
		if (!Array.isArray(message?.content)) return message;
		let changed = false;
		const content = message.content.map((part, j) => {
			const key = `${index}:${j}`;
			if (part?.type === "image" && old.images.has(key)) { changed = true; return { type: "text", text: IMAGE_STAND_IN }; }
			if (part?.type === "text" && old.results.has(index) && typeof part.text === "string") { const text = shortResultText(part.text); if (text !== part.text) { changed = true; return { ...part, text }; } }
			if (part?.type === "toolCall" && old.calls.has(key)) { const args = shortCallArguments(part.arguments); if (args !== part.arguments) { changed = true; return { ...part, arguments: args }; } }
			return part;
		});
		return changed ? { ...message, content } : message;
	});
	if (!old.from && !old.gap) return view;
	const parts = message => (typeof message.content === "string" ? [{ type: "text", text: message.content }] : contentOf(message));
	return view.flatMap((message, index) => {
		if (index < old.from || (old.gap && index > old.gap.at && index < old.gap.end)) return [];
		if (old.from && index === old.from) message = { ...message, content: [{ type: "text", text: leftOutNote(old.from) }, ...parts(message)] };
		if (old.gap && index === old.gap.at) message = { ...message, content: [...parts(message), { type: "text", text: gapNote(old.gap.end - old.gap.at - 1) }] };
		return [message];
	});
}

// Scripts that name a language unambiguously; Han alone (no kana) reads as Chinese.
const SCRIPTS = [[/[가-힣]/, "Korean"], [/[぀-ヿ]/, "Japanese"], [/[一-鿿]/, "Chinese"], [/[Ѐ-ӿ]/, "Russian"], [/[฀-๿]/, "Thai"], [/[؀-ۿ]/, "Arabic"]];

/** The language the user's message is written in when its script says so, else null (Latin text: no guess). */
function replyLanguage(text) {
	const plain = String(text ?? "").replace(/<studio-context[\s\S]*?(<\/studio-context>|\/>)/g, "");
	return SCRIPTS.find(([pattern]) => pattern.test(plain))?.[1] ?? null;
}

/** The reminder a user's Studio message carries at model-call time. A general "reply in the user's language" rule barely moves
 * replies; drift into English comes in the short notes before tool calls, so the language is named, from the user's own text. */
const languageReminder = language => `[Reply in ${language}. Write every message for this request in ${language}, the language it is written in, short notes before tool calls included, even when tools answer in English.]`;

// A request about staging, coverage or the camera.
const STAGING_WORDS = /샷|컷|카메라|커버리지|구도|배치|동선|OTS|투샷|프레임|shot|camera|coverage|two-shot|framing|staging|blocking/i;

/**
 * Whether a Studio turn carries the top-view plan image. It used to ride every turn of any scene with a shot or two
 * characters, re-sending a plan the conversation already had; now a turn asks for it by wording, or it comes once,
 * on the first turn of such a scene in this session (planSeen: a plan was already attached here).
 */
export const wantsPlan = ({ text, characterCount, shots, planSeen }) => STAGING_WORDS.test(text || "") || (!planSeen && (characterCount >= 2 || shots >= 1));


/**
 * Each Studio prompt message ends with its reply-language reminder (by its own text, so the cached prefix never moves), and a
 * long turn repeats it on every REMIND_EVERY-th tool result after the prompt: 9240db36 wrote a note in English 17 results in.
 */
const REMIND_EVERY = 8;
function withLanguageReminders(messages) {
	let language = null, results = 0;
	return messages.map(message => {
		if (message?.role === "toolResult" && language && Array.isArray(message.content) && ++results % REMIND_EVERY === 0) return { ...message, content: [...message.content, { type: "text", text: languageReminder(language) }] };
		if (message?.role !== "user" || !Array.isArray(message.content) || !message.content.some(part => part?.type === "text" && STUDIO_CONTEXT.test(part.text ?? ""))) return message;
		language = replyLanguage(message.content.filter(part => part?.type === "text").map(part => part.text).join("\n")); results = 0;
		return language ? { ...message, content: [...message.content, { type: "text", text: languageReminder(language) }] } : message;
	});
}

const declaredChars = tools => (Array.isArray(tools) ? tools : []).reduce((sum, tool) => sum + weight(JSON.stringify({ name: tool?.name, description: tool?.description, parameters: tool?.parameters })), 0);

/** The Studio request after the context diet: every prompt carrying its reply language, older bulk shortened (the budget
 * runs last, so its estimate counts the reminders; the system prompt and the tools count as its fixed part). */
export function budgetStudioRequest({ messages, systemPrompt, tools }) {
	const fixed = (weight(String(systemPrompt ?? "")) + declaredChars(tools)) / CHARS_PER_TOKEN;
	return { messages: budgetStudioMessages(withLanguageReminders(messages), fixed), systemPrompt };
}
