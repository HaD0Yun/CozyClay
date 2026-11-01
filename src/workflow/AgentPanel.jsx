import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { FiAlertTriangle, FiArrowUp, FiCamera, FiCheck, FiChevronRight, FiClock, FiDownload, FiImage, FiMoreHorizontal, FiPaperclip, FiPlus, FiPower, FiRotateCw, FiX } from "react-icons/fi";
import { ATTACHMENT_ACCEPT, ATTACHMENT_FAILED_NOTICE, ATTACHMENT_LIMIT_NOTICE, ATTACHMENT_TYPE_NOTICE, attachmentFilesFromTransfer, attachmentFromFile, transferCarriesFiles } from "./attachment-image.js";
import { isImeComposing } from "../ime.js";
import { useStudioShell } from "../shell/studio-shell-context.js";
import { ko } from "../locale.js"; import { saveExport } from "../export-workspace.js"; import { AgentContextMeter } from "./AgentContextMeter.jsx";
import {
	AGENT_PANEL_OVERLAY_BREAKPOINT,
	AGENT_PANEL_RAIL_WIDTH,
	AGENT_PANEL_WIDTH_MAX, AGENT_PANEL_WIDTH_MIN,
	AGENT_STATES,
	agentServerUnavailable,
	describeActivity,
	JOB_STATE_COPY,
	createAgentChatStore,
	effortOptions,
	ERROR_COPY,
	formatJobProgress,
	isTerminalJobState,
	jobStateTone,
	modelIsSelectable,
	nextSelectedModel,
	AGENT_PANEL_WIDTH_DEFAULT,
	clampPanelWidth,
	createAgentTransport,
	panelPresentation,
	requestHostImageAction,
	formatTurnClock,
	formatResetIn,
	readStoredPanelWidth,
	storeModel, storePanelWidth,
	STUDIO_SESSION_STORAGE_KEY,
	selectedModelRoles,
	shortModelId,
	supervisorFollowUp,
} from "./agent-client.js";
import { TaskDetail, TaskRows, TaskStrip, readStoredTaskMode, storeTaskMode } from "./TaskInline.jsx";
import "./agent-panel.css";
// The task board (task mode, parallel Studio tasks) loads only where it is used: the Studio, never the workflow page.
const TaskBoard = lazy(() => import("./TaskBoard.jsx"));
import { AgentProgressCard } from "./AgentProgressCard.jsx";
import { LoginPanel } from "./LoginPanel.jsx";
import { TurnSteps } from "./AgentTurnSteps.jsx";
import { PlanCard } from "./AgentPlanCard.jsx";
import { ReplyText } from "./AgentReplyText.jsx";
import { stepLabel, turnLayout } from "./agent-turn.js";
import { connectAuthState, connectFinished, connectOpened, connectStarted, modelChanged } from "./connect-telemetry.js";
import { noteChipDraft, noteDraftConsumed, noteDraftInput, stagePrompt } from "./prompt-telemetry.js";

