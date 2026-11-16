// The document targets a command writes, known before it runs, for tasks that edit one scene at once (parallel Studio
// tasks, P1). A key names one target: object:<id> (a group carries its subtree), character:<id>:<layer> (one owned
// layer of a character, below), shot:<id> (its camera, rail and keys), or one of the singletons stage (light,
// environment, lens), timeline (frame count, shot order and ranges) and scene (documents, the cast library, a replace of
// a whole kind). timeline and scene are exclusive: no other task runs beside them. A command that only creates
// (object.add, a kit, character.add, a shot.create that fits in free frames) needs no key: what it makes joins its task.
// A shot.create that must lengthen the take to fit writes timeline (the frame count every shot and take reads). A
// command this table does not know writes scene, so a new command is safe until it is named here.
// A character is four layers, so one task can place her while another makes her motion: placement (where she stands,
// her scale, parent, visibility, tint, static pose: every cast field the others do not own), take (the motion take, its
// timing edit and the root path), ik (the IK keys and range pins on top of the take) and props (what she holds; the
// held object's own key goes with it). Playback already stacks them placement < take < ik; the split only says who may
// write which. A plain character:<id> is all four (the scope a task names; a receipt's id): it overlaps every layer.
import { addShotAtFrame } from './cuts.js';
const EXCLUSIVE_KEYS = new Set(['timeline', 'scene']);
const CHARACTER_LAYERS = Object.freeze(['placement', 'take', 'ik', 'props']);
const ID = '[A-Za-z0-9][A-Za-z0-9._:-]*';
const KEY = new RegExp(`^(?:(?:object|character|shot):${ID}|stage|timeline|scene)$`);
export const isScopeKey = key => typeof key === 'string' && key.length <= 140 && KEY.test(key);
const LAYERED = /^character:(.+?)(?::(placement|take|ik|props))?$/s;
/** { id, layer } of a character key (layer null for the plain key), or null for any other key. */
export function layerOf(key) {
	const match = LAYERED.exec(key);
	return match ? { id: match[1], layer: match[2] ?? null } : null;
}
const layers = (id, names = CHARACTER_LAYERS) => names.map(name => `character:${id}:${name}`);
/** The keys a scope names, with a plain character:<id> spelled out as its four layers. */
export const expandScope = keys => [...new Set(keys.flatMap(key => { const of = layerOf(key); return of && !of.layer ? layers(of.id) : [key]; }))];
/** True when one key's target covers part of the other's: the same key, or a plain character key and one of its layers. */
export function keysOverlap(a, b) {
	if (a === b) return true;
	const x = layerOf(a), y = layerOf(b);
	return Boolean(x && y && x.id === y.id && (!x.layer || !y.layer));
}

const SCENE = ['cast.replace', 'cast.showExtras', 'objects.replace', 'shot.replace', 'ai.prepareShot'];
const TIMELINE = ['shot.split', 'shot.duplicate', 'shot.remove', 'shot.reorder', 'shot.setRange', 'shot.setTimeline'];
const CREATE = ['object.add', 'object.createKit', 'asset.import', 'character.add'];
const CHARACTER = /^(character\.|characters?\b|cast\.setLayer$|ik\.|motion\.)/;
// The layers each character command writes, read from what it changes: a compile installs a take and clears the IK
// keys on it (motion domain replace), a timing edit moves the IK keys with the frames they address, a pose that clears
// motion clears both, and attaching a prop changes what she holds. A command this table does not name writes all four.
const WRITES = {
	'character.move': ['placement'], 'characters.arrange': ['placement'], 'cast.setLayer': ['take'], 'motion.set': ['take'],
	'motion.compile': ['take', 'ik'], 'motion.clear': ['take', 'ik'], 'motion.keyObject': ['take', 'ik', 'props'], 'object.attach': ['props'],
	...Object.fromEntries(['addWaypoint', 'moveWaypoint', 'removeWaypoint', 'clearWaypoints'].map(verb => [`character.${verb}`, ['take']])),
	...Object.fromEntries(['cut', 'setSegmentSpeed', 'removeSegment', 'trim', 'resetTiming'].map(verb => [`motion.${verb}`, ['take', 'ik']])),
	...Object.fromEntries(['character.setIkKey', 'character.removeIkKey', 'character.clearIkKeys', 'ik.setKey', 'ik.removeKey', 'ik.clearKeys', 'ik.applyPose',
		'motion.rangePin.apply', 'motion.rangePin.remove'].map(id => [id, ['ik']])),
};
// A cast field the take or the IK layer owns (the rest is placement); a model swap is a different body under all four.
const FIELD_LAYER = { layer: 'take', motionTake: 'take', waypoints: 'take', ikEdits: 'ik', ikKeys: 'ik', model: null };
const fieldLayers = fields => fields.some(field => FIELD_LAYER[field] === null) ? CHARACTER_LAYERS
	: [...new Set(fields.map(field => FIELD_LAYER[field] ?? 'placement'))];
