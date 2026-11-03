import { useCallback, useEffect, useRef, useState } from "react";
import { FiX } from "react-icons/fi";
import { answerLogin, cancelLogin, fetchLogins, logoutProvider, readLogin, startLogin } from "./login-client.js";
import { formatWaitLeft } from "./agent-provider-help.js";
import { connectFinished, connectPanelClosed, connectStarted, connectStep } from "./connect-telemetry.js";

// "Connect a model": pi's own login (the coding agent's /login) inside the agent panel (#pi-login). The list
// is what pi ships: each provider with its subscription sign-in and/or api-key login; picking one runs pi's
// flow in the sidecar and this panel only shows what pi asks (a key, a server address, a pasted code, a
// choice) and tells (a sign-in page to open, a device code, progress). ChatGPT keeps CozyClay's own sign-in.

const GROUPS = [
	["Connected", (entry) => entry.connected],
	["Subscriptions", (entry) => !entry.connected && entry.methods.some((method) => method.subscription)],
	["API keys", (entry) => !entry.connected && !entry.methods.some((method) => method.subscription)],
];

function PromptForm({ prompt, onSubmit }) {
	const [value, setValue] = useState("");
	const ask = prompt.prompt;
	if (ask.type === "select") {
		return <div className="agent-login-choices" role="group" aria-label={ask.message}>
			<p className="agent-login-ask">{ask.message}</p>
			{(ask.options ?? []).map((option) => <button key={option.id} type="button" className="agent-ghost-button" onClick={() => onSubmit(option.id)}>{option.label}</button>)}
		</div>;
	}
	const inputId = `agent-login-${prompt.promptId}`;
	return <form className="agent-login-form" onSubmit={(event) => { event.preventDefault(); onSubmit(value); setValue(""); }}>
		<label className="agent-login-ask" htmlFor={inputId}>{ask.message}</label>
		<div className="agent-key-controls">
			<input id={inputId} className="agent-key-input" type={ask.type === "secret" ? "password" : "text"} autoComplete="off" spellCheck="false"
				placeholder={ask.placeholder ?? ""} value={value} autoFocus onChange={(event) => setValue(event.target.value)} />
			<button type="submit" className="agent-key-save" disabled={ask.type === "secret" && !ask.optional && !value.trim()}>Continue</button>
		</div>
	</form>;
}

