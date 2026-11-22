// The edit on the user's last message in the Studio's Agent box (AgentUserBubble.jsx): the corrected message is sent in
// the old one's place. Only the last turn's message can be edited: rewinding it drops that turn alone. Sending the
// correction stops the turn if it still runs, has the sidecar take the turn out of the conversation the model is given
// (bin/agent/session-rewind.mjs: its message, replies, tool calls, steers and failure record), takes the same out of
// the transcript here, and sends the corrected text as a new turn. The scene is left as it is; the model is told so
// with the corrected message.
import { ko } from "../locale.js";

const EDIT_ERROR_COPY = {
	NOT_LAST: ko("Only the last message can be edited.", "마지막 메시지만 수정할 수 있어요.", "只能编辑最后一条消息。"),
	TASK_MODE: ko("A message sent in task mode cannot be edited.", "작업 모드에서 보낸 메시지는 수정할 수 없어요.", "任务模式下发送的消息无法编辑。"),
	ENGINE_KEEPS_HISTORY: ko("This model keeps the conversation in its own session: the message cannot be replaced.", "이 모델은 대화를 자체 세션에 보관해서 메시지를 바꿀 수 없어요.", "此模型在自己的会话中保存对话：无法替换该消息。"),
	BUSY: ko("The stopped turn has not ended yet: try again in a moment.", "멈춘 턴이 아직 끝나지 않았어요. 잠시 뒤 다시 시도하세요.", "已停止的这一轮尚未结束：请稍后再试。"),
};

/** The id of the message the edit control goes on: the last message that started a turn (a steered one never did). */
export function editableMessageId(items) {
	return items.findLast((item) => item.kind === "user" && typeof item.turnId === "string" && !item.steered)?.id ?? null;
}

/**
 * resendEdited({ store, transport, itemId, text, attachments, options }) -> { ok, message }
 * store: the chat store (agent-client.js); options: what the corrected turn is sent with (model, effort, frame switch).
 * The composer's draft, its pictures and the queue are not touched. A refusal leaves the transcript as it was (a turn
 * that ran is stopped all the same) and says why.
 */
export async function resendEdited({ store, transport, itemId, text, attachments = [], options = {} }) {
	const chat = store.getState(), item = chat.items.find((entry) => entry.id === itemId), trimmed = String(text ?? "").trim();
	if (!trimmed || !item?.turnId || typeof transport?.rewind !== "function") return { ok: false, message: "" };
	if (chat.streaming && chat.turnId === item.turnId) store.stop();
	try { await transport.rewind(chat.sessionId, item.turnId); }
	catch (error) { return { ok: false, message: EDIT_ERROR_COPY[error?.code] ?? String(error?.message || error) }; }
	store.rewindTo(itemId);
	void store.send(trimmed, { ...options, attachments, queued: true });
	return { ok: true, message: "" };
}
