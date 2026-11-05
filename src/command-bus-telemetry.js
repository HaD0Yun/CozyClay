// The command bus's friction signals: studio:refused (one per refusal, capped per
// key), the history receipts an undo can name, and edit:undone for the user's own
// undos (domains/scene-undo.js). Only closed values leave: a refusal code, a
// command group, an edit kind, an age bucket, a refused argument's schema path.
// Never ids, argument values or messages.
import { EDIT_GROUPS, recordSemanticEdit, track } from './analytics.js';
import { createFirstEditRecorder } from './semantic-edit.js';
import { admit, bump } from './analytics-friction.js';
import { bucketAge, refusalCodeOf, REFUSAL_FIELD_PATTERN } from './analytics-strict.js';
import { STUDIO_REFUSAL_RULES } from './studio-error-codes.js';
import { noteEditGesture } from './post-turn-edits.js';
import { noteBusReceipt } from './click-friction.js';

let send = track, clock = () => Date.now();
const REFUSALS_PER_KEY = 3, UNDOS_PER_SESSION = 20, STAMPS_KEPT = 500;

// Command id prefix to studio:refused group; anything else is "other".
const GROUPS = [
	[/^objects?\./, 'object'], [/^shot\./, 'shot'], [/^(characters?|cast)\./, 'cast'], [/^scene\./, 'scene'],
	[/^(?:motion|ik)\./, 'motion'], [/^edit\./, 'edit'], [/^task\./, 'task'], [/^agent\./, 'agent'],
];
export const commandGroup = id => GROUPS.find(([pattern]) => pattern.test(String(id)))?.[1] ?? 'other';

// The one table from a committed command to its closed edit kind (FIRST_EDIT_KINDS,
// semantic-edit.js); its group (EDIT_GROUPS, analytics.js) follows from the kind.
// Recording a camera key is camera_key_record; drawing or clearing a rail (or a
// setCamera patch naming a rail field) is rail_edit; retiming or removing keys and
// other camera-block changes are shot_edit, as they were in version 1. Capturing the
// viewing camera into the shot (after an orbit or fly) is navigation, not an edit.
// Bone and IK keys are pose; placing or adding a character counts as an object, as it
// does for object_insert. Everything else is no edit kind.
const EDIT_KINDS = [
	[/^shot\.captureCamera$/, null],
	[/^shot\.(create|createStill|duplicate|split)$/, 'shot_add'],
	[/^shot\.(setCameraRail|clearCameraRail)$/, 'rail_edit'],
	[/^shot\.addKey$/, 'camera_key_record'],
	[/^shot\./, 'shot_edit'],
	[/^(character\.(setPose|setIkKey|removeIkKey|clearIkKeys)|ik\.|motion\.rangePin\.)/, 'pose_edit'],
	[/^(object\.(add|duplicate|sculpt|createKit)|character\.add)$/, 'object_insert'],
	[/^(objects?\.|character\.(set|remove|update|move)$|characters\.arrange$|cast\.replace$)/, 'object_transform'],
	// The take's fields carry its prompt (motion.take.prompt).
	[/^motion\.set$/, 'prompt_block_edit'],
];
const GROUP_BY_KIND = new Map(Object.entries(EDIT_GROUPS).flatMap(([group, kinds]) => kinds.map(entry => [entry, group])));
const groupOf = kind => GROUP_BY_KIND.get(kind);
/** A command's closed edit kind, or null. `hint`: asset.import's closed `placeAs`, and `rail` when a
 * shot.setCamera patch names a rail field (key names only; values are never read). */
