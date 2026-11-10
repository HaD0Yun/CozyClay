#!/usr/bin/env node
// Source/layout contract for the workflow Agent panel (#126). The panel's
// behaviour is proved in the browser by test/qa-agent-panel-browser.mjs; this
// suite pins the things a refactor can silently break without any test going
// red: where the panel is mounted, the width contract, the no-token rule, and
// the presence of every state the issue enumerates.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const panel = readFileSync(new URL("../src/workflow/AgentPanel.jsx", import.meta.url), "utf8");
// Connect a model is pi's own login (#pi-login): the list and the flow live in LoginPanel.jsx and login-client.js.
const login = readFileSync(new URL("../src/workflow/LoginPanel.jsx", import.meta.url), "utf8");
const loginClient = readFileSync(new URL("../src/workflow/login-client.js", import.meta.url), "utf8");
const client = readFileSync(new URL("../src/workflow/agent-client.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/workflow/agent-panel.css", import.meta.url), "utf8");
const builder = readFileSync(new URL("../src/workflow/WorkflowBuilder.jsx", import.meta.url), "utf8");
const studio = ["../src/App.jsx", "../src/shell/DetailsSlot.jsx", "../src/shell/ViewportToolbar.jsx", "../src/shell/TopBar.jsx"].map(path => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
const studioCss = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const { STUDIO_TOOLS, validateReceipt } = await import("../src/studio-agent-protocol.js");
const { createAgentChatStore } = await import("../src/workflow/agent-client.js");

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

// --- mount point --------------------------------------------------------
expect("WorkflowBuilder imports AgentPanel", builder.includes('import AgentPanel from "./AgentPanel.jsx"'));
expect("AgentPanel renders as a sibling AFTER .workflow-canvas", (() => {
	const canvasClose = builder.indexOf("</section>");
	const mount = builder.indexOf("<AgentPanel");
	// The canvas section may carry refs/handlers (paste, drop); only its class matters here.
	const canvasOpen = builder.search(/<section className="workflow-canvas"[^>]*>/);
	return canvasOpen !== -1 && canvasClose !== -1 && mount > canvasClose;
})(), "AgentPanel must follow the closing </section> of .workflow-canvas");
expect("the panel lives inside .workflow-main", (() => {
	const mainOpen = builder.indexOf('<div className="workflow-main">');
	const mount = builder.indexOf("<AgentPanel");
	return mainOpen !== -1 && mount > mainOpen;
})());
expect("the top bar carries a panel toggle", builder.includes("workflow-agent-toggle") && builder.includes("cozyclay:agent-panel-toggle"));
expect("AgentPanel imports its own stylesheet", panel.includes('import "./agent-panel.css"'));

// --- Studio mount -------------------------------------------------------
// The studio has no room for another top bar button (IA rule R4): the panel is
// shown from the View ▾ menu, exactly like every other "what is on screen"
// toggle, and it boots collapsed so the studio still opens on the stage.
expect("Studio imports the shared AgentPanel", studio.includes('import AgentPanel from "./workflow/AgentPanel.jsx"'));
expect("Studio mounts AgentPanel beside the authoring workspace", studio.includes("<AgentPanel") && studio.includes("sceneName={scenes.find((entry) => entry.id === activeSceneId)?.name"));
expect("Studio boots the panel collapsed and mirrors the flag", studio.includes("defaultCollapsed") && studio.includes("onCollapsedChange={setAgentCollapsed}") && studio.includes("useState(true)"));
expect("AgentPanel accepts the host's default/notify pair", panel.includes("defaultCollapsed = false") && panel.includes("onCollapsedChange?.(collapsed)") && panel.includes("useState(defaultCollapsed)"));
expect("Studio adds NO agent button to the top bar", !studio.includes("agent-topbar-toggle") && !/topbar-action[^"]*agent/i.test(studio));
expect("the View menu owns the panel toggle", (() => {
	const menu = studio.indexOf('<div className="view-menu-wrap">');
	const item = studio.indexOf('"view-menu-item agent-panel-toggle"');
	return menu !== -1 && item > menu && studio.includes('cozyclay:agent-panel-toggle');
})(), "the toggle must sit inside the View ▾ menu");
expect("the item is a checkbox that reflects the panel state", /role="menuitemcheckbox"\s*\n\s*className=\{"view-menu-item agent-panel-toggle"[^]*?aria-checked=\{!agentCollapsed\}[^]*?aria-pressed=\{!agentCollapsed\}/.test(studio));
expect("the item is labelled Agent panel in both locales", studio.includes('ko("Agent panel", "에이전트 패널")'));
expect("Studio tokens share the panel host scope", /\.workflow-app,\s*\.app\s*\{/.test(css));
expect("the studio shows no collapsed rail — the mode budget stays as it was", /\.app \.agent-panel\.collapsed\s*\{[^}]*display:\s*none/.test(css));
expect("the overlay drawer hangs from a host-sized token", /--agent-drawer-top:\s*58px/.test(css) && /\.app\s*\{\s*--agent-drawer-top:\s*48px;?\s*\}/.test(css) && !/[^-]top:\s*58px/.test(css));
expect("embedded Studio hides the authoring panel", studioCss.includes('.app[data-embed-mode="playview"] .agent-panel'));

// --- width contract -----------------------------------------------------
expect("css defines the default width token as 360px", /--agent-width-default:\s*360px/.test(css));
expect("css defines the min width token as 300px", /--agent-width-min:\s*300px/.test(css));
expect("css defines the max width token as 560px", /--agent-width-max:\s*560px/.test(css));
expect("css defines the collapsed rail token as 36px", /--agent-rail-width:\s*36px/.test(css));
expect("the collapsed rail uses the rail token", /\.agent-panel\.collapsed\s*\{[^}]*width:\s*var\(--agent-rail-width\)/.test(css));
expect("below 1100px the panel becomes an overlay drawer", /@media \(max-width:\s*1100px\)/.test(css) && /position:\s*fixed/.test(css));
expect("the panel has a left drag handle", css.includes(".agent-resize") && /\.agent-resize\s*\{[^}]*left:/.test(css) && panel.includes("agent-resize"));
expect("width persists under the agreed localStorage key", client.includes('"cozyclay.workflow.agentPanel.width"'));
expect("stored width is clamped to the min/max contract", client.includes("AGENT_PANEL_WIDTH_MIN") && client.includes("AGENT_PANEL_WIDTH_MAX") && client.includes("clampPanelWidth"));

// --- no token ever reaches the browser ----------------------------------
for (const [name, source] of [["agent-client.js", client], ["AgentPanel.jsx", panel]]) {
	expect(`${name} never handles access_token`, !/access_token/i.test(source));
	expect(`${name} never handles refresh_token`, !/refresh_token/i.test(source));
	expect(`${name} never sets an Authorization header`, !/authorization/i.test(source));
}
expect("the client only reads a session description over loopback", ["/oauth/status", "/oauth/start", "/oauth/logout", "/agent/turn", "/agent/stop", "/agent/models"].every((route) => client.includes(route)));
// Without a sidecar the dev server must answer EVERY agent route the panel
// calls with its 503, including the Studio replay and acceptance routes. The
// SPA fallback would hand back index.html, which the panel cannot parse.
expect("the dev 503 gate covers every route the panel calls", (() => {
	const vite = readFileSync(new URL("../vite.config.js", import.meta.url), "utf8");
	const source = vite.match(/agentUrl && (\/\^\\\/agent[^\n]*?)\.test\(path\)/)?.[1];
	if (!source) return false;
	const gate = new RegExp(source.slice(1, source.lastIndexOf("/")));
	return ["/agent/turn", "/agent/stop", "/agent/models", "/agent/providers", "/agent/providers/openai", "/agent/turn/8b1f/events", "/agent/turn/8b1f/steer", "/agent/jobs/job-1/accept"].every((route) => gate.test(route))
		&& !["/agent/image", "/agent/providers/openai/extra", "/agent/turn/8b1f/events/extra", "/agent/turn/8b1f/steer/extra"].some((route) => gate.test(route));
})());

// --- every state name exists --------------------------------------------
for (const state of ["signed-out", "signing-in", "no-entitlement", "ready", "streaming", "rate-limited", "error"]) {
	expect(`state "${state}" exists in the client`, client.includes(`"${state}"`));
	const rendered = panel.includes(`"${state}"`) || panel.includes(`'${state}'`);
	expect(`state "${state}" is reachable from the panel`, rendered);
}

// --- SSE event types -----------------------------------------------------
for (const type of ["text.delta", "tool.start", "tool.done", "thinking.delta", "tool.compose", "tool.progress", "image", "quota", "error", "done"]) {
	expect(`the panel or client handles the "${type}" event`, client.includes(`"${type}"`) || panel.includes(`"${type}"`));
}
// The turn now lives in the shared chat store, so cancellation identity is
// asserted where it is implemented.
expect("explicit Stop identifies user cancellation before aborting SSE", client.includes('controller?.abort("agent-stop")'));
expect("a Studio Stop names the turn and the running job", /surface: "studio", sessionId: target\.sessionId, turnId: target\.turnId, \.\.\.\(target\.jobId/.test(client));
for (const code of ["auth", "entitlement", "rate_limit", "upstream"]) {
	expect(`error code "${code}" has copy`, client.includes(code));
}

// --- required controls ---------------------------------------------------
const controls = [
	["header title", 'className="agent-title"'],
	["New session button", "agent-new"],
	["History placeholder", "agent-history"],
	["overflow menu", "agent-overflow-toggle"],
	["Clear context action", "Clear context"],
	["Connect a model action", "Connect a model…"],
	["login list", "<LoginPanel"],
	["Sign out action", "Sign out"],
	["collapse control", "agent-collapse"],
	["account strip", "agent-account"],
	["plan badge", "agent-plan-badge"],
	["resets-in label", "resets in "],
	["aria-live transcript", 'aria-live="polite"'],
	["user bubble", "agent-bubble"],
	["turn step list", "<TurnSteps"],
	["image result card", "ImageResultCard"],
	["Use in scene", "Use in scene"],
	["Download", "Download"],
	["Regenerate", "Regenerate"],
	["Placed / Undo", "Placed"],
	["lightbox", "agent-lightbox"],
	["attach frame chip", "Attach current frame"],
	["model select", "agent-model-select"],
	["stop control", "agent-stop"],
	["suggestion chips", "presentation.suggestions"],
	["paused card", "PausedCard"],
	["Wait & retry", "<PausedCard resetAt"],
	["Switch model", "onSwitchModel={switchModel}"],
	["error Retry", ">Retry<"],
	["step list Retry", "onRetry={() => runTurn(chat.lastPrompt, \"retry_button\")} />"],
];
for (const [name, needle] of controls) expect(`composer/transcript exposes the ${name}`, panel.includes(needle), needle);

expect("Enter sends and Shift+Enter inserts a newline", panel.includes('event.key === "Enter" && !isImeComposing(event) && !event.shiftKey'));
expect("a composing Enter never sends or steers", panel.includes("isImeComposing(event)"));
expect("Esc stops a running turn", panel.includes('event.key === "Escape" && streaming'));
expect("Cmd/Ctrl+B toggles the panel", panel.includes("event.metaKey || event.ctrlKey") && panel.includes('=== "b"'));
expect("focus moves to the composer on open", panel.includes("composerRef.current?.focus()"));
expect("the footer hint states the image cost", client.includes("Image generation uses about 3-5x a normal turn") && panel.includes("presentation.imageHint"));
expect("there is no hover-reveal for the collapsed rail", !/\.agent-panel\.collapsed:hover\s*\{[^}]*width/.test(css));
// (the chip count is asserted from the imported module below)

// --- embedded host mode (#292) -------------------------------------------
// The dock keeps every default; an embedded host takes over the chrome the
// studio sidebar already owns.
expect("the panel takes an embedded host mode and a hidden flag", panel.includes("embedded = false") && panel.includes("hidden = false"));
expect("the dock still owns its own width", panel.includes("style={embedded ? undefined : { width: `${width}px` }}"));
expect("an embedded host owns the width", /\.agent-panel\.embedded\s*\{[^}]*width:\s*100%/.test(css));
expect("an embedded panel never escapes its host as a drawer", /\.agent-panel:not\(\.collapsed\):not\(\.embedded\)\s*\{[^}]*position:\s*fixed/.test(css) && /\.agent-panel\.collapsed:not\(\.embedded\)\s*\{[^}]*position:\s*fixed/.test(css));
expect("the resize handle is dock-only", panel.includes("{!embedded && <div") && panel.includes('className="agent-resize"'));
expect("the collapse control is dock-only", panel.includes('{!embedded && <button type="button" className="agent-icon-button agent-collapse"'));
expect("the collapsed rail is dock-only", panel.includes("if (collapsed && !embedded)"));
expect("the global shortcut and toggle event are dock-only", (panel.match(/if \(embedded\) return;/g) || []).length >= 3);
expect("a hidden embedded panel keeps its chat mounted", panel.includes("hidden={embedded && hidden}") && !panel.includes("if (hidden) return null"));
expect("a hidden panel is removed from layout and focus order", /\.agent-panel\[hidden\]\s*\{[^}]*display:\s*none/.test(css));
expect("focus never moves into a hidden panel", /if \(hidden\) \{[\s\S]{0,320}composerRef\.current\.blur\(\);[\s\S]{0,40}return;\s*\}\s*\n\s*if \(!\(embedded \|\| !collapsed\)\) return;\s*composerRef\.current\?\.focus\(\)/.test(panel));
expect("the host is told about dock collapse only", panel.includes("if (embedded) return;\n\t\tonCollapsedChange?.(collapsed);"));

// --- one panel, two presentations (#350) ----------------------------------
// The Studio mount is the SAME component: only the chrome around the shared
// conversation differs, and the surface it was given decides it — never the
// address bar.
expect("the panel hands its surface to the transport", panel.includes("createAgentTransport({ surface })"));
expect("the transport prefers the host's surface over the URL", client.includes("createMockTransport({ surface: options.surface, ...config })")
	&& /\["studio", "workflow"\]\.includes\(surface\) \? surface/.test(client));
expect("the panel reads its chrome from one presentation", panel.includes("panelPresentation(surface)")
	&& panel.includes("presentation.toolLabels") && panel.includes("presentation.history") && panel.includes("presentation.persistWidth"));
expect("the Workflow-only constants no longer reach the shared render", !panel.includes("IMAGE_COST_HINT") && !panel.includes("SUGGESTION_CHIPS") && !panel.includes("CANVAS_TOOL_LABELS"));
expect("a receipt reaches the host that can show it on the element", panel.includes("onReceipt") && client.includes("onReceipt?.(receipt)"));
expect("the Studio mount asks for the Inspector-row receipt callback", studio.includes("onReceipt={highlightAgentTargets}"));
expect("the Studio mount no longer owns an image action", !studio.includes("onImageAction") && !studio.includes('"cozyclay:agent-image"'));
expect("a touched hierarchy row is a Studio style, not panel chrome", /\.hierarchy-row\.agent-touched/.test(studioCss) && !/agent-touched/.test(css));

// --- Studio session, jobs and receipts ------------------------------------
expect("Studio identities are UUIDs", client.includes("export function createStudioSessionId") && client.includes("randomUUID"));
expect("the Studio turn body is the frozen envelope", /surface: "studio", sessionId, turnId, text, context: turnRequest\.context/.test(client));
expect("the legacy Workflow body and its turn_id telemetry are unchanged", client.includes('JSON.stringify({ sessionId, text, attachFrame, model, ...(effort ? { effort } : {}), ...attached, ...(telemetry.turnId ? { turn_id: telemetry.turnId } : {}) })'));
expect("a dropped Studio stream resumes from an event cursor", client.includes("/agent/turn/${encodeURIComponent(turnId)}/events?after=${cursor}") && client.includes("if (event.eventSeq <= cursor) return;"));
expect("Clear context and New share one session reset", panel.includes("store.clearContext()") && client.includes("clearContext: resetSession") && client.includes("newSession: resetSession"));
expect("the panel renders job progress", panel.includes("function JobCard") && panel.includes("agent-job-card") && panel.includes("agent-job-stop"));
expect("progress is shown only when the runtime reported one", client.includes("export const formatJobProgress") && panel.includes('aria-valuenow={percent}'));
expect("an unverified candidate needs an explicit acceptance", panel.includes("agent-job-accept") && panel.includes("Apply with warnings") && client.includes("explicitUnverifiedAcceptance: true"));
expect("an unverified installation keeps its label", panel.includes('<span className="agent-job-badge">Unverified</span>'));
expect("receipts and structured failures have their own cards", panel.includes("function ReceiptCard") && panel.includes("function FailureCard") && panel.includes("RECOVERY_COPY"));
const restoredStore = createAgentChatStore({ transport: {}, newId: (() => { let id = 0; return () => `restored-${++id}`; })() });
restoredStore.restore([{ kind: "user", text: "hello" }, { kind: "failure", code: "upstream", message: "Provider unavailable." }], "restored-session");
expect("restored turn errors become existing failure items", restoredStore.getState().items.some((item) => item.kind === "failure" && item.failure.code === "upstream" && item.failure.message === "Provider unavailable."));
const receiptIdsForRestore = [{ kind: "receipt", receiptId: "R1" }, { kind: "receipt", receiptId: "R1" }];
const receiptStore = createAgentChatStore({ transport: {}, newId: (() => { let id = 0; return () => `receipt-test-${++id}`; })() });
const restoredReceipts = receiptStore.restore(receiptIdsForRestore, "receipt-session");
expect("restoring duplicate receipts keeps one row with a unique id", restoredReceipts.filter((item) => item.kind === "receipt" && item.receiptId === "R1").length === 1 && new Set(restoredReceipts.map((item) => item.id)).size === restoredReceipts.length, JSON.stringify(restoredReceipts));
expect("restored errors render through the existing FailureCard", /item\.kind === "failure"\) return <div className="agent-row"[^]*?<FailureCard failure=\{item\.failure\}/.test(panel));
expect("receipts are validated before they are rendered as success", client.includes("validateReceipt") && client.includes('kind: "failure", id: newId()'));
expect("image actions are acknowledged by the host, never assumed", client.includes("export function requestHostImageAction") && client.includes("cozyclay:agent-image-result") && panel.includes("store.applyImage(image.id)"));
expect("an unclaimed image action fails instead of claiming a placement", client.includes("No editor accepted the image."));
expect("one acknowledgement settles one action", client.includes("if (!requestId || settledActions.has(requestId)) return;"));
// --- pasted and dropped pictures (#367) -----------------------------------
// The studio's document paste handler steps aside for a textarea so text still
// lands in the caret; the composer therefore has to take the picture itself.
expect("the composer intercepts a paste", panel.includes("onPaste={composerDisabled ? undefined : onComposerPaste}") && panel.includes("const onComposerPaste = useCallback"));
expect("only a clipboard carrying a picture is intercepted", /const takeTransfer = useCallback\(\(transfer\) => \{[\s\S]{0,400}if \(!images\.length\) \{[\s\S]{0,260}return unsupported > 0;/.test(panel)
	&& panel.includes("if (takeTransfer(event.clipboardData)) event.preventDefault();"), "a text paste must reach the caret untouched");
expect("the composer accepts a dropped picture too", panel.includes("onDrop={onComposerDrop}") && panel.includes("onDragOver={onComposerDragOver}")
	&& panel.includes("onDrop={composerDisabled ? undefined : onComposerDrop}"));
expect("the detection rules are the shared, tested ones", panel.includes('from "./attachment-image.js"') && panel.includes("attachmentFilesFromTransfer") && panel.includes("attachmentFromFile"));
expect("pending pictures are thumbnails above the composer, each with a remove control", panel.includes('<ul className="agent-attachments"')
	&& panel.includes('className="agent-attachment-remove"') && panel.includes("store.removeAttachment(attachment.id)"));
expect("a paste the composer claimed is not also dropped on the canvas", /const onPaste = \(event\) => \{[\s\S]{0,240}if \(event\.defaultPrevented\) return;/.test(builder), "the builder's window paste listener must stand down for a handled paste");
expect("a refused picture says why instead of vanishing", panel.includes("agent-attachment-notice") && client.includes("ATTACHMENT_MAX_COUNT"));
expect("the sent bubble keeps the pictures it was sent with", panel.includes("agent-bubble-attachments") && client.includes('kind: "user", id: newId(), text: trimmed, attachFrame: Boolean(options.attachFrame), attachments'));
expect("sending empties the composer's pictures with its draft", /set\(\{[\s\S]{0,200}draft: "",\n\t\t\t\tpendingAttachments: \[\],/.test(client));
expect("the attachment strip is token-driven", /\.agent-attachment\s*\{[^}]*width: var\(--agent-thumb\)/.test(css) && /\.agent-attachments\s*\{[^}]*gap: var\(--agent-space-2\)/.test(css));
{
	const attachments = await import("../src/workflow/attachment-image.js");
	expect("the composer states the limit it enforces", attachments.ATTACHMENT_LIMIT_NOTICE === "Up to 4 images per message" && attachments.ATTACHMENT_MAX_COUNT === 4);
}

expect("auth refresh is event-driven on return from sign-in", panel.includes('window.addEventListener("focus", onReturn)') && panel.includes('document.addEventListener("visibilitychange", onReturn)') && !/setTimeout/.test(panel));
expect("the chat state has one owner, not a second emitter", panel.includes("useSyncExternalStore(store.subscribe") && !panel.includes("setItems("));

// new surfaces stay on the token system
for (const [name, rule] of [
	["job card", /\.agent-job-card,[\s\S]*?padding: var\(--agent-space-3\) var\(--agent-space-4\)/],
	["progress track", /\.agent-job-bar\s*\{[^}]*background: var\(--agent-track\)/],
	["progress fill", /\.agent-job-bar-fill\s*\{[^}]*background: var\(--agent-accent\)/],
	["acceptance action", /\.agent-job-accept\s*\{[^}]*background: var\(--agent-warn-bg\)/],
]) expect(`the ${name} is token-driven`, rule.test(css));
expect("progress animates on the compositor only", /\.agent-job-bar-fill\s*\{[^}]*transition: transform var\(--agent-motion\)/.test(css));

// --- mock transport ------------------------------------------------------
expect("mock mode is gated on ?agent=mock", client.includes('params.get("agent") !== "mock"'));
expect("mock mode reads ?state=", client.includes('params.get("state")'));
expect("the scripted turn captures then renders", client.includes("capture_blocking_frame") && client.includes("render_from_frame"));
expect("the scripted turn emits an image and a done event", client.includes('type: "image"') && client.includes('type: "done"'));

// --- behaviour of the pure helpers --------------------------------------
const module_ = await import("../src/workflow/agent-client.js");
const rejectedTransport = module_.createHttpTransport({ fetchImpl: async () => ({
	ok: false,
	status: 422,
	clone: () => ({ json: async () => ({ error: "H3 preservation failed", preservation: { pass: false, worst: { p95Rgb: 44 } } }) }),
}) });
await assert.rejects(() => rejectedTransport.video({}), (error) => error.status === 422 && error.preservation?.worst?.p95Rgb === 44);
expect("video transport keeps H3 rejection evidence for the node", true);
expect("clampPanelWidth pins the floor", module_.clampPanelWidth(120) === 300);
expect("clampPanelWidth pins the ceiling", module_.clampPanelWidth(9000) === 560);
expect("clampPanelWidth keeps a legal width", module_.clampPanelWidth(412) === 412);
expect("clampPanelWidth falls back to the default", module_.clampPanelWidth("nonsense") === 360);
expect("formatResetIn renders minutes", module_.formatResetIn(1000 + 42 * 60000, 1000) === "42m 00s");
expect("formatResetIn renders hours", module_.formatResetIn(1000 + 95 * 60000, 1000) === "1h 35m");
expect("formatResetIn tolerates a missing reset", module_.formatResetIn(null) === null);
expect("formatResetIn parses an ISO reset", module_.formatResetIn(new Date(60000).toISOString(), 0) === "1m 00s");
expect("toolCallLabel reads as verb + target", module_.toolCallLabel({ name: "capture_blocking_frame" }) === "Capture blocking frame");
expect("toolCallLabel prefers an explicit label", module_.toolCallLabel({ name: "x", label: "Render from frame" }) === "Render from frame");
expect("formatElapsed switches to seconds", module_.formatElapsed(1412) === "1.4s" && module_.formatElapsed(268) === "268ms");
expect("parseSseChunk keeps a partial trailing frame", (() => {
	const parsed = module_.parseSseChunk('data: {"type":"text.delta","text":"hi"}\ndata: {"type":"do');
	return parsed.events.length === 1 && parsed.events[0].text === "hi" && parsed.tail === 'data: {"type":"do';
})());
expect("the empty ready state offers exactly three suggestion chips", module_.SUGGESTION_CHIPS.length === 3 && module_.SUGGESTION_CHIPS.every((chip) => typeof chip === "string" && chip.length > 8));
{
	const { studio: studioPresentation, workflow } = module_.PANEL_PRESENTATIONS;
	expect("an unknown surface falls back to the dock's presentation", module_.panelPresentation("nonsense") === workflow && module_.panelPresentation("studio") === studioPresentation);
	expect("the Studio panel drops every Workflow-only affordance", studioPresentation.imageHint === null && studioPresentation.imageEntitlement === false
		&& studioPresentation.history === true && studioPresentation.persistWidth === false);
	expect("the dock keeps them", workflow.imageHint === module_.IMAGE_COST_HINT && workflow.imageEntitlement === true && workflow.history === true && workflow.persistWidth === true);
	expect("steering belongs to the Workflow turn alone", workflow.steer === true && studioPresentation.steer === false);
	expect("Studio History is enabled and backed by the session key", panel.includes("agent-history-popover") && panel.includes("STUDIO_SESSION_STORAGE_KEY") && client.includes('"cozyclay.agent.session.studio"'));
	expect("Studio restore has a visible fallback notice", panel.includes("Previous conversation could not be restored") && panel.includes("store.restore"));
	expect("the Studio offers three previs chips of its own", studioPresentation.suggestions.length === 3
		&& studioPresentation.suggestions.every((chip) => typeof chip === "string" && chip.length > 8)
		&& studioPresentation.suggestions.every((chip) => !module_.SUGGESTION_CHIPS.includes(chip)));
	expect("every Studio tool and alias reads as an action", STUDIO_TOOLS.every((family) => typeof studioPresentation.toolLabels[family] === "string" && studioPresentation.toolLabels[family].length > 3),
		JSON.stringify(Object.keys(studioPresentation.toolLabels)));
	expect("no Studio tool reads as a function name", STUDIO_TOOLS.every((family) => !studioPresentation.toolLabels[family].includes("_")));
	expect("the families a mechanical label would mangle are named properly", ["inspect_studio", "operate_studio", "patch_elements", "verify_result", "undo_edit", "frame_shot"]
		.every((family) => module_.resolveToolLabel({ name: family }, studioPresentation.toolLabels) !== module_.toolCallLabel({ name: family })));
	expect("the label map is the panel's, not the server's", module_.resolveToolLabel({ name: "arrange_objects", label: "arrange objects" }, studioPresentation.toolLabels) === studioPresentation.toolLabels.arrange_objects);
	expect("an unmapped tool still reads as verb + target", module_.resolveToolLabel({ name: "future_tool" }, studioPresentation.toolLabels) === "Future tool");
}
expect("mockConfigFromSearch stays off without ?agent=mock", module_.mockConfigFromSearch("?state=ready") === null);
expect("mockConfigFromSearch rejects an unknown state", module_.mockConfigFromSearch("?agent=mock&state=bogus").state === "ready");
expect("mockConfigFromSearch carries every listed state", module_.AGENT_STATES.every((state) => module_.mockConfigFromSearch(`?agent=mock&state=${state}`).state === state));

const mock = module_.createMockTransport({ state: "ready", speed: 60 });
const status = await mock.status();
expect("the mock signs in for the ready state", status.signedIn === true && typeof status.email === "string");
expect("the signed-out mock reports no session", (await module_.createMockTransport({ state: "signed-out" }).status()).signedIn === false);
expect("the no-entitlement mock withholds image entitlement", (await module_.createMockTransport({ state: "no-entitlement" }).status()).entitlements.image === false);

const seen = [];
await mock.turn({ sessionId: "s", text: "hi", attachFrame: false }, (event) => seen.push(event));
const types = seen.map((event) => event.type);
expect("the scripted turn streams text first", types[0] === "text.delta");
expect("the scripted turn runs capture then render", (() => {
	const starts = seen.filter((event) => event.type === "tool.start").map((event) => event.name);
	return starts[0] === "capture_blocking_frame" && starts[1] === "render_from_frame";
})(), types.join(","));
expect("every tool.start is answered by a tool.done", seen.filter((event) => event.type === "tool.start").length === seen.filter((event) => event.type === "tool.done").length);
expect("the scripted turn ends with an image, a quota and done", types.includes("image") && types.includes("quota") && types.at(-1) === "done");

// The Studio mock is the Studio turn: scene families, no image, and a receipt
// the panel validates before it renders anything as a success.
const studioMock = [];
await module_.createMockTransport({ state: "ready", speed: 60, surface: "studio" }).turn({}, (event) => studioMock.push(event));
const studioStarts = studioMock.filter((event) => event.type === "tool.start");
expect("the Studio mock runs Studio families only", studioStarts.length > 0 && studioStarts.every((event) => STUDIO_TOOLS.includes(event.name)), studioStarts.map((event) => event.name).join(","));
expect("every Studio mock tool.start carries label and args", studioStarts.every((event) => typeof event.label === "string" && event.args));
expect("every Studio mock tool.done states its elapsed time", studioMock.filter((event) => event.type === "tool.done").every((event) => Number.isFinite(event.elapsedMs)));
expect("the Studio mock never generates an image", !studioMock.some((event) => event.type === "image"));
const mockReceipt = studioMock.find((event) => event.type === "receipt")?.receipt;
expect("the Studio mock ends in a valid receipt that names what it touched", (() => {
	try { return module_.receiptSummary(validateReceipt(mockReceipt)).length > 0 && mockReceipt.affectedIds.length > 0; } catch { return false; }
})(), JSON.stringify(mockReceipt?.affectedIds));
const receiptStoreForReplay = createAgentChatStore({
	transport: { async turn(_request, onEvent) { onEvent({ type: "receipt", receipt: { ...mockReceipt, receiptId: "R1" } }); } },
	newId: (() => { let id = 0; return () => `receipt-replay-${++id}`; })(),
});
receiptStoreForReplay.restore([{ kind: "receipt", receiptId: "R1" }], "receipt-replay-session");
await receiptStoreForReplay.send("replay receipt");
expect("a live receipt replayed after restore adds no row", receiptStoreForReplay.getState().items.filter((item) => item.kind === "receipt" && item.receiptId === "R1").length === 1, JSON.stringify(receiptStoreForReplay.getState().items));

const limited = [];
await module_.createMockTransport({ state: "rate-limited" }).turn({}, (event) => limited.push(event));
expect("the rate-limited mock emits a rate_limit error with a reset", limited.some((event) => event.type === "error" && event.code === "rate_limit" && event.resetAt));
const failed = [];
await module_.createMockTransport({ state: "error" }).turn({}, (event) => failed.push(event));
expect("the error mock fails a tool call", failed.some((event) => event.type === "tool.done" && event.ok === false));

// --- provider keys (#379) -------------------------------------------------
// The overflow menu opens an INLINE section that states which providers have a
// key and where it came from. A key is typed into a password field, handed to
// the sidecar once and dropped: no store, no transcript, no DOM node keeps it.
expect("the overflow menu offers Connect a model…", panel.includes('className="agent-menu-keys"') && panel.includes("Connect a model…"));
expect("Connect a model is an inline section, never a modal", login.includes('<section className="agent-keys agent-login"') && !/role="dialog"/.test(login));
expect("it opens from the menu and the signed-out card, and closes in place", panel.includes("toggleProviderKeys") && panel.includes("openProviderKeys") && login.includes("agent-keys-close"));
expect("it lists pi's login methods: connected, subscriptions, api keys", login.includes("fetchLogins") && ["Connected", "Subscriptions", "API keys"].every((title) => login.includes(`["${title}"`)));
expect("a login runs pi's flow in the sidecar: start, read prompts and events, answer, cancel", ["startLogin", "readLogin", "answerLogin", "cancelLogin"].every((name) => login.includes(`${name}(`))
	&& loginClient.includes('"/agent/logins"') && loginClient.includes("/answer"));
expect("a secret pi asks for is a password field, and nothing typed is kept", login.includes('type={ask.type === "secret" ? "password" : "text"}') && login.includes('onSubmit(value); setValue("")'));
expect("ChatGPT keeps CozyClay's own sign-in", login.includes('method.type === "chatgpt"') && panel.includes("onChatGPT={signIn}"));
expect("a sign-in page and a device code are shown as pi sends them", login.includes('event.type === "auth_url"') && login.includes('event.type === "device_code"') && login.includes("Open the sign-in page"));
expect("a connected provider can log out through pi", login.includes("logoutProvider(provider.id)") && loginClient.includes("/agent/logout/"));
expect("a finished login re-reads the session AND the models", /const refreshProviderState = useCallback\(async \(\) => \{[\s\S]{0,120}await readAccount\(\);[\s\S]{0,200}transport\.models\(\)/.test(panel)
	&& panel.includes("onChanged={refreshProviderState}") && /entry\.type === "done" && entry\.ok\) \{ await onChanged\?\.\(\)/.test(login));
expect("the transport owns the three provider routes", client.includes("async providers()") && client.includes("async setProviderKey(id, key)") && client.includes("async removeProviderKey(id)"));
expect("the key is sent once as a PUT body and never in a URL", client.includes('{ method: "PUT", body: JSON.stringify({ key }) }') && !/providers\/[^\n]*key=/.test(client));
for (const [name, rule] of [
	["section", /\.agent-keys\s*\{[^}]*padding: var\(--agent-space-4\)/],
	["row", /\.agent-key-row\s*\{[^}]*border-radius: var\(--agent-radius-md\)/],
	["input", /\.agent-key-input\s*\{[^}]*background: var\(--agent-bg-sunken\)/],
	["error", /\.agent-key-error\s*\{[^}]*color: var\(--agent-alert\)/],
]) expect(`the provider keys ${name} is token-driven`, rule.test(css));
expect("the provider keys section hardcodes no colour", !/#[0-9a-f]{3,8}/i.test(css.slice(css.indexOf(".agent-keys {"), css.indexOf("/* --- transcript"))));
{
	const keys = module_.createMockTransport({ state: "ready" });
	const before = await keys.providers();
	expect("the mock answers in the sidecar's provider shape", before.length === 6
		&& before.every((entry) => typeof entry.id === "string" && typeof entry.label === "string" && Object.hasOwn(entry, "authSource") && typeof entry.signedIn === "boolean"), JSON.stringify(before));
	expect("five API-key providers sit beside ChatGPT", before.filter((entry) => entry.id !== "openai-codex").length === 5);
	expect("one provider is env-backed, so the disabled row is reachable in QA", before.some((entry) => entry.authSource === "env" && entry.signedIn));
	await keys.setProviderKey("anthropic", "sk-test-123");
	const after = await keys.providers();
	expect("saving a key flips that provider to a file-backed signed-in state", after.find((entry) => entry.id === "anthropic")?.authSource === "file"
		&& after.find((entry) => entry.id === "anthropic")?.signedIn === true, JSON.stringify(after));
	expect("the provider list carries the source of a key, never the key", !JSON.stringify(after).includes("sk-test-123"));
	await keys.removeProviderKey("anthropic");
	expect("removing a key flips the provider back to unset", (await keys.providers()).find((entry) => entry.id === "anthropic")?.signedIn === false);
	let refused = null;
	try { await keys.setProviderKey("openai", "sk-no"); } catch (error) { refused = error; }
	expect("a refused key fails with a 400 that quotes nothing it was given", refused?.status === 400 && !String(refused.message).includes("sk-no"), String(refused?.message));
	expect("a refused save leaves the provider unconfigured", (await keys.providers()).find((entry) => entry.id === "openai")?.signedIn === false);
	expect("the mock refuses to store a key for ChatGPT", await keys.setProviderKey("openai-codex", "sk-test-123").then(() => false, (error) => error.status === 400));
	expect("the panel can name the variable an env-backed provider is set by", module_.providerEnvLabel("google") === "GEMINI_API_KEY or GOOGLE_API_KEY"
		&& module_.providerEnvLabel("anthropic") === "ANTHROPIC_API_KEY" && module_.providerEnvLabel("nope") === "an environment variable");
}

// --- a saved key is a way in, immediately (#379) ---------------------------
// Saving the first key changes WHO the session is, not just which rows are
// green: readiness is `signedIn || providersConfigured > 0`, so a signed-out
// session that saves a key must reach the composer WITHOUT a reload, and must
// fall back behind the sign-in card the moment that key is removed.
{
	const signedOut = module_.createMockTransport({ state: "signed-out" });
	// The panel's own gate, restated here as the thing the flow must flip.
	const gate = (status) => Boolean(status?.signedIn || status?.providersConfigured > 0);
	const before = await signedOut.status();
	expect("a signed-out scripted session starts behind the gate", before.providersConfigured === 0 && !gate(before), JSON.stringify(before));
	await signedOut.setProviderKey("anthropic", "sk-test-123");
	const saved = await signedOut.status();
	expect("saving the first key opens the gate with no ChatGPT sign-in", saved.signedIn === false && saved.providersConfigured === 1 && gate(saved), JSON.stringify(saved));
	await signedOut.setProviderKey("openai", "sk-test-456");
	expect("the scripted session counts every key it holds", (await signedOut.status()).providersConfigured === 2, JSON.stringify(await signedOut.status()));
	await signedOut.removeProviderKey("openai");
	await signedOut.removeProviderKey("anthropic");
	const removed = await signedOut.status();
	expect("removing the last key closes the gate again", removed.providersConfigured === 0 && !gate(removed), JSON.stringify(removed));
}
// The panel re-reads that session through the ONE status path it already owns,
// once per credential write — never a second route, never a timer.
// The refresh is read as its own declaration, so nothing that merely sits
// between it and the next callback can satisfy this.
const refreshBody = (() => {
	const start = panel.indexOf("const refreshProviderState = useCallback");
	if (start === -1) return "";
	return panel.slice(start, panel.indexOf("\n\tconst ", start + 1));
})();
expect("a finished login or logout re-reads the session the readiness gate depends on",
	(refreshBody.match(/readAccount\(\)/g) || []).length === 1 && refreshBody.includes("transport.models()"), refreshBody);
expect("readiness is refreshed through the existing status call, not a new one", (panel.match(/transport\.status\(\)/g) || []).length === 2
	&& panel.includes("const status = await transport.status();") && !/setInterval\([^)]*(status|readAccount|refreshProviderState)/.test(panel),
	String((panel.match(/transport\.status\(\)/g) || []).length));
{
	// The scripted sidecar counts the session reads it answers, which is how the
	// browser QA proves the panel asks exactly once per write and never polls.
	const entries = new Map();
	const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, String(value)), removeItem: (key) => entries.delete(key) },
	});
	try {
		const counted = module_.createMockTransport({ state: "signed-out" });
		await counted.status();
		await counted.status();
		expect("every scripted session read is counted for QA", entries.get(module_.MOCK_STATUS_CALLS_KEY) === "2", JSON.stringify([...entries]));
	} finally {
		if (original) Object.defineProperty(globalThis, "localStorage", original);
		else delete globalThis.localStorage;
	}
}

// Two Stop scenarios share one driver: the host answers 200 either way, so the
// only thing that may justify an "unchanged" claim is the runtime's own outcome.
const cancellationEvents = [];
async function driveStop(stopResponse) {
	let deliver = null;
	const transport = {
		async status() { return { signedIn: true }; },
		async models() { return [{ id: "fixture-only" }]; },
		async turn(_request, onEvent, signal) {
			deliver = onEvent;
			onEvent({ type: "tool.start", callId: "cancel-call", name: "generate_motion" });
			onEvent({ type: "job.state", jobId: "cancel-job", commandId: "cancel-command", state: "generating", phase: "generating" });
			await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
			cancellationEvents.push("turn-aborted");
		},
		async stop() { return stopResponse; },
	};
	const store = module_.createAgentChatStore({
		transport,
		surface: "studio",
		buildContext: () => ({ host: {}, revision: {}, entities: [] }),
	});
	const turn = store.send("cancel this generation");
	await Promise.resolve();
	store.stop();
	await turn;
	return { store, deliver };
}

// Proven not-applied: the runtime reported an explicit unmutated cancellation.
const { store: cancellationStore, deliver: deliverFrame } = await driveStop({ ok: true, status: "stopped", outcome: { status: "cancelled", code: "CANCELLED", mutated: false } });
const cancelledJob = cancellationStore.getState().items.find((item) => item.kind === "job");
const cancelledTool = cancellationStore.getState().items.find((item) => item.kind === "tool");
expect("stopping a Studio job marks it not-applied", cancelledJob?.state === "cancelled" && cancelledJob.outcome?.status === "not_applied" && cancelledJob.outcome.mutated === false);
expect("stopping a Studio job settles its tool card", cancelledTool?.status === "cancelled" && cancelledTool.result?.status === "not_applied");
expect("stopping a Studio job aborts its turn", cancellationEvents.includes("turn-aborted"));
// A frame buffered before the abort can still reach the store after the stop is
// acknowledged; it must not erase the outcome the panel is showing.
deliverFrame({ type: "job.state", jobId: "cancel-job", commandId: "cancel-command", state: "generating", phase: "generating" });
const lateJob = cancellationStore.getState().items.find((item) => item.kind === "job");
// Same acknowledged 200, but the runtime could not establish what happened. The
// panel must report uncertainty, never borrow the unchanged-scene claim.
const { store: unknownStore } = await driveStop({ ok: true, status: "stopped", outcome: { status: null, code: "UNCERTAIN_APPLY", mutated: "unknown" } });
const unknownJob = unknownStore.getState().items.find((item) => item.kind === "job");
const unknownTool = unknownStore.getState().items.find((item) => item.kind === "tool");
expect("an unproven Stop never claims the scene is unchanged", unknownJob?.outcome?.status === "unknown" && unknownJob.outcome.mutated === "unknown" && unknownJob.state !== "cancelled");
expect("an unproven Stop settles its tool card without claiming not-applied", unknownTool?.status === "cancelled" && unknownTool.result?.status === "unknown");
// A host that answers 200 with no runtime outcome at all is equally unproven.
const { store: silentStore } = await driveStop({ ok: true, status: "stopped" });
expect("a Stop with no runtime outcome stays unknown", silentStore.getState().items.find((item) => item.kind === "job")?.outcome?.status === "unknown");
expect("a late job frame cannot erase the not-applied outcome", lateJob?.outcome?.status === "not_applied" && lateJob.outcome.mutated === false);

// --- activity line and explicit turn outcomes (#324) ----------------------
// The panel must never look idle while it is working, and never look idle
// after a turn died. Source shape first, then the exact words per phase.
expect("the panel renders one activity line", panel.includes('className="agent-activity"') && panel.includes("data-agent-activity={activity.phase}"));
expect("the activity line is announced politely", /className="agent-activity"[^>]*role="status" aria-live="polite"/.test(panel));
expect("the activity line sits between the transcript and the composer", (() => {
	const transcript = panel.indexOf('className="agent-transcript"');
	const line = panel.indexOf('className="agent-activity"');
	const composer = panel.indexOf('className="agent-composer"');
	return transcript !== -1 && line > transcript && composer > line;
})());
expect("the activity line carries an animated indicator", panel.includes("agent-activity-indicator")
	&& /\.agent-activity-indicator\.busy\s*\{[^}]*animation: agent-pulse/.test(css) && /@keyframes agent-pulse/.test(css));
expect("the activity line is token-driven", /\.agent-activity\s*\{[^}]*padding: var\(--agent-space-2\) var\(--agent-space-4\)/.test(css));
expect("the elapsed clock ticks on an interval, never a timeout", panel.includes("setInterval(() => setActivityNow(Date.now()), 500)"));

const activityState = (patch) => ({ items: [], streaming: false, turnStartedAt: null, lastTurn: null, ...patch });
const phase = (patch, now = 4000) => module_.describeActivity(activityState(patch), { now });
const prompt = { kind: "user", id: "u1", text: "frame a two-shot" };

const sending = phase({ streaming: true, turnStartedAt: 1000, items: [prompt] }, 2000);
expect('a request in flight reads "Sending… · 1 s"', sending.phase === "sending" && sending.text === "Sending… · 1 s" && sending.ticking, sending.text);
const unanswered = phase({ streaming: true, turnStartedAt: 1000, items: [prompt] });
expect('a request the model has not answered yet reads "Waiting for the model… · 3 s"', unanswered.text === "Waiting for the model… · 3 s", unanswered.text);
const thinking = phase({ streaming: true, turnStartedAt: 1000, items: [prompt, { kind: "tool", id: "t0", name: "inspect_studio", status: "done" }] });
expect('a model deciding its next step reads "Thinking… · 3 s"', thinking.phase === "thinking" && thinking.text === "Thinking… · 3 s", thinking.text);
const replying = phase({ streaming: true, turnStartedAt: 1000, items: [prompt, { kind: "assistant", id: "a1", text: "Framing" }] });
expect('a streaming reply reads "Writing the reply… · 3 s"', replying.phase === "reply" && replying.text === "Writing the reply… · 3 s", replying.text);
const runningTool = phase({ streaming: true, turnStartedAt: 1000, items: [prompt, { kind: "tool", id: "t1", name: "capture_blocking_frame", status: "running" }] });
expect('an open tool call names the tool it is running', runningTool.phase === "tool" && runningTool.text === "Running Capture blocking frame… · 3 s", runningTool.text);
const generating = phase({ streaming: true, turnStartedAt: 1000, items: [prompt, { kind: "tool", id: "t1", name: "generate_motion", status: "running" }, { kind: "job", id: "j1", jobId: "job-1", state: "generating", progress: 0.25 }] });
expect('job frames read "Generating motion 25% · 3 s"', generating.phase === "job" && generating.text === "Generating motion 25% · 3 s", generating.text);
const waiting = phase({ items: [{ kind: "image", id: "i1", apply: { status: "applying", startedAt: 1000 } }] });
expect('a dispatched editor action reads "Waiting for the editor… · 3 s"', waiting.phase === "editor" && waiting.text === "Waiting for the editor… · 3 s", waiting.text);

const doneTurn = phase({ lastTurn: { status: "done", endedAt: 3500, durationMs: 12000, failure: null } });
expect('a finished turn reads "Done · 12 s"', doneTurn.kind === "terminal" && doneTurn.phase === "done" && doneTurn.text === "Done · 12 s", doneTurn.text);
const stoppedTurn = phase({ lastTurn: { status: "stopped", endedAt: 3500, durationMs: 4000, failure: null } });
expect("a stopped turn says so", stoppedTurn.kind === "terminal" && stoppedTurn.text === "Stopped", stoppedTurn.text);
const failedTurn = phase({ lastTurn: { status: "failed", endedAt: 3500, durationMs: 900, failure: { code: "upstream", status: 400, message: "400 — The requested model is not supported" } } });
expect("a failed turn names the reason the transport reported", failedTurn.text === "Failed: 400 — The requested model is not supported", failedTurn.text);
const limitedTurn = phase({ lastTurn: { status: "failed", endedAt: 3500, durationMs: 900, failure: { code: "rate_limit", message: module_.ERROR_COPY.rate_limit } } });
expect("a usage limit is stated in a few words", limitedTurn.text === "Failed: provider quota reached", limitedTurn.text);
// #1043: a rate limit is the provider's quota, says how long to wait, and offers another connected provider.
{
	expect("the rate-limit copy names the provider's quota, not CozyClay's", /provider's quota/.test(module_.ERROR_COPY.rate_limit) && /not CozyClay's/.test(module_.ERROR_COPY.rate_limit), module_.ERROR_COPY.rate_limit);
	const providers = [
		{ id: "google", label: "Google Gemini", signedIn: true, models: [{ key: "google/gemini-x" }, { key: "google/gemini-y" }] },
		{ id: "anthropic", label: "Anthropic", signedIn: false, models: [{ key: "anthropic/claude-x" }] },
		{ id: "openai-compatible", label: "OpenAI-compatible", signedIn: true, endpoint: "local", models: [{ key: "openai-compatible/qwen" }] },
	];
	const models = [{ id: "google/gemini-x" }, { id: "google/gemini-y" }, { id: "anthropic/claude-x" }, { id: "openai-compatible/qwen" }];
	const help = await import("../src/workflow/agent-provider-help.js");
	const cards = readFileSync(new URL("../src/workflow/AgentWaitCards.jsx", import.meta.url), "utf8");
	const next = help.otherProviderModel(providers, models, "google/gemini-x");
	expect("the switch skips the limited provider and one without a credential", JSON.stringify(next) === JSON.stringify({ model: "openai-compatible/qwen", provider: "openai-compatible", label: "OpenAI-compatible" }), JSON.stringify(next));
	expect("no other connected provider: no switch target", help.otherProviderModel(providers.slice(0, 2), models, "google/gemini-x") === null);
	expect("the card names the provider by its label", help.providerLabel(providers, "google") === "Google Gemini" && help.providerLabel([], "google") === "google");
	expect("the client keeps the frame's provider on the paused state", client.includes('provider: typeof event.provider === "string" ? event.provider : null'));
	expect("the paused card offers the other provider by name, and the wait or that none was given", cards.includes("Switch to ${alternative.label}") && cards.includes('ko("Wait & retry"') && cards.includes('"wait time not given"') && panel.includes("alternative={alternative}"));
	expect("the wait left reads in minutes, then seconds", help.formatWaitLeft("1970-01-01T00:10:00.000Z", 0) === "10 min" && help.formatWaitLeft("1970-01-01T00:00:40.000Z", 0) === "40 s" && help.formatWaitLeft(undefined, 0) === null);
	expect("every waiting-card failure class has words", ["timeout", "callback_error", "port_busy"].every((reason) => typeof help.SIGN_IN_FAILURE_COPY[reason] === "string"));
}
const settled = phase({ lastTurn: { status: "done", endedAt: 3500, durationMs: 12000, failure: null } }, 3500 + module_.ACTIVITY_TERMINAL_MS);
expect("the terminal state gives way to a quiet Ready", settled.kind === "idle" && settled.text === "Ready" && !settled.ticking, settled.text);
expect("an idle panel says Ready", phase({}).text === "Ready" && phase({}).phase === "idle");
expect("the clock stays readable past a minute", module_.formatTurnClock(65000) === "1 m 05 s" && module_.formatTurnClock(-5) === "0 s");

// A turn is driven through the real store with an injected clock, so the
// outcome it records is the one the panel reads.
let fakeNow = 0;
const driveTurn = async (turn) => {
	fakeNow = 1000;
	const store = module_.createAgentChatStore({ transport: { turn: (_request, onEvent, signal) => turn(onEvent, signal) }, clock: () => fakeNow });
	const sent = store.send("do something");
	fakeNow = 3500;
	await sent;
	return store.getState();
};

const silent = await driveTurn(async () => {});
const silentCard = silent.items.find((item) => item.kind === "failure");
expect("a turn that ends with no output renders a failure card", silentCard?.failure.code === "no_output" && silentCard.failure.recovery.retryAllowed === true);
expect("that turn is reported as failed, not finished", silent.lastTurn?.status === "failed" && silent.lastTurn.durationMs === 2500);
expect("the activity line states the silent failure", module_.describeActivity(silent, { now: 3500 }).text === "Failed: no response");

const doneOnly = await driveTurn(async (onEvent) => { onEvent({ type: "done" }); });
const doneOnlyCard = doneOnly.items.find((item) => item.kind === "failure");
expect("a turn whose only frame is done still renders a no_output failure card", doneOnlyCard?.failure.code === "no_output");
expect("that done-only turn is reported as failed", doneOnly.lastTurn?.status === "failed");
expect("the activity line states the done-only failure", module_.describeActivity(doneOnly, { now: 3500 }).text === "Failed: no response");

const refused = await driveTurn(async (onEvent) => { onEvent({ type: "error", code: "upstream", status: 429, message: "429 — usage limit, resets in 42m" }); onEvent({ type: "done" }); });
const refusedCard = refused.items.find((item) => item.kind === "failure");
expect("an upstream refusal renders a failure card with the reported detail", refusedCard?.failure.code === "upstream" && refusedCard.failure.message === "429 — usage limit, resets in 42m" && refusedCard.failure.status === 429);
expect("the failure card offers a retry", refusedCard.failure.recovery.retryAllowed === true);
expect("a refused turn ends as failed", refused.lastTurn?.status === "failed");

// A second message while the agent still answers: the server says only "busy"; the card says what that means, once.
const busyTurn = await driveTurn(async (onEvent) => { onEvent({ type: "error", code: "busy", message: "busy" }); onEvent({ type: "done" }); });
const busyCard = busyTurn.items.find((item) => item.kind === "failure");
expect("a busy refusal reads as plain English, not \"busy busy\"", busyCard?.failure.message === module_.ERROR_COPY.busy && /still answering/.test(busyCard.failure.message), busyCard?.failure.message);
expect("the activity line says why in a few words", module_.describeActivity(busyTurn, { now: 3500 }).text === "Failed: agent still answering", module_.describeActivity(busyTurn, { now: 3500 }).text);
expect("a failure card never repeats its code as its message", panel.includes("(failure.message !== failure.code && failure.message)"));

const attached = await driveTurn(async (onEvent) => {
	onEvent({ type: "tool.start", callId: "c1", name: "capture_blocking_frame" });
	onEvent({ type: "tool.done", callId: "c1", ok: false, error: "Viewport is not ready" });
	onEvent({ type: "error", code: "upstream", message: "The model service failed to answer." });
	onEvent({ type: "done" });
});
expect("a failure inside a turn stays on that turn's tool card", !attached.items.some((item) => item.kind === "failure")
	&& attached.items.find((item) => item.kind === "tool")?.failure?.code === "upstream");

fakeNow = 1000;
const stopStore = module_.createAgentChatStore({
	transport: {
		turn: (_request, onEvent, signal) => { onEvent({ type: "text.delta", text: "Framing" }); return new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })); },
		stop: async () => ({ ok: true }),
	},
	clock: () => fakeNow,
});
const stopping = stopStore.send("go");
fakeNow = 6000;
stopStore.stop();
expect("Stop is reported the moment it is asked for", stopStore.getState().lastTurn?.status === "stopped" && module_.describeActivity(stopStore.getState(), { now: 6000 }).text === "Stopped");
await stopping;
expect("the settled turn keeps the stopped outcome", stopStore.getState().lastTurn?.status === "stopped");

// --- a refused turn explains itself (#324 control finding 1) --------------
const refusal = await module_.refusalEvent({ status: 400, clone: () => ({ json: async () => ({ error: { code: "upstream", message: "The requested model is not supported for this account." } }) }) });
expect("a refused turn forwards the status and the sanitized detail", refusal.code === "upstream" && refusal.status === 400
	&& refusal.message === "400 — The requested model is not supported for this account.", refusal.message);
const prefixed = await module_.refusalEvent({ status: 502, clone: () => ({ json: async () => ({ error: { code: "upstream", message: "502 — The model service failed to answer." } }) }) });
expect("the status the sidecar already stated is not repeated", prefixed.message === "502 — The model service failed to answer.", prefixed.message);
const bodiless = await module_.refusalEvent({ status: 502, clone: () => { throw new Error("no body"); } });
expect("a refusal with no readable body still reports its status", bodiless.code === "upstream" && bodiless.message === "The turn was refused with HTTP 502.", bodiless.message);
expect("a 429 refusal routes to the paused state", (await module_.refusalEvent({ status: 429, clone: () => ({ json: async () => ({}) }) })).code === "rate_limit");
expect("the panel stops inventing a generic refusal message", !panel.includes("turn responded") && client.includes("refusalEvent(response)"));

// --- no stale model id is ever sent (#324 control finding 2) --------------
// The guard covers the LIVE half of the file: the scripted ?agent=mock
// catalogue below it names realistic models on purpose, and no turn can ever
// reach a provider through it.
const liveClient = client.slice(0, client.indexOf("// --- mock transport"));
expect("the client hardcodes no model list", !client.includes("DEFAULT_MODELS") && !/gpt-[\d.]/.test(liveClient));
expect("the panel starts with no model and takes the advertised list", panel.includes('const [model, setModel] = useState("")') && panel.includes('setModelsState("ready")'));
expect("the composer stays disabled until a model it may send to is selected",
	panel.includes('const composerDisabled = panelState === "rate-limited" || !model || !modelIsSelectable(modelProviders, model);'));
expect("the wait for the model list is visible, not silent", panel.includes("Loading models…") && panel.includes("No model available"));
expect("an unanswered model list is a state, not a guess", client.includes("const models = Array.isArray(result?.models) ? result.models : [];")
	&& panel.includes('if (advertised.status === "rejected" || !applyModelList(advertised.value)) setModelsState("failed");'));

// --- provider-grouped models, effort and steering (#379) ------------------
// Five providers now answer /agent/models. The dropdown groups them, says
// which ones are waiting for a key, and the composer can nudge a turn that is
// already running instead of queueing a second one behind it.
expect("the model list is consumed as the grouped { providers, models } payload", client.includes("return { providers, models };")
	&& client.includes("Array.isArray(result?.providers)"));
expect("a sidecar that answers with the flat list alone still fills the dropdown", /providers = Array\.isArray\(result\?\.providers\)[\s\S]{0,200}: \[\];/.test(client)
	&& panel.includes("modelProviders.length") && panel.includes("models.map((entry) => <option key={entry.id} value={entry.id}>"));
expect("the dropdown is grouped by provider", panel.includes("<optgroup key={provider.id} label={provider.label}>") && panel.includes("value={entry.key}"));
expect("a provider without a key still lists its models, unpickable and labelled", panel.includes("disabled={!provider.signedIn}") && panel.includes("\u2014 add key"));
expect("the chosen model key is remembered between sessions", client.includes('export const AGENT_MODEL_KEY = "cozyclay.agent.model"')
	&& panel.includes("storeModel(id)") && client.includes("preferredModel(models.filter("));
expect("only a model whose provider holds a credential is auto-selected or switched to", client.includes("export function modelIsSelectable(providers, key)") && panel.includes("modelIsSelectable(modelProviders, entry.id)"));
expect("effort options come from the selected model", panel.includes("effortOptions(models.find((entry) => entry.id === model))")
	&& client.includes("entry.defaultEffort && efforts.includes(entry.defaultEffort)"));
expect("the transport can steer a running turn", client.includes("async steer(turnId, body)") && client.includes("/agent/turn/${encodeURIComponent(turnId)}/steer"));
expect("the store steers instead of starting a second turn", client.includes("async steer(text, options = {})") && client.includes("if (!state.streaming || !wireTurnId"));
expect("a refused steer names the code and keeps the draft", client.includes("export const STEER_ERROR_COPY") && client.includes("STEER_UNSUPPORTED")
	&& client.includes("NO_ACTIVE_TURN") && panel.includes("setSteerNotice(result.message"));
expect("Send becomes Steer while a steerable turn runs, and Stop stays reachable", panel.includes('className="agent-send agent-steer"') && panel.includes(">Steer</button>")
	&& panel.includes('className="agent-send stop agent-stop"'));
expect("only the Workflow surface offers Steer", panel.includes("presentation.steer &&") && panel.includes("if (streaming) { if (presentation.steer) steerTurn(draft); return; }"));
expect("a provider key is a way in, not only the ChatGPT sign-in", panel.includes("status?.signedIn || status?.providersConfigured > 0"));
expect("the scripted transport answers the grouped list and the steer route", client.includes("const MOCK_PROVIDER_MODELS") && client.includes("cozyclay.mock.agent.last-steer"));
expect("the notice line is token-driven", /\.agent-toast\s*\{[^}]*padding: var\(--agent-space-3\) var\(--agent-space-4\)/.test(css)
	&& /\.agent-toast\.alert\s*\{[^}]*background: var\(--agent-alert-bg\)/.test(css)
	&& /\.agent-model-select optgroup\s*\{[^}]*color: var\(--agent-text-muted\)/.test(css));

expect("preferredModel keeps a remembered key that is still advertised", module_.preferredModel([{ id: "a/1" }, { id: "b/2" }], "b/2") === "b/2");
expect("preferredModel ignores a key nobody advertises any more", module_.preferredModel([{ id: "a/1" }], "gone/9") === "a/1");
expect("preferredModel falls back to nothing rather than a guess", module_.preferredModel([], "a/1") === "");
{
	const grouped = await mock.models();
	expect("the scripted list groups every provider", grouped.providers.length === 6 && grouped.providers.every((provider) => Array.isArray(provider.models) && provider.models.length > 0),
		JSON.stringify(grouped.providers?.map((provider) => provider.id)));
	expect("the flat scripted list is key-addressed", grouped.models.length > 5 && grouped.models.every((entry) => entry.id === entry.key && entry.key.includes("/")));
	expect("the scripted list includes a provider that is waiting for a key", grouped.providers.some((provider) => !provider.signedIn && provider.models.length > 0));
	expect("every scripted model carries its efforts and a default", grouped.models.every((entry) => Array.isArray(entry.efforts) && entry.efforts.includes(entry.defaultEffort)));
	expect("effortOptions puts the model's default first", JSON.stringify(module_.effortOptions({ efforts: ["none", "low", "medium"], defaultEffort: "medium" })) === JSON.stringify(["medium", "none", "low"]));
	await assert.rejects(() => mock.steer("mock-turn-404", { text: "too late" }), (error) => error.status === 409 && error.code === "NO_ACTIVE_TURN");
	expect("the scripted steer refuses a turn that is not running", true);
	await assert.rejects(() => module_.createMockTransport({ state: "ready", surface: "studio" }).steer("any", { text: "nope" }),
		(error) => error.status === 409 && error.code === "STEER_UNSUPPORTED");
	expect("the scripted Studio surface refuses steering outright", true);
	expect("a scripted session reports how many provider keys it has", Number.isInteger((await mock.status()).providersConfigured)
		&& (await module_.createMockTransport({ state: "signed-out" }).status()).providersConfigured === 0);
}

// --- a selection whose provider is unavailable is dropped (#379) ----------
// The panel opens on whatever the sidecar listed first, which — before any
// credential exists — is a provider that cannot run a turn. Saving the first
// key makes the session ready WITHOUT making that model usable, so the list
// load is where the selection is settled again: a turn is never addressed to a
// provider this session cannot reach, and the composer is shut while the
// selected model is not one it may send to.
{
	// The sidecar's own shape, with ChatGPT signed out and Anthropic holding the
	// key the author just saved — the catalogue ordering that produced the bug.
	const catalogue = (anthropicSignedIn) => [
		{ id: "openai-codex", label: "ChatGPT", signedIn: false, authSource: null, models: [{ key: "openai-codex/gpt-6-astra", label: "gpt-6-astra" }] },
		{ id: "anthropic", label: "Anthropic", signedIn: anthropicSignedIn, authSource: anthropicSignedIn ? "file" : null, models: [{ key: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5" }] },
	];
	const advertised = catalogue(false).flatMap((provider) => provider.models.map((entry) => ({ ...entry, id: entry.key })));
	const entries = new Map([[module_.AGENT_MODEL_KEY, "openai-codex/gpt-6-astra"]]);
	const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, String(value)), removeItem: (key) => entries.delete(key) },
	});
	try {
		// Before the save nothing is usable, so there is nothing to select: the
		// composer has no model to submit rather than a disabled one.
		const beforeSave = module_.nextSelectedModel(catalogue(false), advertised, "");
		expect("a session with no usable provider selects no model at all", beforeSave === "", beforeSave);
		// The panel has been mounted since before the key existed, so the remembered
		// ChatGPT key is what it is holding when the list reloads.
		const afterSave = module_.nextSelectedModel(catalogue(true), advertised, "openai-codex/gpt-6-astra");
		expect("saving the first key drops the selection its provider cannot run", afterSave === "anthropic/claude-sonnet-4-5", afterSave);
		expect("the model the save left selected is one the session can send to", module_.modelIsSelectable(catalogue(true), afterSave));
		expect("the remembered preference is re-validated, never rewritten", entries.get(module_.AGENT_MODEL_KEY) === "openai-codex/gpt-6-astra", entries.get(module_.AGENT_MODEL_KEY));
		// The composer's gate, on the value the panel is holding: usable model in,
		// unusable model out.
		expect("the composer may send to the re-picked model", Boolean(afterSave) && module_.modelIsSelectable(catalogue(true), afterSave));
		expect("the composer may NOT send to the model the panel was holding", !module_.modelIsSelectable(catalogue(true), "openai-codex/gpt-6-astra"));
		// And the turn really is addressed to it: the store is the same one the
		// panel sends through.
		let request = null;
		const sending = module_.createAgentChatStore({
			transport: { turn: async (sent, onEvent) => { request = sent; onEvent({ type: "text.delta", text: "framing" }); onEvent({ type: "done" }); } },
		});
		await sending.send("frame a two-shot", { model: afterSave });
		expect("the turn is addressed to the model the save re-picked", request?.model === "anthropic/claude-sonnet-4-5", JSON.stringify(request?.model));
		// Removing that key takes the way in away again: no usable model, so no
		// model is selected and the composer has nothing to submit.
		const afterRemove = module_.nextSelectedModel(catalogue(false), advertised, afterSave);
		expect("removing the key leaves no submittable model behind", afterRemove === "", afterRemove);
		// A signed-in ChatGPT author is not moved off their own model by someone
		// else's key landing beside it.
		const signedIn = [{ ...catalogue(true)[0], signedIn: true, authSource: "chatgpt" }, catalogue(true)[1]];
		expect("a usable ChatGPT selection survives another provider's key", module_.nextSelectedModel(signedIn, advertised, "openai-codex/gpt-6-astra") === "openai-codex/gpt-6-astra");
		// A sidecar that answers with the flat list alone says nothing about
		// providers, so it can never invalidate a selection.
		expect("an ungrouped list keeps the selection it knows nothing about", module_.nextSelectedModel([], advertised, "openai-codex/gpt-6-astra") === "openai-codex/gpt-6-astra");
	} finally {
		if (original) Object.defineProperty(globalThis, "localStorage", original);
		else delete globalThis.localStorage;
	}
}
expect("the list load settles the selection instead of keeping it unconditionally", panel.includes("setModel((current) => nextSelectedModel(providers, list, current));")
	&& !panel.includes("current || preferredModel("));

// --- signing in is an authentication transition, not a status read (#379) --
// The grouped catalogue carries each provider's sign-in state, and the
// composer may only send to a model whose provider holds a credential. A
// ChatGPT sign-in therefore changes WHICH models exist for this session, not
// just who it is: it has to go through the same refresh a credential write
// uses (providers + models + status), or the panel reaches "ready" with every
// ChatGPT option still drawn disabled and nothing to submit. The DOM proof is
// in test/qa-agent-panel-browser.mjs; this pins the wiring and the scripted
// sidecar the browser drives.
expect("a successful sign-in refreshes the catalogue, not only the account", /await transport\.signIn\(\);\n\t\t\tawait refreshProviderState\(\);/.test(panel),
	panel.slice(panel.indexOf("const signIn = useCallback"), panel.indexOf("const signOut = useCallback")));
expect("signing out refreshes the catalogue through that same path", /transport\.signOut\(\)[\s\S]{0,420}await refreshProviderState\(\);/.test(panel),
	panel.slice(panel.indexOf("const signOut = useCallback"), panel.indexOf("const newSession = useCallback")));
expect("a sign-in finished in another window lands on the same refresh", (() => {
	const start = panel.indexOf('if (authState !== "signing-in") return;');
	const body = panel.slice(start, panel.indexOf("}, [authState", start));
	return start !== -1 && body.includes("refreshProviderState()") && !body.includes("readAccount()");
})(), panel.slice(panel.indexOf('if (authState !== "signing-in") return;'), panel.indexOf("// Mock states that only exist")));
expect("the auth transition adds no second models-fetch path", (panel.match(/transport\.models\(\)/g) || []).length === 2,
	String((panel.match(/transport\.models\(\)/g) || []).length));
expect("no timer drives the auth transition", !/set(Interval|Timeout)\([^)]*(signIn|signOut|readAccount|refreshProviderState)/.test(panel));
{
	// The scripted sidecar is a session, not a fixed prop: signIn() and signOut()
	// move it, which is what lets the browser QA drive the transition the F2
	// probe reproduced.
	const entries = new Map([[module_.AGENT_MODEL_KEY, "openai-codex/gpt-6-astra"]]);
	const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, String(value)), removeItem: (key) => entries.delete(key) },
	});
	try {
		const session = module_.createMockTransport({ state: "signed-out" });
		const gate = (status) => Boolean(status?.signedIn || status?.providersConfigured > 0);
		const before = await session.status();
		expect("a signed-out scripted session with no key has no composer to type into", !gate(before), JSON.stringify(before));
		const beforeList = await session.models();
		expect("the signed-out catalogue draws every ChatGPT model out of reach", !module_.modelIsSelectable(beforeList.providers, "openai-codex/gpt-6-astra")
			&& beforeList.providers.find((provider) => provider.id === "openai-codex")?.signedIn === false,
			JSON.stringify(beforeList.providers.map((provider) => [provider.id, provider.signedIn])));
		expect("the scripted sign-in reports success", (await session.signIn())?.ok === true);
		const after = await session.status();
		expect("a successful ChatGPT sign-in opens the gate with no key saved", after.signedIn === true && gate(after), JSON.stringify(after));
		const afterList = await session.models();
		expect("the refreshed catalogue marks ChatGPT signed in", afterList.providers.find((provider) => provider.id === "openai-codex")?.signedIn === true,
			JSON.stringify(afterList.providers.map((provider) => [provider.id, provider.signedIn])));
		const picked = module_.nextSelectedModel(afterList.providers, afterList.models, "");
		expect("the refreshed catalogue hands the composer a ChatGPT model it may send to",
			picked === "openai-codex/gpt-6-astra" && module_.modelIsSelectable(afterList.providers, picked), picked);
		expect("the sign-in re-validated the remembered preference instead of rewriting it", entries.get(module_.AGENT_MODEL_KEY) === "openai-codex/gpt-6-astra");
		expect("the scripted sign-out reports success", (await session.signOut())?.ok === true);
		const out = await session.status();
		expect("signing out closes the gate again", out.signedIn === false && !gate(out), JSON.stringify(out));
		const outList = await session.models();
		expect("the sign-out catalogue takes the ChatGPT models back out of reach", !module_.modelIsSelectable(outList.providers, picked)
			&& !module_.nextSelectedModel(outList.providers, outList.models, picked).startsWith("openai-codex/"),
			`${JSON.stringify(outList.providers.map((provider) => [provider.id, provider.signedIn]))} -> ${module_.nextSelectedModel(outList.providers, outList.models, picked)}`);
		// A provider key is the OTHER way in, and signing out of ChatGPT does not
		// take it away: the gate rule is unchanged.
		await session.setProviderKey("anthropic", "sk-signout-123");
		expect("a key still open after the sign-out keeps the session usable", gate(await session.status()), JSON.stringify(await session.status()));
		const keyed = await session.models();
		expect("and the composer is handed that provider's model, never the signed-out one",
			module_.nextSelectedModel(keyed.providers, keyed.models, picked) === "anthropic/claude-sonnet-4-5",
			module_.nextSelectedModel(keyed.providers, keyed.models, picked));
	} finally {
		if (original) Object.defineProperty(globalThis, "localStorage", original);
		else delete globalThis.localStorage;
	}
}
{
	// The catalogue reads the browser QA counts, beside the session reads it
	// already counted: exactly one of each per auth transition proves the panel
	// refreshed once and never polled for it.
	const entries = new Map();
	const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, String(value)), removeItem: (key) => entries.delete(key) },
	});
	try {
		const counted = module_.createMockTransport({ state: "signed-out" });
		await counted.models();
		await counted.signIn();
		await counted.models();
		expect("every scripted catalogue read is counted for QA", entries.get(module_.MOCK_MODEL_CALLS_KEY) === "2", JSON.stringify([...entries]));
		expect("the catalogue counter is its own key, beside the session counter", module_.MOCK_MODEL_CALLS_KEY !== module_.MOCK_STATUS_CALLS_KEY
			&& String(module_.MOCK_MODEL_CALLS_KEY).startsWith("cozyclay.mock.agent."), String(module_.MOCK_MODEL_CALLS_KEY));
	} finally {
		if (original) Object.defineProperty(globalThis, "localStorage", original);
		else delete globalThis.localStorage;
	}
}

