// The cards that wait on someone: a turn its provider's quota stopped and the ChatGPT sign-in page the sidecar is
// waiting for (#1043, #1044), each saying whose wait it is, how long it lasts and what to do instead; and a command
// the agent asked for that waits on the author's own yes (agent-confirm.js).
import { useEffect, useState } from "react";
import { FiCheck, FiClock, FiDownload } from "react-icons/fi";
import { ko } from "../locale.js";
import { formatResetIn } from "./agent-client.js";
import { formatWaitLeft } from "./agent-provider-help.js";

// A rate-limited turn (#1043): whose quota it is, how long that provider asked to wait (when it said), and a
// one-click move to another connected provider when there is one.
export function PausedCard({ resetAt, provider, alternative, onRetry, onSwitchModel }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	const countdown = formatResetIn(resetAt, now);
	return <div className="agent-paused" data-agent-card="rate-limited" role="status">
		<div className="agent-paused-head"><FiClock size={12} aria-hidden="true" /> {ko(`Paused — ${provider} quota reached`, `일시 중지 — ${provider} 사용 한도 도달`)}
			<span className="agent-paused-countdown" data-agent-paused-wait={countdown ? "known" : "unknown"}>{countdown ? ko(`try again in ${countdown}`, `${countdown} 후 다시 시도`) : ko("wait time not given", "대기 시간 미제공", "未提供等待时间")}</span>
		</div>
		<p style={{ margin: 0 }}>{ko(`${provider} stopped taking requests from your account for now. This is ${provider}'s own quota or rate limit, not CozyClay's.`, `${provider}가 지금 이 계정의 요청을 받지 않아요. CozyClay가 아닌 ${provider} 자체의 사용 한도예요.`)}</p>
		<div className="agent-paused-actions">
			<button type="button" className="agent-paused-wait" onClick={onRetry}>{ko("Wait & retry", "기다렸다가 다시 시도", "等待后重试")}</button>
			<button type="button" className="agent-paused-switch" data-agent-switch-provider={alternative?.provider ?? ""} onClick={onSwitchModel}>{alternative ? ko(`Switch to ${alternative.label}`, `${alternative.label}(으)로 전환`) : ko("Switch model", "모델 변경", "切换模型")}</button>
		</div>
	</div>;
}

// The ChatGPT sign-in's waiting step: what to do next, when the wait ends, and a way out. When the wait has ended the
// panel reads the sidecar once (onWaitEnded), which says how it ended.
export function SigningInCard({ account, onCancel, onWaitEnded }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const until = Date.parse(account?.waitUntil ?? "");
		const tick = setInterval(() => { if (Date.now() > until) onWaitEnded?.(); else setNow(Date.now()); }, 15_000);
		return () => clearInterval(tick);
	}, [account?.waitUntil, onWaitEnded]);
	const left = formatWaitLeft(account?.waitUntil, now);
	return <div className="agent-state-card" data-agent-card="signing-in">
		<span className="agent-spinner" aria-hidden="true" />
		<h3>Waiting for your browser…</h3>
		<p>1. Sign in to ChatGPT on the page that opened in your browser. No page? Use the link below.</p>
		<p>2. When the page says you are signed in, come back here. This panel picks up the session.</p>
		{left && <p className="agent-key-note" data-agent-signin-wait="true">The sign-in stops waiting in {left}. You can start it again then.</p>}
		{account?.authorizeUrl && <a className="agent-ghost-button agent-signin-link" href={account.authorizeUrl} target="_blank" rel="noopener noreferrer">Open the sign-in page again</a>}
		<button type="button" className="agent-ghost-button agent-signin-cancel" onClick={onCancel}>Cancel</button>
	</div>;
}

const confirmSubject = ({ kind, name }) => kind === "timeline" ? ko("the whole timeline", "타임라인 전체", "整条时间线")
	: kind === "shot" ? ko(`shot "${name}"`, `샷 "${name}"`, `镜头"${name}"`) : ko("the current shot", "현재 샷", "当前镜头");

// The agent asked to export a video and the Studio needs the author's yes (CONFIRMATION_REQUIRED). Export runs that
// exact request; Cancel declines it. Either answer goes to the agent with the next message.
export function ConfirmCard({ item, onApprove, onDecline }) {
	const subject = confirmSubject(item.subject);
	const open = item.state === "pending" || item.state === "failed";
	return <div className="agent-card agent-job-card agent-confirm-card" data-agent-card="confirm" data-confirm-state={item.state} data-confirm-action={item.action}>
		<div className="agent-job-head">
			<span className={`agent-status-dot ${item.state === "done" ? "ok" : item.state === "failed" ? "alert" : item.state === "declined" ? "idle" : "warn"}`} aria-hidden="true" />
			<span className="agent-job-label">{ko(`The agent wants to export ${subject} as video.`, `에이전트가 ${subject}을(를) 영상으로 내보내려고 해요.`, `智能体想把${subject}导出为视频。`)}</span>
		</div>
		{item.reason && open && <p className="agent-job-phase">{item.reason}</p>}
		<div className="agent-job-actions">
			{open && <button type="button" className="agent-ghost-button agent-confirm-approve" onClick={onApprove}><FiDownload size={11} aria-hidden="true" /> {ko("Export", "내보내기", "导出")}</button>}
			{open && <button type="button" className="agent-ghost-button agent-confirm-decline" onClick={onDecline}>{ko("Cancel", "취소", "取消")}</button>}
			{item.state === "running" && <span className="agent-job-note">{ko("Exporting…", "내보내는 중…", "正在导出…")}</span>}
			{item.state === "done" && <span className="agent-job-note"><FiCheck size={11} aria-hidden="true" /> {item.fileName ? ko(`Exported ${item.fileName}`, `${item.fileName}(으)로 내보냈어요`, `已导出 ${item.fileName}`) : ko("Exported", "내보냈어요", "已导出")}</span>}
			{item.state === "declined" && <span className="agent-job-note">{ko("Cancelled. The agent hears it with your next message.", "취소했어요. 다음 메시지와 함께 에이전트에게 전해져요.", "已取消。智能体会随你的下一条消息得知。")}</span>}
			{item.error && <span className="agent-job-note alert" role="alert">{item.error}</span>}
		</div>
	</div>;
}
