// motion.v4.install: the editor action the v4 track store commits through (src/motion-v4/track/store.js). It decodes
// the encoded raw track (codec.js), bakes the take v3 the editor plays for the character's placement (literal.js
// placedTake) and installs it on the motion owner like motion.compile does. The encoded track stays at
// take.spec.raw, so a save keeps it (take-source.js copies the spec) and a reload rebuilds it (compileRawSource).
// agentHidden: the old engine's action index and inspect leave it out, so its prompt does not change.
// A command module in the shape src/commands/index.js loads: declarations and register(registry, ports).
import { fail, characterOf } from "../../commands/shared.js";
import { skeletonFor } from "../../motion3/rigs/index.js";
import { decodeRawTrack } from "../track/codec.js";
import { placedTake } from "../track/literal.js";
import { characterName } from "../../character-name.js";

const SPEC_SCHEMA = "cozyclay.motion-spec.v1";

export const declarations = Object.freeze([
	{ id: "motion.v4.install", label: "Install raw take", description: "Install a raw per-bone take (v4 engine).",
		kind: "mutation", undoDomain: "motion", agentHidden: true, timeoutMs: 60000,
		input: { type: "object", additionalProperties: false, required: ["characterId", "raw"],
			properties: { characterId: { type: "string", minLength: 1 }, raw: { type: "object", properties: {}, required: [], additionalProperties: true },
				label: { type: "string", maxLength: 80 } } } },
]);

export function register(registry, ports) {
	const owner = () => ports.storeDomain("motion");
	const mounted = () => Boolean(ports.storeDomain?.("motion")) || "The motion owner is not mounted.";
	registry.register({ ...declarations[0], available: mounted, target: args => args.characterId, run({ characterId, raw: encoded, label }) {
		const character = characterOf(ports, characterId);
		const sk = skeletonFor(character.model);
		if (!sk) fail("TARGET_NOT_READY", `${characterName(character)} is a ${character.model} body, which a raw take cannot drive; use an X Bot or Y Bot character.`);
		if (Math.abs((character.scale ?? 1) - 1) > 1e-6) fail("TARGET_NOT_READY", "Set the character's scale back to 1 before installing motion.");
		let raw;
		try { raw = decodeRawTrack(encoded, sk); } catch (error) { fail("INVALID_ARGUMENT", error.message); }
		const F = raw.frameCount, placement = { position: [character.x ?? 0, character.y ?? 0, character.z ?? 0], yaw: character.rot ?? 0 };
		const spec = { schema: SPEC_SCHEMA, fps: 24, frames: F, ...(label ? { label } : {}), raw: encoded };
		const take = placedTake(raw, placement, { spec, prompt: label ?? "v4 raw take" });
		owner().replace(characterId, { ...take, frames: take.frameCount });
		return { affectedIds: [characterId], summary: `Installed raw take: ${F} frames.`, output: { frames: F } };
	} });
}