// --- a refreshed catalogue that no longer advertises the selection (#379) --
// A live-only Codex model exists only while the ChatGPT credential does, so a
// sign-out (or any catalogue that shrank) can retire the selected id WITHOUT
// changing which providers hold a key. A rule that only asks "does this
// model's provider hold a credential?" keeps that retired id while the native
// <select> — which can only show an option it actually has — falls back to
// another one: the panel then submits a model nobody is looking at. What the
// composer submits must be the option the dropdown is showing, every time.
{
	const codexLive = { key: "openai-codex/live-only", label: "live-only" };
	const codexStatic = { key: "openai-codex/gpt-6-astra", label: "gpt-6-astra" };
	const codex = (signedIn, models) => ({ id: "openai-codex", label: "ChatGPT", signedIn, authSource: signedIn ? "chatgpt" : null, models });
	const anthropic = { id: "anthropic", label: "Anthropic", signedIn: true, authSource: "file", models: [{ key: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5" }] };
	const flatten = (catalogue) => catalogue.flatMap((provider) => provider.models.map((entry) => ({ ...entry, id: entry.key })));
	// What the panel's <select value={model}> shows: the option carrying that
	// value when the list still has one, and otherwise the fallback a native
	// select lands on — the first option it is allowed to select.
	const visibleOption = (catalogue, value) => {
		const options = catalogue.flatMap((provider) => provider.models.map((entry) => ({ value: entry.key, disabled: !provider.signedIn })));
		return (options.find((option) => option.value === value) ?? options.find((option) => !option.disabled) ?? options[0] ?? null)?.value ?? "";
	};
	// The model the composer actually submits, through the same store the panel
	// sends its turns with.
	const submittedModel = async (model) => {
		let request = null;
		const store = module_.createAgentChatStore({
			transport: { turn: async (sent, onEvent) => { request = sent; onEvent({ type: "text.delta", text: "framing" }); onEvent({ type: "done" }); } },
		});
		await store.send("hold the wider frame", { model });
		return request?.model ?? null;
	};
	const entries = new Map();
	const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, String(value)), removeItem: (key) => entries.delete(key) },
	});
	try {
		// 1. The catalogue shrank with every credential intact: ChatGPT is still
		// signed in, it simply stopped listing the live-only entry.
		const shrunk = [codex(true, [codexStatic]), anthropic];
		const afterShrink = module_.nextSelectedModel(shrunk, flatten(shrunk), codexLive.key);
		expect("a selection the refreshed catalogue no longer advertises is dropped, signed in or not", afterShrink === codexStatic.key, afterShrink);
		expect("the dropped selection is replaced by the preferred advertised model", afterShrink === module_.preferredModel(flatten(shrunk).filter((entry) => module_.modelIsSelectable(shrunk, entry.id))), afterShrink);
		expect("the next turn is submitted with the re-picked model, never the retired id", await submittedModel(afterShrink) === codexStatic.key);
		expect("what is submitted is the option the dropdown is showing", await submittedModel(afterShrink) === visibleOption(shrunk, afterShrink), `${afterShrink} vs ${visibleOption(shrunk, afterShrink)}`);

		// 2. The sign-out that produced the bug: the live-only model goes with the
		// credential, the remaining Codex option is drawn disabled, and the key
		// behind another provider is what the session still has.
		const signedOut = [codex(false, [codexStatic]), anthropic];
		const afterSignOut = module_.nextSelectedModel(signedOut, flatten(signedOut), codexLive.key);
		expect("a sign-out that retires the selected model lands on one this session can run", afterSignOut === "anthropic/claude-sonnet-4-5", afterSignOut);
		expect("and the turn after the sign-out goes to exactly the visible option", await submittedModel(afterSignOut) === visibleOption(signedOut, afterSignOut), `${await submittedModel(afterSignOut)} vs ${visibleOption(signedOut, afterSignOut)}`);
		expect("no retired id survives the refresh in the composer's hands", await submittedModel(afterSignOut) !== codexLive.key);

		// 3. A model the refreshed catalogue still advertises is NOT disturbed.
		const unchanged = [codex(true, [codexLive, codexStatic]), anthropic];
		const kept = module_.nextSelectedModel(unchanged, flatten(unchanged), codexLive.key);
		expect("a still-advertised selection survives the refresh untouched", kept === codexLive.key, kept);
		expect("and that turn is submitted with the model the dropdown shows", await submittedModel(kept) === visibleOption(unchanged, kept), `${kept} vs ${visibleOption(unchanged, kept)}`);
		expect("the remembered preference is re-read, never rewritten by the refresh", !entries.has(module_.AGENT_MODEL_KEY), JSON.stringify([...entries]));

		// The scripted sidecar carries the same live-only entry, which is what lets
		// browser QA drive this transition (panel-signout-selection.png).
		const session = module_.createMockTransport({ state: "ready" });
		const live = await session.models();
		const liveOnly = live.models.filter((entry) => entry.id.startsWith("openai-codex/")).map((entry) => entry.id);
		expect("the scripted signed-in catalogue advertises a live-only ChatGPT model", liveOnly.some((id) => id.endsWith("-live-preview")), JSON.stringify(liveOnly));
		const retired = liveOnly.find((id) => id.endsWith("-live-preview"));
		await session.setProviderKey("anthropic", "sk-signout-16t");
		await session.signOut();
		const outList = await session.models();
		expect("signing out of the scripted sidecar retires that model from the catalogue", !outList.models.some((entry) => entry.id === retired), JSON.stringify(outList.models.map((entry) => entry.id)));
		const scripted = module_.nextSelectedModel(outList.providers, outList.models, retired);
		expect("the scripted sign-out hands the composer an advertised model it may send to",
			outList.models.some((entry) => entry.id === scripted) && module_.modelIsSelectable(outList.providers, scripted), scripted);
		expect("the scripted sign-out turn is addressed to the visible option too", await submittedModel(scripted) === visibleOption(outList.providers, scripted),
			`${scripted} vs ${visibleOption(outList.providers, scripted)}`);
	} finally {
		if (original) Object.defineProperty(globalThis, "localStorage", original);
		else delete globalThis.localStorage;
	}
}

