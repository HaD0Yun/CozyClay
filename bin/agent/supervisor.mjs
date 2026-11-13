// Supervisor v2 (#728): one asynchronous review of a finished Studio turn by
// the turn's own model at high reasoning effort. It never blocks the turn and
// never talks back to the agent: the sidecar starts it after the turn's stream
// has ended and appends exactly one `supervisor` event to the turn record,
// which the panel shows as a note card.

export const SUPERVISOR_RUBRIC = "You are the previs supervisor reviewing one agent turn in CozyClay Studio. Judge ONLY from the evidence given (receipts, refusal codes, geometry facts, pictures). Evaluate exactly these seven items: 1 request coverage - every deliverable the user literally asked for exists (blocker when missing); 2 impossible items - anything refused with TARGET_NOT_READY / CAPABILITY_MISSING / CONFIRMATION_REQUIRED is 'refused', not 'missing'; it is a blocker only when the reply hid the refusal from the user; 3 spatial sanity - floating or sunken objects, unintended interpenetration, subjects occluded by set pieces (concern); 4 framing - requested size vs derivedSize, clipped subjects, subject out of frame (concern); 5 continuity across shots - 180-degree line (axisConsistent, cameraSide), eyeline, OTS over the correct shoulder, screen direction (concern); 6 undo integrity - the turn is one history entry / receipts are undoable (blocker when broken); 7 report honesty - the reply claims nothing the receipts do not show and claims no verification that did not run (blocker). Capsule figures (characterKind proxy) cannot pose, sit or animate: a refused pose on one is 'refused'. In a hybrid project (castStyle hybrid, or no castStyle given), capsule figures the user approved in place of rigs for a shot (previousExchange holds the proposal the request answers) are not a coverage miss. Reply with JSON only: { \"items\": [{ \"text\": string, \"status\": \"done\"|\"partial\"|\"refused\"|\"missing\", \"evidence\": string }], \"issues\": [{ \"severity\": \"blocker\"|\"concern\"|\"note\", \"kind\": \"coverage\"|\"disclosure\"|\"spatial\"|\"framing\"|\"continuity\"|\"undo\"|\"honesty\", \"text\": string, \"evidence\": string }], \"summary\": string }. Write text fields in the user's language. Be concrete and short; cite ids, metres and shot names. An issue MAY carry \"fix\": { \"action\": \"<action id from the ACTIONS list>\", \"args\": { ... } } - ONE run_action call the next turn executes verbatim, with real ids and values taken from the receipts and geometry and args shaped by ACTION SCHEMAS. Examples: {\"action\":\"character.setPose\",\"args\":{\"characterId\":\"char-b\",\"posture\":\"sit\"}}, {\"action\":\"shot.frame\",\"args\":{\"shotId\":\"shot-1\",\"subjectIds\":[\"char-a\"],\"framing\":{\"intent\":{\"size\":\"wide shot\",\"view\":\"front\",\"level\":\"eye\",\"side\":\"left\"}}}}, {\"action\":\"object.set\",\"args\":{\"id\":\"table-1\",\"set\":{\"position\":{\"x\":0,\"y\":0,\"z\":1.2}}}}. Use only actions present in ACTIONS; never invent ids; never propose a pose or motion fix for a capsule figure; omit fix when no safe single action exists.";

const REFUSAL_CODES = Object.freeze(["TARGET_NOT_READY", "CAPABILITY_MISSING", "CONFIRMATION_REQUIRED"]);
const SUPERVISOR_LIMITS = Object.freeze({ delta: 8, warnings: 12, reply: 4000, images: 5, createdShots: 3, imageWidth: 1280, args: 600, timeoutMs: 120_000, schemaBytes: 6000 });
/** The actions whose input schemas the reviewer gets, so a fix it writes has
 * the right shape (#743). Only those present in the turn's action index are
 * asked for. */
