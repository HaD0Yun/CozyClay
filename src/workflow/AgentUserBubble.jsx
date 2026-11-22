import { useState } from "react";
import { FiEdit2, FiX } from "react-icons/fi";
import { isImeComposing } from "../ime.js";
import { ko } from "../locale.js";
import "./agent-edit.css";

// One message of the user's in the transcript. The last one that started a turn (agent-edit.js) has an edit control:
// the pencil under the bubble (shown on hover, and to the keyboard on focus). It opens the text in place, with the
// message's pictures; Enter (or Send) sends the corrected message in place of this one, Esc (or Cancel) closes it and
// leaves everything as it was. Edited in place rather than in the composer: the composer may hold a draft the user is
// writing, and the bubble shows which message is replaced.
function hint(running, steered) {
	const main = running
		? ko("Sending stops the running turn and replaces this message: the turn's reply and steps leave the conversation. What it already changed in the scene stays. Esc cancels.", "보내면 진행 중인 턴을 멈추고 이 메시지를 바꿔요. 그 턴의 답과 단계는 대화에서 빠져요. 장면에 이미 바뀐 것은 그대로 남아요. Esc는 취소.", "发送会停止正在运行的这一轮并替换这条消息：该轮的回复和步骤从对话中移除。它已对场景做出的更改会保留。按 Esc 取消。")
		: ko("Sending replaces this message: its reply and steps leave the conversation. What they changed in the scene stays. Esc cancels.", "보내면 이 메시지를 바꿔요. 그 답과 단계는 대화에서 빠져요. 장면에 바뀐 것은 그대로 남아요. Esc는 취소.", "发送会替换这条消息：它的回复和步骤从对话中移除。场景中已做的更改会保留。按 Esc 取消。");
	// what the user sent into this turn with Send now is part of the turn: it leaves too, and the user is told before
	return steered ? `${main} ${ko("The messages you sent into this turn (Send now) leave with it.", "이 턴에 지금 보내기로 넣은 메시지도 함께 빠져요.", "你用“立即发送”加入这一轮的消息也会一并移除。")}` : main;
}

/** item: the transcript's user item; editable: it is the message the edit goes on; running: a turn streams; steered: the
 * turn holds messages sent into it (Send now); onCheck(item) -> Promise<boolean>: the sidecar would take the edit (a
 * refusal is told by the panel, and the edit stays shut); onEdit(item, text, attachments) -> Promise<{ ok }> sends the
 * correction; onOpen(picture) shows a picture large. */
export function AgentUserBubble({ item, editable, running, steered, disabled, onCheck, onEdit, onOpen }) {
	const [editing, setEditing] = useState(null); // { text, attachments, sending }
	const open = editable && editing;
	const pictures = open ? editing.attachments : item.attachments ?? [];
	const send = async () => {
		if (!editing?.text.trim() || editing.sending || disabled) return;
		setEditing({ ...editing, sending: true });
		const result = await onEdit(item, editing.text, editing.attachments);
		setEditing(result?.ok ? null : { ...editing, sending: false });
	};
	const onKeyDown = (event) => {
		if (event.key === "Enter" && !event.shiftKey && !isImeComposing(event)) { event.preventDefault(); void send(); }
		else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditing(null); }
	};
	return <div className="agent-row user" data-agent-editing={open ? "true" : undefined}>
		{pictures.length > 0 && <div className="agent-bubble-attachments">
			{pictures.map((picture, index) => <span key={`${item.id}-${index}`} className="agent-edit-picture">
				<img src={picture.dataUrl} alt={picture.name || "Attached image"} onClick={() => onOpen({ dataUrl: picture.dataUrl, prompt: picture.name })} />
				{open && <button type="button" className="agent-attachment-remove" aria-label={ko(`Remove ${picture.name || "picture"}`, `${picture.name || "사진"} 빼기`, `移除 ${picture.name || "图片"}`)} onClick={() => setEditing({ ...editing, attachments: editing.attachments.filter((_, at) => at !== index) })}><FiX size={10} aria-hidden="true" /></button>}
			</span>)}
		</div>}
		{open
			? <div className="agent-bubble agent-edit-box">
				<textarea className="agent-edit-input" aria-label={ko("Edit your message", "보낸 메시지 수정", "编辑你的消息")} value={editing.text} autoFocus rows={Math.min(8, Math.max(2, editing.text.split("\n").length))} disabled={editing.sending} onChange={(event) => setEditing({ ...editing, text: event.target.value })} onKeyDown={onKeyDown} />
				<p className="agent-edit-hint">{hint(running, steered)}</p>
				<div className="agent-edit-actions">
					<button type="button" className="agent-ghost-button agent-edit-cancel" disabled={editing.sending} onClick={() => setEditing(null)}>{ko("Cancel", "취소", "取消")}</button>
					<button type="button" className="agent-primary-button agent-edit-send" title={ko("Send the corrected message (Enter)", "고친 메시지 보내기 (Enter)", "发送修改后的消息 (Enter)")} disabled={disabled || editing.sending || !editing.text.trim()} onClick={() => void send()}>{ko("Send", "보내기", "发送")}</button>
				</div>
			</div>
			: <div className="agent-bubble">{item.text}</div>}
		{editable && !open && <button type="button" className="agent-edit-open" aria-label={ko("Edit message", "메시지 수정", "编辑消息")} title={ko("Edit message", "메시지 수정", "编辑消息")} onClick={async () => { if (await onCheck(item)) setEditing({ text: item.text, attachments: item.attachments ?? [], sending: false }); }}><FiEdit2 size={12} aria-hidden="true" /></button>}
	</div>;
}