export function firstEditKindOf(action, { placeAs, rail = false } = {}) {
	if (action === 'asset.import') return placeAs === 'cutout' ? 'cutout_insert' : 'object_insert';
	if (action === 'shot.setCamera' && rail) return 'rail_edit';
	return EDIT_KINDS.find(([pattern]) => pattern.test(String(action)))?.[1] ?? null;
}
// The camera block's rail fields (semantic-edit.js rail_edit): a setCamera patch naming one edits the rail.
const RAIL_FIELDS = ['cameraRail', 'craneHeight', 'railFollow', 'dollyTiming'];
const railPatch = args => Object.keys(args?.patch ?? {}).some(key => RAIL_FIELDS.includes(key));
// A drag's begin/update patches, remembered by txId until its commit names the edit.
const railTransactions = new Set();
function hintOf(id, args, recorded) {
	if (id === 'run.begin' || id === 'run.update') {
		if (recorded.txId && railPatch(args?.args)) railTransactions.add(recorded.txId);
		while (railTransactions.size > 50) railTransactions.delete(railTransactions.values().next().value);
		return {};
	}
	return { placeAs: args?.placeAs, rail: id === 'run.commit' ? railTransactions.delete(recorded.txId) : railPatch(args) };
}
const AGENT_WORK = new Set(['agent.turn.finish', 'task.finish']);
/** The edit:undone / post-turn group of a command: pose, camera, object, shot, prompt, agent_turn or other. */
export function editKind(action, origin = 'ui', hint) {
	// What the agent made (its turn, a task, or an edit it ran on its own) is undone as agent work.
	if (AGENT_WORK.has(action) || origin !== 'ui') return 'agent_turn';
	return groupOf(firstEditKindOf(action, hint)) ?? 'other';
}

// The user's own edits feed the session edit buckets and the surface's first edit
// (definition_version 2). App starts a new mount boundary with startUserEdits.
let editSurface = 'craft', firstEdit = createFirstEditRecorder((event, props) => send(event, props));
export function startUserEdits(surface) {
	editSurface = surface;
	firstEdit = createFirstEditRecorder((event, props) => send(event, props));
}

const emit = (event, props) => {
	try { send(event, props); } catch { /* telemetry is advisory */ }
};

/** An INVALID_ARGUMENT's failing field as studio:refused carries it: the error's schema path with array
 * indices folded to [] ("$.args.ops[3].position" -> "$.args.ops[].position"), or undefined when it has none or
 * the path is not plain field names. Paths come from the schema the command declares (studio-agent-protocol.js
 * validateStudioSchema) or from a command that names its own declared field; never a value. */
function refusalField(path) {
	if (typeof path !== 'string') return undefined;
	const folded = path.replace(/\[[^\]]*\]/g, '[]');
	return folded.length <= 96 && REFUSAL_FIELD_PATTERN.test(folded) ? folded : undefined;
}
/** The closed rule of an INVALID_ARGUMENT (STUDIO_REFUSAL_RULES): the error's own, else "check" for a coded
 * refusal a command raised itself and "unclassified" for a plain Error that reached the bus without a code. */
function refusalRule(error) {
	const rule = error?.details?.rule;
	if (STUDIO_REFUSAL_RULES.includes(rule)) return rule;
	return error?.code ? 'check' : 'unclassified';
}

/** A refusal receipt: the session counter always moves; the event, at most 3 times per (code, command, field, origin).
 * `registered`: `id` is an action the registry declares (or a bus control), so it may ride along as `command`; an id the
 * caller made up (an unknown action) is reported by its group alone. `error`: what was thrown; an INVALID_ARGUMENT
 * adds its failing `field` and `rule` (#1042). */
export function noteRefusal(value, origin, id, registered = false, error = undefined) {
	// A cancel the caller asked for is not a refusal. A UI one tells a click it was refused (click-friction.js);
	// an agent's or MCP client's refusal at the same moment is not the user's click.
	if (value.code === 'CANCELLED') return;
	if (origin === 'ui') noteBusReceipt(false);
	const by = origin === 'ui' ? 'ui' : 'agent', code = refusalCodeOf(value.code), group = commandGroup(id);
	bump(by === 'ui' ? 'refusals_ui' : 'refusals_agent');
	const command = registered ? String(id) : undefined;
	const argument = code === 'INVALID_ARGUMENT' ? { rule: refusalRule(error), field: refusalField(error?.details?.path) } : {};
	const detail = { ...(command ? { command } : {}), ...(argument.field ? { field: argument.field } : {}), ...(argument.rule ? { rule: argument.rule } : {}) };
	if (admit(`studio:refused:${code}:${command ?? group}:${argument.field ?? argument.rule ?? ''}:${by}`, REFUSALS_PER_KEY)) emit('studio:refused', { code, origin: by, phase: value.phase, group, ...detail });
}