const SUPERVISOR_FIX_ACTIONS = Object.freeze(["character.setPose", "character.move", "character.update", "shot.frame", "shot.set", "shot.setRange", "object.update", "object.remove", "objects.arrange", "stage.set", "edit.undo", "view.update"]);
const ITEM_STATUSES = ["done", "partial", "refused", "missing"];
const SEVERITIES = ["blocker", "concern", "note"];
const KINDS = ["coverage", "disclosure", "spatial", "framing", "continuity", "undo", "honesty"];

const isObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const clip = (text, max) => text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;

/** Pictures never ride in the digest's text: every dataUrl, at any depth, is dropped. */
function withoutDataUrls(value) {
	if (Array.isArray(value)) return value.map(withoutDataUrls);
	if (!isObject(value)) return value;
	return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "dataUrl").map(([key, entry]) => [key, withoutDataUrls(entry)]));
}

/** One receipt, verbatim but bounded: no image bytes, at most 8 delta rows and 12 warnings. */
function boundReceipt(receipt) {
	const bounded = withoutDataUrls(receipt);
	if (!isObject(bounded)) return bounded;
	if (Array.isArray(bounded.delta) && bounded.delta.length > SUPERVISOR_LIMITS.delta) {
		bounded.deltaOmitted = bounded.delta.length - SUPERVISOR_LIMITS.delta;
		bounded.delta = bounded.delta.slice(0, SUPERVISOR_LIMITS.delta);
	}
	if (Array.isArray(bounded.warnings) && bounded.warnings.length > SUPERVISOR_LIMITS.warnings) {
		bounded.warningsOmitted = bounded.warnings.length - SUPERVISOR_LIMITS.warnings;
		bounded.warnings = bounded.warnings.slice(0, SUPERVISOR_LIMITS.warnings);
	}
	return bounded;
}

const refusalOf = (code, message, tool) => REFUSAL_CODES.includes(code) ? [{ code, message: clip(String(message ?? ""), 400), ...(tool ? { tool } : {}) }] : [];

/** What a turn's frames say about it: whether it authored anything, the
 * refusals it met, its tool calls and its receipts (read-only results such as
 * inspect_studio are calls, not receipts). */
function analyseTurnFrames(frames = []) {
	const names = new Map();
	const calls = [], receipts = [], refusals = [];
	let authored = false;
	for (const frame of Array.isArray(frames) ? frames : []) {
		if (frame?.type === "tool.start") {
			names.set(frame.callId, frame.name);
			calls.push({ callId: frame.callId, name: frame.name, args: clip(JSON.stringify(frame.args ?? {}), SUPERVISOR_LIMITS.args) });
		} else if (frame?.type === "tool.done") {
			const name = names.get(frame.callId);
			const call = calls.find(entry => entry.callId === frame.callId);
			if (call) call.ok = frame.ok === true;
			if (frame.ok !== true) {
				const error = String(frame.error ?? "");
				const match = /^([A-Z][A-Z_]+):\s*([\s\S]*)$/.exec(error);
				if (call) call.error = clip(error, 400);
				if (match) refusals.push(...refusalOf(match[1], match[2], name));
				continue;
			}
			const result = frame.result;
			if (!isObject(result)) continue;
			if (result.authored === true) authored = true;
			if (result.ok === false) refusals.push(...refusalOf(result.code ?? result.error?.code, result.message ?? result.error?.message, name));
			if (name !== "inspect_studio" && (typeof result.receiptId === "string" || typeof result.authored === "boolean" || isObject(result.checks))) receipts.push({ tool: name ?? null, receipt: result });
		} else if (frame?.type === "receipt" && isObject(frame.receipt)) {
			if (frame.receipt.authored === true) authored = true;
			if (frame.receipt.ok === false) refusals.push(...refusalOf(frame.receipt.code, frame.receipt.message, null));
			receipts.push({ tool: "turn", receipt: frame.receipt });
		}
	}
	return { authored, refusals, calls: calls.map(({ callId: _callId, ...call }) => call), receipts };
}

/** Pure read-only turns and questions are not reviewed: only a turn that
 * authored something or met a refusal is. */
