import { useEffect, useState } from "react";
import { ko } from "./locale.js";
import { noteGuideDismissed, noteGuideOpened, noteGuideStep } from "./guide-telemetry.js";

const ANIMATION_STEPS = [
	{
		// #1047: a new project starts with no character, so the old "Select Character 1"
		// had nothing to select. Adding one is the step, and it ticks itself off.
		en: "Add a character.",
		ko: "인물을 추가하세요.",
		zh: "添加一个角色。",
		hintEn: "Click the lit Add button at the top of the tool rail on the right, then Block figure.",
		hintKo: "오른쪽 도구 막대 맨 위에 빛나는 추가 버튼을 누르고 블록 인형을 고르세요.",
		hintZh: "点击右侧工具栏顶部高亮的“添加”按钮，然后选择积木人。",
	},
	{
		en: "Move it in the Scene view.",
		ko: "장면 보기에서 인물을 움직이세요.",
		zh: "在场景视图中移动它。",
		hintEn: "Drag the character marker on the floor to place it.",
		hintKo: "바닥의 인물 마커를 드래그해 배치하세요.",
		hintZh: "拖动地面上的角色标记来摆放位置。",
	},
	{
		en: "Ask the Agent for a motion.",
		ko: "에이전트에게 동작을 요청하세요.",
		zh: "让智能体生成一个动作。",
		hintEn: "Open it with Cmd/Ctrl+B and say what the character does; the take lands on the Body lane.",
		hintKo: "Cmd/Ctrl+B로 열고 인물이 할 동작을 말하면 테이크가 바디 레인에 올라갑니다.",
		hintZh: "按 Cmd/Ctrl+B 打开，说出角色要做的动作；动作片段会落在身体轨道上。",
	},
	{
		en: "Scrub the timeline or press Space to play.",
		ko: "타임라인을 문지르거나 Space를 눌러 재생하세요.",
		zh: "拖动时间线或按空格播放。",
		hintEn: "Seeing the playhead move is your first visible result.",
		hintKo: "재생 헤드가 움직이면 첫 결과를 확인한 것입니다.",
		hintZh: "看到播放头移动，就是你的第一个可见结果。",
	},
];

const ADD_BUTTON = "[data-testid='viewport-add']";

/** A compact, dismissible first-run checklist that follows the v2 shell grammar. */
export default function FirstSuccessGuide({ open, onDismiss, castCount = 0 }) {
	const mode = "animation";
	const STEPS = ANIMATION_STEPS;
	const [marked, setStep] = useState(0);
	useEffect(() => {
		if (open) { setStep(0); noteGuideOpened(mode); }
	}, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- reported once per opening
	// Step 1 is done while a character exists, whether it was added now or was already there.
	const castDone = castCount > 0;
	const step = castDone ? Math.max(marked, 1) : marked;
	const addStep = open && step === 0;
	useEffect(() => {
		if (open && castDone && marked === 0) noteGuideStep(mode, 1, STEPS.length);
	}, [open, castDone]); // eslint-disable-line react-hooks/exhaustive-deps -- reported once, when it ticks
	// ...and until then its target, the Add button, is lit.
	useEffect(() => {
		const target = addStep ? globalThis.document?.querySelector(ADD_BUTTON) : null;
		target?.classList.add("guide-target");
		return () => target?.classList.remove("guide-target");
	}, [addStep]);
	if (!open) return null;
	const complete = step >= STEPS.length;
	// Closing after the last step is not a drop-off: only an unfinished guide reports guide:dismissed.
	const dismiss = () => { if (!complete) noteGuideDismissed(mode, step + 1); onDismiss(); };

	return (
		<aside className="v2-first-success-guide first-success-guide" role="dialog" aria-labelledby="first-success-guide-kicker first-success-guide-title" aria-describedby="first-success-guide-description">
			<div className="v2-first-success-guide-head first-success-guide-head">
				<div>
					<em className="v2-first-success-guide-kicker" id="first-success-guide-kicker" data-testid="first-success-guide-kicker">{ko("Tutorial", "튜토리얼")}</em>
					<strong id="first-success-guide-title">{ko("Your first 60 seconds", "첫 60초")}</strong>
					<span>{complete ? ko("Core loop complete", "핵심 흐름 완료", "核心流程完成") : ko(`Step ${step + 1} of ${STEPS.length}`, `${step + 1} / ${STEPS.length} 단계`, `第 ${step + 1} / ${STEPS.length} 步`)}</span>
				</div>
				<button type="button" className="v2-first-success-guide-close first-success-guide-close" onClick={dismiss} aria-label={ko("Dismiss guide", "가이드 닫기")}>×</button>
			</div>
			{complete ? (
				<div className="v2-first-success-guide-complete first-success-guide-complete" id="first-success-guide-description" role="status">
					<div className="v2-first-success-guide-check first-success-guide-check">✓</div>
					<strong>{ko("You made your first shot.", "첫 샷을 만들었어요.")}</strong>
					<p>{ko("Add, move, ask, and play are the core CozyClay loop. You can close this guide and keep blocking.", "추가하고, 움직이고, 요청하고, 재생하는 것이 CozyClay의 핵심 흐름입니다. 가이드를 닫고 계속 블로킹하세요.")}</p>
					<button type="button" className="v2-first-success-guide-next first-success-guide-next btn primary" onClick={dismiss}>{ko("Continue editing", "편집 계속하기")}</button>
				</div>
			) : (
				<>
					<p id="first-success-guide-description" className="v2-first-success-guide-intro first-success-guide-intro">{ko("Follow these four actions to see a result quickly.", "네 가지 동작으로 빠르게 결과를 확인해 보세요.")}</p>
					<ol className="v2-first-success-guide-steps first-success-guide-steps">
						{STEPS.map((item, index) => (
							<li key={item.en} className={index < step ? "done" : index === step ? "current" : ""}>
								<span className="v2-first-success-guide-step-mark first-success-guide-step-mark">{index < step ? "✓" : index + 1}</span>
								<div><strong>{ko(item.en, item.ko, item.zh)}</strong>{index === step && <span>{ko(item.hintEn, item.hintKo, item.hintZh)}</span>}</div>
							</li>
						))}
					</ol>
					<button type="button" className="v2-first-success-guide-next first-success-guide-next btn primary" onClick={() => { noteGuideStep(mode, step + 1, STEPS.length); setStep(step + 1); }}>
						{ko(step === STEPS.length - 1 ? "Mark complete" : "I did this", step === STEPS.length - 1 ? "완료로 표시" : "했어요", step === STEPS.length - 1 ? "标记完成" : "我做了这一步")}
					</button>
				</>
			)}
			<button type="button" className="v2-first-success-guide-skip first-success-guide-skip" onClick={dismiss}>{ko("Skip guide", "가이드 건너뛰기")}</button>
		</aside>
	);
}
