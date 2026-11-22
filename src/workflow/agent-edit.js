// The edit on the user's last message in the Studio's Agent box (AgentUserBubble.jsx): the corrected message is sent in
// the old one's place. Only the last turn's message can be edited: rewinding it drops that turn alone. Sending the
// correction asks the sidecar whether that turn can leave (a refusal changes nothing: a running turn goes on), stops the
// turn if it still runs, has the sidecar take the turn out of the conversation the model is given
// (bin/agent/session-rewind.mjs: its message, replies, tool calls, steers and failure record), takes the same out of
// the transcript here, and sends the corrected text as a new turn. The scene is left as it is; the model is told so
// with the corrected message. A message sent with Tasks on (a task-mode turn) cannot be edited: the pencil says so.
import { ko } from "../locale.js";

const EDIT_ERROR_COPY = {
	NOT_LAST: ko("Only the last message can be edited.", "마지막 메시지만 수정할 수 있어요.", "只能编辑最后一条消息。"),
	TASK_MODE: ko("A message sent with Tasks on cannot be edited. One sent with Tasks off can.", "작업(Tasks)을 켜고 보낸 메시지는 수정할 수 없어요. 작업을 끄고 보낸 메시지는 수정할 수 있어요.", "开启任务（Tasks）时发送的消息无法编辑。关闭任务后发送的消息可以编辑。"),
	ENGINE_KEEPS_HISTORY: ko("This model keeps the conversation in its own session: the message cannot be replaced.", "이 모델은 대화를 자체 세션에 보관해서 메시지를 바꿀 수 없어요.", "此模型在自己的会话中保存对话：无法替换该消息。"),
	BUSY: ko("The stopped turn has not ended yet: try again in a moment.", "멈춘 턴이 아직 끝나지 않았어요. 잠시 뒤 다시 시도하세요.", "已停止的这一轮尚未结束：请稍后再试。"),
};

/** The id of the message the edit control goes on: the last message that started a turn (a steered one never did). */
export function editableMessageId(items) {
	return items.findLast((item) => item.kind === "user" && typeof item.turnId === "string" && !item.steered)?.id ?? null;
}

/** Whether the turn has messages the user sent into it while it ran (Send now): they leave with it when its message is edited. */
export function steeredAfter(items, itemId) {
	return items.slice(items.findIndex((item) => item.id === itemId) + 1).some((item) => item.kind === "user" && item.steered);
}

const refusal = (error) => ({ ok: false, message: EDIT_ERROR_COPY[error?.code] ?? String(error?.message || error) });

/** checkEdit({ store, transport, itemId }) -> { ok, message }: asks the sidecar whether that message's turn can leave the
 * conversation. Nothing changes either way; a refusal says why (task mode, not the last turn any more, the engine). */
export async function checkEdit({ store, transport, itemId }) {
	const chat = store.getState(), item = chat.items.find((entry) => entry.id === itemId);
	if (!item?.turnId || typeof transport?.rewind !== "function") return { ok: false, message: "" };
	try { await transport.rewind(chat.sessionId, item.turnId, true); return { ok: true, message: "" }; } catch (error) { return refusal(error); }
}

/**
 * resendEdited({ store, transport, itemId, text, attachments, options }) -> { ok, message }
 * store: the chat store (agent-client.js); options: what the corrected turn is sent with (model, effort, frame switch).
 * The composer's draft, its pictures and the queue are not touched. A refusal says why and leaves the transcript as it
 * was; one the sidecar can tell beforehand (checkEdit) leaves a running turn running too.
 */
export async function resendEdited({ store, transport, itemId, text, attachments = [], options = {} }) {
	const item = store.getState().items.find((entry) => entry.id === itemId), trimmed = String(text ?? "").trim();
	if (!trimmed || !item?.turnId || typeof transport?.rewind !== "function") return { ok: false, message: "" };
	const checked = await checkEdit({ store, transport, itemId });
	if (!checked.ok) return checked;
	const chat = store.getState();
	if (chat.streaming && chat.turnId === item.turnId) store.stop();
	try { await transport.rewind(chat.sessionId, item.turnId); } catch (error) { return refusal(error); }
	store.rewindTo(itemId);
	void store.send(trimmed, { ...options, attachments, queued: true });
	return { ok: true, message: "" };
}