export const shouldSupervise = frames => {
	const { authored, refusals } = analyseTurnFrames(frames);
	return authored || refusals.length > 0;
};

function imagePart(image) {
	const match = /^data:([^;,]+);base64,(.*)$/.exec(image?.dataUrl ?? "");
	return match ? { type: "image", data: match[2], mimeType: match[1] } : null;
}

/** The ACTION SCHEMAS block: whole schemas in the order given while they fit
 * the byte budget; the ids that did not fit are named, never half-quoted. */
function boundSchemas(schemas) {
	const kept = {}, omitted = [];
	let size = 2;
	for (const entry of Array.isArray(schemas) ? schemas : []) {
		if (typeof entry?.id !== "string" || !isObject(entry.input)) continue;
		const cost = JSON.stringify({ [entry.id]: entry.input }).length;
		if (size + cost > SUPERVISOR_LIMITS.schemaBytes) { omitted.push(entry.id); continue; }
		kept[entry.id] = entry.input;
		size += cost;
	}
	return omitted.length ? { ...kept, omitted } : kept;
}

/** The digest the reviewer reads: a compact JSON-ish text block plus at most
 * five pi ImageContent parts, in the order the text lists them. `actions` is
 * `{ index: [{ id, label }], schemas: [{ id, input }] }`: what a fix may name
 * and the input shape of the pre-selected ones (#743). */
export function buildSupervisorInput({ request = "", frames = [], reply = "", geometry = null, refusals, images = [], notes = [], actions = null, castStyle, previousExchange } = {}) {
	const turn = analyseTurnFrames(frames);
	const pictures = (Array.isArray(images) ? images : []).map(image => ({ image, part: imagePart(image) })).filter(entry => entry.part).slice(0, SUPERVISOR_LIMITS.images);
	const section = (name, value) => `${name}: ${JSON.stringify(value)}`;
	const text = [
		"<turn-review>",
		section("request", String(request ?? "")), ...(previousExchange ? [section("previousExchange", previousExchange)] : []), ...(typeof castStyle === "string" ? [section("castStyle", castStyle)] : []),
		section("toolCalls", turn.calls),
		section("receipts", turn.receipts.map(entry => ({ tool: entry.tool, ...boundReceipt(entry.receipt) }))),
		section("refusals", Array.isArray(refusals) ? refusals : turn.refusals),
		section("reply", clip(String(reply ?? ""), SUPERVISOR_LIMITS.reply)),
		section("geometry", geometry ?? { note: "no geometry facts were measured" }),
		section("images", pictures.map((entry, index) => `${index + 1} ${entry.image.label ?? "image"}${entry.image.width ? ` (${entry.image.width}x${entry.image.height})` : ""}`)),
		...(notes.length ? [section("evidenceNotes", notes)] : []),
		section("ACTIONS", (Array.isArray(actions?.index) ? actions.index : []).filter(row => typeof row?.id === "string").map(row => typeof row.label === "string" && row.label ? `${row.id} (${row.label})` : row.id)),
		section("ACTION SCHEMAS", boundSchemas(actions?.schemas)),
		"</turn-review>",
	].join("\n");
	return { text, images: pictures.map(entry => entry.part) };
}

/** The first balanced {...} block of a reply, string-aware. */
function firstJsonBlock(text) {
	const start = text.indexOf("{");
	if (start === -1) return null;
	let depth = 0, inString = false, escaped = false;
	for (let index = start; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === "\"") inString = false;
		} else if (char === "\"") inString = true;
		else if (char === "{") depth += 1;
		else if (char === "}" && --depth === 0) return text.slice(start, index + 1);
	}
	return null;
}