const poseLayers = args => args.clearMotion ? ['placement', 'take', 'ik'] : ['placement'];
/** The layer keys a character command writes on character `id`. */
function characterKeys(id, args) {
	if (WRITES[id]) return WRITES[id];
	if (id === 'character.update') return fieldLayers(Object.keys(args.patch ?? {}));
	if (id === 'character.set') return fieldLayers(Object.keys(args.set ?? {}));
	if (id === 'character.setPose') return poseLayers(args);
	return CHARACTER_LAYERS;
}

/** object:<id> and every object under it. */
function objectKeys(ids, state) {
	const rows = state?.objects ?? [], out = new Set();
	const visit = id => { if (!id || out.has(`object:${id}`)) return; out.add(`object:${id}`); for (const row of rows) if (row.parent === id) visit(row.id); };
	for (const id of ids) visit(id);
	return [...out];
}
const arrangeKeys = (ops, state) => ops.flatMap(op => op.op === 'create' ? [] : op.op === 'group' ? objectKeys([op.parentId, ...op.childIds], state)
	: op.op === 'ungroup' ? objectKeys(op.childIds, state) : objectKeys([op.id], state));

/**
 * The keys command `id` with validated `args` writes against state `state` (the bus's read), or [] when it writes
 * none (a read, a view change, a pure creation). `entry` is its registry entry (kind, readOnly).
 */
export function commandKeys(id, args = {}, state = {}, entry = {}) {
	if (entry.kind === 'document' || /^(scene|project)\./.test(id) || id === 'load_scenes' || SCENE.includes(id)) return ['scene'];
	if (entry.readOnly || entry.kind === 'transient' || /^(view|timeline)\./.test(id) || ['motion.qa', 'motion.sample', 'motion.describe', 'motion.report', 'sculpt.compare', 'export.shotVideo'].includes(id)) return [];
	if (CREATE.includes(id)) return [];
	if (id === 'objects.batch') return [...new Set(args.ops.flatMap(op => commandKeys(op.name, op.args, state)))];
	if (id === 'objects.arrange') return [...new Set(arrangeKeys(args.ops, state))];
	if (id === 'characters.arrange') return args.ops.flatMap(op => op.op === 'create' ? [] : layers(op.characterId, characterKeys(id, op)));
	// A set or a take edit of several characters at once names each one (an op is { id, set }).
	if ((id === 'character.set' || id === 'motion.set') && args.ops) return [...new Set(args.ops.flatMap(op => layers(op.id, characterKeys(id, op))))];
	if (id.startsWith('stage.') || id === 'shot.setLens') return ['stage'];
	if (id === 'shot.create') return addShotAtFrame(state.shots, state.frame ?? state.view?.frame ?? 0, state.frameCount, null) !== state.shots ? [] : ['timeline'];
	if (TIMELINE.includes(id)) return ['timeline'];
	if (id.startsWith('shot.')) {
		const shot = args.shotId ?? args.id ?? state.selectedShotId;
		return shot ? [`shot:${shot}`] : ['timeline'];
	}
	if (id === 'object.group') return objectKeys([args.parent, ...args.children], state);
	if (id === 'object.ungroup') return objectKeys(args.children, state);
	if (id === 'object.remove') return objectKeys(args.ids, state);
	if (id === 'object.attach' || id === 'motion.keyObject') return [...layers(args.characterId, characterKeys(id, args)), ...objectKeys([args.objectId], state)];
	if (id.startsWith('object.')) return objectKeys([args.id ?? args.objectId], state);
	if (CHARACTER.test(id) && (args.characterId ?? args.id)) return layers(args.characterId ?? args.id, characterKeys(id, args));
	return ['scene'];
}

/** The key an id a receipt names resolves to in state, or null (the scene's own id, a removed target). */
export function keyOfId(id, state = {}) {
	if ((state.objects ?? []).some(row => row.id === id)) return `object:${id}`;
	if ((state.characters ?? []).some(row => row.id === id)) return `character:${id}`;
	if ((state.shots ?? []).some(row => row.id === id)) return `shot:${id}`;
	return null;
}

/** Why `keys` cannot join task `taskId` beside the other open tasks, or null. */
export function scopeConflict(taskId, keys, tasks) {
	for (const other of tasks.values()) {
		if (other.taskId === taskId) continue;
		const held = keys.find(key => EXCLUSIVE_KEYS.has(key) || [...other.keys].some(k => EXCLUSIVE_KEYS.has(k) || keysOverlap(key, k)));
		if (held) return `${held} is held by task ${other.taskId}${other.title ? ` (${other.title})` : ''}`;
	}
	return null;
}
