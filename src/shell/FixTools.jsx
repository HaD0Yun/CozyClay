// Fix and tell, on the IK keys row's header in Pose mode when the character has an installed take (the key bar above is
// full: its controls already overflow it): Fix mode (a pose drag makes a correction
// island at that frame, domains/motion/fix-islands.js), A/B (the take alone or with its fixes; the fixed view also ghosts
// the original pose, fix-original-ghost.jsx) and Send fixes (one composer chip per island, fix-send.js). Icon-sized.
import { useContext, useEffect, useSyncExternalStore } from "react";
import { FiCheck, FiSend, FiTool } from "react-icons/fi";
import { AppContext } from "../app-context.js";
import { ko } from "../locale.js";
import { fixView, setFixMode, setFixView, useFixMode, useFixView } from "../motion/fix-door.js";
import { islandsOf } from "../motion/fix-weight.js";
import { sendFixes } from "../fix-send.js";
import { mergeFixKeys } from "../domains/motion/fix-islands.js";
import { mergeNotice } from "../motion/TimelineFixIslands.jsx";
import { useStudioShell } from "./studio-shell-context.js";
import "./fix-tools.css";

const none = () => () => {};

/** Show the take alone ("original") or with its fixes, on every live character, and re-pose the playhead. */
function showView(app, view) {
	setFixView(view);
	const owner = app.storeDomain("motion");
	for (const state of owner?.liveIkStates().values() ?? []) state.fixView = view;
	owner?.project?.();
}

export function FixTools() {
	const app = useContext(AppContext), shell = useStudioShell(), characterId = shell?.activeChar?.id ?? null;
	const owner = app?.storeDomain?.("motion") ?? null;
	const row = useSyncExternalStore(owner?.documentStore.subscribe ?? none, () => owner?.read().find((entry) => entry.id === characterId) ?? null);
	const mode = useFixMode(), view = useFixView();
	// Leaving Pose mode (or the take) puts the fixes back on screen; already showing them, it re-poses nothing.
	useEffect(() => () => { if (app?.storeDomain && fixView() === "original") showView(app, "fixed"); }, [app]);
	if (!owner || !row?.take) return null;
	const islands = islandsOf(row.ikKeys).length, original = view === "original";
	const send = () => sendFixes(app, characterId, shell?.activeRig).then((count) => {
		if (shell?.agentOpen === false) shell.toggleAgent?.();
		app.notify?.(ko(`${count} fix${count === 1 ? "" : "es"} added to the message`, `보정 ${count}개를 메시지에 담았어요`, `已将 ${count} 个修正加入消息`));
	}, (error) => app.notify?.(error.message));
	return (
		<span className="pose-fix-tools">
			<button type="button" className="pose-fix-icon" aria-pressed={mode} data-testid="fix-mode" onClick={() => setFixMode(!mode)}
				aria-label={ko("Fix mode", "보정 모드", "修正模式")}
				title={ko("Fix mode: a pose drag keys that body part at this frame, on its own row under IK keys. The first key eases in and out over 6 frames each side; more keys shape the motion between them", "보정 모드: 포즈를 끌면 그 파츠가 이 프레임에 키로 찍혀요 (IK 키 아래 파츠 줄). 첫 키는 양쪽 6프레임에 걸쳐 들어오고 빠지고, 키를 더 찍으면 그 사이 동작을 만들어요", "修正模式：拖动姿势会在此帧为该部位记录关键帧（IK 键下的部位行）。第一个关键帧前后各 6 帧渐入渐出；更多关键帧塑造其间的动作")}>
				<FiTool size={13} aria-hidden="true" />
			</button>
			<button type="button" className="pose-fix-icon" aria-pressed={original} data-testid="fix-ab" disabled={!islands} onClick={() => showView(app, original ? "fixed" : "original")}
				aria-label={ko("Compare with the original take", "원본 테이크와 비교", "与原始片段对比")}
				title={original ? ko("Showing the original take (A). Click to show it with your fixes (B)", "원본 테이크(A)를 보는 중. 클릭하면 보정한 버전(B)을 봐요", "正在显示原始片段 (A)。点击显示修正后的版本 (B)")
					: ko("Showing the take with your fixes (B), the original pose as a ghost. Click to show the original take (A)", "보정한 버전(B)을 보는 중, 원래 포즈는 고스트로 보여요. 클릭하면 원본 테이크(A)를 봐요", "正在显示修正后的片段 (B)，原始姿势显示为残影。点击显示原始片段 (A)")}>
				{original ? "A" : "B"}
			</button>
			<button type="button" className="pose-fix-icon" data-testid="fix-merge-all" disabled={!islands} onClick={() => app.notify?.(mergeNotice(mergeFixKeys(owner, characterId)))}
				aria-label={ko("Merge all keys into the motion", "키를 모두 모션에 병합", "将全部关键帧合并进动作")}
				title={ko("Merge all keys into the motion: the take's own frames take this motion and every row clears, so the next keys start a new layer over it. Undo brings the keys back", "키를 모두 모션에 병합: 테이크의 프레임 자체가 이 동작이 되고 줄이 모두 비워져서, 다음 키는 그 위에 새로 쌓여요. 실행 취소하면 키로 돌아와요", "将全部关键帧合并进动作：片段自身的帧变为此动作并清空所有行，之后的关键帧在其上新建一层。撤销可恢复关键帧")}>
				<FiCheck size={13} aria-hidden="true" />
			</button>
			<button type="button" className="pose-fix-icon" data-testid="fix-send" disabled={!islands} onClick={send}
				aria-label={ko("Send fixes to the agent", "보정을 에이전트에게 보내기", "将修正发送给代理")}
				title={ko("Send fixes: one chip per fix in the agent's message, with a before and after picture", "보정 보내기: 보정마다 칩 하나를 에이전트 메시지에 담고, 전후 사진을 붙여요", "发送修正：每个修正在代理消息中添加一个标签，并附上前后对比图")}>
				<FiSend size={13} aria-hidden="true" />
			</button>
		</span>
	);
}