// --- an installed-with-warnings motion, rendered --------------------------
// The job and receipt cards are rendered from the panel's own source: the
// function declarations are cut out, run through Vite's oxc JSX transform and
// fed the same icons and client helpers the panel imports.
{
	const { parseSync } = await import("rolldown/experimental");
	const { transformWithOxc } = await import("vite");
	const React = await import("react");
	const { renderToStaticMarkup } = await import("react-dom/server");
	const scope = { React, ...(await import("react-icons/fi")), ...(await import("../src/workflow/agent-client.js")) };
	const names = Object.keys(scope).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name) && name !== "default");
	const cards = parseSync("AgentPanel.jsx", panel).program.body
		.filter((node) => node.type === "FunctionDeclaration" && ["StatusDot", "JobCard", "ReceiptCard"].includes(node.id.name))
		.map((node) => panel.slice(node.start, node.end)).join("\n");
	const { code } = await transformWithOxc(`function cards() {\n${cards}\nreturn { JobCard, ReceiptCard };\n}`, "cards.jsx", { lang: "jsx", jsx: { runtime: "classic" } });
	const { JobCard, ReceiptCard } = new Function(...names, `${code}\nreturn cards();`)(...names.map((name) => scope[name]));
	const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));
	const warnings = [
		{ code: "FLOOR_PENETRATION", message: "Feet sink 3.1 cm into the floor (limit 2.0 cm)." },
		{ code: "COLLISION_FRAMES", count: 4, message: "4 frames collide with the body, cast or scene." },
	];
	const receipt = (status) => ({ ok: true, status: "installed", receiptId: "receipt-1", warnings: status === "unverified" ? warnings : [], acceptance: status === "unverified" ? "advisory-policy" : undefined,
		verification: { status, limitations: [] }, installed: { characterId: "actor-a", durationSeconds: 2 } });
	const warned = render(ReceiptCard, { item: { receiptId: "receipt-1", receipt: receipt("unverified"), summary: "Installed 2s of motion on actor-a — installed unverified" } });
	expect("an unverified install reads Installed with warnings", warned.includes("Installed with warnings"), warned);
	expect("an unverified install lists every warning", warnings.every((warning) => warned.includes(warning.message)), warned);
	// The pane has no direct Undo path into the Studio editor, so it names the
	// two that exist instead of drawing a button.
	expect("an unverified install says how to undo it", warned.includes("Undo with Cmd+Z or ask the agent") && !warned.includes("<button"), warned);
	const clean = render(ReceiptCard, { item: { receiptId: "receipt-2", receipt: receipt("verified"), summary: "Installed 2s of motion on actor-a — verified over 48 frames" } });
	expect("a verified install carries no warning copy", !clean.includes("Installed with warnings") && !clean.includes("Undo with Cmd+Z"), clean);
	const job = (status) => render(JobCard, { job: { jobId: "job-1", state: "installed", verification: { status, limitations: [] }, acceptance: null }, onStop() {}, onAccept() {} });
	expect("an unverified installed job reads Installed with warnings", job("unverified").includes("Installed with warnings"), job("unverified"));
	expect("a verified installed job reads Installed", job("verified").includes(">Installed<") && !job("verified").includes("with warnings"), job("verified"));
}

