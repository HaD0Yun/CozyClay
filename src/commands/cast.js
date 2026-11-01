// Cast commands: a named character's root waypoints and IK key layer. They
// name their character explicitly, so they run the same way whichever
// character is active and whatever mode the editor is in.
import { studioActionDeclaration } from "../studio-actions.js";
import { characterOf, fail, changedIds, checkPoseBones } from "./shared.js";
import { elementSetSchema, registerElementSet } from './elements.js';
import './elements/character.js';
import { createCharacterEntry, CHARACTER_KIND_IDS, POSTURES, PROXY_FIGURE_MODEL, isProxyFigure } from '../scenes.js';
import { KIND_FIXED_REFUSAL } from '../character-kind.js';
import { track } from '../analytics.js';
import { DEFAULT_POSE } from '../poses.js';
import { createStableItemId } from '../stable-items.js';
import { STUDIO_TOOL_SCHEMAS, StudioSchemas } from '../studio-agent-protocol.js';

const id = StudioSchemas.TargetGuard.properties.targetId;
const input = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const record = { type: 'object', properties: {}, additionalProperties: true };
// A capsule figure is cast by model id; its posture is the one body choice it
// has. A patched posture outside POSTURES normalizes to "stand" (createCharacterEntry).
const newCharacter = { ...record, properties: { model: { type: 'string', enum: [...CHARACTER_KIND_IDS] }, posture: { type: 'string', enum: [...POSTURES] },
	x: { type: 'number', description: 'floor position, metres (position { x, z } is read the same)' }, z: { type: 'number' }, rot: { type: 'number', description: 'yaw, degrees (yawDeg too)' } }, required: [] };
const characterPatch = { ...record, properties: { posture: { type: 'string', description: `One of ${POSTURES.join(', ')}; anything else stands.` } }, required: [] };
const mutation = (id, label, schema, exposure = 'open') => ({ id, label, description: label, kind: 'mutation', undoDomain: 'cast', input: schema, exposure });

const semantic = [
	mutation('character.set', 'Set character fields', elementSetSchema('character')),
	mutation('character.add', 'Add character', input({ character: newCharacter })),
	mutation('character.remove', 'Remove character', input({ characterId: id })),
	mutation('character.update', 'Update character', input({ characterId: id, patch: characterPatch })),
	studioActionDeclaration('character.move'),
	mutation('character.setPose', 'Set character pose', input({ characterId: id, pose: { oneOf: [id, record, { type: 'null' }] }, clearMotion: { type: 'boolean' } }, ['characterId', 'pose'])),
	
	mutation('characters.arrange', 'Arrange characters', STUDIO_TOOL_SCHEMAS.arrange_characters),
	mutation('cast.replace', 'Replace cast', input({ characters: { type: 'array', items: record, minItems: 1 } }), 'ui-only'),
	mutation('cast.setCustomPoses', 'Set pose library', input({ poses: { type: 'array', items: record } }), 'ui-only'),
	mutation('cast.savePose', 'Save pose', input({ pose: record, characterId: id, clearMotion: { type: 'boolean' } }, ['pose']), 'ui-only'),
	mutation('cast.removePose', 'Remove saved pose', input({ id }), 'ui-only'),
	mutation('cast.showExtras', 'Show extra subjects', input({ show: { type: 'boolean' } }), 'ui-only'),
	mutation('cast.setLayer', 'Set character layer', input({ characterId: id, layer: record }), 'ui-only'),
];
export const declarations = Object.freeze([...semantic, ...["character.addWaypoint", "character.moveWaypoint", "character.removeWaypoint", "character.clearWaypoints"].map(studioActionDeclaration)]);

