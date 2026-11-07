// The Studio conversation's budget at model-call time. A long Studio session kept every tool result, every script the
// agent wrote and every image whole, so each request carried all of them again: a 28-turn session reached 969k
// context tokens a call (median 534k), most of it old receipts (805k chars) and old scripts (607k chars). Applied to
// the provider view only (pi's transform_context, after the per-request context diet): the stored lane and the
// persisted history keep everything. Older results and images shrink to what a later call still needs (their ids and
// opening lines), but only when it pays: shortening one changes the prompt early in the conversation, and everything
// after it is written to the prompt cache again. Shortening 8 results at a time cost the 2026-11-07 physics bench 84
// such rewrites in 30 sessions, $39 of cache writes, to save $5.6 of cache reads (#1115). So the view stays as it is
// until its estimate passes `limit`; then every older result and image shrinks in one step (the newest stay whole) if
// that takes at least `room` off, and the next step waits until the view has grown by `room` again. Past `ceiling` a
// step also leaves the oldest turns out.
// Estimate: text, thinking and call arguments at 3.6 characters a token, an image at 1600 tokens, messages only (the
// system prompt and the tool schemas are fixed for the session).
const BUDGET = Object.freeze({ limit: 120_000, room: 40_000, ceiling: 200_000, keepResults: 10, keepImages: 3, bulky: 1200, head: 480, codeHead: 360 });
const CHARS_PER_TOKEN = 3.6, IMAGE_TOKENS = 1600;

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
	if (message.role === "user") { const block = LIVE_CONTEXT.exec(text); return block ? SUPERSEDED_CONTEXT.length + text.length - block[0].length : text.length; }
	if (message.role !== "toolResult" || message.toolName !== "inspect_studio" || !text.includes("\"context\"")) return text.length;
	try {
		const value = JSON.parse(text);
		if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "context")) return text.length;
		const { context: _context, ...rest } = value;
		return JSON.stringify(rest).length;
	} catch { return text.length; }
}

/** A part's estimated tokens as later requests will send it (settled). */
function partTokens(message, part) {
	if (part?.type === "image") return IMAGE_TOKENS;
	if (part?.type === "text" && typeof part.text === "string") return settledChars(message, part.text) / CHARS_PER_TOKEN;
	if (part?.type === "thinking") return String(part.thinking ?? "").length / CHARS_PER_TOKEN;
	if (part?.type === "toolCall") return (String(part.name ?? "").length + JSON.stringify(part.arguments ?? {}).length) / CHARS_PER_TOKEN;
	return 0;
}

const callSaving = part => (JSON.stringify(part.arguments).length - JSON.stringify(shortCallArguments(part.arguments)).length) / CHARS_PER_TOKEN;
const resultSaving = message => contentOf(message).reduce((sum, part) => sum + (part?.type === "text" && typeof part.text === "string" ? part.text.length - shortResultText(part.text).length : 0), 0) / CHARS_PER_TOKEN;
const IMAGE_SAVING = IMAGE_TOKENS - IMAGE_STAND_IN.length / CHARS_PER_TOKEN;
const leftOutNote = count => `[The first ${count} messages of this session are left out of this request to save context.]`;
const NOTE_TOKENS = leftOutNote(1e6).length / CHARS_PER_TOKEN;

/**
 * Which results, script calls and images the view shortens, and where it starts. The steps are replayed from the start
 * of the history with each message at its settled size, so a request reaches the same steps as the one before it plus
 * at most a new one at its end: between steps the view only grows at its end and the cached prefix holds.
 */
function shortenedParts(messages) {
	const results = [], images = [], calls = [], prompts = [], size = [];
	let total = 0, live = 0, next = BUDGET.limit, cutResults = 0, cutImages = 0, cutCalls = 0, from = 0;
	const cut = item => { size[item.index] -= item.saving; if (item.index >= from) total -= item.saving; };
	const pending = (items, done, keep) => items.slice(done, Math.max(done, items.length - keep)).reduce((sum, item) => sum + (item.index >= from ? item.saving : 0), 0);
	// One step: every older result and image shrinks, the newest stay whole, when that takes at least `room` off the view
	// (a smaller step costs a rewrite and saves little). Shortened forms and thinking still add up over hundreds of requests,
	// so past the ceiling the oldest whole turns leave the view as well, down to `limit` in the same step (a turn runs from
	// its prompt to the next one, so every call keeps its result). Only the running turn can hold the view above the ceiling.
	const step = () => {
		const leave = total + live > BUDGET.ceiling && prompts.at(-1) > from;
		if (leave || pending(results, cutResults, BUDGET.keepResults) + pending(images, cutImages, BUDGET.keepImages) >= BUDGET.room) {
			for (; cutResults < results.length - BUDGET.keepResults; cutResults += 1) cut(results[cutResults]);
			for (; cutImages < images.length - BUDGET.keepImages; cutImages += 1) cut(images[cutImages]);
		}
		if (leave) for (const at of prompts) { if (total + live <= BUDGET.limit) break; if (!from && at) total += NOTE_TOKENS; for (; from < at; from += 1) total -= size[from]; }
		next = total + live < BUDGET.ceiling ? Math.min(BUDGET.ceiling, Math.max(BUDGET.limit, total + BUDGET.room)) : total + BUDGET.room;
	};
	messages.forEach((message, index) => {
		// An assistant message of the running turn may carry signed thinking next to its calls: only earlier turns' scripts
		// shrink, all at once when a turn starts, where the diet moves the prefix anyway. The ceiling also counts the running
		// prompt's studio context, which stays whole for its turn.
		if (isPrompt(message)) {
			prompts.push(index);
			for (; cutCalls < calls.length; cutCalls += 1) cut(calls[cutCalls]);
			live = contentOf(message).reduce((sum, part) => sum + (part?.type === "text" && typeof part.text === "string" ? part.text.length - settledChars(message, part.text) : 0), 0) / CHARS_PER_TOKEN;
		}
		size[index] = 0;
		contentOf(message).forEach((part, j) => {
			size[index] += partTokens(message, part);
			if (part?.type === "image") images.push({ index, key: `${index}:${j}`, saving: IMAGE_SAVING });
			if (message.role === "assistant" && part?.type === "toolCall" && typeof part.arguments?.code === "string") calls.push({ index, key: `${index}:${j}`, saving: callSaving(part) });
		});
		total += size[index];
		if (message?.role === "toolResult") results.push({ index, saving: resultSaving(message) });
		if (total > next || (total + live > BUDGET.ceiling && prompts.at(-1) > from)) step();
	});
	const keys = (items, count) => new Set(items.slice(0, count).map(item => item.key ?? item.index));
	return { from, results: keys(results, cutResults), calls: keys(calls, cutCalls), images: keys(images, cutImages) };
}

/** The messages a Studio request sends: older tool results, script calls and images shortened (new objects only), and
 * past the ceiling the oldest turns left out, with a note on the first prompt kept. */
function budgetStudioMessages(messages) {
	const old = shortenedParts(messages);
	if (!old.from && !old.results.size && !old.calls.size && !old.images.size) return messages;
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
	if (!old.from) return view;
	const [first, ...rest] = view.slice(old.from);
	return [{ ...first, content: [{ type: "text", text: leftOutNote(old.from) }, ...first.content] }, ...rest];
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

/** The Studio request after the context diet: every prompt carrying its reply language, older bulk shortened (the budget
 * runs last, so its estimate counts the reminders). */
export const budgetStudioRequest = ({ messages, systemPrompt }) => ({ messages: budgetStudioMessages(withLanguageReminders(messages)), systemPrompt });
