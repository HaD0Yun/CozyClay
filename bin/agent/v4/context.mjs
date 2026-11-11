// V4Context (design 2.2): what the v4 tools of one Studio conversation share. The engine builds it
// on the first turn and re-binds the per-turn parts (studio calls, records, signal) on every turn.
import { skeletonFor } from "../../../src/motion3/rigs/index.js";

const notReady = message => Object.assign(new Error(message), { code: "TARGET_NOT_READY" });

/**
 * The motion subject from the editor's describe answer: the active character when it has a
 * Y Bot or X Bot rig, else the only such character; with `id` (a motion task names its character), that one.
 * Throws TARGET_NOT_READY otherwise.
 * -> { id, model, position: [x, y, z], yaw, scale }
 */
export function subjectOf(describe, id = null) {
	const characters = Array.isArray(describe?.characters) ? describe.characters : [];
	const rigged = characters.filter(entry => entry && typeof entry.id === "string" && skeletonFor(entry.model));
	const pick = id ? rigged.find(entry => entry.id === id) : rigged.find(entry => entry.id === describe?.activeCharacterId) ?? (rigged.length === 1 ? rigged[0] : null);
	if (!pick) {
		throw notReady(id ? `${id} is not a Y Bot or X Bot character of this scene${rigged.length ? ` (it has: ${rigged.map(entry => entry.id).join(", ")})` : ""}.` : rigged.length
			? `The scene has ${rigged.length} rigged characters and none is active; select the one to animate.`
			: "The scene has no Y Bot or X Bot character to animate.");
	}
	const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
	return { id: pick.id, model: pick.model, position: [finite(pick.x), finite(pick.y), finite(pick.z)], yaw: finite(pick.rot), scale: finite(pick.scale, 1) };
}

/**
 * Point ctx at this turn: studio.runAction and studio.command go through this turn's studio tools
 * and workspace handle, records() answers this turn's describe objects, signal is this turn's.
 * turn: { describe, studioTools, hub, workspaceHandle, signal, log?, subjectId? }
 */
export function bindTurn(ctx, turn) {
	const { describe, studioTools, hub, workspaceHandle, signal } = turn;
	const records = Array.isArray(describe?.objects) ? describe.objects : [];
	ctx.records = async () => records;
	ctx.studio = {
		runAction: (action, args) => studioTools.internal.invoke("run_action", { action, args: args ?? {} }),
		command: (name, args, options) => (options ? hub.command(name, args ?? {}, workspaceHandle, options) : hub.command(name, args ?? {}, workspaceHandle)),
	};
	ctx.signal = signal;
	if (typeof turn.log === "function") ctx.log = turn.log;
	return ctx;
}

/** A new V4Context for the subject of turn.describe; ctx.track is set later by the tool set. */
export function createV4Context(turn) {
	const character = subjectOf(turn.describe, turn.subjectId);
	const ctx = { sk: skeletonFor(character.model), character, track: null, log: () => {} };
	return bindTurn(ctx, turn);
}