function relativeTime(value, now = Date.now()) {
	const at = Date.parse(value || "");
	if (!Number.isFinite(at)) return "just now";
	const seconds = Math.max(0, Math.floor((now - at) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

function StatusDot({ tone, title }) {
	return <span className={`agent-status-dot ${tone}`} title={title} aria-hidden="true" />;
}

function ImageResultCard({ image, onUse, onUndo, onRegenerate, onOpen }) {
	const applying = image.apply?.status === "applying";
	const failed = image.apply?.status === "failed";
	return <div className="agent-card agent-image-card" data-image-id={image.imageId} data-placed={image.placed ? "true" : "false"} data-apply-status={image.apply?.status || "idle"}>
		<figure>
			<img src={image.dataUrl} width={image.width} height={image.height} alt={image.prompt || "Generated image"} onClick={() => onOpen(image)} />
		</figure>
		{image.placed
			? <div className="agent-placed"><StatusDot tone="ok" />Placed<button type="button" className="agent-image-undo" disabled={applying} onClick={() => onUndo(image)}>{applying ? "Removing…" : "Undo"}</button></div>
			: <div className="agent-image-actions">
				<button type="button" className="primary agent-image-use" disabled={applying} onClick={() => onUse(image)}><FiImage size={11} /> {applying ? "Applying…" : "Use in scene"}</button>
				<a className="agent-image-download" role="button" href={image.dataUrl} download={`${image.imageId || "agent-image"}.png`} onClick={(event) => { event.preventDefault(); void saveExport(image.dataUrl, `${image.imageId || "agent-image"}.png`); }}><FiDownload size={11} /> Download</a>
				<button type="button" className="agent-image-regenerate" onClick={() => onRegenerate(image)}><FiRotateCw size={11} /> Regenerate</button>
			</div>}
		{/* The card states what the editor actually did: an unacknowledged or
		    refused action is never drawn as a placement. */}
		{failed && <p className="agent-image-error" role="alert">{image.apply.error}</p>}
	</div>;
}

// Plain `vite` serves the Studio without the agent server, so there is nothing to sign in to. The card says
// so and how to start it, in place of sign-in buttons that could only fail.
function OfflineCard({ probing, onRetry }) {
	return <div className="agent-state-card agent-offline-card" data-agent-card="offline" role="status" aria-live="polite">
		<FiPower className="agent-offline-icon" size={18} aria-hidden="true" />
		<h3>{ko("Agent server is not running", "에이전트 서버가 실행 중이 아니에요")}</h3>
		<p>{ko(<>Start CozyClay with <code>npx cozyclay</code> (or <code>npm run dev</code> in a checkout) to sign in.</>,
			<>로그인하려면 <code>npx cozyclay</code>(체크아웃에서는 <code>npm run dev</code>)로 CozyClay를 시작하세요.</>, <>使用 <code>npx cozyclay</code> 启动 CozyClay（在代码检出中使用 <code>npm run dev</code>）即可登录。</>)}</p>
		<button type="button" className="agent-ghost-button agent-offline-retry" onClick={onRetry} disabled={probing} aria-busy={probing}>
			<FiRotateCw size={11} aria-hidden="true" /> {probing ? ko("Checking…", "확인 중…") : ko("Retry", "다시 확인", "重新检查")}
		</button>
	</div>;
}

function PausedCard({ resetAt, onRetry, onSwitchModel }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	const countdown = formatResetIn(resetAt, now);
	return <div className="agent-paused" data-agent-card="rate-limited" role="status">
		<div className="agent-paused-head"><FiClock size={12} aria-hidden="true" /> Paused — usage limit reached
			<span className="agent-paused-countdown">{countdown ? `resets in ${countdown}` : "resets soon"}</span>
		</div>
		<p style={{ margin: 0 }}>{ERROR_COPY.rate_limit}</p>
		<div className="agent-paused-actions">
			<button type="button" className="agent-paused-wait" onClick={onRetry}>Wait &amp; retry</button>
			<button type="button" className="agent-paused-switch" onClick={onSwitchModel}>Switch model</button>
		</div>
	</div>;
}

// The lineup the sidecar derived for the selected model (#717), read-only:
// what a turn may lean on beside it. Vision is named only when it is not the
// selected model itself.
function ModelRolesLine({ model, roles }) {
	if (!roles) return null;
	const parts = [[ko("helper", "보조"), roles.helper], [ko("advisor", "자문"), roles.advisor]];
	if (roles.vision !== model) parts.push([ko("vision", "비전"), roles.vision]);
	return <p className="agent-model-roles" data-agent-model-roles="true">
		{parts.map(([label, key]) => `${label} · ${shortModelId(key)}`).join(" · ")}
	</p>;
}

// A generation is a server-owned job. The card shows the state the runtime
// reported, the phase it named and only a progress value it actually sent.
function JobCard({ job, onStop, onAccept }) {
	const running = !isTerminalJobState(job.state);
	// A finished job never keeps showing the percentage or the phase it was in
	// when it finished; the terminal state and its receipt are the truth.
	const percent = running && Number.isFinite(job.progress) ? Math.round(job.progress * 100) : null;
	const phase = job.state === "installed" ? null : job.phase;
	const unverified = job.state === "review_required" || job.verification?.status === "unverified";
	const limitations = job.verification?.limitations ?? [];
	// An unverified take is installed all the same; the label says both.
	const label = job.state === "installed" && unverified ? "Installed with warnings" : JOB_STATE_COPY[job.state] || job.state;
	return <div className="agent-card agent-job-card" data-job-id={job.jobId} data-job-state={job.state}>
		<div className="agent-job-head">
			<StatusDot tone={jobStateTone(job.state)} title={job.state} />
			<span className="agent-job-label">{label}</span>
			{unverified && <span className="agent-job-badge">Unverified</span>}
			{percent !== null && <span className="agent-job-progress">{formatJobProgress(job.progress)}</span>}
		</div>
		{phase && <p className="agent-job-phase">{phase}</p>}
		{/* An acknowledged Stop states what happened to the scene; the state label
		    alone does not. Uncertainty is reported as uncertainty, never as safety. */}
		{job.outcome?.status === "not_applied" && <p className="agent-job-outcome">Not applied — scene unchanged.</p>}
		{job.outcome?.status === "unknown" && <p className="agent-job-outcome">Stopped, but the result is unknown — reconcile before editing this target.</p>}
		{percent !== null && <div className="agent-job-bar" role="progressbar" aria-label="Generation progress" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
			<span className="agent-job-bar-fill" style={{ transform: `scaleX(${job.progress})` }} />
		</div>}
		{limitations.length > 0 && <ul className="agent-job-limits">{limitations.map((limit) => <li key={limit}>{limit}</li>)}</ul>}
		<div className="agent-job-actions">
			{running && job.state !== "review_required" && <button type="button" className="agent-ghost-button agent-job-stop" onClick={() => onStop(job)}>Stop</button>}
			{job.acceptance?.status === "required" && <button type="button" className="agent-ghost-button agent-job-accept" onClick={() => onAccept(job)}><FiAlertTriangle size={11} /> Apply with warnings</button>}
			{job.acceptance?.status === "accepting" && <span className="agent-job-note">Applying…</span>}
			{job.acceptance?.status === "accepted" && <span className="agent-job-note"><FiCheck size={11} /> Applied at your request</span>}
			{job.acceptance?.error && <span className="agent-job-note alert" role="alert">{job.acceptance.error}</span>}
		</div>
	</div>;
}

function ReceiptCard({ item }) {
	const { receipt = {}, summary } = item;
	const unverified = receipt.verification?.status === "unverified";
	const limitations = receipt.verification?.limitations ?? [];
	const warnings = receipt.warnings ?? [];
	const installedWithWarnings = receipt.status === "installed" && unverified;
	return <div className="agent-card agent-receipt-card" data-receipt-id={item.receiptId} data-receipt-status={receipt.status}>
		<div className="agent-receipt-head">
			<StatusDot tone={unverified ? "warn" : "ok"} title={receipt.status} />
			{installedWithWarnings && <span className="agent-job-label">Installed with warnings</span>}
			<span className="agent-receipt-summary">{summary}</span>
		</div>
		{(warnings.length > 0 || limitations.length > 0) && <ul className="agent-receipt-notes">
			{warnings.map((warning) => <li key={warning.code}>{warning.message || warning.code}</li>)}
			{limitations.map((limit) => <li key={limit}>{limit}</li>)}
		</ul>}
		{/* The pane has no direct Undo into the Studio editor; it names the two
		    paths that do exist rather than drawing a button it cannot honour. */}
		{installedWithWarnings && <p className="agent-job-note">Undo with Cmd+Z or ask the agent.</p>}
	</div>;
}

const SUPERVISOR_SEVERITY_COPY = { blocker: ko("blocker", "차단"), concern: ko("concern", "우려"), note: ko("note", "참고") };
const SUPERVISOR_STATUS_COPY = { done: ko("done", "완료"), partial: ko("partial", "일부"), refused: ko("refused", "거부됨"), missing: ko("missing", "누락") };

// The supervisor's note on a finished Studio turn (#728): muted, collapsed to
// its summary and counts, and never acted on by itself. Its one action puts
// the blockers and concerns into the composer as the author's next turn.
function SupervisorCard({ note, onSend, defaultOpen = false }) {
	const [open, setOpen] = useState(defaultOpen);
	if (note.verdict !== "reviewed") return <div className="agent-card agent-supervisor-card" data-supervisor-verdict="unavailable">
		<p className="agent-supervisor-summary">{ko("Supervisor review unavailable", "감독 검토를 할 수 없었어요")}{note.reason ? ` — ${note.reason}` : ""}</p>
	</div>;
	const followUp = supervisorFollowUp(note);
	// Validated run_action drafts (#743), shown under the issue each one fixes.
	const fixes = Array.isArray(note.fixes) ? note.fixes : [];
	return <div className="agent-card agent-supervisor-card" data-supervisor-verdict="reviewed" data-open={open ? "true" : "false"}>
		<div className="agent-supervisor-head">
			<span className="agent-job-label">{ko("Supervisor", "감독")}</span>
			{["blocker", "concern", "note"].filter((severity) => note.counts?.[severity] > 0).map((severity) => <span key={severity} className={`agent-job-badge agent-supervisor-badge ${severity}`} data-severity={severity}>{note.counts[severity]} {SUPERVISOR_SEVERITY_COPY[severity]}</span>)}
			<button type="button" className="agent-ghost-button agent-supervisor-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? ko("Less", "접기") : ko("Details", "자세히")}</button>
		</div>
		<p className="agent-supervisor-summary">{note.summary}</p>
		{open && note.items?.length > 0 && <ul className="agent-receipt-notes agent-supervisor-items">
			{note.items.map((item, index) => <li key={index} data-status={item.status}>{SUPERVISOR_STATUS_COPY[item.status] ?? item.status} · {item.text}{item.evidence ? ` — ${item.evidence}` : ""}</li>)}
		</ul>}
		{open && note.issues?.length > 0 && <ul className="agent-receipt-notes agent-supervisor-issues">
			{note.issues.map((issue, index) => {
				const fix = fixes.find((entry) => entry.issueIndex === index);
				return <li key={index} data-severity={issue.severity}>{SUPERVISOR_SEVERITY_COPY[issue.severity] ?? issue.severity} · {issue.text}{issue.evidence ? ` — ${issue.evidence}` : ""}
					{fix && <code className="agent-supervisor-fix" data-fix-action={fix.action}>{`run_action ${JSON.stringify({ action: fix.action, args: fix.args })}`}</code>}
				</li>;
			})}
		</ul>}
		{followUp && <div className="agent-job-actions">
			<button type="button" className="agent-ghost-button agent-supervisor-send" onClick={() => onSend(followUp)}
				title={note.autofix?.eligible ? ko("Autofix is on: the blocker fixes would be applied as written", "자동 수정 켜짐: 차단 수정안을 적힌 그대로 적용합니다") : undefined}>
				{fixes.length ? ko("Apply fixes as next prompt", "수정안 다음 턴으로 보내기") : ko("Send as next prompt", "다음 턴으로 보내기")}
			</button>
		</div>}
	</div>;
}

const RECOVERY_COPY = {
	none: "No recovery is available for this command.",
	inspect: "Ask the agent to inspect the target before trying again.",
	retry: "The same command can be retried.",
	new_intent: "Tell the agent what to do with the changed target.",
	reconcile: "The result is unknown; reconcile before changing this target.",
	sign_in: "Sign in again to continue.",
	fix_key: "Log in again under Connect a model, then retry.",
};

function FailureCard({ failure, onRetry, onFixKey }) {
	return <div className="agent-card agent-failure-card" data-failure-code={failure.code} role="alert">
		<div className="agent-failure-head"><FiAlertTriangle size={12} aria-hidden="true" /><span className="agent-failure-code">{failure.code}</span></div>
		<p className="agent-failure-message">{failure.message || "The command did not complete."}</p>
		<p className="agent-failure-recovery">{RECOVERY_COPY[failure.recovery?.action] || RECOVERY_COPY.none}{failure.preserved?.authoredState === "unchanged" ? " Nothing in the scene changed." : failure.preserved?.authoredState === "unknown" ? " Whether the scene changed is unknown." : ""}</p>
		{failure.recovery?.retryAllowed && <div className="agent-error-actions">{failure.recovery.action === "fix_key" && onFixKey && <button type="button" className="agent-ghost-button agent-error-keys" onClick={onFixKey}>Log in again</button>}<button type="button" className="agent-ghost-button agent-error-retry" data-fid="agent_retry" onClick={onRetry}>Retry</button></div>}
	</div>;
}

// `defaultCollapsed` + `onCollapsedChange` let a host mirror the panel's
// visibility in its own chrome (the studio's View ▾ menu) without taking the
// flag away from the panel: the rail button, Cmd/Ctrl+B and the toggle event
// all still flip it here, and the host is told after every flip.
//
// `embedded` is the other arrangement: a host (the Studio Inspector column)
// owns the width, the visibility and the global shortcut, and passes `hidden`.
// The panel then stays mounted with its draft, session and transcript intact,
// renders no rail, no resize handle and no collapse control, and never binds a
// window shortcut that would fire twice.
export default function AgentPanel({
	transport: injectedTransport = null,
	sceneName = "CozyClay Scene",
	defaultCollapsed = false,
	onCollapsedChange = null,
	embedded = false,
	hidden = false,
	surface = "workflow",
	buildContext = null,
	onImageAction = null,
	onReceipt = null,
}) {
	// What this host shows around the shared conversation: labels, chips, the
	// affordances it owns and the ones it has no use for.
	const presentation = useMemo(() => panelPresentation(surface), [surface]);
	// The surface is a prop, not an inference from the address bar: an embedded
	// Studio panel is a Studio panel on every route.
	const transport = useMemo(() => injectedTransport || createAgentTransport({ surface }), [injectedTransport, surface]);
	const mockState = transport.mock ? transport.state : null;

	// Inside the studio the title names the project's previs mode (#650).
	const previsMode = useStudioShell()?.previsMode;
	const titleMode = surface === "studio" && previsMode
		? (previsMode === "storyboard" ? ko("Storyboard", "스토리보드") : ko("Animation", "애니메이션"))
		: null;
	const [collapsed, setCollapsed] = useState(defaultCollapsed);
	// Only the dock owns a width; an embedded host sizes the panel itself and
	// never reads the dock's stored key.
	const [width, setWidth] = useState(() => presentation.persistWidth ? readStoredPanelWidth() : AGENT_PANEL_WIDTH_DEFAULT);
	const [resizing, setResizing] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const [account, setAccount] = useState(null);
	const [authState, setAuthState] = useState("loading");
	// "offline" is its own auth state: no agent server answered /agent/models. Retry bumps `probe`.
	const [probe, setProbe] = useState(0);
	const [probing, setProbing] = useState(false);
	// Why the last ChatGPT sign-in click did not start, under its button; a click never fails silently.
	const [signInError, setSignInError] = useState("");
	// No model is assumed. Sending a guessed id is how a turn fails upstream with
	// nothing the panel can explain, so the composer waits for /agent/models.
	const [models, setModels] = useState([]);
	// The same list grouped by the provider that serves it, which is the only
	// way five providers' models fit one dropdown legibly.
	const [modelProviders, setModelProviders] = useState([]);
	const [model, setModel] = useState("");
	const [modelsState, setModelsState] = useState("loading");
	// The roles derived per main model (#717); shown, never sent or stored.
	const [modelRoles, setModelRoles] = useState(null);
	// null = the model's backend default; picking a model resets it.
	const [effort, setEffort] = useState(null);
	const efforts = useMemo(() => effortOptions(models.find((entry) => entry.id === model)), [models, model]);
	// Picking a model is a preference, not a per-session decision: the key is
	// remembered so a reload does not quietly move the next turn to another
	// provider's model.
	const chooseModel = useCallback((id) => { setModel(id); setEffort(null); storeModel(id); modelChanged(id); }, []);
	// Task mode (parallel Studio tasks): the chat talks to the main agent, which answers at once and runs tasks on the board.
	const [taskMode, setTaskMode] = useState(() => surface === "studio" && readStoredTaskMode());
	const toggleTaskMode = useCallback(() => setTaskMode((current) => { storeTaskMode(!current); return !current; }), []);
	// One place takes `{ providers, models }` from the sidecar: the grouped list
	// the dropdown draws, the flat key-addressed list every lookup uses, and the
	// model to open with. Returns false when nothing was advertised.
	const applyModelList = useCallback((advertised) => {
		const list = Array.isArray(advertised?.models) ? advertised.models : [];
		if (!list.length) return false;
		const providers = Array.isArray(advertised?.providers) ? advertised.providers : [];
		setModelProviders(providers);
		setModels(list);
		setModelRoles(advertised?.roles?.byMain ?? null);
		// A saved or removed key arrives through this same path, so a selection the
		// panel opened with is dropped here the moment its provider cannot run it.
		setModel((current) => nextSelectedModel(providers, list, current));
		setModelsState("ready");
		return true;
	}, []);
	const [attachFrame, setAttachFrame] = useState(false);
	// What the composer refused and why, in one line under the thumbnails: a
	// picture that silently fails to attach is the bug this replaces.
	const [attachNotice, setAttachNotice] = useState(null);
	const [dropping, setDropping] = useState(false);
	const [lightbox, setLightbox] = useState(null);
	const [overlay, setOverlay] = useState(() => !embedded && (globalThis.innerWidth || 1440) < AGENT_PANEL_OVERLAY_BREAKPOINT);
	const [historyOpen, setHistoryOpen] = useState(false);
	// Connect a model (pi's login list, LoginPanel.jsx) reads its own list from the sidecar while it is open.
	const [keysOpen, setKeysOpen] = useState(false);
	const [historySessions, setHistorySessions] = useState([]);
	const [restoreNotice, setRestoreNotice] = useState("");
	// Why the last steer did not reach the running turn. It reads in the same
	// line the restore notice uses, because it is the same kind of statement:
	// something the panel tried and could not do.
	const [steerNotice, setSteerNotice] = useState("");
	const [restoreReady, setRestoreReady] = useState(surface !== "studio");

	const composerRef = useRef(null);
	const fileInputRef = useRef(null);
	const focusPendingRef = useRef(false);
	const transcriptRef = useRef(null);

	// The host's context builder and image-action handler are read through refs
	// so a re-rendered host never rebuilds the conversation.
	const buildContextRef = useRef(buildContext);
	buildContextRef.current = buildContext;
	const imageActionRef = useRef(onImageAction);
	imageActionRef.current = onImageAction;
	const receiptRef = useRef(onReceipt);
	receiptRef.current = onReceipt;

	const store = useMemo(() => createAgentChatStore({
		transport,
		surface,
		buildContext: () => buildContextRef.current?.() ?? null,
		// Host prop first, then the scripted mock host, then the live editor event.
		requestImageAction: (request) => (imageActionRef.current ?? transport.applyImage?.bind(transport) ?? requestHostImageAction)(request),
		onReceipt: (receipt) => receiptRef.current?.(receipt),
		onAuthLost: () => setAuthState("signed-out"),
	}), [surface, transport]);
	const chat = useSyncExternalStore(store.subscribe, store.getState, store.getState);
	const { context, draft, items, pendingAttachments, quota, rateLimit, streaming } = chat;

	// Studio history is sidecar-backed; Workflow keeps the existing in-memory UX.
	useEffect(() => {
		if (surface !== "studio") { setRestoreReady(true); return undefined; }
		let cancelled = false;
		let stored = null;
		try { stored = globalThis.localStorage?.getItem(STUDIO_SESSION_STORAGE_KEY); } catch { /* storage may be unavailable */ }
		if (!stored) { setRestoreReady(true); return undefined; }
		(async () => {
			try {
				const payload = await transport.loadSession(stored);
				if (!Array.isArray(payload?.transcript)) throw new Error("missing transcript");
				if (!cancelled) store.restore(payload.transcript, payload.sessionId || stored);
			} catch (error) {
				if (!cancelled) {
					store.newSession();
					// A session id with no record behind it (the pane opened, nothing
					// was ever sent) is nothing to restore, not a failure; with no agent server the offline card says why.
					if (![404, 502, 503].includes(error?.status) && !(error instanceof TypeError || error instanceof SyntaxError)) setRestoreNotice("Previous conversation could not be restored");
				}
			} finally {
				if (!cancelled) setRestoreReady(true);
			}
		})();
		return () => { cancelled = true; };
	}, [surface, store, transport]);

	useEffect(() => {
		if (surface !== "studio" || !restoreReady) return;
		try { globalThis.localStorage?.setItem(STUDIO_SESSION_STORAGE_KEY, chat.sessionId); } catch { /* storage may be unavailable */ }
	}, [chat.sessionId, restoreReady, surface]);

	// One line that always states what the panel is doing, ticking while a turn
	// is live and holding the turn's outcome for a few seconds after it ends.
	const [activityNow, setActivityNow] = useState(() => Date.now());
	const activity = model
		? describeActivity(chat, { now: activityNow, toolLabel: (call) => stepLabel(call, presentation.toolLabels) })
		: modelsState === "failed"
			? { phase: "no-model", kind: "terminal", tone: "alert", text: "No model available — the agent service did not answer with one", ticking: false }
			: { phase: "models", kind: "live", tone: "busy", text: "Loading models…", ticking: false };
	// The transcript grouped per turn, and the motion progress card (above the latest turn's steps, so the live
	// step stays at the bottom where the transcript scrolls) limited to that turn's drafts.
	const layout = useMemo(() => turnLayout(items, { streaming }), [items, streaming]);
	const turnSince = streaming ? chat.turnStartedAt : chat.lastTurn ? chat.lastTurn.endedAt - chat.lastTurn.durationMs : null;
	const progressCard = <AgentProgressCard items={items} since={turnSince} live={streaming} />;
	useEffect(() => {
		if (!activity.ticking) return;
		const timer = setInterval(() => setActivityNow(Date.now()), 500);
		return () => clearInterval(timer);
	}, [activity.ticking]);

	// Two ways in (#379): the ChatGPT sign-in, or a provider key the sidecar
	// already holds. `providersConfigured` counts the second, so a session that
	// never signed in to ChatGPT still gets a composer instead of a sign-in wall
	// it does not need.
	// The image entitlement only gates a surface that can ask for an image; a
	// Studio turn authors the scene, so a plan without image generation is a
	// perfectly ready session there.
	const sessionState = useCallback((status) => status?.signedIn || status?.providersConfigured > 0
		? (presentation.imageEntitlement && status?.entitlements?.image === false ? "no-entitlement" : "ready")
		: status?.pending ? "signing-in" : "signed-out", [presentation]);
	const readAccount = useCallback(async () => {
		try {
			const status = await transport.status();
			setAccount(status);
			setAuthState(sessionState(status));
			return status;
		} catch {
			setAuthState("signed-out");
			return null;
		}
	}, [sessionState, transport]);
	// Everything an authentication change moves, read back once: WHO the session
	// is (readiness is `signedIn || providersConfigured > 0`), which providers
	// hold a credential, and WHICH models this session may therefore send to. A
	// credential write and a ChatGPT sign-in/sign-out are the same event for the
	// composer — both change the answer to all three — so both come through
	// here, once per transition, beside the rows and the models. That is what
	// lets an author who just signed in (or just saved their first key) type
	// into a composer without reloading the page, and what takes it away again
	// when the last way in goes. No timer is involved.
	const refreshProviderState = useCallback(async () => {
		await readAccount();
		try {
			applyModelList(await transport.models());
		} catch { /* the composer keeps the list it was last advertised */ }
	}, [applyModelList, readAccount, transport]);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			const [status, advertised] = await Promise.allSettled([transport.status(), transport.models()]);
			if (cancelled) return;
			setProbing(false);
			// No agent server behind the page: the panel says so instead of offering sign-ins that cannot work.
			if (advertised.status === "rejected" && agentServerUnavailable(advertised.reason)) { setAuthState("offline"); setModelsState("failed"); return; }
			if (status.status === "fulfilled") { setAccount(status.value); setAuthState(sessionState(status.value)); } else setAuthState("signed-out");
			// An unanswered model list is a visible state, not a silent guess.
			if (advertised.status === "rejected" || !applyModelList(advertised.value)) setModelsState("failed");
		})();
		return () => { cancelled = true; };
	}, [applyModelList, probe, sessionState, transport]);
	const retryServer = useCallback(() => { setProbing(true); setProbe((count) => count + 1); }, []);

	// Sign-in finishes in another window. The panel picks the session up when
	// this document is looked at again, or when the host announces the return —
	// never on a fixed timer.
	useEffect(() => {
		if (authState !== "signing-in") return;
		const onReturn = () => { if (document.visibilityState !== "hidden") refreshProviderState(); };
		window.addEventListener("focus", onReturn);
		window.addEventListener("cozyclay:agent-auth-return", onReturn);
		document.addEventListener("visibilitychange", onReturn);
		return () => {
			window.removeEventListener("focus", onReturn);
			window.removeEventListener("cozyclay:agent-auth-return", onReturn);
			document.removeEventListener("visibilitychange", onReturn);
		};
	}, [authState, refreshProviderState]);

	// Mock states that only exist as a rendered result (a finished streaming
	// turn, a paused card, a failed tool call) are driven by replaying the
	// scripted turn once, so QA screenshots the same code path a live turn uses.
	useEffect(() => {
		if (!mockState || authState !== "ready" || !model) return;
		if (!["streaming", "rate-limited", "error"].includes(mockState)) return;
		if (items.length) return;
		store.send("Give me a wide two-shot of this scene", { attachFrame: false, model });
	}, [authState, items.length, mockState, model, store]);

	useEffect(() => {
		if (embedded) return;
		const onResize = () => setOverlay((globalThis.innerWidth || 1440) < AGENT_PANEL_OVERLAY_BREAKPOINT);
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [embedded]);

	useEffect(() => {
		// An embedded host owns the shortcut; binding it here too would toggle
		// the panel twice per press.
		if (embedded) return;
		const onKey = (event) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
				event.preventDefault();
				setCollapsed((value) => !value);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [embedded]);

	useEffect(() => {
		if (embedded) return;
		const onToggle = () => setCollapsed((value) => !value);
		window.addEventListener("cozyclay:agent-panel-toggle", onToggle);
		return () => window.removeEventListener("cozyclay:agent-panel-toggle", onToggle);
	}, [embedded]);

	useEffect(() => {
		if (embedded) return;
		onCollapsedChange?.(collapsed);
	}, [collapsed, embedded, onCollapsedChange]);

	// Focus moves to the composer whenever the panel opens. The composer only
	// mounts once the session resolves, so authState is a dependency too:
	// otherwise this fires against a composer that does not exist yet. A hidden
	// embedded panel never pulls focus out of the host's own surface. An
	// embedded panel never collapses itself (its host hides it), so shown means
	// open there: without that the Studio composer opened unfocused and the
	// next Cmd+V landed on the stage.
	useEffect(() => {
		if (hidden) {
			// Chrome blurs a hidden focused field only on its next lifecycle step;
			// until then the caret is still inside chrome the author cannot see.
			if (composerRef.current && composerRef.current === document.activeElement) composerRef.current.blur();
			return;
		}
		if (!(embedded || !collapsed)) return;
		composerRef.current?.focus();
		// A composer still waiting on the model list is disabled and refuses
		// focus; the open is remembered so it lands once the composer enables.
		focusPendingRef.current = document.activeElement !== composerRef.current;
	}, [authState, collapsed, embedded, hidden]);

	useEffect(() => {
		const node = transcriptRef.current;
		if (node) node.scrollTop = node.scrollHeight;
	}, [items, streaming]);

	const startResize = useCallback((event) => {
		event.preventDefault();
		setResizing(true);
		const startX = event.clientX;
		const startWidth = width;
		const onMove = (move) => setWidth(clampPanelWidth(startWidth + (startX - move.clientX)));
		const onUp = (up) => {
			setResizing(false);
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			storePanelWidth(clampPanelWidth(startWidth + (startX - up.clientX)));
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}, [width]);

	const nudgeWidth = useCallback((delta) => {
		setWidth((current) => {
			const next = clampPanelWidth(current + delta);
			storePanelWidth(next);
			return next;
		});
	}, []);

	// A screenshot is the fastest thing an author can show the agent, so the
	// composer takes one from the clipboard or the desktop. Only a transfer that
	// actually carries a picture is intercepted: a text paste still lands in the
	// caret, which is the whole reason the studio's document handler steps aside
	// for a textarea in the first place. The paste is taken on the composer
	// block, not the textarea, so the Send and model buttons a click just left
	// focus on do not hand the picture to the stage.
	const attachFiles = useCallback(async (files) => {
		const prepared = [];
		let failed = 0;
		for (const file of files) {
			try { prepared.push(await attachmentFromFile(file)); } catch { failed += 1; }
		}
		const rejected = prepared.length ? store.addAttachments(prepared).rejected : 0;
		setAttachNotice(rejected ? ATTACHMENT_LIMIT_NOTICE : failed ? ATTACHMENT_FAILED_NOTICE : null);
	}, [store]);
	const takeTransfer = useCallback((transfer) => {
		const { images, unsupported } = attachmentFilesFromTransfer(transfer);
		if (!images.length) {
			// A picture in a format the turn cannot carry is refused out loud; a
			// clipboard with no picture at all is simply not ours.
			if (unsupported) setAttachNotice(ATTACHMENT_TYPE_NOTICE);
			return unsupported > 0;
		}
		attachFiles(images);
		return true;
	}, [attachFiles]);
	// The paperclip opens the file picker; what it returns goes through the same rules as a drop.
	const onPickFiles = useCallback((event) => {
		takeTransfer({ files: event.target.files });
		event.target.value = "";
	}, [takeTransfer]);
	const onComposerPaste = useCallback((event) => {
		if (takeTransfer(event.clipboardData)) event.preventDefault();
	}, [takeTransfer]);
	const onComposerDragOver = useCallback((event) => {
		// `files` is withheld until the drop, so the types list is the only thing
		// that can decide whether the composer wants this drag.
		if (!transferCarriesFiles(event.dataTransfer)) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
		setDropping(true);
	}, []);
	const onComposerDragLeave = useCallback((event) => {
		if (!event.currentTarget.contains(event.relatedTarget)) setDropping(false);
	}, []);
	const onComposerDrop = useCallback((event) => {
		setDropping(false);
		// The textarea and the composer both listen; the drop bubbles, so only the first one takes it.
		if (!event.defaultPrevented && takeTransfer(event.dataTransfer)) event.preventDefault();
	}, [takeTransfer]);

	// `via`: how the prompt was sent, for agent:prompt_sent (prompt-telemetry.js keeps no text).
	const runTurn = useCallback((text, via = "typed") => {
		setAttachNotice(null); setSteerNotice("");
		stagePrompt(text, { via, model, attached: attachFrame || store.getState().pendingAttachments.length > 0, taskMode });
		return store.send(text, { attachFrame, model, effort: effort ?? undefined, tasks: taskMode });
	}, [attachFrame, effort, model, store, taskMode]);
	const taskStepLabel = useCallback((call) => stepLabel(call, presentation.toolLabels), [presentation.toolLabels]);
	const stopTurn = useCallback(() => store.stop(), [store]);
	// Steering the turn that is already running: the composer's text joins THAT
	// turn instead of starting a second one. A refusal (the turn ended while the
	// stream was still open, or this surface cannot be steered) says so and
	// leaves the draft to be sent as a normal message.
	const steerTurn = useCallback(async (text) => {
		if (!String(text ?? "").trim()) return;
		setAttachNotice(null); setSteerNotice("");
		const result = await store.steer(text);
		// An accepted steer consumed the draft: its typing time is not the next prompt's (prompt-telemetry.js).
		if (result.ok) noteDraftConsumed(); else setSteerNotice(result.message || "The running turn did not take that message.");
	}, [store]);

	// A sign-in that succeeds is an authentication transition, not a status
	// read: the grouped catalogue's `signedIn` flags — and with them every
	// ChatGPT option the dropdown draws disabled — are only true of the session
	// that asked for them. Refreshing the account alone leaves the panel
	// "ready" with nothing it may send (#379).
	const signIn = useCallback(async () => {
		connectStarted("openai-codex", "chatgpt"); setAuthState("signing-in");
		setSignInError("");
		try {
			await transport.signIn();
			await refreshProviderState();
		} catch (error) {
			connectFinished("failed"); if (agentServerUnavailable(error)) { setAuthState("offline"); return; }
			setSignInError(error?.message || ko("Sign-in could not start.", "로그인을 시작하지 못했어요."));
			setAuthState("signed-out");
		}
	}, [refreshProviderState, transport]);

	const signOut = useCallback(async () => {
		setMenuOpen(false);
		await transport.signOut().catch(() => {});
		// The account this panel was holding is gone. Who the session is now — it
		// may still hold a provider key, which is the other way in — and which
		// models that leaves it is read back through the same refresh.
		setAccount(null);
		store.newSession();
		await refreshProviderState();
	}, [refreshProviderState, store, transport]);

	const newSession = useCallback(() => {
		if (surface === "studio") {
			try { globalThis.localStorage?.removeItem(STUDIO_SESSION_STORAGE_KEY); } catch { /* storage may be unavailable */ }
		}
		store.newSession();
		setHistoryOpen(false);
		setMenuOpen(false);
		composerRef.current?.focus();
	}, [store, surface]);

	const openHistory = useCallback(async () => {
		if (surface !== "studio") return;
		const nextOpen = !historyOpen;
		setHistoryOpen(nextOpen);
		if (!nextOpen) return;
		try { setHistorySessions(await transport.listSessions()); } catch { setHistorySessions([]); }
	}, [historyOpen, surface, transport]);
	const restoreHistorySession = useCallback(async (sessionId) => {
		try {
			const payload = await transport.loadSession(sessionId);
			if (!Array.isArray(payload?.transcript)) throw new Error("missing transcript");
			store.restore(payload.transcript, payload.sessionId || sessionId);
			setHistoryOpen(false);
			setRestoreNotice("");
		} catch {
			setRestoreNotice("Previous conversation could not be restored");
		}
	}, [store, transport]);

	// The section is read when it opens; every write goes back through the
	// refresh above, because a key changes the session, not just a row.
	const toggleProviderKeys = useCallback(() => { setMenuOpen(false); if (!keysOpen) connectOpened("menu"); setKeysOpen(!keysOpen); }, [keysOpen]);
	// Opens (never toggles) Connect a model, pi's login list: the signed-out card and a refused key both lead here.
	const openProviderKeys = useCallback((entry) => { setMenuOpen(false); connectOpened(entry); setKeysOpen(true); }, []);
	// The connect funnel's ChatGPT attempt settles with the auth state (connect-telemetry.js).
	useEffect(() => { connectAuthState(authState, account); }, [authState, account]);

	// Clearing the transcript also retires the session, so what the author sees
	// and what the model remembers cannot diverge.
	const clearContext = useCallback(() => {
		store.clearContext();
		setMenuOpen(false);
	}, [store]);

	const switchModel = useCallback(() => {
		// Only a model whose provider holds a credential is worth switching to:
		// the others are exactly the ones the dropdown draws disabled.
		const usable = models.filter((entry) => modelIsSelectable(modelProviders, entry.id));
		const list = usable.length ? usable : models;
		const index = list.findIndex((entry) => entry.id === model);
		const next = list[(index + 1) % list.length];
		if (next) chooseModel(next.id);
		store.clearRateLimit();
	}, [chooseModel, model, modelProviders, models, store]);

	const onComposerKeyDown = useCallback((event) => {
		if (event.key === "Escape" && streaming) {
			event.preventDefault();
			stopTurn();
			return;
		}
		if (event.key === "Enter" && !isImeComposing(event) && !event.shiftKey) {
			event.preventDefault();
			// Enter does what the button under it says: Send, or Steer while a turn
			// on a steerable surface is still running.
			if (streaming) { if (presentation.steer) steerTurn(draft); return; }
			runTurn(draft);
		}
	}, [draft, presentation, runTurn, steerTurn, stopTurn, streaming]);

	const panelState = rateLimit ? "rate-limited"
		: authState !== "ready" ? authState
		: streaming ? "streaming"
		: items.some((item) => (item.kind === "tool" && item.status === "failed") || item.kind === "failure") ? "error"
		: "ready";
	const statusTone = { "signed-out": "", "signing-in": "busy", "no-entitlement": "warn", ready: "ok", streaming: "busy", "rate-limited": "warn", error: "alert" }[panelState] || "";
	const resetLabel = formatResetIn(rateLimit?.resetAt || quota?.resetAt);
	// A disabled composer under the sign-in card is dead weight: the composer
	// only exists once there is a session to talk to.
	const authenticated = authState === "ready" || authState === "no-entitlement";
	// A model whose provider holds no credential is not something this session
	// can send to: the composer stays shut instead of submitting a turn the
	// provider would refuse.
	const composerDisabled = panelState === "rate-limited" || !model || !modelIsSelectable(modelProviders, model);
	useEffect(() => {
		if (hidden) focusPendingRef.current = false;
		if (hidden || composerDisabled || !focusPendingRef.current) return;
		focusPendingRef.current = false;
		// Only claim focus nobody else has taken in the meantime.
		if (!document.activeElement || document.activeElement === document.body) composerRef.current?.focus();
	}, [composerDisabled, hidden]);

	if (collapsed && !embedded) {
		return <aside className="agent-panel collapsed" data-agent-state={panelState} data-agent-collapsed="true" aria-label="Agent panel, collapsed">
			<button type="button" className="agent-rail-toggle" onClick={() => setCollapsed(false)} aria-label="Expand agent panel" title="Expand agent panel (Cmd/Ctrl+B)"><FiChevronRight size={13} style={{ transform: "rotate(180deg)" }} /></button>
			<StatusDot tone={statusTone} title={panelState} />
			<span className="agent-rail-label">Agent</span>
		</aside>;
	}

	return <aside
		className={`agent-panel${resizing ? " resizing" : ""}${overlay && !embedded ? " overlay" : ""}${embedded ? " embedded" : ""}`}
		style={embedded ? undefined : { width: `${width}px` }}
		hidden={embedded && hidden}
		data-agent-state={panelState}
		data-agent-width={embedded ? undefined : width}
		data-agent-overlay={overlay && !embedded ? "true" : "false"}
		data-agent-embedded={embedded ? "true" : "false"}
		aria-label="Agent"
	>
		{!embedded && <div
			role="separator"
			aria-label="Resize agent panel"
			aria-orientation="vertical"
			aria-valuenow={width}
			aria-valuemin={AGENT_PANEL_WIDTH_MIN}
			aria-valuemax={AGENT_PANEL_WIDTH_MAX}
			tabIndex={0}
			className="agent-resize"
			onPointerDown={startResize}
			onKeyDown={(event) => {
				if (event.key === "ArrowLeft") { event.preventDefault(); nudgeWidth(16); }
				if (event.key === "ArrowRight") { event.preventDefault(); nudgeWidth(-16); }
			}}
		/>}

		<header className="agent-header">
			<StatusDot tone={statusTone} title={panelState} />
			<h2 className="agent-title" data-previs-mode={titleMode ? previsMode : undefined}>{titleMode ? `Agent · ${titleMode}` : "Agent"}</h2>
			<span className="agent-header-spacer" />
			<button type="button" className="agent-icon-button agent-new" aria-label="New conversation" title="New conversation" onClick={newSession}><FiPlus size={14} aria-hidden="true" /></button>
			{presentation.history && <span className="agent-history-wrap">
				<button type="button" className="agent-icon-button agent-history" aria-label="History" title="History" aria-haspopup="listbox" aria-expanded={surface === "studio" ? historyOpen : undefined} onClick={surface === "studio" ? openHistory : undefined} disabled={surface !== "studio"}><FiClock size={13} aria-hidden="true" /></button>
				{surface === "studio" && historyOpen && <div className="agent-history-popover" role="listbox" aria-label="Agent history">
					{historySessions.length ? historySessions.map((entry) => <button type="button" role="option" className="agent-history-item" key={entry.sessionId} onClick={() => restoreHistorySession(entry.sessionId)}>
						<span className="agent-history-time">{relativeTime(entry.updatedAt)}</span>
						<span className="agent-history-text">{entry.firstText || "Untitled conversation"}</span>
					</button>) : <span className="agent-history-empty">No previous conversations</span>}
				</div>}
			</span>}
			<span className="agent-overflow">
				<button type="button" className="agent-icon-button agent-overflow-toggle" aria-haspopup="menu" aria-expanded={menuOpen} aria-label="More agent actions" onClick={() => setMenuOpen((value) => !value)}><FiMoreHorizontal size={13} /></button>
				{menuOpen && <div className="agent-menu" role="menu">
					{/* Who the session is lives with the actions that change it, not
					    as a standing strip over the conversation. */}
					{account?.signedIn && <div className="agent-account" role="presentation">
						<span className="agent-account-email">{account.email}</span>
						<span className="agent-plan-badge">{quota?.plan || account.plan || "Free"}</span>
						{resetLabel && <span className="agent-account-reset">resets in {resetLabel}</span>}
					</div>}
					<button type="button" role="menuitem" onClick={clearContext}>Clear context</button>
					<button type="button" role="menuitem" className="agent-menu-keys" data-fid="agent_connect" aria-expanded={keysOpen} onClick={toggleProviderKeys}
						disabled={authState === "offline"} title={authState === "offline" ? ko("The agent server is not running", "에이전트 서버가 실행 중이 아니에요") : undefined}>Connect a model…</button>
					{account?.signedIn && <button type="button" role="menuitem" onClick={signOut}>Sign out</button>}
				</div>}
			</span>
			{!embedded && <button type="button" className="agent-icon-button agent-collapse" onClick={() => setCollapsed(true)} aria-label="Collapse agent panel" title="Collapse agent panel (Cmd/Ctrl+B)"><FiChevronRight size={13} /></button>}
		</header>

		{restoreNotice && <div className="agent-toast" role="status">{restoreNotice}</div>}
		{steerNotice && <div className="agent-toast alert agent-steer-notice" role="alert">{steerNotice}</div>}{surface === "studio" && taskMode && authenticated && <TaskStrip />}

		{/* An inline section, not a modal: the panel stays the one place the
		    conversation and the credentials it runs on are managed. */}
		{keysOpen && authState !== "offline" && <LoginPanel onClose={() => setKeysOpen(false)} onChatGPT={signIn} onChanged={refreshProviderState} />}

		<div className="agent-transcript" ref={transcriptRef} aria-live="polite" aria-label="Conversation" data-agent-transcript="true">
			{authState === "signed-out" && <div className="agent-state-card" data-agent-card="signed-out">
				<h3>Connect a model</h3>
				<p>Sign in with ChatGPT, or log in to another provider with a subscription, an API key, or your own proxy server. Sign-in happens in your browser — no token is ever stored in this page.</p>
				<button type="button" className="agent-primary-button agent-signin" onClick={signIn}>Sign in with ChatGPT</button>
				{signInError && <p className="agent-key-error agent-signin-error" role="alert">{signInError}</p>}
				<button type="button" className="agent-ghost-button agent-use-key" onClick={() => openProviderKeys("signed_out")}>Log in with another provider</button>
			</div>}

			{authState === "offline" && <OfflineCard probing={probing} onRetry={retryServer} />}

			{authState === "signing-in" && <div className="agent-state-card" data-agent-card="signing-in">
				<span className="agent-spinner" aria-hidden="true" />
				<h3>Waiting for your browser…</h3>
				<p>Finish the ChatGPT sign-in in the browser page that just opened. This panel picks up the session when you come back.</p>
				{account?.authorizeUrl && <a className="agent-ghost-button agent-signin-link" href={account.authorizeUrl} target="_blank" rel="noopener noreferrer">Open the sign-in page again</a>}
			</div>}

			{authState === "no-entitlement" && <div className="agent-state-card" data-agent-card="no-entitlement">
				<h3>Image generation is not on this plan</h3>
				<p>Signed in as {account?.email || "your account"}. Chat and tool calls work; image results need a plan with image generation.</p>
				<button type="button" className="agent-primary-button" onClick={() => window.open("https://chatgpt.com/#pricing", "_blank", "noopener,noreferrer")}>See plans</button>
			</div>}

			{authState === "ready" && !items.length && !rateLimit && <div className="agent-state-card" data-agent-card="ready">
				<h3>{presentation.emptyTitle}</h3>
				<p>{presentation.emptyHint(sceneName)}</p>
				<div className="agent-suggestions">
					{presentation.suggestions.map((chip) => <button type="button" key={chip} className="agent-chip" onClick={() => { noteChipDraft(); store.setDraft(chip); composerRef.current?.focus(); }}>{chip}</button>)}
				</div>
			</div>}

			{/* One step list per turn (AgentTurnSteps.jsx); the motion progress card sits just above the latest one. */}
			{layout.map((entry, index) => {
				if (entry.type === "steps") return <Fragment key={entry.id}>
					{entry.last && progressCard}
					<div className="agent-row"><TurnSteps block={entry} now={activityNow} toolLabels={presentation.toolLabels} formatClock={formatTurnClock} onRetry={() => runTurn(chat.lastPrompt, "retry_button")} /></div>{taskMode && layout[index + 1]?.item?.kind !== "assistant" && <TaskRows steps={entry.steps} />}
				</Fragment>;
				const { item } = entry;
				if (item.kind === "user") return <div className="agent-row user" key={item.id}>
					{item.attachments?.length > 0 && <div className="agent-bubble-attachments">
						{item.attachments.map((attachment, index) => <img key={`${item.id}-${index}`} src={attachment.dataUrl} alt={attachment.name || "Attached image"} onClick={() => setLightbox({ dataUrl: attachment.dataUrl, prompt: attachment.name })} />)}
					</div>}
					<div className="agent-bubble">{item.text}</div>
				</div>;
				if (item.kind === "assistant") return <Fragment key={item.id}><div className="agent-row assistant"><div className="agent-assistant-text"><ReplyText text={item.text} tail={streaming && <span className="agent-caret">▌</span>} /></div></div>{taskMode && layout[index - 1]?.type === "steps" && <TaskRows steps={layout[index - 1].steps} />}</Fragment>;
				if (item.kind === "job") return <div className="agent-row" key={item.id}><JobCard job={item} onStop={stopTurn} onAccept={(job) => store.acceptJob(job.jobId)} /></div>;
				if (item.kind === "receipt") return <div className="agent-row" key={item.id}><ReceiptCard item={item} /></div>;
				if (item.kind === "failure") return <div className="agent-row" key={item.id}><FailureCard failure={item.failure} onRetry={() => runTurn(chat.lastPrompt, "retry_button")} onFixKey={() => openProviderKeys("failure_card")} /></div>;
				if (item.kind === "supervisor") return <div className="agent-row" key={item.id}><SupervisorCard note={item} onSend={(text) => { store.setDraft(text); runTurn(text, "supervisor"); }} /></div>;
				if (item.kind === "plan") return <PlanCard key={item.id} plan={item} live={streaming && !item.outcome} />;
				return <div className="agent-row" key={item.id}><ImageResultCard image={item} onUse={(image) => store.applyImage(image.id)} onUndo={(image) => store.undoImage(image.id)} onRegenerate={() => runTurn(chat.lastPrompt, "regenerate")} onOpen={setLightbox} /></div>;
			})}

			{!layout.some((entry) => entry.type === "steps" && entry.last) && progressCard}{taskMode && <TaskRows items={items} />}
			{rateLimit && <PausedCard resetAt={rateLimit.resetAt} onRetry={() => { store.clearRateLimit(); runTurn(chat.lastPrompt, "retry_button"); }} onSwitchModel={switchModel} />}
		</div>
		{surface === "studio" && taskMode && authenticated && <><Suspense fallback={null}><TaskBoard sessionId={chat.sessionId} pulse={chat.lastTurn?.endedAt ?? 0} labelOf={taskStepLabel} onMainNote={store.note} /></Suspense><TaskDetail /></>}

		{/* Never a blank panel: busy states name the phase and tick, a finished
		    turn states how it ended, and idle says so in as many words. */}
		{authenticated && <div className="agent-activity" data-agent-activity={activity.phase} data-agent-activity-kind={activity.kind} role="status" aria-live="polite">
			<span className={`agent-activity-indicator ${activity.tone}`} aria-hidden="true" />
			<span className="agent-activity-text">{activity.text}</span>
			{activity.detail && <span className="agent-activity-detail">{activity.detail}</span>}<AgentContextMeter context={context} />
		</div>}

		{authenticated && <div
			className="agent-composer"
			data-agent-dropping={dropping ? "true" : "false"}
			onDragOver={composerDisabled ? undefined : onComposerDragOver}
			onDragLeave={composerDisabled ? undefined : onComposerDragLeave}
			onDrop={composerDisabled ? undefined : onComposerDrop}
			onPaste={composerDisabled ? undefined : onComposerPaste}
		>
			{pendingAttachments.length > 0 && <ul className="agent-attachments" aria-label="Attached images">
				{pendingAttachments.map((attachment) => <li key={attachment.id} className="agent-attachment">
					<img src={attachment.dataUrl} alt={attachment.name || "Attached image"} />
					<button type="button" className="agent-attachment-remove" aria-label={`Remove ${attachment.name || "attached image"}`} onClick={() => store.removeAttachment(attachment.id)}><FiX size={10} aria-hidden="true" /></button>
				</li>)}
			</ul>}
			{attachNotice && <p className="agent-attachment-notice" role="status">{attachNotice}</p>}
			<div className="agent-field">
				<textarea
					ref={composerRef}
					className="agent-input"
					aria-label="Message the agent"
					placeholder={panelState === "rate-limited" ? "Composer is paused" : model ? presentation.composerPlaceholder : "Waiting for the model list…"}
					value={draft}
					disabled={composerDisabled}
					onChange={(event) => { noteDraftInput(); store.setDraft(event.target.value); }}
					onKeyDown={onComposerKeyDown}
					onDragOver={onComposerDragOver}
					onDrop={onComposerDrop}
				/>
				<div className="agent-composer-controls">
					<button type="button" className="agent-attach-chip" aria-pressed={attachFrame} aria-label="Attach current frame" title="Attach current frame" onClick={() => setAttachFrame((value) => !value)}>
						{attachFrame ? <span className="agent-attach-thumb" aria-hidden="true" /> : <FiCamera size={13} aria-hidden="true" />}
					</button>
					<button type="button" className="agent-attach-chip agent-attach-file" aria-label="Attach image or video" title="Attach image or video" disabled={composerDisabled} onClick={() => fileInputRef.current?.click()}>
						<FiPaperclip size={13} aria-hidden="true" />
					</button>
					<input ref={fileInputRef} type="file" accept={ATTACHMENT_ACCEPT} multiple hidden onChange={onPickFiles} />
					{/* Five providers in one dropdown: grouped by the provider that serves
					    them, and a provider without a credential still lists its models —
					    unpickable, and saying what they are waiting for. */}
					<select className="agent-model-select" aria-label="Model" title="Model" value={model} disabled={!models.length} onChange={(event) => chooseModel(event.target.value)}>
						{modelProviders.length
							? modelProviders.map((provider) => <optgroup key={provider.id} label={provider.label}>
								{provider.error && <option value={`${provider.id}/error`} disabled>{provider.error}</option>}{provider.models.length
									? provider.models.map((entry) => <option key={entry.key} value={entry.key} disabled={!provider.signedIn}>{provider.signedIn ? entry.label : `${entry.label} — add key`}</option>)
									: <option value={`${provider.id}/`} disabled>{provider.signedIn ? "No models" : "No models — add key"}</option>}
							</optgroup>)
							: models.length
								? models.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)
								: <option value="">{modelsState === "failed" ? "No model available" : "Loading models…"}</option>}
					</select>
					{efforts.length > 0 && (
						<select className="agent-model-select agent-effort-select" aria-label="Reasoning effort" title="Reasoning effort" value={effort ?? efforts[0]} onChange={(event) => setEffort(event.target.value)}>
							{/* The closed select shows only the word; "default" rides in the
							    option's tooltip so the composer row stays one line. */}
							{efforts.map((value, index) => <option key={value} value={value} title={index === 0 ? "Default for this model" : undefined}>{value}</option>)}
						</select>
					)}
					{surface === "studio" && (
						<button type="button" className={`agent-supervisor-toggle agent-tasks-toggle${taskMode ? " is-on" : ""}`} role="switch" aria-checked={taskMode} aria-label={ko("Task mode", "작업 모드")} title={ko(taskMode ? "Task mode is on: the agent answers at once and runs your requests as parallel tasks" : "Task mode is off: one request at a time", taskMode ? "작업 모드 켜짐: 에이전트가 바로 답하고 요청을 병렬 작업으로 돌려요" : "작업 모드 꺼짐: 한 번에 요청 하나", taskMode ? "任务模式已开启：智能体会立即回答，并将请求作为并行任务运行" : "任务模式已关闭：一次只处理一个请求")} onClick={toggleTaskMode} disabled={streaming}>
							{ko("Tasks", "작업")} {taskMode ? "ON" : "OFF"}
						</button>
					)}
					<span className="agent-composer-spacer" aria-hidden="true" />
					{/* While a turn runs, Stop is still the way out of it; on a surface
					    that can be steered, Send becomes the way INTO it. */}
					{streaming
						? <>
							<button type="button" data-fid="agent_stop" className="agent-send stop agent-stop" onClick={stopTurn}>Stop</button>
							{presentation.steer && <button type="button" data-fid="agent_steer" className="agent-send agent-steer" disabled={!draft.trim()} onClick={() => steerTurn(draft)}>Steer</button>}
						</>
						: <button type="button" data-fid="agent_send" className="agent-send" aria-label="Send" title="Send (Enter)" disabled={composerDisabled || !draft.trim()} onClick={() => runTurn(draft)}><FiArrowUp size={14} aria-hidden="true" /></button>}
				</div>
				<ModelRolesLine model={model} roles={selectedModelRoles(modelRoles, model)} />
			</div>
		</div>}
		{/* The hint exists to warn about image spend; a surface that cannot
		    generate an image has nothing to warn about. */}
		{authenticated && presentation.imageHint && <p className="agent-footer-hint">{presentation.imageHint}</p>}

		{lightbox && <button type="button" className="agent-lightbox" aria-label="Close image preview" onClick={() => setLightbox(null)}>
			<img src={lightbox.dataUrl} alt={lightbox.prompt || "Generated image"} />
		</button>}
	</aside>;
}

export { AGENT_STATES, AGENT_PANEL_RAIL_WIDTH };
