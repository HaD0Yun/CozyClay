import { useContext, useState } from "react";
import Foldout from "./Foldout.jsx";
import { AppContext } from "../app-context.js";
import { ko } from "../locale.js";
import { trackFeature } from "../analytics.js";
import { useStudioShell } from "../shell/studio-shell-context.js";
import { SAMPLE_MOTIONS, sampleMotionSpec } from "../motion/sample-motions.js";

// Motion mode, a character selected: one click installs a sample take and plays it. It needs no agent and no agent
// server, so it is what the hosted Studio can show of motion (the Agent panel there says so and points here).
export default function SampleMotionsPanel({ hidden, activeChar }) {
	const app = useContext(AppContext);
	const { setTlFrame, setTlPlaying, tlFrameCount } = useStudioShell();
	const [busy, setBusy] = useState(null), [status, setStatus] = useState("");
	const say = text => { setStatus(text); app?.notify?.(text); };
	const run = async sample => {
		setBusy(sample.id); setStatus("");
		try {
			const receipt = await app.bus.run("motion.compile", { characterId: activeChar.id, spec: sampleMotionSpec(sample.id, activeChar), install: true });
			if (!receipt?.ok) throw new Error(receipt?.message ?? "motion.compile failed");
			const frames = receipt.output?.frames ?? receipt.output?.take?.frames;
			if (Number.isFinite(frames) && frames > tlFrameCount) await app.bus.run("shot.setTimeline", { frameCount: frames });
			trackFeature("sample_motion");
			setTlFrame?.(0); setTlPlaying?.(true);
			say(ko(`${sample.en} installed. Press Space to play or stop.`, `${sample.ko} 테이크를 넣었어요. Space로 재생하거나 멈추세요.`, `已添加“${sample.zh}”。按空格播放或停止。`));
		} catch (error) { say(error.message); } finally { setBusy(null); }
	};
	return (
		<Foldout hidden={hidden} title={ko("Sample motions", "샘플 동작", "示例动作")}>
			<div className="sample-motions v2-details-panel" data-fid="sample_motions">
				<p className="inspector-hint">{ko("One click makes the character move. It replaces the current take; Undo brings it back.", "한 번 누르면 캐릭터가 움직여요. 지금 테이크를 바꾸며, 실행 취소로 되돌릴 수 있어요.", "点一下角色就会动起来。会替换当前动作，可用撤销恢复。")}</p>
				<div className="sample-motions-list">
					{SAMPLE_MOTIONS.map(sample => (
						<button key={sample.id} type="button" className="secondary-button" data-sample-motion={sample.id} disabled={busy !== null} aria-busy={busy === sample.id} onClick={() => run(sample)}>
							{busy === sample.id ? ko("Making…", "만드는 중…", "生成中…") : ko(sample.en, sample.ko, sample.zh)}
						</button>
					))}
				</div>
				{status && <p className="inspector-hint" role="status">{status}</p>}
			</div>
		</Foldout>
	);
}