/** The reviewer's verdict, validated, or null for anything that is not one. */
export function parseSupervisorVerdict(text) {
	if (typeof text !== "string") return null;
	const block = firstJsonBlock(text);
	if (!block) return null;
	let value;
	try { value = JSON.parse(block); } catch { return null; }
	if (!isObject(value) || typeof value.summary !== "string" || !Array.isArray(value.items) || !Array.isArray(value.issues)) return null;
	const items = value.items.map(item => isObject(item) && typeof item.text === "string" && ITEM_STATUSES.includes(item.status) && typeof item.evidence === "string"
		? { text: item.text, status: item.status, evidence: item.evidence } : null);
	// A fix rides along unvalidated here; validateFixes keeps or drops it.
	const issues = value.issues.map(issue => isObject(issue) && SEVERITIES.includes(issue.severity) && KINDS.includes(issue.kind) && typeof issue.text === "string" && typeof issue.evidence === "string"
		? { severity: issue.severity, kind: issue.kind, text: issue.text, evidence: issue.evidence, ...(issue.fix !== undefined && issue.fix !== null ? { fix: issue.fix } : {}) } : null);
	if (items.includes(null) || issues.includes(null)) return null;
	return { items, issues, summary: value.summary };
}

/**
 * The fixes a note may hand the next turn (#743). A fix survives only when its
 * action is in the turn's action index and its args are an object carrying
 * every key the action's schema requires (when the schema was read). Every
 * other fix is removed from its issue and reported with the reason.
 */
export function validateFixes(issues, { index = [], schemas = [] } = {}) {
	const known = new Set((Array.isArray(index) ? index : []).map(row => typeof row === "string" ? row : row?.id).filter(id => typeof id === "string"));
	const inputs = new Map((Array.isArray(schemas) ? schemas : []).filter(entry => typeof entry?.id === "string" && isObject(entry.input)).map(entry => [entry.id, entry.input]));
	const dropped = [];
	const kept = (Array.isArray(issues) ? issues : []).map((issue, issueIndex) => {
		if (!isObject(issue) || issue.fix === undefined) return issue;
		const { fix, ...rest } = issue;
		const action = typeof fix?.action === "string" ? fix.action : null;
		const required = Array.isArray(inputs.get(action)?.required) ? inputs.get(action).required : [];
		const missing = isObject(fix?.args) ? required.filter(key => !Object.hasOwn(fix.args, key)) : [];
		const reason = !isObject(fix) || !action ? "malformed fix"
			: !known.has(action) ? "unknown action"
				: !isObject(fix.args) ? "args is not an object"
					: missing.length ? `missing required key ${missing.map(key => `"${key}"`).join(", ")}` : null;
		if (!reason) return { ...rest, fix: { action, args: fix.args } };
		dropped.push({ issueIndex, action, reason });
		return rest;
	});
	return { issues: kept, dropped };
}

const verdictCounts = issues => Object.fromEntries(SEVERITIES.map(severity => [severity, issues.filter(issue => issue.severity === severity).length]));

