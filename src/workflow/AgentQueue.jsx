import { useState } from "react";
import { FiCheck, FiEdit2, FiX } from "react-icons/fi";
import { isImeComposing } from "../ime.js";
import { ko } from "../locale.js";
import "./agent-queue.css";

// The queue above the composer (agent-queue.js): one row per message typed while a turn ran, in the order they go.
// Each row: Send now (into the running turn at its next step, or as a new turn when none runs), edit, remove.
// A row being handed to the running turn reads so until the turn's stream says the model has it; then it leaves the
// queue and joins the conversation.
function headLine({ held }, streaming) {
	if (held) return ko("Held after Stop. Send now sends a message; the rest follow when its turn ends.", "멈춤 뒤 보류 중이에요. 지금 보내기를 누르면 보내고, 그 턴이 끝나면 나머지가 이어서 가요.", "停止后已暂停。点“立即发送”发送一条，其余在该轮结束后依次发送。");
	return streaming ? ko("Queued: each goes as the next turn when this one ends.", "대기 중: 이 턴이 끝나면 하나씩 다음 턴으로 보내요.", "排队中：本轮结束后逐条作为下一轮发送。") : ko("Queued", "대기 중", "排队中");
}

/** queue: the queue's state ({ rows, held }); actions: the queue (agent-queue.js); onSendNow(id): the panel's Send now. */
export function AgentQueue({ queue, actions, streaming, onSendNow }) {
	const [editing, setEditing] = useState(null); // { id, text } of the row being edited
	if (!queue.rows.length) return null;
	const open = (row) => { actions.beginEdit(row.id); setEditing({ id: row.id, text: row.text }); };
	const save = () => { if (editing) actions.edit(editing.id, editing.text); setEditing(null); };
	const cancel = () => { if (editing) actions.cancelEdit(editing.id); setEditing(null); };
	const onEditKey = (event) => {
		if (event.key === "Enter" && !event.shiftKey && !isImeComposing(event)) { event.preventDefault(); save(); }
		else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); }
	};
	return <section className="agent-queue" aria-label={ko("Queued messages", "대기 중인 메시지", "排队的消息")} data-agent-queue-held={queue.held ? "true" : "false"}>
		<p className="agent-queue-head">{headLine(queue, streaming)}</p>
		<ol className="agent-queue-rows">
			{queue.rows.map((row) => {
				const pictures = row.options?.attachments?.length ?? 0, isOpen = editing?.id === row.id && row.status === "editing";
				return <li key={row.id} className="agent-queue-row" data-queue-id={row.id} data-status={row.status}>
					{isOpen
						? <textarea className="agent-queue-input" aria-label={ko("Edit the queued message", "대기 중인 메시지 수정", "编辑排队的消息")} value={editing.text} autoFocus rows={2} onChange={(event) => setEditing({ id: row.id, text: event.target.value })} onKeyDown={onEditKey} />
						: <span className="agent-queue-text">{row.text}{pictures > 0 && <span className="agent-queue-meta"> · {ko(`${pictures} picture${pictures === 1 ? "" : "s"}`, `사진 ${pictures}장`, `${pictures} 张图片`)}</span>}</span>}
					<span className="agent-queue-actions">
						{row.status === "sending"
							? <span className="agent-queue-status" role="status">{ko("Waiting for the agent's next step…", "에이전트의 다음 단계를 기다리는 중…", "等待智能体的下一步…")}</span>
							: isOpen
								? <>
									<button type="button" className="agent-queue-icon agent-queue-save" aria-label={ko("Save", "저장", "保存")} title={ko("Save (Enter)", "저장 (Enter)", "保存 (Enter)")} disabled={!editing.text.trim()} onClick={save}><FiCheck size={13} aria-hidden="true" /></button>
									<button type="button" className="agent-queue-icon agent-queue-cancel" aria-label={ko("Cancel", "취소", "取消")} title={ko("Cancel (Esc)", "취소 (Esc)", "取消 (Esc)")} onClick={cancel}><FiX size={13} aria-hidden="true" /></button>
								</>
								: <>
									<button type="button" data-fid="agent_steer" className="agent-queue-send" title={streaming ? ko("Give this message to the running turn: the agent reads it at its next step", "진행 중인 턴에 이 메시지를 보내요: 에이전트가 다음 단계에서 읽어요", "把这条消息交给正在运行的这一轮：智能体在下一步读取") : ko("Send this message now as a new turn", "이 메시지를 지금 새 턴으로 보내요", "现在把这条消息作为新一轮发送")} onClick={() => onSendNow(row.id)}>{ko("Send now", "지금 보내기", "立即发送")}</button>
									<button type="button" className="agent-queue-icon agent-queue-edit" aria-label={ko("Edit", "수정", "编辑")} title={ko("Edit", "수정", "编辑")} onClick={() => open(row)}><FiEdit2 size={13} aria-hidden="true" /></button>
									<button type="button" className="agent-queue-icon agent-queue-remove" aria-label={ko("Remove", "삭제", "删除")} title={ko("Remove", "삭제", "删除")} onClick={() => actions.remove(row.id)}><FiX size={13} aria-hidden="true" /></button>
								</>}
					</span>
				</li>;
			})}
		</ol>
	</section>;
}