// --- model roles line (#717) ----------------------------------------------
// The sidecar derives helper / vision / advisor per main model; the panel
// passes them through and shows them read-only under the Model select.
{
	const byMain = { "cliproxy/claude-opus-5-5": { helper: "cliproxy/claude-haiku-5-5", vision: "cliproxy/claude-opus-5-5", advisor: "cliproxy/claude-sonnet-5-5", fallback: ["cliproxy/claude-sonnet-5-5"] } };
	const answering = (body) => module_.createHttpTransport({ fetchImpl: async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }) });
	const withRoles = await answering({ providers: [], models: [{ id: "cliproxy/claude-opus-5-5" }], roles: { byMain } }).models();
	expect("the transport passes roles.byMain through from /agent/models", withRoles.roles?.byMain === undefined ? false : JSON.stringify(withRoles.roles.byMain) === JSON.stringify(byMain), JSON.stringify(withRoles));
	expect("a sidecar without roles advertises none", (await answering({ providers: [], models: [] }).models()).roles === undefined
		&& (await answering({ providers: [], models: [], roles: { byMain: [] } }).models()).roles === undefined);
	expect("selectedModelRoles returns the entry for the selected key", module_.selectedModelRoles(byMain, "cliproxy/claude-opus-5-5") === byMain["cliproxy/claude-opus-5-5"]);
	expect("selectedModelRoles hides a missing or malformed entry", module_.selectedModelRoles(byMain, "cliproxy/other") === null && module_.selectedModelRoles(null, "x/y") === null
		&& module_.selectedModelRoles({ "x/y": { helper: 3 } }, "x/y") === null);
	expect("shortModelId drops the provider prefix", module_.shortModelId("cliproxy/claude-haiku-5-5") === "claude-haiku-5-5" && module_.shortModelId("openrouter/a/b") === "a/b");
	expect("the roles line sits directly under the model controls", /<\/div>\n\t+<ModelRolesLine model=\{model\} roles=\{selectedModelRoles\(modelRoles, model\)\} \/>/.test(panel));
	expect("the roles line labels go through ko()", panel.includes('ko("helper", "보조")') && panel.includes('ko("advisor", "자문")') && panel.includes('ko("vision", "비전")'));
	expect("the roles are never persisted", !/storeModel\([^)]*[Rr]oles|localStorage[^\n]*roles/.test(panel + client));
	expect("the roles line is token-driven", /\.agent-model-roles\s*\{[^}]*color: var\(--agent-text-dim\)/.test(css));
	const { parseSync } = await import("rolldown/experimental");
	const { transformWithOxc } = await import("vite");
	const React = await import("react");
	const { renderToStaticMarkup } = await import("react-dom/server");
	const scope = { React, ko: (english) => english, shortModelId: module_.shortModelId };
	const source = parseSync("AgentPanel.jsx", panel).program.body
		.filter((node) => node.type === "FunctionDeclaration" && node.id.name === "ModelRolesLine")
		.map((node) => panel.slice(node.start, node.end)).join("\n");
	const { code } = await transformWithOxc(`function line() {\n${source}\nreturn ModelRolesLine;\n}`, "line.jsx", { lang: "jsx", jsx: { runtime: "classic" } });
	const ModelRolesLine = new Function(...Object.keys(scope), `${code}\nreturn line();`)(...Object.values(scope));
	const rendered = renderToStaticMarkup(React.createElement(ModelRolesLine, { model: "cliproxy/claude-opus-5-5", roles: byMain["cliproxy/claude-opus-5-5"] }));
	expect("the roles line reads helper · id · advisor · id", rendered === '<p class="agent-model-roles" data-agent-model-roles="true">helper · claude-haiku-5-5 · advisor · claude-sonnet-5-5</p>', rendered);
	const borrowed = renderToStaticMarkup(React.createElement(ModelRolesLine, { model: "cliproxy/claude-sonnet-5-5", roles: { helper: "cliproxy/claude-haiku-5-5", vision: "cliproxy/claude-haiku-5-5", advisor: "cliproxy/claude-sonnet-5-5" } }));
	expect("a borrowed vision model is named", borrowed.includes("vision · claude-haiku-5-5"), borrowed);
	expect("no roles, no line", renderToStaticMarkup(React.createElement(ModelRolesLine, { model: "x/y", roles: null })) === "");
}