const redact = message => clip(String(message ?? "unknown failure").replace(/data:[^\s"']+/gi, "[image]").replace(/\b(?:sk-or-|sk-ant-|sk-|Bearer\s+|eyJ)[\w.\-+/=]+/gi, "[redacted]").replace(/\s+/g, " ").trim(), 200);

/**
 * What the reviewer gets to see beyond the frames, read from the editor after
 * the turn: geometry facts for the shots the turn touched (a framing
 * verify_result the sidecar issues itself), the current shot frame, the top
 * view and one frame per shot the turn created. Every piece is optional; what
 * could not be read becomes a note instead of a failure.
 */
async function gatherSupervisorEvidence({ hub, workspaceHandle, admission, baseline, receipts, actionIndex = [] }) {
	const notes = [], images = [];
	const command = (name, args, options) => options ? hub.command(name, args, workspaceHandle, options) : hub.command(name, args, workspaceHandle);
	// What a fix may name: the turn's own action index, and the input schemas
	// of the pre-selected actions it declares (#743).
	const index = (Array.isArray(actionIndex) ? actionIndex : []).filter(row => typeof row?.id === "string").map(row => ({ id: row.id, ...(typeof row.label === "string" ? { label: row.label } : {}) }));
	const wanted = SUPERVISOR_FIX_ACTIONS.filter(id => index.some(row => row.id === id));
	let schemas = [];
	if (wanted.length) {
		try {
			const result = await command("inspect_studio", { scope: "actions", ids: wanted });
			schemas = (Array.isArray(result?.actions) ? result.actions : []).filter(row => wanted.includes(row?.id) && isObject(row.input)).map(row => ({ id: row.id, input: row.input }));
		} catch (error) { notes.push(`action schemas unavailable: ${redact(error?.message)}`); }
	}
	const envelope = (name, args) => ({ name, args, commandId: admission.commandId(), host: admission.host, expectedRevision: admission.revision });
	let context = null;
	try { context = await admission.refresh(); } catch (error) { notes.push(`scene context unavailable: ${redact(error?.message)}`); }
	const shots = Array.isArray(context?.shots) ? context.shots : [];
	const shotIds = new Set(shots.map(shot => shot.id));
	const before = new Set((Array.isArray(baseline?.shots) ? baseline.shots : []).map(shot => shot.id));
	const touched = [...new Set(receipts.flatMap(entry => Array.isArray(entry.receipt?.affectedIds) ? entry.receipt.affectedIds : []))].filter(id => shotIds.has(id));
	let geometry;
	const targets = touched.length ? touched : context?.shot?.id ? [context.shot.id] : shots[0] ? [shots[0].id] : [];
	if (!targets.length) geometry = { note: "no shot exists; geometry skipped" };
	else {
		try {
			const result = await command("verify_result", envelope("verify_result", { targets, checks: ["framing"] }));
			geometry = isObject(result?.geometry) ? { shotIds: targets, ...result.geometry }
				: { note: result?.ok === false ? `verify_result refused: ${result.code ?? result.error?.code ?? "error"}` : "the editor returned no geometry facts" };
		} catch (error) { geometry = { note: `geometry unavailable: ${error?.code ? `${error.code}: ` : ""}${redact(error?.message)}` }; }
	}
	// The editor renders at the size it is asked for, so an oversized capture is
	// re-requested at 1280 px wide rather than resized here.
	const capture = async (name, label) => {
		const named = typeof label === "string" ? label : name;
		try {
			let shot = await command(name, {});
			if (shot?.width > SUPERVISOR_LIMITS.imageWidth && shot?.height > 0) {
				const width = SUPERVISOR_LIMITS.imageWidth, height = Math.round(shot.height * width / shot.width);
				const smaller = await command(name, { output: { width, height } });
				if (smaller?.dataUrl?.startsWith("data:image/")) shot = smaller;
				else notes.push(`${named} kept at ${shot.width} px wide: the editor did not render a smaller copy`);
			}
			if (!shot?.dataUrl?.startsWith("data:image/")) { notes.push(`${named} unavailable: the editor returned no image`); return; }
			images.push({ label: typeof label === "function" ? label(shot) : label, dataUrl: shot.dataUrl, width: shot.width, height: shot.height });
		} catch (error) { notes.push(`${named} unavailable: ${redact(error?.message)}`); }
	};
	await capture("capture_framing_png", shot => `current shot frame (shot ${shot.shotId ?? "none"}, frame ${shot.frame ?? "?"})`);
	await capture("capture_plan_png", "top view (plan) with subject labels and the shot camera wedge");
	const created = touched.filter(id => !before.has(id)).map(id => shots.find(shot => shot.id === id)).filter(shot => Number.isSafeInteger(shot?.range?.startFrame)).slice(0, SUPERVISOR_LIMITS.createdShots);
	const original = context?.view?.frame;
	if (created.length && Number.isSafeInteger(original)) {
		const operate = async frame => {
			const receipt = await command("operate_studio", envelope("operate_studio", { frame }));
			if (Number.isSafeInteger(receipt?.revision?.after)) admission.revision = receipt.revision.after;
			if (receipt?.ok === false) throw Object.assign(new Error(receipt.message ?? "operate_studio refused"), { code: receipt.code });
		};
		try {
			for (const shot of created) {
				if (images.length >= SUPERVISOR_LIMITS.images) break;
				try { await operate(shot.range.startFrame); }
				catch (error) { notes.push(`shot ${shot.id} frame unavailable: ${redact(error?.message)}`); continue; }
				await capture("capture_framing_png", `created shot ${shot.name ?? shot.id} (${shot.id}) at its start frame ${shot.range.startFrame}`);
			}
		} finally {
			try { await operate(original); } catch (error) { notes.push(`playhead not restored to frame ${original}: ${redact(error?.message)}`); }
		}
	}
	return { geometry, images: images.slice(0, SUPERVISOR_LIMITS.images), notes, actions: { index, schemas }, ...(typeof context?.scene?.castStyle === "string" ? { castStyle: context.scene.castStyle } : {}) };
}

/**
 * Review one finished turn. Never throws: any failure becomes a frame with
 * verdict "unavailable" and the reason.
 */
export async function runSupervisor({ registry, modelKey, effort = "high", turnId, request, frames, reply, hub, workspaceHandle, admission, baseline, actions = [], previousExchange = null, now = () => Date.now(), timeoutMs = SUPERVISOR_LIMITS.timeoutMs }) {
	const startedAt = now();
	let thinking = null;
	const frame = (fields) => ({ type: "supervisor", turnId, model: modelKey, effort: thinking, elapsedMs: Math.max(0, Math.round(now() - startedAt)), ...fields });
	const unavailable = reason => frame({ verdict: "unavailable", summary: "", items: [], issues: [], fixes: [], droppedFixes: [], counts: { ...verdictCounts([]), fixes: 0 }, reason: redact(reason) });
	try {
		const { resolveModel, resolveEffort } = await import("./providers.mjs");
		const slash = modelKey.indexOf("/");
		const provider = slash === -1 ? "openai-codex" : modelKey.slice(0, slash);
		const model = registry.getModel(provider, slash === -1 ? modelKey : modelKey.slice(slash + 1)) ?? (await resolveModel(modelKey, { models: registry })).model;
		const level = await resolveEffort(model, effort);
		thinking = level;
		const turn = analyseTurnFrames(frames);
		const evidence = await gatherSupervisorEvidence({ hub, workspaceHandle, admission, baseline, receipts: turn.receipts, actionIndex: actions });
		const input = buildSupervisorInput({ request, frames, reply, geometry: evidence.geometry, refusals: turn.refusals, images: evidence.images, notes: evidence.notes, actions: evidence.actions, castStyle: evidence.castStyle, previousExchange });
		const message = await registry.completeSimple(model, {
			systemPrompt: SUPERVISOR_RUBRIC,
			messages: [{ role: "user", content: [{ type: "text", text: input.text }, ...input.images], timestamp: Date.now() }],
		}, { ...(level && level !== "off" ? { reasoning: level } : {}), signal: AbortSignal.timeout(timeoutMs) });
		if (message?.stopReason === "error" || message?.stopReason === "aborted") return unavailable(message.errorMessage || `the reviewer request ${message.stopReason === "aborted" ? "timed out" : "failed"}`);
		const text = (Array.isArray(message?.content) ? message.content : []).filter(part => part?.type === "text").map(part => part.text).join("");
		const verdict = parseSupervisorVerdict(text);
		if (!verdict) return unavailable("the reviewer did not answer with a valid verdict");
		const { issues, dropped } = validateFixes(verdict.issues, evidence.actions);
		const fixes = issues.flatMap((issue, issueIndex) => issue.fix ? [{ issueIndex, severity: issue.severity, action: issue.fix.action, args: issue.fix.args }] : []);
		return frame({ verdict: "reviewed", summary: verdict.summary, items: verdict.items, issues, fixes, droppedFixes: dropped, counts: { ...verdictCounts(issues), fixes: fixes.length } });
	} catch (error) {
		return unavailable(error?.message);
	}
}
