// The panel's side of the connection test (bin/agent/connect-test.mjs): ask the sidecar to try the stored key,
// server address or model once, and say what came back in plain words. The key never passes through here; the
// sidecar reads its own stored credential. Each answer also records agent:connect_tested (closed values only).
import { sidecarRequest } from "../agent-image-client.js";
import { ko } from "../locale.js";
import { connectTested } from "./connect-telemetry.js";

// bin/agent/connect-test.mjs TESTABLE_PROVIDERS: the connections the author types (sign-ins are tested by signing in).
export const TESTABLE_PROVIDERS = Object.freeze(["anthropic", "openai", "google", "minimax", "minimax-cn", "openrouter", "cliproxy", "openai-compatible"]);
export const isTestable = (providerId) => TESTABLE_PROVIDERS.includes(providerId);

/** { provider, result, model, models?, detail? } for the stored connection; `model` is the bare id to try, if any. */
export async function runConnectTest(providerId, model) {
	let answer;
	try {
		answer = await sidecarRequest(globalThis.fetch.bind(globalThis), `/agent/providers/${encodeURIComponent(providerId)}/test`, { method: "POST", body: JSON.stringify(model ? { model } : {}) });
	} catch (failure) {
		answer = { provider: providerId, result: "other", model: model ?? null, detail: failure?.message || "" };
	}
	connectTested(providerId, answer?.result);
	return answer;
}

/** The line the panel shows for one answer: { tone: ok|error, text }. */
export function connectCheckCopy(answer) {
	const model = answer?.model || ko("the model", "모델", "模型");
	const served = (answer?.models ?? []).join(", ");
	switch (answer?.result) {
	case "ok": return { tone: "ok", text: ko(`Connection works: ${model} answered.`, `연결 확인: ${model} 모델이 응답했어요.`, `连接正常：${model} 已回应。`) };
	case "key_rejected": return { tone: "error", text: ko("The key was refused. Check it, then log out and connect again.", "키가 거부됐어요. 키를 확인하고 로그아웃한 뒤 다시 연결하세요.", "密钥被拒绝。请检查密钥，然后退出并重新连接。") };
	case "unreachable": return { tone: "error", text: ko(`The address could not be reached${answer.detail ? ` (${answer.detail})` : ""}. Check the server address and that the server is running.`, `주소에 연결할 수 없어요${answer.detail ? ` (${answer.detail})` : ""}. 서버 주소와 서버가 켜져 있는지 확인하세요.`, `无法连接该地址${answer.detail ? `（${answer.detail}）` : ""}。请检查服务器地址，并确认服务器正在运行。`) };
	case "model_not_found": return { tone: "error", text: ko(`This server does not have ${model}.${served ? ` It serves: ${served}.` : ""}`, `이 서버에는 ${model} 모델이 없어요.${served ? ` 있는 모델: ${served}.` : ""}`, `该服务器没有 ${model}。${served ? `可用模型：${served}。` : ""}`) };
	case "rate_limited": return { tone: "error", text: ko("Refused for rate limit or quota (credits or plan). Check your plan, or wait and test again.", "요청 한도나 할당량(크레딧, 요금제)에 걸렸어요. 요금제를 확인하거나 잠시 뒤 다시 테스트하세요.", "因速率限制或额度（余额或套餐）被拒绝。请检查套餐，或稍后重新测试。") };
	case "timeout": return { tone: "error", text: ko("No answer within 15 seconds. The server may be busy or still loading the model.", "15초 안에 응답이 없었어요. 서버가 바쁘거나 아직 모델을 불러오는 중일 수 있어요.", "15 秒内没有回应。服务器可能正忙，或仍在加载模型。") };
	default: return { tone: "error", text: ko(`The test request failed${answer?.detail ? `: ${answer.detail}` : "."}`, `테스트 요청이 실패했어요${answer?.detail ? `: ${answer.detail}` : "."}`, `测试请求失败${answer?.detail ? `：${answer.detail}` : "。"}`) };
	}
}

// The model picked in the agent's dropdown, tested once per pick (AgentPanel chooseModel -> ConnectCheck).
let picked = { key: "", seq: 0 };
const listeners = new Set();
/** A model key (`provider/id`) was picked; a testable provider's pick is tested under the picker. */
export function checkPickedModel(key) {
	picked = { key: isTestable(String(key ?? "").split("/")[0]) ? String(key) : "", seq: picked.seq + 1 };
	for (const listener of listeners) listener();
}
export const subscribePicked = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
export const readPicked = () => picked;
