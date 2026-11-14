// Say why a click or a key did nothing (#973). Chrome shows no title tooltip on a
// disabled button, so the reason a control already carries in `title` was never
// seen; a click on it now shows that reason in a short toast. Keys that need a
// selection (Delete, Ctrl/Cmd+D, F) say so once in a while. Plain DOM, so the
// capture-phase friction listeners can call it without a React round trip.
import { ko } from "./locale.js";

const SHOW_MS = 2200, SAME_HINT_GAP_MS = 4000, SELECTION_HINT_GAP_MS = 60_000;

const FALLBACK = {
	tool_pin: () => ko("Select a bone to pin first", "먼저 고정할 뼈를 선택하세요", "请先选择要固定的骨骼"),
	tool_ik: () => ko("Select a character first", "먼저 인물을 선택하세요", "请先选择角色"),
	mode_pose: () => ko("Select a character to pose first", "먼저 포즈를 잡을 인물을 선택하세요", "请先选择要摆姿势的角色"),
	agent_send: () => ko("Type a message first", "먼저 메시지를 입력하세요", "请先输入消息"),
};
const HOSTED_AGENT = () => ko("The agent connects in the local app: npx cozyclay", "에이전트는 로컬 앱에서 연결돼요: npx cozyclay", "智能体需在本地应用中连接：npx cozyclay");

let node = null, hideTimer = null, last = { text: "", at: -Infinity }, lastSelectionHintAt = -Infinity;
let now = () => performance.now(), mount = (text) => showToast(text);

/** The public cozyclay.org site, where no local agent server can run. */
function hostedSite() {
	const runtime = globalThis.__COZYCLAY_RUNTIME__;
	if (runtime?.distribution === "npm") return false;
	return /(^|\.)cozyclay\.org$/.test(globalThis.location?.hostname ?? "");
}

function showToast(text) {
	const doc = globalThis.document;
	if (!doc?.body) return;
	if (!node || !node.isConnected) {
		node = doc.createElement("div");
		node.className = "toast friction-hint";
		node.setAttribute("role", "status");
		node.style.bottom = "64px";
		doc.body.appendChild(node);
	}
	node.textContent = text;
	node.hidden = false;
	clearTimeout(hideTimer);
	hideTimer = setTimeout(() => { if (node) node.hidden = true; }, SHOW_MS);
}

function show(text) {
	if (!text) return;
	const at = now();
	if (text === last.text && at - last.at < SAME_HINT_GAP_MS) return;
	last = { text, at };
	mount(text);
}

/** The reason a disabled control gives: the hosted agent note, else its own title, else the per-control fallback. */
function disabledReason(element, control) {
	if (control === "agent_connect" && hostedSite()) return HOSTED_AGENT();
	// data-disabled-reason is sometimes a machine id (no-shots, export-running); only a sentence is shown.
	const reason = (element?.getAttribute?.("data-disabled-reason") || "").trim();
	const own = (/\s/.test(reason) ? reason : element?.getAttribute?.("title") || "").trim().slice(0, 140);
	return own || FALLBACK[control]?.() || null;
}

/** A click on a disabled control (click-friction.js). */
export function hintDisabledClick(element, control) {
	try { show(disabledReason(element, control)); } catch { /* a hint never affects a click */ }
}

/** Delete, Duplicate or Frame with nothing selected (shortcut-friction.js); at most once a minute. */
export function hintNoSelection() {
	try {
		const at = now();
		if (at - lastSelectionHintAt < SELECTION_HINT_GAP_MS) return;
		lastSelectionHintAt = at;
		show(ko("Select something first", "먼저 무언가를 선택하세요", "请先选择对象"));
	} catch { /* advisory */ }
}

/** Tests only: capture shown hints and drive the clock; returns the restore. */
export function frictionHintSeam({ capture, clock }) {
	const previous = [mount, now];
	mount = capture; now = clock;
	last = { text: "", at: -Infinity }; lastSelectionHintAt = -Infinity;
	return () => { [mount, now] = previous; last = { text: "", at: -Infinity }; lastSelectionHintAt = -Infinity; };
}
