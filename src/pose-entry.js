// The Pose tab with no posable active character (#1048). On 3.2.1 most Pose
// clicks landed on a disabled tab that looked enabled, and the reason toast
// showed at the bottom of the screen, far from the click. Now:
//  - exactly ONE rigged character: the click selects it and enters Pose as soon
//    as its rig resolves (the tab is not disabled at all);
//  - none, or several to choose from: the tab looks disabled, and the click
//    lights up what to do next (Add, or the character rows in the Outliner).
import { useEffect, useRef } from "react";
import { characterCapabilities } from "./character-kind.js";
import { ko } from "./locale.js";

const POINT_MS = 1600;
const POINT_TARGETS = { add: "[data-testid='viewport-add']", characters: ".hierarchy-row[data-kind='character']" };

/** What a Pose click does: enter, select the one rigged character, or refuse with a reason and a target to point at. */
export function planPoseEntry(characters, activeChar, refusal) {
	if (!refusal) return { enter: true };
	const cast = characters ?? [];
	const rigged = cast.filter((entry) => characterCapabilities(entry).pose);
	// The active character is rigged but its rig is still resolving: wait for it rather than refuse.
	if (rigged.some((entry) => entry.id === activeChar?.id)) return { selectId: activeChar.id };
	if (rigged.length === 1) return { selectId: rigged[0].id };
	if (!cast.length) return { reason: ko("Add a character first: Add > Y Bot", "먼저 캐릭터를 추가하세요: 추가 > Y Bot", "请先添加角色：添加 > Y Bot"), point: "add" };
	// Only capsule figures: none of them can be posed, so point at Add instead of at them.
	if (!rigged.length) return { reason: refusal, point: "add" };
	return { reason: ko("Select a character to pose first", "먼저 포즈를 잡을 캐릭터를 선택하세요", "请先选择要摆姿势的角色"), point: "characters" };
}

/** Light up the control the refusal points at for one beat. */
export function pointAt(point, doc = globalThis.document) {
	const selector = POINT_TARGETS[point];
	if (!selector || !doc?.querySelectorAll) return;
	for (const node of doc.querySelectorAll(selector)) {
		node.classList.remove("pose-point");
		void node.offsetWidth; // restart the pulse on a repeat click
		node.classList.add("pose-point");
		setTimeout(() => node.classList.remove("pose-point"), POINT_MS);
	}
}

/** The plan for this render plus `request()`, the Pose tab's click. `enter()` is the app's own mode switch. */
export function usePoseEntry({ characters, activeChar, refusal, select, enter }) {
	const plan = planPoseEntry(characters, activeChar, refusal);
	const pending = useRef(false);
	useEffect(() => {
		if (!pending.current || refusal) return;
		pending.current = false;
		enter();
	}, [refusal]); // eslint-disable-line react-hooks/exhaustive-deps -- enter once the rig resolves
	// A character removed or swapped while its rig loads cancels the wait.
	useEffect(() => { if (plan.selectId == null) pending.current = false; }, [plan.selectId]);
	/** True when the click was handled (selected or entered); false when it refused. */
	const request = () => {
		if (plan.enter) return enter();
		if (plan.selectId == null) { pointAt(plan.point); return false; }
		pending.current = true;
		select(plan.selectId);
		return true;
	};
	return { plan, blocked: Boolean(refusal) && plan.selectId == null, request };
}