// --- supervisor note (#728) ------------------------------------------------
// After a reviewable Studio turn has ended, the store asks the sidecar once
// for the supervisor's note and appends it; the card renders it muted, with a
// button that sends its blockers and concerns as the next turn.
{
	const note = { type: "supervisor", turnId: "turn-1", verdict: "reviewed", model: "cliproxy/claude-opus-5-5", effort: "high", elapsedMs: 4200, eventSeq: 9,
		summary: "The chair landed; the reply claims a verification that did not run.",
		items: [{ text: "Chair 1.4 m left of Alex", status: "done", evidence: "receipt-1 actualGapM 1.4" }],
		issues: [{ severity: "blocker", kind: "honesty", text: "Claims a verify that never ran", evidence: "no verify_result call" }, { severity: "concern", kind: "framing", text: "Chair clipped at frame left", evidence: "clipped: true" }, { severity: "note", kind: "spatial", text: "Chair faces the wall", evidence: "yawDeg 180" }],
		counts: { blocker: 1, concern: 1, note: 1 } };
	expect("the client asks the supervisor route", client.includes("/supervisor`") && client.includes("requestSupervisorNote(turnId)"));
	expect("the send label goes through ko()", panel.includes('ko("Send as next prompt", "다음 턴으로 보내기")'));
	expect("the supervisor card is token-driven and muted", /\.agent-supervisor-card\s*\{[^}]*color: var\(--agent-text-muted\)/.test(css));
	// The composer has no supervisor switch: a Studio turn never asks for the review.
	expect("the composer sends no supervisor flag", !panel.includes("supervisor: supervisorOn") && !panel.includes("agent-supervisor-toggle${"));
	const drive = async (frames, options = { supervisor: true }) => {
		const asked = [], requests = [];
		let store;
		const transport = {
			async turn(request, onEvent) { requests.push(request); for (const frame of frames) onEvent(frame); onEvent({ type: "done" }); },
			async supervisor(turnId) { asked.push({ turnId, streaming: store.getState().streaming, status: store.getState().lastTurn?.status }); return note; },
		};
		store = createAgentChatStore({ transport, surface: "studio", buildContext: () => ({ schema: "studio-context-v1" }) });
		const arrived = new Promise((resolve) => { const off = store.subscribe((state) => { if (state.items.some((item) => item.kind === "supervisor")) { off(); resolve(); } }); });
		await store.send("put a chair left of her", options);
		return { store, asked, requests, arrived, turnId: store.getState().turnId };
	};
	const authoredFrames = [{ type: "tool.start", callId: "c1", name: "arrange_objects" }, { type: "tool.done", callId: "c1", ok: true, result: { ok: true, authored: true, receiptId: "receipt-1", affectedIds: ["chair"] } }, { type: "text.delta", text: "Placed." }];
	const unasked = await drive(authoredFrames, {});
	await new Promise((resolve) => setImmediate(resolve));
	expect("an authored turn sent without the switch never asks for a note", unasked.asked.length === 0 && !("supervisor" in unasked.requests[0]), JSON.stringify(unasked.asked));
	const switchedOff = await drive(authoredFrames, { supervisor: false });
	await new Promise((resolve) => setImmediate(resolve));
	expect("a turn sent with the switch off never asks and says so", switchedOff.asked.length === 0 && switchedOff.requests[0].supervisor === false);
	const authored = await drive(authoredFrames);
	expect("a turn sent with the switch on carries supervisor: true", authored.requests[0].supervisor === true);
	let deadline;
	await Promise.race([authored.arrived, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("supervisor note never arrived")), 5000); })]).finally(() => clearTimeout(deadline));
	expect("an authored Studio turn asks for its note once, after it is Ready", authored.asked.length === 1 && authored.asked[0].turnId === authored.turnId && authored.asked[0].streaming === false && authored.asked[0].status === "done", JSON.stringify(authored.asked));
	const card = authored.store.getState().items.find((item) => item.kind === "supervisor");
	expect("the note joins the transcript as a supervisor item", card?.id === `supervisor:${authored.turnId}` && card.summary === note.summary && card.counts.blocker === 1, JSON.stringify(card));
	expect("an explicit-on turn gets exactly one supervisor item", authored.store.getState().items.filter((item) => item.kind === "supervisor").length === 1);
	// The wire body: the sidecar reviews only a turn that says supervisor: true.
	const bodies = [];
	const wire = module_.createHttpTransport({ fetchImpl: async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response('data: {"type":"done"}\n\n', { status: 200, headers: { "content-type": "text/event-stream" } }); } });
	const studioTurn = (extra) => wire.turn({ surface: "studio", sessionId: "s", turnId: "t", text: "x", context: {}, ...extra }, () => {}, new AbortController().signal);
	await studioTurn({});
	await studioTurn({ supervisor: true });
	await studioTurn({ supervisor: false });
	expect("the Studio body sends the switch only when set", !("supervisor" in bodies[0]) && bodies[1].supervisor === true && bodies[2].supervisor === false, JSON.stringify(bodies));
	const readOnly = await drive([{ type: "tool.start", callId: "c1", name: "inspect_studio" }, { type: "tool.done", callId: "c1", ok: true, result: { entities: [] } }, { type: "text.delta", text: "One character." }]);
	await new Promise((resolve) => setImmediate(resolve));
	expect("a read-only turn never asks for a note", readOnly.asked.length === 0, JSON.stringify(readOnly.asked));
	const refused = await drive([{ type: "tool.start", callId: "c1", name: "run_action" }, { type: "tool.done", callId: "c1", ok: false, error: "TARGET_NOT_READY: Capsule figures cannot pose." }, { type: "text.delta", text: "It cannot pose." }]);
	await refused.arrived;
	expect("a refused turn asks for its note", refused.asked.length === 1);
	const followUp = module_.supervisorFollowUp(note);
	expect("the next prompt carries the blockers and concerns, not the notes", followUp.includes("[blocker] Claims a verify that never ran (no verify_result call)") && followUp.includes("[concern] Chair clipped at frame left") && !followUp.includes("faces the wall"), followUp);
	expect("a note without blockers or concerns suggests no prompt", module_.supervisorFollowUp({ issues: [note.issues[2]] }) === null);

	const { parseSync } = await import("rolldown/experimental");
	const { transformWithOxc } = await import("vite");
	const React = await import("react");
	const { renderToStaticMarkup } = await import("react-dom/server");
	const source = parseSync("AgentPanel.jsx", panel).program.body
		.filter((node) => (node.type === "FunctionDeclaration" && node.id.name === "SupervisorCard")
			|| (node.type === "VariableDeclaration" && ["SUPERVISOR_SEVERITY_COPY", "SUPERVISOR_STATUS_COPY"].includes(node.declarations[0]?.id?.name)))
		.map((node) => panel.slice(node.start, node.end)).join("\n");
	const { code } = await transformWithOxc(`function card() {\n${source}\nreturn SupervisorCard;\n}`, "card.jsx", { lang: "jsx", jsx: { runtime: "classic" } });
	const cardFor = (locale) => new Function("React", "useState", "ko", "supervisorFollowUp", `${code}\nreturn card();`)(React, React.useState, (english, korean) => locale === "ko" ? korean : english, module_.supervisorFollowUp);
	const render = (locale, props) => renderToStaticMarkup(React.createElement(cardFor(locale), { onSend() {}, ...props }));
	const collapsed = render("en", { note });
	expect("collapsed: summary, counts and the send button, no lists", collapsed.includes(note.summary) && collapsed.includes("1 blocker") && collapsed.includes("1 concern") && collapsed.includes("1 note")
		&& collapsed.includes("Send as next prompt") && collapsed.includes('data-open="false"') && !collapsed.includes("Chair 1.4 m left of Alex"), collapsed);
	const expanded = render("en", { note, defaultOpen: true });
	expect("expanded: items and issues with their evidence", expanded.includes("done · Chair 1.4 m left of Alex — receipt-1 actualGapM 1.4") && expanded.includes("blocker · Claims a verify that never ran — no verify_result call")
		&& expanded.includes("note · Chair faces the wall") && expanded.includes('aria-expanded="true"'), expanded);
	expect("the send button reads in Korean under the Korean locale", render("ko", { note }).includes("다음 턴으로 보내기"));
	const unavailable = render("en", { note: { ...note, verdict: "unavailable", reason: "the reviewer request timed out", summary: "", items: [], issues: [], counts: { blocker: 0, concern: 0, note: 0 } } });
	// A note with fixes (#743): each fix is a code line under its issue, and the
	// button says it applies them.
	const pose = { action: "character.setPose", args: { characterId: "char-b", posture: "sit" } };
	const fixNote = { ...note, issues: [{ ...note.issues[0], fix: pose }, ...note.issues.slice(1)], fixes: [{ issueIndex: 0, severity: "blocker", ...pose }], counts: { ...note.counts, fixes: 1 } };
	expect("the fixes label goes through ko()", panel.includes('ko("Apply fixes as next prompt", "수정안 다음 턴으로 보내기")'));
	const withFixes = render("en", { note: fixNote, defaultOpen: true });
	const fixLine = `<code class="agent-supervisor-fix" data-fix-action="character.setPose">run_action ${JSON.stringify(pose).replaceAll('"', "&quot;")}</code>`;
	expect("expanded: the fix is a code line under its issue", withFixes.includes(`Claims a verify that never ran — no verify_result call${fixLine}</li>`) && (withFixes.match(/agent-supervisor-fix/g) ?? []).length === 1, withFixes);
	expect("a note with fixes offers to apply them", withFixes.includes("Apply fixes as next prompt") && !withFixes.includes("Send as next prompt") && !withFixes.includes("title="), withFixes);
	expect("the fixes label reads in Korean under the Korean locale", render("ko", { note: fixNote }).includes("수정안 다음 턴으로 보내기"));
	expect("autofix only adds the button tooltip", render("en", { note: { ...fixNote, autofix: { eligible: true, severity: "blocker" } } }).includes('title="Autofix is on: the blocker fixes would be applied as written"'));
	expect("collapsed: no fix line", !render("en", { note: fixNote }).includes("agent-supervisor-fix"));
	expect("an unavailable review is one muted line", unavailable === '<div class="agent-card agent-supervisor-card" data-supervisor-verdict="unavailable"><p class="agent-supervisor-summary">Supervisor review unavailable — the reviewer request timed out</p></div>', unavailable);
}

