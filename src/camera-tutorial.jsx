import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TutorialBeacon } from "./camera-tutorial-beacon.jsx";
import { GestureCue } from "./camera-tutorial-cue.jsx";
import { useViewportHost } from "./camera-tutorial-language.jsx";
import { CAMERA_TUTORIAL_STEPS, NAV_KINDS, SIGNAL_KINDS, TUTORIAL_BEACONS, WALK_KEYS } from "./camera-tutorial-steps.jsx";
import { noteGuideDismissed, noteGuideOpened, noteGuideStep } from "./guide-telemetry.js";
import { ko } from "./locale.js";
import { useStudioShell } from "./shell/studio-shell-context.js";
import "./camera-tutorial.css";

const reducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

// The camera tutorial: eight steps the operator finishes by doing them in the real Studio. It ran in the 2.x Studio
// (#206, #211), left with the 3.0 start screen, and is back for a first visit to the hosted Studio (guest-start.js),
// where it opens with the stage instead of the project chooser.
//
//   cozyclay:nav               fly / walk / dolly / orbit  (src/controls.jsx, nav-signal.js)
//   shotCount / railReady      shot / rail                 (authored state)
//   previewing prop            play                        (lookThroughShot)
//
// Nothing here drives the studio. A step is done when the operator has done
// the thing in the real tool — there is no "next" button to fake progress
// with, which is the whole point of teaching a camera by flying it.

/**
 * The overlay itself: a chip strip plus one hint card for the step the
 * operator is on. It sits at the top of the viewport pane, left of the
 * Top-View inset, and never takes the pointer except on its own close button
 * — every step is completed by working the studio underneath it.
 */