// receiptId -> { at, kind }: when a history receipt was recorded and what it did.
const stamps = new Map();

/**
 * The bus's history receipts by history entry id (what edit.undo restores), each
 * stamped when it was recorded. Gesture rule: a drag is one transaction whose
 * receipt is recorded at run.commit, and any later receipt naming the same entry
 * replaces the earlier one, so an entry's age runs from its LAST receipt: the
 * time since the user finished that edit, not since they started it.
 */
export function createHistoryReceipts(ports) {
	const receipts = new Map();
	return {
		get: historyEntryId => receipts.get(historyEntryId),
		/** `id` the command, `action` the command a transaction ran (run.commit of a drag). */
		remember(recorded, { id, origin, action, args }) {
			const hint = hintOf(id, args, recorded);
			if (origin === 'ui' && recorded.ok !== false) noteBusReceipt(true);
			// Session friction: an undo the user made (agent undos are the agent's own correction).
			if (id === 'edit.undo' && origin === 'ui' && recorded.status === 'undone') bump('undos');
			// The user's edit that changed the scene, once per receipt (a drag commits once): the session edit
			// buckets, the first edit and agent:post_turn_edit. Agent, MCP and undo/redo receipts never count.
			if (origin === 'ui' && recorded.authored === true && !id.startsWith('edit.')) noteUserEdit(firstEditKindOf(action ?? id, hint));
			if (recorded.undo?.canUndoDirect && !id.startsWith('edit.')) {
				receipts.set(recorded.undo.historyEntryId, recorded);
				stamps.set(recorded.receiptId, { at: clock(), kind: editKind(action ?? id, origin, hint) });
				while (stamps.size > STAMPS_KEPT) stamps.delete(stamps.keys().next().value);
			}
			for (const [key, receipt] of receipts) if (ports.isRetained?.(receipt) === false) { receipts.delete(key); stamps.delete(receipt.receiptId); }
		},
	};
}

let userEditAt = -Infinity;
/** When the user's own last edit receipt was recorded (bus clock), or -Infinity: the thrash detectors' "no edit in between". */
export const lastUserEditAt = () => userEditAt;
function noteUserEdit(kind) {
	if (!kind) return;
	userEditAt = clock();
	try { recordSemanticEdit(kind); firstEdit(editSurface, kind); } catch { /* telemetry is advisory */ }
	noteEditGesture(groupOf(kind));
}

const RESULTS = { undone: 'done', noop: 'noop' };
/** The user's undo (`via` key, menu or button): its receipt, or null for an IK drag preview backed out. */
export function noteUndone(via, receipt) {
	const result = !receipt ? 'done' : receipt.ok === false ? 'refused' : RESULTS[receipt.status];
	if (!result || !admit('edit:undone', UNDOS_PER_SESSION)) return;
	// A native history entry no receipt names (or nothing undone at all) is "other", with no age.
	const stamp = result === 'done' && receipt ? stamps.get(receipt.undoneReceiptId) : null;
	emit('edit:undone', { kind: receipt ? stamp?.kind ?? 'other' : 'ik_preview', via, result, ...(stamp ? { age: bucketAge(clock() - stamp.at) } : {}) });
}

/** Tests only: capture what is sent and drive the clock; returns the restore. */
export function telemetrySeam({ track: capture = track, now = () => Date.now() } = {}) {
	const previous = [send, clock];
	send = capture; clock = now;
	return () => { [send, clock] = previous; stamps.clear(); };
}
