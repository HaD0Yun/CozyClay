// motion.v4.install: the editor action the v4 track store commits through (src/motion-v4/track/store.js). It decodes
// the encoded raw track (codec.js), bakes the take v3 the editor plays for the character's placement (literal.js
// placedTake) and installs it on the motion owner like motion.compile does. The encoded track stays at
// take.spec.raw, so a save keeps it (take-source.js copies the spec) and a reload rebuilds it (compileRawSource).
// A track is of a body of one size (codec.js scale: a share of the skeleton's own body, 1 unless it says another): it
// installs on a character that stands that large, its scale times its look's body (src/lowvis/studio/figure.js).
// lowvis (optional): the motion writer's scene and spec the track was compiled from ({ name, scene, spec }), kept in the
// take's spec, so they are saved, reloaded, duplicated and undone with the take that plays them.
// agentHidden: the old engine's action index and inspect leave it out, so its prompt does not change.
// A command module in the shape src/commands/index.js loads: declarations and register(registry, ports).
import { fail, characterOf } from "../../commands/shared.js";
import { skeletonFor } from "../../motion3/rigs/index.js";
import { decodeRawTrack } from "../track/codec.js";
import { placedTake } from "../track/literal.js";
import { characterName } from "../../character-name.js";
import { bodyScale, scaleOf } from "../../lowvis/studio/figure.js";

const SPEC_SCHEMA = "cozyclay.motion-spec.v1";

export const declarations = Object.freeze([
	{ id: "motion.v4.install", label: "Install raw take", description: "Install a raw per-bone take (v4 engine).",
		kind: "mutation", undoDomain: "motion", agentHidden: true, timeoutMs: 60000,
		input: { type: "object", additionalProperties: false, required: ["characterId", "raw"],
			properties: { characterId: { type: "string", minLength: 1 }, raw: { type: "object", properties: {}, required: [], additionalProperties: true },
				label: { type: "string", maxLength: 80 }, lowvis: { type: "object", properties: {}, required: [], additionalProperties: true } } } },
]);

export function register(registry, ports) {
	const owner = () => ports.storeDomain("motion");
	const mounted = () => Boolean(ports.storeDomain?.("motion")) || "The motion owner is not mounted.";
	registry.register({ ...declarations[0], available: mounted, target: args => args.characterId, run({ characterId, raw: encoded, label, lowvis }) {
		const character = characterOf(ports, characterId);
		const sk = skeletonFor(character.model);
		if (!sk) fail("TARGET_NOT_READY", `${characterName(character)} is a ${character.model} body, which a raw take cannot drive; use an X Bot or Y Bot character.`);
		// the take's size and the character's, both as the character's scale (its look's body at scale 1)
		const of = Number.isFinite(encoded?.scale) ? encoded.scale : 1, scale = character.scale ?? 1, wants = scaleOf(of, bodyScale({ model: character.model }));
		if (Math.abs(bodyScale(character) - of) > 1e-6) fail("TARGET_NOT_READY", wants === 1 ? "Set the character's scale back to 1 before installing motion." : `This take is of a body of scale ${wants} and the character's scale is ${scale}: set the character's scale to ${wants} first.`);
		let raw;
		try { raw = decodeRawTrack(encoded, sk); } catch (error) { fail("INVALID_ARGUMENT", error.message); }
		const F = raw.frameCount, placement = { position: [character.x ?? 0, character.y ?? 0, character.z ?? 0], yaw: character.rot ?? 0 };
		const spec = { schema: SPEC_SCHEMA, fps: 24, frames: F, ...(label ? { label } : {}), raw: encoded, ...(lowvis ? { lowvis: structuredClone(lowvis) } : {}) };
		const take = placedTake(raw, placement, { spec, prompt: label ?? "v4 raw take" });
		owner().replace(characterId, { ...take, frames: take.frameCount });
		return { affectedIds: [characterId], summary: `Installed raw take: ${F} frames.`, output: { frames: F } };
	} });
}
