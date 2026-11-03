// The two cards a provider makes the author wait on (#1043, #1044): a turn its quota stopped, and the ChatGPT
// sign-in page the sidecar is waiting for. Each says whose wait it is, how long it lasts and what to do instead.
import { useEffect, useState } from "react";
import { FiClock } from "react-icons/fi";
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
			<span className="agent-paused-countdown" data-agent-paused-wait={countdown ? "known" : "unknown"}>{countdown ? ko(`try again in ${countdown}`, `${countdown} 후 다시 시도`) : ko("wait time not given", "대기 시간 미제공")}</span>
		</div>
		<p style={{ margin: 0 }}>{ko(`${provider} stopped taking requests from your account for now. This is ${provider}'s own quota or rate limit, not CozyClay's.`, `${provider}가 지금 이 계정의 요청을 받지 않아요. CozyClay가 아닌 ${provider} 자체의 사용 한도예요.`)}</p>
		<div className="agent-paused-actions">
			<button type="button" className="agent-paused-wait" onClick={onRetry}>{ko("Wait & retry", "기다렸다가 다시 시도")}</button>
			<button type="button" className="agent-paused-switch" data-agent-switch-provider={alternative?.provider ?? ""} onClick={onSwitchModel}>{alternative ? ko(`Switch to ${alternative.label}`, `${alternative.label}(으)로 전환`) : ko("Switch model", "모델 변경")}</button>
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
