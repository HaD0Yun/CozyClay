import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ko } from "../locale.js";
import { connectCheckCopy, readPicked, runConnectTest, subscribePicked } from "./connect-check.js";

// One connection's test result, inline next to the setting that changed (bin/agent/connect-test.mjs): testing,
// then OK with the model's name or the reason in plain words, and a button to test again. Saving never waits on it.
export function ConnectCheck({ providerId, model, auto = true, compact = false }) {
	const [state, setState] = useState(auto ? { testing: true } : null);
	const run = useRef(0);
	const test = useCallback(async () => {
		const id = ++run.current;
		setState({ testing: true });
		const answer = await runConnectTest(providerId, model);
		if (id === run.current) setState({ answer });
	}, [providerId, model]);
	// the automatic test when it mounts (a key or address just saved, a model just picked); a later answer wins
	useEffect(() => {
		if (!auto) return undefined;
		const id = ++run.current;
		runConnectTest(providerId, model).then((answer) => { if (id === run.current) setState({ answer }); });
		return () => { run.current += 1; };
	}, [auto, providerId, model]);
	if (!state) return <div className="agent-key-controls agent-connect-check" data-connect-check="idle">
		<button type="button" className="agent-ghost-button" data-connect-test="true" onClick={test}>{ko("Test connection", "연결 테스트", "测试连接")}</button>
	</div>;
	if (state.testing) return <p className="agent-key-note agent-connect-check" data-connect-check="testing" role="status">{ko("Testing the connection…", "연결을 확인하는 중…", "正在测试连接…")}</p>;
	const copy = connectCheckCopy(state.answer);
	return <div className={`agent-connect-check${compact ? " is-compact" : ""}`} data-connect-check={state.answer?.result ?? "other"}>
		<p className={copy.tone === "ok" ? "agent-key-note agent-connect-ok" : "agent-key-error"} role={copy.tone === "ok" ? "status" : "alert"}>{copy.text}</p>
		<button type="button" className="agent-ghost-button agent-connect-retry" data-connect-test="true" onClick={test}>{ko("Test again", "다시 테스트", "重新测试")}</button>
	</div>;
}

/** Under the model picker: the pick just made, when its provider is one the author connected by key or address. */
export function PickedModelCheck({ model }) {
	const picked = useSyncExternalStore(subscribePicked, readPicked);
	if (!picked.key || picked.key !== model) return null;
	const slash = model.indexOf("/");
	return <ConnectCheck key={picked.seq} providerId={model.slice(0, slash)} model={model.slice(slash + 1)} compact />;
}