function CameraTutorial({ previsMode, previewing = false, playing = false, shotCount = 0, shotFrames = 0, railReady = false, onStepChange, onClose }) {
	const [done, setDone] = useState(() => new Set());
	const [walked, setWalked] = useState(() => new Set());
	const [cue, setCue] = useState(null);
	const reported = useRef(new Set());
	// the length the first shot was made with: the Length step is done once a shot is longer than that
	const [firstFrames, setFirstFrames] = useState(0);
	if (!firstFrames && shotFrames > 0) setFirstFrames(shotFrames);
	const effectiveDone = useMemo(() => {
		const next = new Set(done);
		if (shotCount > 0) next.add("shot");
		if (firstFrames && shotFrames > firstFrames) next.add("length");
		if (railReady) next.add("rail");
		// Play is playback seen through the shot camera, once there is a rail to ride.
		if (previewing && playing && next.has("rail")) next.add("play");
		return next;
	}, [done, firstFrames, playing, previewing, railReady, shotCount, shotFrames]);

	useEffect(() => {
		const complete = (kind) => setDone((current) => (current.has(kind) ? current : new Set(current).add(kind)));
		const onNav = (event) => {
			const kind = event.detail?.kind;
			if (!NAV_KINDS.has(kind)) return;
			if (kind !== "walk") {
				complete(kind);
				return;
			}
			const key = typeof event.detail?.key === "string" ? event.detail.key.toLowerCase() : null;
			if (!WALK_KEYS.includes(key)) return;
			setWalked((current) => {
				if (current.has(key)) return current;
				const next = new Set(current).add(key);
				if (WALK_KEYS.every((walkKey) => next.has(walkKey))) complete("walk");
				return next;
			});
		};
		const onSignal = (event) => {
			if (SIGNAL_KINDS.has(event.detail?.kind)) complete(event.detail.kind);
		};
		window.addEventListener("cozyclay:nav", onNav);
		window.addEventListener("cozyclay:playground-signal", onSignal);
		return () => {
			window.removeEventListener("cozyclay:nav", onNav);
			window.removeEventListener("cozyclay:playground-signal", onSignal);
		};
	}, []);

	// Studio-native completion comes from the authored state (shots, a rail, look-through), folded into
	// effectiveDone above. Latching it here keeps a step done after its state goes away again: leaving look-through
	// does not un-finish Play. Look-through only counts once there is a rail to ride.
	if (effectiveDone.size > done.size) setDone(effectiveDone);

	const current = useMemo(() => CAMERA_TUTORIAL_STEPS.find((step) => !effectiveDone.has(step.kind)) ?? null, [effectiveDone]);
	const complete = current === null;
	const currentKind = current?.kind ?? null;
	// guide:* telemetry in the "camera" mode: opened once, then each step as the studio reports it done.
	useEffect(() => { noteGuideOpened("camera"); }, []);
	useEffect(() => {
		CAMERA_TUTORIAL_STEPS.forEach((step, index) => {
			if (!effectiveDone.has(step.kind) || reported.current.has(step.kind)) return;
			reported.current.add(step.kind);
			noteGuideStep("camera", index + 1, CAMERA_TUTORIAL_STEPS.length);
		});
	}, [effectiveDone]);

	// The step the operator is on is the studio's business too: App puts it on
	// the .app root as data-tutorial-step, and styles.css spotlights whichever
	// control that step needs (#211).
	useEffect(() => {
		onStepChange?.(currentKind);
	}, [currentKind, onStepChange]);
	useEffect(() => () => onStepChange?.(null), [onStepChange]);

	// Steps 1–4 carry a gesture cue instead of a beacon. It fades out when its
	// step completes rather than vanishing under the hand that just finished it.
	const cueKind = currentKind && NAV_KINDS.has(currentKind) ? currentKind : null;
	if (cueKind && (cue?.kind !== cueKind || cue.leaving)) setCue({ kind: cueKind, leaving: false });
	else if (!cueKind && cue && !cue.leaving) setCue(reducedMotion() ? null : { ...cue, leaving: true });

	// Storyboard projects never show the camera tutorial (its steps are shot/rail/play).
	if (previsMode === "storyboard") return null;

	return (
	<>
		<aside
			className="camera-tutorial"
			data-testid="camera-tutorial"
			data-state={complete ? "done" : "active"}
			data-previewing={previewing ? 1 : 0}
			aria-label={ko("Camera tutorial", "카메라 튜토리얼")}
		>
			<ol className="camera-tutorial-steps">
				{CAMERA_TUTORIAL_STEPS.map((step, index) => (
					<li
						key={step.kind}
						data-testid="camera-tutorial-step"
						data-kind={step.kind}
						data-done={effectiveDone.has(step.kind) ? 1 : 0}
						data-current={step === current ? 1 : 0}
					>
						<i aria-hidden="true">{effectiveDone.has(step.kind) ? "✓" : index + 1}</i>
						{step.label}
					</li>
				))}
			</ol>
			<div className="camera-tutorial-card" data-testid="camera-tutorial-card" role="status">
				{complete ? (
					<>
						<span className="camera-tutorial-count done">{ko("Done", "완료", "完成")}</span>
						<p>{ko(
							"That is the whole camera: look, walk, dolly, orbit, cut, length, rail, play. Next, open the Motion tab and press a sample motion to change how the character moves.",
							"카메라의 전부입니다: 보기, 걷기, 돌리, 궤도, 컷, 길이, 레일, 재생. 다음은 Motion 탭에서 샘플 동작을 눌러 캐릭터의 움직임을 바꿔 보세요.",
							"这就是摄影机的全部：环顾、行走、推拉、环绕、镜头、时长、轨道、播放。接下来打开 Motion 标签页，点一个示例动作，改变角色的动作。",
						)}</p>
					</>
				) : (
					<>
						<span className="camera-tutorial-count">{`${CAMERA_TUTORIAL_STEPS.indexOf(current) + 1} / ${CAMERA_TUTORIAL_STEPS.length}`}</span>
						<p>
							{current.where && <span className="camera-tutorial-where">{current.where}</span>}
							{current.how({ walked })}
						</p>
					</>
				)}
			</div>
			<button
				type="button"
				className="camera-tutorial-close"
				data-testid="camera-tutorial-close"
				aria-label={ko("Close tutorial", "튜토리얼 닫기")}
				title={ko("Close tutorial", "튜토리얼 닫기")}
				onClick={() => { if (!complete) noteGuideDismissed("camera", CAMERA_TUTORIAL_STEPS.indexOf(current) + 1); onClose?.(); }}
			>
				×
			</button>
		</aside>
		{cue && (
			<GestureCue
				kind={cue.kind}
				walked={walked}
				leaving={cue.leaving}
				onLeft={() => setCue((prev) => (prev?.leaving ? null : prev))}
			/>
		)}
		{(TUTORIAL_BEACONS[currentKind] ?? []).map((beacon) => (
			<TutorialBeacon
				key={beacon.role}
				kind={currentKind}
				step={CAMERA_TUTORIAL_STEPS.indexOf(current) + 1}
				role={beacon.role}
				selector={beacon.selector}
				label={beacon.label}
				requires={beacon.requires}
				absent={beacon.absent}
			/>
		))}
	</>
	);
}

/**
 * The tutorial over the live Studio: it reads the shots, the rail and look-through from the shell, hangs itself in
 * the viewport pane, and publishes the current step on the .app root for the spotlight (camera-tutorial.css).
 */
export default function StudioCameraTutorial({ onClose }) {
	const shell = useStudioShell();
	const host = useViewportHost();
	const looking = Boolean(shell?.lookThroughShot);
	useEffect(() => {
		const app = document.querySelector(".app");
		if (!app) return undefined;
		if (looking) app.dataset.tutorialLooking = "1"; else delete app.dataset.tutorialLooking;
		return () => { delete app.dataset.tutorialLooking; };
	}, [looking]);
	const publish = useCallback((kind) => {
		const app = document.querySelector(".app");
		if (!app) return;
		if (kind) app.dataset.tutorialStep = kind; else delete app.dataset.tutorialStep;
	}, []);
	if (!host || !shell) return null;
	const shots = shell.shots ?? [];
	return createPortal(
		<CameraTutorial
			previsMode={shell.previsMode}
			previewing={looking}
			playing={Boolean(shell.tlPlaying)}
			shotCount={shots.length}
			shotFrames={Math.max(0, ...shots.map((shot) => shot.endFrame - shot.startFrame + 1))}
			railReady={shots.some((shot) => Array.isArray(shot.camera?.cameraRail) && shot.camera.cameraRail.length >= 2)}
			onStepChange={publish}
			onClose={onClose}
		/>,
		host,
	);
}
