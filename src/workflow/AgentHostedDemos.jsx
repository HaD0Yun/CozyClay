// What the agent does, shown on a page that has no agent (the hosted Studio's Agent panel, AgentOfflineCard.jsx):
// three requests as buttons. Each one does in the Studio what the agent would do for those words, with the same
// commands: a walk or a flip from the motion compiler's own skills (motion/sample-motions.js), and a street of
// grey-box buildings added one by one (agent-demo-set.js). They are fixed results, not a model; the card says so.
import { useContext, useState } from "react";
import { FiCheck, FiPlay } from "react-icons/fi";
import { AppContext } from "../app-context.js";
import { trackFeature } from "../analytics.js";
import { ko } from "../locale.js";
import { sampleMotionSpec } from "../motion/sample-motions.js";
import { useStudioShell } from "../shell/studio-shell-context.js";
import { demoStreet } from "./agent-demo-set.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DEMOS = [
	{ id: "walk", motion: "walk", ask: () => ko("Make the character walk in", "캐릭터가 걸어 들어오게 해줘", "让角色走进来"), done: () => ko("Walk added. Space plays and stops.", "걷기를 넣었어요. Space로 재생하고 멈춰요.", "已添加行走。按空格播放或停止。") },
	{ id: "street", ask: () => ko("Build a street around them", "주변에 거리를 만들어줘", "在周围搭一条街道"), done: () => ko("Eight buildings added. They are ordinary objects: select, move, delete.", "건물 8개를 세웠어요. 일반 오브젝트라 선택, 이동, 삭제가 됩니다.", "已添加 8 栋建筑。它们是普通物体，可以选中、移动、删除。") },
	{ id: "flip", motion: "back_flip", ask: () => ko("Now a back flip", "이번엔 백플립", "再来一个后空翻"), done: () => ko("Back flip added. Space plays and stops.", "백플립을 넣었어요. Space로 재생하고 멈춰요.", "已添加后空翻。按空格播放或停止。") },
];

export default function AgentHostedDemos() {
	const app = useContext(AppContext), shell = useStudioShell();
	const [busy, setBusy] = useState(null), [finished, setFinished] = useState(() => new Set()), [status, setStatus] = useState("");
	const character = () => app?.storeDomain?.("cast")?.read?.().at(-1) ?? null;
	const motion = async (id, who) => {
		const receipt = await app.bus.run("motion.compile", { characterId: who.id, spec: sampleMotionSpec(id, who), install: true });
		if (!receipt?.ok) throw new Error(receipt?.message ?? "motion.compile failed");
		const frames = receipt.output?.frames ?? receipt.output?.take?.frames;
		if (Number.isFinite(frames) && frames > shell.tlFrameCount) await app.bus.run("shot.setTimeline", { frameCount: frames });
		shell.setTlFrame?.(0); shell.setTlPlaying?.(true);
	};
	const street = async (who) => {
		const have = new Set((app.storeDomain("objects").read() ?? []).map((object) => object.name));
		for (const { name, x, z, ...patch } of demoStreet(who)) {
			if (have.has(name)) continue;
			const added = await app.bus.run("object.add", { kind: "cube", name, placement: { x, z } });
			await app.bus.run("object.update", { id: added.affectedIds[0], patch });
			await pause(140); // one by one, the way an agent's turn lands on the stage
		}
	};
	const run = async (demo) => {
		const who = character();
		if (!who) return setStatus(ko("Add a character first: + in the toolbar, then Character.", "먼저 캐릭터를 추가하세요: 툴바의 +, Character.", "请先添加角色：工具栏的 +，然后选 Character。"));
		setBusy(demo.id); setStatus("");
		try {
			await (demo.motion ? motion(demo.motion, who) : street(who));
			trackFeature("agent_demo");
			setFinished((current) => new Set(current).add(demo.id)); setStatus(demo.done());
		} catch (error) { setStatus(String(error?.message ?? error)); } finally { setBusy(null); }
	};
	return <div className="agent-demos" data-fid="agent_demos">
		{DEMOS.map((demo) => <button key={demo.id} type="button" className="agent-demo" data-demo={demo.id} disabled={busy !== null} aria-busy={busy === demo.id} onClick={() => run(demo)}>
			{finished.has(demo.id) ? <FiCheck size={12} aria-hidden="true" /> : <FiPlay size={11} aria-hidden="true" />}<span>{demo.ask()}</span>
		</button>)}
		<p className="agent-demos-status" role="status" aria-live="polite">{status}</p>
	</div>;
}