export function register(registry, ports) {
	const owner = () => ports.storeDomain('cast');
	const mounted = () => Boolean(ports.storeDomain?.('cast')) || 'The cast document owner is not mounted.';
	const character = characterId => owner().read().find(row => row.id === characterId) ?? fail('STALE_TARGET', `Character ${characterId} is not in this scene.`);
	// Every pose path names only POSE_BONES joints: a pose sent whole, one chosen from the library by id,
	// and every library entry written (#773).
	const pose = value => {
		const resolved = typeof value === 'string' ? owner().poses().find(row => row.id === value) ?? fail('STALE_TARGET', `Pose ${value} is not in the library.`) : value;
		checkPoseBones(resolved?.bones);
		return resolved;
	};
	const patch = (characterId, update) => { character(characterId); owner().update(characterId, update); };
	// A character groups under a scene object that stands in the world. An
	// object a character carries is refused: it rides a bone, not a route.
	const groupParent = value => {
		if (value === null || value === undefined) return;
		const object = ports.state().objects.find(row => row.id === value) ?? fail('STALE_TARGET', `Object ${value} is not in this scene.`);
		if (object.attach) fail('INVALID_ARGUMENT', 'A character cannot be grouped under an object that a character carries.');
	};
	const methods = {
		'character.add': ({ character: sent }) => {
			// position { x, z } and yawDeg were dropped without a word and the character stood at the origin (agent runs, 2026-10-30)
			const { position, yawDeg, ...value } = sent;
			if (position && typeof position === 'object') { if (Number.isFinite(position.x) && value.x === undefined) value.x = position.x; if (Number.isFinite(position.z) && value.z === undefined) value.z = position.z; }
			if (Number.isFinite(yawDeg) && value.rot === undefined) value.rot = yawDeg;
			const row = createCharacterEntry({ ...value, id: value.id ?? createStableItemId('character') }, owner().read().length);
			if (owner().read().some(entry => entry.id === row.id)) fail('INVALID_ARGUMENT', 'Character id already exists.');
			owner().write(rows => [...rows, row]);
		},
		// An empty stage is legal: a new project starts on one.
		'character.remove': ({ characterId }) => { character(characterId); owner().write(rows => rows.filter(row => row.id !== characterId)); },
		'character.update': ({ characterId, patch: value }) => {
			// Rig <-> capsule figure is a different kind of cast member; rig-to-rig model swaps stay.
			if (Object.hasOwn(value, 'model') && (value.model === PROXY_FIGURE_MODEL) !== isProxyFigure(character(characterId))) fail('INVALID_ARGUMENT', KIND_FIXED_REFUSAL.en);
			if (Object.hasOwn(value, 'parent')) groupParent(value.parent);
			patch(characterId, value);
		},
		'character.move': ({ characterId, ...value }) => patch(characterId, value),
		'character.setPose': ({ characterId, pose: value, clearMotion }) => { character(characterId); owner().applyPose(characterId, pose(value), clearMotion); },
		
		'cast.replace': ({ characters }) => owner().write(characters),
		'cast.setCustomPoses': ({ poses }) => { for (const entry of poses) checkPoseBones(entry?.bones); owner().writeState(before => ({ ...before, customPoses: poses })); },
		'cast.savePose': ({ pose, characterId, clearMotion }) => {
			checkPoseBones(pose?.bones);
			if (characterId) character(characterId);
			owner().writeState(before => ({ ...before, customPoses: [...before.customPoses.filter(entry => entry.id !== pose.id), pose] }));
			if (characterId) owner().applyPose(characterId, pose, clearMotion);
		},
		'cast.removePose': ({ id }) => owner().writeState(before => ({
			characters: before.characters.map(entry => entry.pose?.id === id ? { ...entry, pose: DEFAULT_POSE } : entry),
			customPoses: before.customPoses.filter(entry => entry.id !== id),
		})),

		'cast.showExtras': ({ show }) => owner().showExtras(show),
		'cast.setLayer': ({ characterId, layer }) => patch(characterId, { layer: { ...character(characterId).layer, ...layer } }),
	};
	registerElementSet({ register(entry) {
		registry.register({ ...entry, available: mounted, run(args) {
			// A pose id selects a complete library entry, not a deep bone patch.
			const ops = args.ops ?? [args];
			for (const op of ops) if (Object.hasOwn(op.set, 'parent')) groupParent(op.set.parent);
			const poses = ops.filter(op => Object.hasOwn(op.set, 'pose')).map(op => ({ id: op.id, value: pose(op.set.pose) }));
			const fields = ops.map(({ id, set: { pose: _pose, ...set } }) => ({ id, set }));
			const result = entry.run(args.ops ? { ops: fields } : fields[0]);
			for (const selected of poses) owner().applyPose(selected.id, selected.value, false);
			return result;
		} });
	} }, ports, semantic[0]);
	for (const declaration of semantic.slice(1)) registry.register({ ...declaration, available: mounted, run(args, context) {
		if (declaration.id === 'characters.arrange') { const plan = owner().arrange(args); return { affectedIds: plan.affectedIds, summary: 'Arranged characters.', checks: plan.checks, warnings: plan.warnings }; }
		const before = owner().read();
		methods[declaration.id](args);
		// The Assets tile and the MCP live path report themselves; this is the agent and
		// any other non-UI bus caller adding a capsule figure.
		if (declaration.id === 'character.add' && context?.origin && context.origin !== 'ui' && isProxyFigure(owner().read().find(row => !before.some(prior => prior.id === row.id)))) track('cast:proxy_added', { surface: 'agent' });
		const changed = changedIds(before, owner().read());
		return { affectedIds: changed.length ? changed : [args.characterId ?? ports.state().activeSceneId], summary: declaration.label };
	} });
	if (ports.storeDomain?.('cast')) registry.registerToolAlias('arrange_characters', 'characters.arrange');
	const castAction = (id, run) => registry.register({ ...studioActionDeclaration(id),
		available: state => state.characters.length > 0 || "There are no characters in this scene; add one with arrange_characters.",
		run: args => {
			const character = characterOf(ports, args.characterId);
			return { affectedIds: [character.id], summary: run(args, character.subject || character.id) };
		} });
	const pin = waypoint => `frame ${waypoint.frame} (x ${waypoint.x}, z ${waypoint.z})`;
	const warned = warnings => warnings.length ? `; warning: ${warnings[0]}` : "";
	castAction("character.addWaypoint", ({ characterId, position, frame }, name) => {
		const { waypoint, index, warnings } = ports.addCharacterWaypoint(characterId, position, frame ?? null);
		ports.setWaypointMode(true);
		return `Added ${name}'s root waypoint ${index + 1} at ${pin(waypoint)}${warned(warnings)}.`;
	});
	castAction("character.moveWaypoint", ({ characterId, frame, position }, name) => {
		const { waypoint, warnings } = ports.moveCharacterWaypoint(characterId, frame, position);
		ports.setWaypointMode(true);
		return `Moved ${name}'s root waypoint to ${pin(waypoint)}${warned(warnings)}.`;
	});
	castAction("character.removeWaypoint", ({ characterId, frame }, name) => {
		ports.removeCharacterWaypoint(characterId, frame);
		return `Removed ${name}'s root waypoint at frame ${frame}.`;
	});
	castAction("character.clearWaypoints", ({ characterId }, name) => {
		const count = ports.clearCharacterWaypoints(characterId);
		return count ? `Cleared ${name}'s root path (${count} waypoint${count === 1 ? "" : "s"}).` : `${name} has no root waypoints; nothing changed.`;
	});
}