function FlowLog({ entries }) {
	return <ul className="agent-login-log">
		{entries.map((entry, index) => {
			const event = entry.event;
			if (event.type === "auth_url") return <li key={index}><a className="agent-primary-button agent-login-open" href={event.url} target="_blank" rel="noopener noreferrer">Open the sign-in page</a>{event.instructions && <span className="agent-key-note">{event.instructions}</span>}</li>;
			if (event.type === "device_code") return <li key={index}><span className="agent-key-note">Enter this code at </span><a href={event.verificationUri} target="_blank" rel="noopener noreferrer">{event.verificationUri}</a><code className="agent-login-code">{event.userCode}</code></li>;
			return <li key={index} className="agent-key-note">{event.message}{(event.links ?? []).map((link) => <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer"> {link.label || link.url}</a>)}</li>;
		})}
	</ul>;
}

export function LoginPanel({ onClose, onChatGPT, onChanged }) {
	const [providers, setProviders] = useState(null);
	const [error, setError] = useState("");
	const [query, setQuery] = useState("");
	const [flow, setFlow] = useState(null);
	const live = useRef(true);
	// The wait's countdown (#1044), coarse: the card says minutes.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!flow?.flowId || flow.done) return undefined;
		const tick = setInterval(() => setNow(Date.now()), 15_000);
		return () => clearInterval(tick);
	}, [flow?.flowId, flow?.done]);
	const load = useCallback(async () => {
		try { setProviders(await fetchLogins()); setError(""); } catch (failure) { setError(failure?.message || "The login list is unavailable."); }
	}, []);
	// Leaving the panel mid-flow abandons that attempt (a ChatGPT sign-in goes on in the agent panel).
	useEffect(() => { live.current = true; load(); return () => { live.current = false; connectPanelClosed(); }; }, [load]);
	// The attempt's funnel step follows the flow: waiting, a prompt to answer, then done.
	useEffect(() => {
		if (!flow?.flowId) return;
		if (flow.done) { if (flow.ok) connectFinished("ok"); else connectFinished(flow.reason === "user_closed" ? "cancelled" : "failed", flow.reason ?? "other"); }
		else connectStep(flow.prompt ? "prompt" : "waiting");
	}, [flow?.flowId, flow?.done, flow?.ok, flow?.prompt]);
	// Read the running flow until pi finishes it.
	useEffect(() => {
		if (!flow?.flowId || flow.done) return undefined;
		let stopped = false;
		(async () => {
			let after = 0;
			while (!stopped && live.current) {
				let page;
				try { page = await readLogin(flow.flowId, after); } catch (failure) { if (!stopped) setFlow((current) => current && { ...current, done: true, ok: false, message: failure?.message || "The login stopped." }); return; }
				if (stopped) return;
				after = page.next;
				if (page.waitUntil) setFlow((current) => current && current.flowId === flow.flowId && current.waitUntil !== page.waitUntil ? { ...current, waitUntil: page.waitUntil } : current);
				for (const entry of page.events) {
					setFlow((current) => {
						if (!current || current.flowId !== flow.flowId) return current;
						if (entry.type === "prompt") return { ...current, prompt: entry };
						if (entry.type === "prompt_closed") return current.prompt?.promptId === entry.promptId ? { ...current, prompt: null } : current;
						if (entry.type === "event") return { ...current, log: [...current.log, entry] };
						return { ...current, prompt: null, done: true, ok: entry.ok, message: entry.message ?? "", reason: entry.reason };
					});
					if (entry.type === "done" && entry.ok) { await onChanged?.(); load(); }
				}
				if (page.done) return;
			}
		})();
		return () => { stopped = true; };
	}, [flow?.flowId, flow?.done, load, onChanged]);

	const begin = async (provider, method) => {
		setError("");
		// ChatGPT's own sign-in shows its waiting card in the panel body, so the list steps aside;
		// that sign-in reports its own connect attempt (AgentPanel signIn).
		if (method.type === "chatgpt") { onChatGPT?.(); onClose?.(); return; }
		connectStarted(provider.id, method.type);
		try {
			const flowId = await startLogin(provider.id, method.type);
			// provider and method stay on the flow: a failed one is tried again in place (#1044)
			setFlow({ flowId, name: provider.name, label: method.label, provider, method, log: [], prompt: null, done: false });
		} catch (failure) { connectFinished("failed"); setError(failure?.message || "That login could not start."); }
	};
	const answer = async (value) => {
		const prompt = flow?.prompt;
		if (!prompt) return;
		setFlow((current) => current && { ...current, prompt: null });
		try { await answerLogin(flow.flowId, prompt.promptId, value); } catch (failure) { setError(failure?.message || "That answer was not taken."); }
	};
	const cancel = async () => {
		if (flow && !flow.done) { connectFinished("cancelled", "user_closed"); await cancelLogin(flow.flowId).catch(() => {}); }
		setFlow(null);
	};
	const logout = async (provider) => {
		try { await logoutProvider(provider.id); await onChanged?.(); load(); } catch (failure) { setError(failure?.message || "Logout failed."); }
	};

	const shown = (providers ?? []).filter((entry) => !query.trim() || entry.name.toLowerCase().includes(query.trim().toLowerCase()));
	return <section className="agent-keys agent-login" aria-label="Connect a model" data-agent-keys="true">
		<div className="agent-keys-head">
			<h3 className="agent-keys-title">Connect a model</h3>
			<button type="button" className="agent-icon-button agent-keys-close" aria-label="Close" onClick={async () => { connectFinished("abandoned", "user_closed"); await cancel(); onClose?.(); }}><FiX size={11} aria-hidden="true" /></button>
		</div>
		{error && <p className="agent-key-error" role="alert">{error}</p>}
		{flow ? <div className="agent-login-flow" data-login-flow={flow.done ? (flow.ok ? "connected" : "failed") : "running"}>
			<p className="agent-key-label">{flow.name} · {flow.label}</p>
			<FlowLog entries={flow.log} />
			{flow.prompt && <PromptForm key={flow.prompt.promptId} prompt={flow.prompt} onSubmit={answer} />}
			{!flow.done && !flow.prompt && <p className="agent-key-note">Waiting for {flow.name}… Finish signing in on the page that opened, then come back here.</p>}
			{!flow.done && formatWaitLeft(flow.waitUntil, now) && <p className="agent-key-note" data-login-wait="true">This sign-in stops waiting in {formatWaitLeft(flow.waitUntil, now)}.</p>}
			{flow.done && <p className={flow.ok ? "agent-key-note" : "agent-key-error"} role={flow.ok ? "status" : "alert"}>{flow.ok ? `Connected to ${flow.name}.` : flow.message}</p>}
			<div className="agent-key-controls">
				{flow.done && !flow.ok && flow.provider && <button type="button" className="agent-key-save" data-login-retry="true" onClick={() => begin(flow.provider, flow.method)}>Try again</button>}
				<button type="button" className="agent-ghost-button" onClick={cancel}>{flow.done ? "Back to the list" : "Cancel"}</button>
			</div>
		</div> : <>
			<p className="agent-keys-hint">A subscription signs in on its own page. A key or server address you type stays with the local CozyClay service and is never shown again.</p>
			<input className="agent-key-input" type="search" aria-label="Search providers" placeholder="Search providers" value={query} onChange={(event) => setQuery(event.target.value)} />
			{providers === null && !error && <p className="agent-keys-note">Loading providers…</p>}
			{GROUPS.map(([title, test]) => {
				const rows = shown.filter(test);
				return rows.length ? <div key={title} className="agent-login-group"><p className="agent-key-endpoint-label">{title}</p>
					{rows.map((provider) => <div key={provider.id} className="agent-key-row" data-provider={provider.id} data-provider-signed-in={provider.connected ? "true" : "false"}>
						<div className="agent-key-head"><span className="agent-key-label">{provider.name}</span><span className="agent-key-source">{provider.connected ? (provider.via === "oauth" ? "signed in" : provider.source || "key") : ""}</span></div>
						<div className="agent-key-controls">
							{provider.connected && provider.id !== "openai-codex"
								? <button type="button" className="agent-ghost-button agent-key-remove" onClick={() => logout(provider)}>Log out</button>
								: provider.methods.map((method) => <button key={method.type} type="button" className={method.subscription ? "agent-key-save" : "agent-ghost-button"} onClick={() => begin(provider, method)}>{method.label}</button>)}
						</div>
					</div>)}
				</div> : null;
			})}
		</>}
	</section>;
}
