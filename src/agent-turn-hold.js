// What the user is told when an agent turn holds the scene (command-bus.js). A turn lands as one history entry, so
// once it has authored an edit the user's own edits wait for it; before that they go through (the agent waits out a
// drag and rebases on the new revision). The refusal used to be silent: a drag or an Add did nothing at all.
import { ko } from "./locale.js";

const agentHoldMessage = () => ko("The agent is editing the scene: wait for it, or press Stop to take over.", "에이전트가 장면을 편집하고 있어요. 끝날 때까지 기다리거나 Stop을 눌러 바로 편집하세요.", "智能体正在编辑场景：请等待，或按 Stop 立即接手。");

/** A user command an open agent turn refused: name the turn, in the locale, instead of the protocol's English. */
export const holdRefusal = (error, turnOpen, origin) => {
	if (origin === "ui" && turnOpen && error?.code === "TARGET_BUSY" && !error.uiMessage) error.uiMessage = agentHoldMessage();
	return error;
};