// --- no agent server (plain vite) ----------------------------------------
// Without the sidecar every /agent/* answers 503 (or the port is dead). The panel shows a quiet
// "not running" status with a Retry instead of sign-in buttons that could only fail silently.
{
	const failing = (response) => module_.createHttpTransport({ fetchImpl: async () => { if (response instanceof Error) throw response; return response; } });
	const reason = async (transport) => { try { await transport.models(); return null; } catch (error) { return error; } };
	for (const status of [503, 502, 404]) {
		const error = await reason(failing(new Response(JSON.stringify({ error: "agent sidecar is not configured" }), { status, headers: { "content-type": "application/json" } })));
		expect(`a ${status} from /agent/models reads as no agent server`, module_.agentServerUnavailable(error), String(error?.status));
	}
	expect("a network error reads as no agent server", module_.agentServerUnavailable(await reason(failing(new TypeError("Failed to fetch")))));
	expect("the server's own refusal is not \"offline\"", !module_.agentServerUnavailable(await reason(failing(new Response("{}", { status: 500 })))) && !module_.agentServerUnavailable({ status: 401 }));
	expect("the panel probes into an offline state and retries it", panel.includes('setAuthState("offline")') && /\}, \[applyModelList, probe, sessionState, transport\]\);/.test(panel) && panel.includes("<OfflineCard probing={probing} onRetry={retryServer} />"));
	expect("offline hides the sign-in card and the login list", !/authState === "offline"[^\n]*agent-signin/.test(panel) && panel.includes('keysOpen && authState !== "offline" && <LoginPanel'));
	// #1044: the reason (a start that failed, or how the sidecar's wait ended) sits above the button that tries again.
	expect("a failed ChatGPT sign-in shows its reason and tries again in place", /\{\(signInError \|\| SIGN_IN_FAILURE_COPY\[account\?\.failure\]\) && <p className="agent-key-error agent-signin-error" role="alert"[^\n]*\n\t+<button type="button" className="agent-primary-button agent-signin" onClick=\{signIn\}>\{signInError \|\| SIGN_IN_FAILURE_COPY\[account\?\.failure\] \? "Try again: sign in with ChatGPT" : "Sign in with ChatGPT"\}/.test(panel));
	expect("the ChatGPT waiting card says what to do, when it stops waiting, and can be cancelled", readFileSync(new URL("../src/workflow/AgentWaitCards.jsx", import.meta.url), "utf8").includes("data-agent-signin-wait") && panel.includes("<SigningInCard account={account} onCancel={cancelSignIn}") && panel.includes('connectFinished("cancelled", "user_closed")'));
	expect("the offline card is token-driven", /\.agent-offline-icon \{[^}]*color: var\(--agent-text-muted\)/.test(css));
	const { parseSync } = await import("rolldown/experimental");
	const { transformWithOxc } = await import("vite");
	const React = await import("react");
	const { renderToStaticMarkup } = await import("react-dom/server");
	const { FiDownload, FiPower, FiRotateCw } = await import("react-icons/fi");
	// The card lives in its own module; hosted (an https page, no agent server to start) reads differently from self-served.
	const cardFile = readFileSync(new URL("../src/workflow/AgentOfflineCard.jsx", import.meta.url), "utf8");
	const build = (koImpl, hosted) => {
		const scope = { React, FiDownload, FiPower, FiRotateCw, ko: koImpl, hostedPage: () => hosted, INSTALL_URL: "https://cozyclay.org/#install", AgentHostedDemos: () => React.createElement("div", { "data-fid": "agent_demos" }) };
		const source = parseSync("AgentOfflineCard.jsx", cardFile).program.body.map((node) => node.declaration ?? node).find((node) => node.type === "FunctionDeclaration" && node.id.name === "OfflineCard");
		return { scope, source: cardFile.slice(source.start, source.end) };
	};
	const render = async (koImpl, props, hosted = false) => {
		const { scope, source } = build(koImpl, hosted);
		const { code } = await transformWithOxc(`function card() {\n${source}\nreturn OfflineCard;\n}`, "card.jsx", { lang: "jsx", jsx: { runtime: "classic" } });
		const OfflineCard = new Function(...Object.keys(scope), `${code}\nreturn card();`)(...Object.values(scope));
		return renderToStaticMarkup(React.createElement(OfflineCard, props));
	};
	const en = await render((english) => english, { probing: false, onRetry() {} });
	expect("offline: the title says the agent server is not running", en.includes("<h3>Agent server is not running</h3>"), en);
	expect("offline: one line says how to start it", en.includes("Start CozyClay with <code>npx cozyclay</code> (or <code>npm run dev</code> in a checkout) to sign in."), en);
	expect("offline: a polite live status with an icon, not colour alone", en.includes('role="status"') && en.includes('aria-live="polite"') && en.includes("<svg") && en.includes('aria-hidden="true"'), en);
	expect("offline: a Retry button and no sign-in button", en.includes(" Retry</button>") && !en.includes("Sign in with ChatGPT") && !en.includes("another provider"), en);
	const busy = await render((english) => english, { probing: true, onRetry() {} });
	expect("offline: Retry is busy while it re-probes", busy.includes("disabled") && busy.includes('aria-busy="true"') && busy.includes("Checking…"), busy);
	const korean = await render((_english, koText) => koText, { probing: false, onRetry() {} });
	expect("offline: the card reads in Korean under the Korean locale", korean.includes("에이전트 서버가 실행 중이 아니에요") && korean.includes("다시 확인"), korean);
	expect("the panel imports the card, and the card decides hosted by the page's protocol or ?try", panel.includes('import { OfflineCard } from "./AgentOfflineCard.jsx";') && cardFile.includes('globalThis.location?.protocol === "https:" || new URLSearchParams(globalThis.location?.search ?? "").has("try")'));
	const hosted = await render((english) => english, { probing: false, onRetry() {} }, true);
	expect("hosted: the title offers a look at the agent, not a server that is down", hosted.includes("<h3>See what the agent does</h3>") && !hosted.includes("not running"), hosted);
	expect("hosted: the ready-made requests come before the way to use it for real", hosted.indexOf('data-fid="agent_demos"') > 0 && hosted.indexOf('data-fid="agent_demos"') < hosted.indexOf("Install CozyClay</a>") && hosted.includes("These three are ready-made results"), hosted);
	expect("hosted: one Install button that opens the landing page's install steps, with no Retry that could only fail", hosted.includes('href="https://cozyclay.org/#install"') && hosted.includes("Install CozyClay</a>") && hosted.includes("agent-primary-button") && !hosted.includes("Retry") && !hosted.includes("<code>") && hosted.includes('data-agent-offline="hosted"'), hosted);
	const hostedKo = await render((_english, koText) => koText, { probing: false, onRetry() {} }, true);
	expect("hosted: the card reads in Korean under the Korean locale", hostedKo.includes("에이전트가 하는 일 보기") && hostedKo.includes("CozyClay 설치"), hostedKo);
	// The demos: a walk and a flip from the sample motions, and a street of eight buildings around the character.
	const demos = readFileSync(new URL("../src/workflow/AgentHostedDemos.jsx", import.meta.url), "utf8");
	expect("the demos run the same commands the agent would: motion.compile, object.add, object.update", demos.includes('app.bus.run("motion.compile"') && demos.includes('app.bus.run("object.add", { kind: "cube"') && demos.includes('app.bus.run("object.update"') && demos.includes('sampleMotionSpec(id, who)'));
	expect("a second press does not build the street twice", demos.includes("if (have.has(name)) continue;"));
	const { demoStreet } = await import("../src/workflow/agent-demo-set.js");
	const street = demoStreet({ x: 0, z: 0, rot: 0 });
	expect("the street is eight buildings with distinct names, four a side", street.length === 8 && new Set(street.map((b) => b.name)).size === 8 && street.filter((b) => b.x > 0).length === 4 && street.filter((b) => b.x < 0).length === 4, JSON.stringify(street));
	expect("the way the character walks in stays clear: no building within 4 m of the centre line, none in front of it", street.every((b) => Math.abs(b.x) - b.scaleX / 2 >= 4 && b.z <= 0), JSON.stringify(street));
	const turned = demoStreet({ x: 2, z: 1, rot: 90 });
	expect("the street turns and moves with the character", turned.every((b, i) => Math.abs((b.x - 2) - street[i].z) < 0.01 && Math.abs((b.z - 1) + street[i].x) < 0.01 && b.rot === 90), JSON.stringify(turned));
}

