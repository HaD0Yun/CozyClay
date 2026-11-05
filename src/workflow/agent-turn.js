// A running agent turn as the panel shows it (AgentTurnSteps.jsx draws it): every tool call, the reasoning the
// model streamed between them and the call it is writing, as one compact step list per turn with plain labels,
// a one-line result each and the time each took; the turn's end state; and what the activity line says now.
// Pure data: the chat store (agent-client.js) feeds it the sidecar's frames, the component only adds a clock.
import { ko } from "../locale.js";
import { STUDIO_TOOL_LABELS } from "../studio-agent-protocol.js";

const LINE_MAX = 140;
const clip = (text, max = LINE_MAX) => { const line = String(text ?? "").replace(/\s+/g, " ").trim(); return line.length > max ? `${line.slice(0, max - 1)}…` : line; };

/** Words for an action id the turn's action index did not label: "motion.compile" -> "Motion compile". */
const actionWords = action => { const words = String(action).replace(/([a-z])([A-Z])/g, "$1 $2").split(/[._\s-]+/).filter(Boolean).join(" ").toLowerCase(); return words ? words[0].toUpperCase() + words.slice(1) : "Editor action"; };

/** The labels the editor gave its actions (the context's actionIndex), by id. */
export const actionLabelsOf = context => new Map((context?.actionIndex ?? []).filter(row => row?.id && row.label).map(row => [row.id, row.label]));

