// What the Studio agent sees of the editor's actions while the lowvis engine is on: one way to move a rig character,
// the motion tool (motion-door.mjs). The old motion actions and the hand-fix actions (HIDDEN_ACTIONS) leave the
// action index the model reads and the inspect_studio { scope: "actions" } answer, and run_action refuses them. The
// root-path actions are refused for a rig character; arrange_characters, character.set and patch_elements are refused
// when they set the pose of a rig character. People are rig figures only (drawn in the look of the launch, src/lowvis/studio/figure.js): the agent cannot add a capsule figure
// (model proxy-figure) or change a character into one, the actions read lose the capsule fields (that model, posture,
// castStyle) and the context loses scene.castStyle. A capsule figure the user adds in the editor stays. The tools'
// internal.invoke is not filtered: the motion tool installs through it. Under the old engine nothing changes.
import { HIDDEN_ACTIONS, motionEngine } from "./motion-engine.mjs";

const HIDDEN = new Set(HIDDEN_ACTIONS);
const ROOT_PATH = new Set(["character.addWaypoint", "character.moveWaypoint", "character.removeWaypoint", "character.clearWaypoints"]);
const CAPSULE = "proxy-figure", CAPSULE_FIELDS = new Set(["posture", "castStyle"]);
const RIG_ONLY = "This version has rig figures only: the agent cannot add a capsule figure (model proxy-figure) or change a character into one.";
// pi-tools.mjs formats a thrown error as "<code>: <message>"
const refuse = message => { throw Object.assign(new Error(message), { code: "NOT_AVAILABLE" }); };
const isRecord = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// A copy of an action declaration without the capsule fields, the capsule model in an enum, or its name in a description.
function blockOnly(value) {
	if (Array.isArray(value)) return value.filter(item => item !== CAPSULE).map(blockOnly);
	if (typeof value === "string") return value.replaceAll(`, ${CAPSULE}`, "");
	if (!isRecord(value)) return value;
	const out = {};
	for (const [key, item] of Object.entries(value)) if (!(CAPSULE_FIELDS.has(key) && isRecord(item))) out[key] = blockOnly(item);
	if (Array.isArray(out.required)) out.required = out.required.filter(key => !CAPSULE_FIELDS.has(key));
	return out;
}

/** The action index rows the agent may see. */
export const visibleActions = rows => (Array.isArray(rows) ? rows.filter(row => !HIDDEN.has(row?.id)).map(blockOnly) : rows);

/**
 * turnAgentView({ env, value, current, invoke }) -> { tools(list) }: under the lowvis engine, drops HIDDEN_ACTIONS from
 * both copies of the turn's action index (value.context.actionIndex, which the model reads, and current.actionIndex,
 * the authoritative read), and tools(list) answers the model-facing Studio tools with the refusals above. Under the old
 * engine both copies stay and tools(list) is the list itself.
 * invoke(name, args): the turn's unfiltered Studio tools, to read the kind of a character the turn's context does not list.
 */
export function turnAgentView({ env = process.env, value, current, invoke }) {
	if (motionEngine(env) !== "lowvis") return { tools: list => list };
	if (Array.isArray(value?.context?.actionIndex)) value.context.actionIndex = visibleActions(value.context.actionIndex);
	if (Array.isArray(current?.actionIndex)) current.actionIndex = visibleActions(current.actionIndex);
	if (isRecord(value?.context?.scene)) delete value.context.scene.castStyle;
	const kinds = new Map((value?.context?.entities ?? []).filter(row => row?.kind === "character" && row.characterKind).map(row => [row.id, row.characterKind]));
	const isRig = async characterId => {
		if (typeof characterId !== "string" || !characterId) return false;
		if (!kinds.has(characterId)) {
			try {
				const row = (await invoke("inspect_studio", { scope: "entities", ids: [characterId] }))?.entities?.find(entity => entity?.id === characterId);
				if (row?.characterKind) kinds.set(characterId, row.characterKind);
			} catch { /* an unknown id: the editor answers it */ }
		}
		return kinds.get(characterId) === "rig";
	};
	const posesRig = async (id, set) => isRecord(set) && "pose" in set && await isRig(id);
	const check = {
		run_action: async args => {
			const action = args?.action, input = isRecord(args?.args) ? args.args : {};
			if (HIDDEN.has(action)) refuse(`${action} is not available to the agent; body motion is the motion tool's work`);
			if (ROOT_PATH.has(action) && await isRig(input.characterId)) refuse(`${action} is not available for the rig character ${input.characterId}; body motion is the motion tool's work`);
			if ((action === "character.add" && input.character?.model === CAPSULE) || (action === "character.update" && input.patch?.model === CAPSULE)) refuse(RIG_ONLY);
			if (action === "character.set") for (const op of Array.isArray(input.ops) ? input.ops : [input]) {
				if (op?.set?.model === CAPSULE) refuse(RIG_ONLY);
				if (await posesRig(op?.id, op?.set)) refuse(`character.set with pose is not available for the rig character ${op.id}; body motion is the motion tool's work`);
			}
		},
		arrange_characters: async args => {
			for (const op of Array.isArray(args?.ops) ? args.ops : []) if (isRecord(op) && "pose" in op && await isRig(op.characterId)) refuse(`arrange_characters with pose is not available for the rig character ${op.characterId}; body motion is the motion tool's work`);
		},
		patch_elements: async args => {
			for (const op of Array.isArray(args?.ops) ? args.ops : []) if (op?.target?.kind === "character" && op.set?.model === CAPSULE) refuse(RIG_ONLY);
			for (const op of Array.isArray(args?.ops) ? args.ops : []) if (op?.target?.kind === "character" && await posesRig(op.target.id, op.set)) refuse(`a pose patch is not available for the rig character ${op.target.id}; body motion is the motion tool's work`);
		},
	};
	return {
		tools: list => list.map(tool => {
			if (check[tool.name]) return { ...tool, handler: async (args, call) => { await check[tool.name](args); return tool.handler(args, call); } };
			if (tool.name !== "inspect_studio") return tool;
			return { ...tool, handler: async (args, call) => {
				const result = await tool.handler(args, call);
				return args?.scope === "actions" && Array.isArray(result?.actions) ? { ...result, actions: visibleActions(result.actions) } : result;
			} };
		}),
	};
}