// The model-connect funnel (PR E): one attempt is one connect_started and one connect_finished, the
// step it reached, and cancelled (the user's Cancel) apart from abandoned (closed or left unfinished).
{
	const { connectOpened, connectStarted, connectStep, connectFinished, connectPanelClosed, connectAuthState, modelChanged, noteTurnOutcome, connectTelemetrySeam } = await import("../src/workflow/connect-telemetry.js");
	const friction = await import("../src/analytics-friction.js");
	const { sanitizeProps } = await import("../src/analytics.js");
	const store = new Map();
	const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) } });
	friction.reset();
	const sent = [];
	let clock = 0;
	const restore = connectTelemetrySeam({ capture: (event, props) => sent.push({ event, props }), clock: () => clock });
	try {
		connectOpened("signed_out");
		connectOpened("menu");
		connectStarted("openrouter", "api_key");
		connectStep("waiting"); connectStep("prompt");
		clock += 4000;
		connectFinished("cancelled");
		connectFinished("cancelled");
		connectStarted("some-new-cloud", "api_key");
		connectStep("waiting");
		clock += 42_000;
		connectFinished("ok");
		connectOpened("signed_out");
		const rows = sent.splice(0);
		expect("connect: the signed-out card reads first_run until this profile connected once, then signed_out",
			rows[0].props.entry === "first_run" && rows.at(-1).props.entry === "signed_out", JSON.stringify(rows));
		const started = rows.filter((row) => row.event === "agent:connect_started"), finished = rows.filter((row) => row.event === "agent:connect_finished");
		expect("connect: each attempt is one started and one finished, a second finish sends nothing", started.length === 2 && finished.length === 2, JSON.stringify(rows));
		expect("connect: Cancel is cancelled at the step it reached; ok ends at done with its duration; unknown ids are other",
			JSON.stringify(finished.map((row) => row.props)) === JSON.stringify([
				{ provider: "openrouter", method: "api_key", outcome: "cancelled", step: "prompt", duration: "lt10s" },
				{ provider: "other", method: "api_key", outcome: "ok", step: "done", duration: "30-60s" },
			]), JSON.stringify(finished));
		connectStarted("anthropic", "api_key"); connectStep("waiting");
		connectPanelClosed();
		connectStarted("google", "api_key");
		connectStarted("openai", "api_key");
		connectFinished("failed");
		const abandoned = sent.splice(0).filter((row) => row.event === "agent:connect_finished").map((row) => `${row.props.provider}:${row.props.outcome}:${row.props.step}`);
		expect("connect: closing the panel mid-flow and starting over both abandon the open attempt", JSON.stringify(abandoned) === JSON.stringify(["anthropic:abandoned:waiting", "google:abandoned:list", "openai:failed:list"]), JSON.stringify(abandoned));
		// ChatGPT's sign-in leaves the panel and settles with the agent panel's auth state.
		connectStarted("openai-codex", "chatgpt");
		connectPanelClosed();
		connectAuthState("signing-in", { signedIn: false, pending: false });
		connectAuthState("ready", { signedIn: true });
		connectStarted("openai-codex", "chatgpt"); connectAuthState("signing-in", { signedIn: false }); connectAuthState("signed-out", { signedIn: false, pending: false });
		const chatgpt = sent.splice(0).filter((row) => row.event === "agent:connect_finished").map((row) => `${row.props.outcome}:${row.props.step}`);
		expect("connect: a ChatGPT sign-in survives the panel closing; ChatGPT signed in is ok, back to signed-out is abandoned", JSON.stringify(chatgpt) === JSON.stringify(["ok:done", "abandoned:waiting"]), JSON.stringify(chatgpt));
		// #929 review: another provider's key makes the panel ready while ChatGPT is still pending; that is not ok.
		connectStarted("openai-codex", "chatgpt"); connectAuthState("signing-in", { signedIn: false });
		connectAuthState("ready", { signedIn: false, pending: true, providersConfigured: 1 });
		const stillOpen = sent.filter((row) => row.event === "agent:connect_finished").length;
		connectAuthState("ready", { signedIn: true, providersConfigured: 1 });
		connectStarted("openai-codex", "chatgpt"); connectAuthState("signing-in", { signedIn: false });
		connectAuthState("ready", { signedIn: false, pending: true, providersConfigured: 1 }); connectAuthState("ready", { signedIn: false, pending: false, providersConfigured: 1 });
		const keyed = sent.splice(0).filter((row) => row.event === "agent:connect_finished").map((row) => `${row.props.outcome}:${row.props.step}`);
		expect("connect: with another provider ready, a pending ChatGPT sign-in stays open; ok waits for ChatGPT itself, an ended unsigned one is abandoned",
			stillOpen === 0 && JSON.stringify(keyed) === JSON.stringify(["ok:done", "abandoned:waiting"]), JSON.stringify({ stillOpen, keyed }));
		// #1044: why an attempt did not connect, a class only, on failed / cancelled / abandoned; never on ok.
		connectStarted("openai-codex", "chatgpt"); connectAuthState("signing-in", { signedIn: false, pending: true });
		connectAuthState("signed-out", { signedIn: false, failure: "timeout" });
		connectStarted("openai-codex", "chatgpt"); connectAuthState("signing-in", { signedIn: false, pending: true });
		connectAuthState("signed-out", { signedIn: false, failure: "callback_error" });
		connectStarted("openai-codex", "chatgpt"); connectFinished("failed", "port_busy");
		connectStarted("anthropic-subscription", "oauth"); connectStep("waiting"); connectFinished("cancelled", "user_closed");
		connectStarted("anthropic-subscription", "oauth"); connectStep("waiting"); connectFinished("failed", "a message, not a class");
		connectStarted("anthropic-subscription", "oauth"); connectFinished("ok", "timeout");
		const reasons = sent.splice(0).filter((row) => row.event === "agent:connect_finished").map((row) => `${row.props.outcome}:${row.props.step}:${row.props.reason ?? "-"}`);
		expect("connect: a failed or closed wait names its class (timeout, callback_error, port_busy, user_closed, other), ok none",
			JSON.stringify(reasons) === JSON.stringify(["failed:waiting:timeout", "failed:waiting:callback_error", "failed:list:port_busy", "cancelled:waiting:user_closed", "failed:waiting:other", "ok:done:-"]), JSON.stringify(reasons));
		const sanitizedReason = sanitizeProps("agent:connect_finished", { provider: "openai-codex", method: "chatgpt", outcome: "failed", step: "waiting", duration: "lt10s", reason: "timeout" });
		expect("connect: the reason survives the closed schema", sanitizedReason.reason === "timeout" && !Object.hasOwn(sanitizeProps("agent:connect_finished", { reason: "EADDRINUSE 127.0.0.1:1455" }), "reason"), JSON.stringify(sanitizedReason));
		// Caps: connect_opened 5, model_changed 10 per session; after_failure follows the last turn.
		for (let i = 0; i < 9; i += 1) connectOpened("menu");
		noteTurnOutcome("failed"); modelChanged("anthropic/claude-x");
		noteTurnOutcome("succeeded"); for (let i = 0; i < 14; i += 1) modelChanged("private-cloud/model");
		const capped = sent.splice(0);
		const models = capped.filter((row) => row.event === "agent:model_changed");
		expect("connect: caps hold (opened 5 with the 3 above, model_changed 10)", capped.filter((row) => row.event === "agent:connect_opened").length === 2 && models.length === 10, JSON.stringify(capped.length));
		expect("connect: model_changed names the provider family and whether the last turn failed", JSON.stringify(models[0].props) === JSON.stringify({ provider: "anthropic", after_failure: true }) && models[1].props.provider === "other" && models[1].props.after_failure === false, JSON.stringify(models.slice(0, 2)));
		expect("connect: every payload passes the closed schema", [...rows, ...capped].every(({ event, props }) => JSON.stringify(sanitizeProps(event, props)) === JSON.stringify(props)));
		// The wiring: LoginPanel starts api-key/oauth attempts, AgentPanel the ChatGPT one and the openers.
		const panelSource = readFileSync(new URL("../src/workflow/AgentPanel.jsx", import.meta.url), "utf8");
		expect("prompt_sent: every send path names its via, the chip and the draft are noted, and the panel stages before it sends",
			["\"retry_button\")", "\"regenerate\")", "\"supervisor\")"].every((via) => panelSource.includes(via)) && panelSource.includes("noteChipDraft(); store.setDraft(chip)")
			&& panelSource.includes("noteDraftInput(); store.setDraft(event.target.value)") && /stagePrompt\(text, [^\n]*\n\s*return store\.send\(text/.test(panelSource));
		expect("connect: the four openers and the ChatGPT attempt are wired", login.includes("connectStarted(provider.id, method.type)") && login.includes('connectFinished("cancelled", "user_closed")') && login.includes('connectFinished("abandoned", "user_closed")')
			&& panelSource.includes('connectOpened("menu")') && panelSource.includes('openProviderKeys("signed_out")') && panelSource.includes('openProviderKeys("failure_card")') && panelSource.includes('connectStarted("openai-codex", "chatgpt")') && panelSource.includes("connectAuthState(authState, account)") && panelSource.includes("if (result.ok) noteDraftConsumed();"));
	} finally {
		restore(); friction.reset();
		if (saved) Object.defineProperty(globalThis, "localStorage", saved); else delete globalThis.localStorage;
	}
}

if (failures) {
	console.error(`${failures} FAILURES`);
	process.exitCode = 1;
} else {
	console.log("all agent panel checks PASS");
}