/** What a script's code calls, by name, each once in order: "Add shot, Frame the shot, Verify the result". */
function scriptCalls(code, actionLabels) {
	const names = [...String(code ?? "").matchAll(/tools\.(\w+)\(\s*\{?\s*(?:action\s*:\s*["'`]([\w.]+)["'`])?/g)]
		.map(([, tool, action]) => action ? actionLabels?.get(action) ?? actionWords(action) : STUDIO_TOOL_LABELS[tool] ?? actionWords(tool));
	const distinct = [...new Set(names)];
	return distinct.length > 3 ? `${distinct.slice(0, 3).join(", ")}…` : distinct.join(", ");
}

/** The fields a tool.start frame adds to its step: the action it runs and what it is about (a script: its title
 * comment, else what it calls). */
export function stepFields(name, args, actionLabels) {
	const action = name === "run_action" && typeof args?.action === "string" ? args.action : null;
	const inner = action ? args.args : args;
	const subject = name === "script" ? /^\s*\/\/\s*(.+)/.exec(String(args?.code ?? ""))?.[1] ?? scriptCalls(args?.code, actionLabels)
		: inner?.spec?.label ?? inner?.caption ?? inner?.label ?? (action ? null : inner?.visual && inner.visual !== "none" ? inner.visual.replace("_", " ") : null);
	return { ...(action ? { action, actionLabel: actionLabels?.get(action) ?? actionWords(action) } : {}), ...(subject ? { subject: clip(subject, 80) } : {}) };
}

/** A step's name: the action's label for run_action, the panel's label for a tool family, else the tool's words. */
export function stepLabel(step, toolLabels = {}) {
	if (step.kind === "compose" || step.kind === "tool") {
		if (step.actionLabel) return step.actionLabel;
		if (step.action) return actionWords(step.action);
		if (step.name === "script") return ko("Script", "스크립트");
		if (Object.hasOwn(toolLabels, step.name)) return toolLabels[step.name];
		return step.label || actionWords(step.name || "tool");
	}
	return "";
}

/** One line of what a verify_result measured: the framing size, motion verification, the image it looked at. */
function verifySummary(result, args) {
	const parts = [];
	// The turn's own review of its edits (bin/agent/studio-review.mjs): what failed, and that the model was shown the pictures.
	if (Array.isArray(result?.findings)) {
		const n = result.findings.length;
		parts.push(n ? `${ko(`${n} check${n === 1 ? "" : "s"} failed`, `검사 ${n}건 실패`, `${n} 项检查未通过`)}: ${result.findings[0]}` : ko("checks passed", "검사 통과", "检查通过"));
		if (result.images > 0) parts.push(ko("looked at the shot", "샷 화면 확인", "已查看镜头画面"));
	}
	const size = result?.checks?.framing?.derivedSize;
	if (size) parts.push(size);
	if (result?.geometry?.axisConsistent === false) parts.push(ko("cameras cross the line", "카메라가 축을 넘음"));
	if (result?.verification?.status) parts.push(result.verification.status === "verified" ? ko("motion checked", "모션 확인") : ko("motion unverified", "모션 미확인"));
	if (result?.visualStatus === "attached") parts.push(args?.visual === "contact_sheet" ? ko("looked at a contact sheet", "컨택트 시트 확인") : ko("looked at the frame", "화면 확인"));
	if (result?.stale) parts.push(ko("stale evidence", "이전 상태 기준"));
	return parts.join(" · ");
}

/** One line for a finished step: the receipt's own summary, what a check measured, a script's calls, or the error. */
export function stepResult(step) {
	if (step.kind !== "tool") return "";
	if (step.status === "failed") return clip(String(step.error ?? step.failure?.message ?? ko("Failed", "실패")).replace(/^Error:\s*/, ""));
	if (step.status === "cancelled") return step.result?.status === "not_applied" ? ko("not applied", "적용 안 됨") : ko("result unknown", "결과 불명");
	const result = step.result;
	if (!result || typeof result !== "object") return "";
	if (step.name === "script") {
		const calls = Array.isArray(result.calls) ? result.calls : [];
		const refused = calls.filter(call => call?.ok === false);
		const head = ko(`${calls.length} call${calls.length === 1 ? "" : "s"}`, `호출 ${calls.length}회`, `调用 ${calls.length} 次`);
		if (result.ok === false) return clip(`${head} · ${result.error?.message ?? ko("failed", "실패")}${result.rollback ? ko(" · its edits were rolled back", " · 편집 되돌림") : ""}`);
		return clip(refused.length ? `${head} · ${ko(`${refused.length} refused`, `${refused.length}회 거부`, `${refused.length} 次拒绝`)}: ${refused[0].code ?? refused[0].message ?? ""}` : head);
	}
	if (step.name === "verify_result") return clip(verifySummary(result, step.args));
	if (typeof result.summary === "string" && result.summary) return clip(result.summary.replace(/\.$/, ""));
	if (result.status === "started") return ko("started", "시작됨");
	return "";
}

/** What a script is running right now, from its last tool.progress frame: "Compile motion (call 4)". */
export function scriptNow(step) {
	const now = step.progress;
	if (!now) return "";
	const label = now.label ?? (now.action ? actionWords(now.action) : actionWords(now.name ?? "call"));
	return ko(`${label} (call ${now.index})`, `${label} (${now.index}번째 호출)`, `${label}（第 ${now.index} 次调用）`);
}

/** The reasoning text so far as one line: its latest paragraph, or the one before while the latest has only begun. */
export function thinkingLine(text) {
	const lines = String(text ?? "").split(/\n+/).map(line => line.replace(/^[#*\s-]+|\*+$/g, "").trim()).filter(Boolean);
	const last = lines.at(-1) ?? "";
	return clip(last.length < 24 && lines.length > 1 ? lines.at(-2) : last);
}

/** items after a thinking.delta frame: the open reasoning step grows, or a new one starts after other output. */
export function withThinking(items, text, now, newId) {
	const last = items.at(-1);
	if (last?.kind === "thinking") return [...items.slice(0, -1), { ...last, text: last.text + text, updatedAt: now }];
	return [...items, { kind: "thinking", id: newId(), text, startedAt: now, updatedAt: now }];
}

/** The reasoning step that just ended (the next call began): it keeps when, so its row shows how long it ran. */
const closeThinking = (items, now) => items.at(-1)?.kind === "thinking" && !items.at(-1).endedAt ? [...items.slice(0, -1), { ...items.at(-1), endedAt: now }] : items;

/** items after a tool.compose frame: the call being written (one per index) names what it has named so far. */
export function withCompose(list, frame, now, newId, actionLabels) {
	const items = closeThinking(list, now);
	const index = Number.isInteger(frame.index) ? frame.index : 0;
	const at = items.findLastIndex(item => item.kind === "compose" && item.index === index);
	const fields = { name: frame.name, ...(frame.action ? { action: frame.action, actionLabel: actionLabels?.get(frame.action) ?? actionWords(frame.action) } : {}), ...(frame.subject ? { subject: clip(frame.subject, 80) } : {}) };
	if (at !== -1 && items[at].name === frame.name) return items.map((item, i) => i === at ? { ...item, ...fields } : item);
	return [...items, { kind: "compose", id: newId(), index, startedAt: now, ...fields }];
}

/** items after a tool.start frame: the call takes the place of the compose step that wrote it. */
export function withToolStart(list, step) {
	const items = closeThinking(list, step.startedAt);
	const at = items.findIndex(item => item.kind === "compose" && item.name === step.name);
	return at === -1 ? [...items, step] : items.map((item, i) => i === at ? { ...step, subject: step.subject ?? item.subject } : item);
}

/** items at the end of a turn: compose steps that never ran go, a call still open ends with the turn (its result
 * unknown), and the turn's end state is recorded. */
export const withTurnEnd = (items, end, newId) => [...items.filter(item => item.kind !== "compose")
	.map(item => item.kind === "tool" && item.status === "running" ? { ...item, status: "cancelled" } : item), { kind: "turn-end", id: newId(), ...end }];

const STEP_KINDS = new Set(["tool", "thinking", "compose"]);

/**
 * The transcript as render entries: { type: "item", item } for every card, and per turn one
 * { type: "steps", id, steps, end, live, last } at the place of its first step, holding its tool calls, reasoning
 * and the calls being written, plus the assistant text written between steps (narration). The text after the
 * last step is the reply and stays a card. The turn's end state ({ status, durationMs }) rides on its block.
 */
export function turnLayout(items, { streaming = false } = {}) {
	const turns = [];
	for (const item of items) {
		if ((item.kind === "user" && !item.steered) || !turns.length) turns.push([]);
		turns.at(-1).push(item);
	}
	const entries = [];
	turns.forEach((turn, t) => {
		const lastStep = turn.findLastIndex(item => STEP_KINDS.has(item.kind));
		const end = turn.find(item => item.kind === "turn-end") ?? null;
		const last = t === turns.length - 1;
		let block = null;
		turn.forEach((item, i) => {
			if (item.kind === "turn-end") return;
			const step = STEP_KINDS.has(item.kind) || (item.kind === "assistant" && i < lastStep && block);
			if (!step) { entries.push({ type: "item", item }); return; }
			if (!block) { block = { type: "steps", id: `steps:${item.id}`, steps: [], end, live: last && streaming, last }; entries.push(block); }
			block.steps.push(item.kind === "assistant" ? { ...item, kind: "narration" } : item);
		});
	});
	return entries;
}

/** The header of a turn's step list: how many steps, how it ended and how long it took. */
export function stepsHeader(block, now, formatClock) {
	const count = block.steps.filter(step => step.kind === "tool").length;
	const steps = count ? ` · ${ko(`${count} step${count === 1 ? "" : "s"}`, `${count}단계`, `${count} 步`)}` : "";
	if (block.live) {
		const started = block.steps[0]?.startedAt;
		return { tone: "busy", text: `${ko("Working", "작업 중")}${steps}${Number.isFinite(started) ? ` · ${formatClock(now - started)}` : ""}` };
	}
	const end = block.end;
	const took = end && Number.isFinite(end.durationMs) ? ` · ${formatClock(end.durationMs)}` : "";
	if (end?.status === "stopped") return { tone: "warn", text: `${ko("Stopped", "중지됨")}${steps}${took}` };
	if (end?.status === "failed") return { tone: "alert", text: `${ko("Failed", "실패")}${steps}${took}` };
	return { tone: "ok", text: `${ko("Done", "완료")}${steps}${took}` };
}

/**
 * One line for a receipt the turn earned, naming what it changed instead of listing ids: names from the editor's
 * context (characters, objects, shots), the rest counted.
 */
export function changedLine(ids, context) {
	const names = new Map([...(context?.entityIndex ?? []), ...(context?.shots ?? [])].filter(row => row?.id && row.name).map(row => [row.id, row.name]));
	const named = [...new Set(ids.map(id => names.get(id)).filter(Boolean))];
	const rest = ids.filter(id => !names.has(id)).length;
	if (!named.length && !rest) return ko("Changed the scene", "장면을 바꿈");
	const shown = named.slice(0, 4).join(", "), more = Math.max(0, named.length - 4) + rest;
	return ko(`Changed ${shown || "the scene"}${more > 0 ? ` and ${more} more` : ""}`, `${shown || "장면"}${more > 0 ? ` 외 ${more}개` : ""} 변경`, `修改了 ${shown || "场景"}${more > 0 ? ` 以及另外 ${more} 项` : ""}`);
}

/** What a stopped turn left behind, as far as its steps tell: their edits stay (one undo entry), or none landed. */
export function stoppedNote(block) {
	const authored = block.steps.some(step => step.result?.authored === true || (step.result?.calls ?? []).some(call => call?.revision && call.revision.after !== call.revision.before));
	if (authored) return ko("Stopped by you. What already ran stays in the scene; Cmd+Z undoes this turn.", "직접 중지했어요. 이미 실행된 편집은 장면에 남아 있고, Cmd+Z로 이번 턴을 되돌릴 수 있어요.");
	if (block.steps.some(step => step.kind === "tool" && step.status === "cancelled")) return ko("Stopped by you while a step was running; its result is unknown.", "단계 실행 중에 직접 중지했어요. 그 단계의 결과는 알 수 없어요.");
	return ko("Stopped by you before anything changed in the scene.", "장면이 바뀌기 전에 직접 중지했어요.");
}
