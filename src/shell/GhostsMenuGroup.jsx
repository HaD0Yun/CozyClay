// The View menu's Ghosts group: onion skin on or off, every N frames or at the key frames, and
// how many on each side. Every control runs view.setGhosts, the agent's door to the same setting.
// The last item shows or hides the agent's draft ghost (draft-ghost.js), a viewer-only setting.
import { useStudioShell } from "./studio-shell-context.js";
import { ko } from "../locale.js";
import { GHOST_COLORS, GHOST_COUNT, GHOST_STEP, useGhostSettings } from "../view-ghosts.js";
import { DRAFT_GHOST_COLOR, setDraftGhostShown, useDraftGhostShown } from "../draft-ghost.js";
import "./ghosts-menu.css";

function Stepper({ label, value, range, disabled, onChange, testId }) {
	return (
		<div className={"view-menu-item ghost-stepper" + (disabled ? " disabled" : "")} data-testid={testId}>
			<span className="view-menu-mark" aria-hidden="true" />
			<span className="ghost-stepper-label">{label}</span>
			<button type="button" role="menuitem" aria-label={`${label} −`} disabled={disabled || value <= range.min} onClick={() => onChange(value - 1)}>−</button>
			<output className="ghost-stepper-value">{value}</output>
			<button type="button" role="menuitem" aria-label={`${label} +`} disabled={disabled || value >= range.max} onClick={() => onChange(value + 1)}>+</button>
		</div>
	);
}

export default function GhostsMenuGroup() {
	const { runStudioAction } = useStudioShell();
	const ghosts = useGhostSettings();
	const drafts = useDraftGhostShown();
	const set = (patch) => runStudioAction("view.setGhosts", { mode: ghosts.mode, count: ghosts.count, step: ghosts.step, ...patch });
	const options = [
		{ value: "off", label: ko("Off", "끔") },
		{ value: "step", label: ko(`Every ${ghosts.step} frames`, `${ghosts.step}프레임마다`, `每 ${ghosts.step} 帧`) },
		{ value: "keys", label: ko("Key frames", "키 프레임") },
	];
	return (
		<div className="view-menu-group ghosts-menu" role="group" aria-label={ko("Ghosts (onion skin)", "고스트 (어니언 스킨)")}>
			<span className="view-menu-label" aria-hidden="true">
				{ko("Ghosts", "고스트")}
				<i className="ghost-swatch" style={{ background: GHOST_COLORS.before }} title={ko("before the playhead", "재생 헤드 앞")} />
				<i className="ghost-swatch" style={{ background: GHOST_COLORS.after }} title={ko("after the playhead", "재생 헤드 뒤")} />
			</span>
			{options.map((option) => {
				const checked = option.value === ghosts.mode;
				return (
					<button
						type="button"
						key={option.value}
						role="menuitemradio"
						className={"view-menu-item ghost-mode-option" + (checked ? " active" : "")}
						data-ghosts={option.value}
						aria-checked={checked}
						title={ko("Translucent poses of the selected character's take before and after the playhead; never in exports", "선택한 인물 테이크의 앞뒤 포즈를 반투명하게 표시합니다. 내보내기에는 나오지 않습니다")}
						onClick={() => set({ mode: option.value })}
					>
						<span className="view-menu-mark" aria-hidden="true">{checked ? "✓" : ""}</span>
						{option.label}
					</button>
				);
			})}
			<Stepper label={ko("Each side", "양쪽 개수")} value={ghosts.count} range={GHOST_COUNT} disabled={ghosts.mode === "off"} onChange={(count) => set({ count })} testId="ghost-count" />
			<Stepper label={ko("Step", "간격")} value={ghosts.step} range={GHOST_STEP} disabled={ghosts.mode !== "step"} onChange={(step) => set({ step })} testId="ghost-step" />
			<button
				type="button"
				role="menuitemcheckbox"
				className={"view-menu-item draft-ghost-option" + (drafts ? " active" : "")}
				data-testid="draft-ghost-toggle"
				aria-checked={drafts}
				title={ko("While the agent works, its latest motion draft plays on the character as a teal figure; never in exports", "에이전트가 작업하는 동안 최신 모션 초안을 인물 위에 청록색으로 재생합니다. 내보내기에는 나오지 않습니다")}
				onClick={() => setDraftGhostShown(!drafts)}
			>
				<span className="view-menu-mark" aria-hidden="true">{drafts ? "✓" : ""}</span>
				{ko("Agent draft", "에이전트 초안")}
				<i className="ghost-swatch" style={{ background: DRAFT_GHOST_COLOR, marginLeft: "auto" }} aria-hidden="true" />
			</button>
		</div>
	);
}
