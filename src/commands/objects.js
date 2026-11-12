// Scene object commands: attachment, duplication and asset import.
import { studioActionDeclaration } from "../studio-actions.js";
import { characterOf, fail } from "./shared.js";
import { elementSetSchema, registerElementSet } from './elements.js';
import './elements/object.js';
import { createSceneObject, updateSceneObject, removeSceneObject, setSceneObjectParent, descendantsOf, normalizeSceneObject, groupUnderNewEmpty, objectPatchFields, createSculptObject, SCULPT_KIND } from '../scene-objects.js';
import { expandSculptParts, normalizeSculptRecipe, patchSculptRecipe } from '../sculpt-recipe.js';
import { sculptRefusalPath } from '../sculpt-refusal-path.js';
import { sculptRefusalExample } from '../sculpt-shape-examples.js';
import { sculptBuildReport } from '../sculpt-report.js';
import { runSculptCompare, sculptCompare } from './sculpt-compare.js';
import { clampWarning } from '../receipt-findings.js';
import { effectPresetSet } from '../effects/effect-record.js';
import { withLightWarnings } from '../light-blockers.js';
import { placeObjectCopies } from '../object-copies.js';
import { STUDIO_TOOL_SCHEMAS, StudioSchemas, StudioProtocolError } from '../studio-agent-protocol.js';
import { characterName } from '../character-name.js';

// An argument refusal that names its field for studio:refused (#1042); the message is what the agent reads.
const argumentFail = (message, path, rule = 'check') => { throw new StudioProtocolError('INVALID_ARGUMENT', message, { path, rule }); };

const id = StudioSchemas.TargetGuard.properties.targetId;
const input = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const ids = { type: 'array', items: id, minItems: 1, maxItems: 100 };
const number = { type: 'number' };
const placement = input({ x: number, y: number, z: number, rot: number }, []);
const setInput = elementSetSchema('object');
const scale = setInput.properties.set.properties.scale;
setInput.properties.set.properties.scale = { oneOf: [number, scale] };
const PATCH_HINTS = { scale: 'use scaleX, scaleY, scaleZ', rotY: 'use rot for yaw', yaw: 'use rot for yaw', rotation: 'use rot, rotX, rotZ', position: 'use x, y, z', parent: 'use object.group or object.set parent', parentId: 'use object.group or object.set parent' };
const mutation = (id, label, input) => ({ id, label, description: label, kind: 'mutation', undoDomain: 'objects', input });
const semantic = [
	mutation('object.set', 'Set object fields', setInput),
	{ ...mutation('object.add', 'Add object', input({ kind: { type: 'string' }, placement, name: { type: 'string' }, parent: id, first: { type: 'boolean' }, text: setInput.properties.set.properties.text }, ['kind'])),
		description: 'Add an object. kind: a catalogue kind (inspect_studio scope "catalogue"), or "text" for words, a title or a sign: text { value, size } stands in the set as a 3D object (no 2D screen overlay), so place it where the shot camera sees it.' },
	// A clay prop from a recipe of soft parts (docs/sculpt-from-image.md). With `id` it re-sculpts that
	// sculpt in place (one undo); without, it creates one. The recipe is checked by sculpt-recipe.js.
	{ ...mutation('object.sculpt', 'Sculpt a clay prop from a recipe', input({ recipe: { type: 'object', properties: {}, additionalProperties: true }, edits: { type: 'array', minItems: 1, maxItems: 48, items: { type: 'object', properties: {}, additionalProperties: true } }, id, name: { type: 'string', maxLength: 240 }, placement, parent: id }, [])),
		description: 'Create a sculpt (or re-sculpt one by id) from a recipe, or patch a sculpt by id with edits [{ set: partId, ...fields } | { add: part } | { remove: partId }]. Recipe { version: 1, parts: [{ id, shape, size: [x,y,z] m, position, rotation (deg), color, parent, mirror, repeat, ...shape fields, material, finish, detail, gradient, op }] }, at most 48 drawn parts after mirrors. Shapes: blob {roundness, taper}; box {roundness}; cylinder {taper}; torus; frame {border}; lathe {profile [[r 0..1, y 0..1]...], smooth}; tube {path [[x,y,z] each -0.5..0.5 of size], thickness m, taper, closed}; extrude {outline [[x,y] -0.5..0.5], holes, roundness}; loft {sections [{ y 0..1, points [[x,z]] } | { y, w, d, x?, z?, roundness? }], smooth}; convex {points | seed, facetCount, facets}; scatter {item blade|tuft|flower|leaf|pebble|twig, count <= 4000, spread ground|shell, seed} thousands of small items as ONE part. Use for: lathe turned things (pots, lamp bases, wheel rims); tube stems, legs, frames, pipes, ropes; loft tapered or changing sections (trunks, hulls, bottles); convex/blob rocks, lumps, foliage masses; extrude flat outlines with thickness (signs, leaves, gears); box with roundness boards, panels; scatter leaves, blades; repeat any 3+ identical parts. Blob roundness runs the other way from box: blob 0 = ellipsoid, 1 = rounded box; box 0 = sharp. repeat {count 2-64, step [x,y,z] m, turn [x,y,z] deg, pivot (default parent origin), jitter {position m, rotation deg, scale 0..0.5, seed}}: copy k moves k*step, then turns k*turn about pivot; ring: turn only; spiral stair: step + turn; stays ONE part (256 copies per recipe); not on scatter, cutters or parts with children. Any part: material clay|wood|straw|stone|brick|concrete|metal|glass|ceramic|plastic|rubber|fabric|paper|foliage (real texture and shine; color tints it; never fake glass with opacity or thatch with stripes) and finish matte|satin|gloss; detail {amount 0..1, scale 1..12 lumps across the part, seed} lumpy surface (clouds, bushes, rocks, hay); gradient {color, axis, from, to} two-tone blend; op subtract|intersect turns the part into a cutter of its parent (windows, doors, arches; hollow a lathe or loft with a smaller one of the same shape). Floor is y=0, front +z, the subject\'s left +x; mirror reflects across x=0. The answer ends with a box check (floating, hidden, below-floor part ids): fix those before a render. Natural things (tree, bush, rock, cloud) are never one symmetric lump: build the mass from 7-12 overlapping pieces in three sizes with gaps between them, each turned differently, and lean the whole a little. A leaf mass: a blob (roundness 0-0.2) with material foliage, detail {amount 0.7-0.95, scale 5-8} and a gradient from a darker underside to a lighter top (axis y); no leaf scatter glued on it. A tree: a trunk (loft or lathe, material wood, detail amount 0.25 scale 12) that tapers, bends a little and flares at the foot into 3-5 short root tubes; 3-5 limbs as tapering tubes that fork from the upper trunk and run up INTO the crown, visible from below; the crown as 7-12 leaf masses of three sizes at the limb ends, not one cap, with gaps where limbs and sky show. A conifer: 5-8 tiers that shrink up the trunk, each a low cone-shaped leaf mass (cylinder taper 0.6-0.8, widest and lowest at its rim) that overlaps the tier below a little, uneven and tilted, never flat discs with bare gaps. When you read the close-up, name what a photo of the real thing shows that yours lacks and add the biggest one. Example, wheelbarrow (wheel_d 0.4, tray_l 0.9, tray_w 0.66, height 0.66): {parts:[{id:"tray",shape:"loft",size:[0.66,0.3,0.92],position:[0,0.51,0],color:"#4f8a5b",material:"metal",sections:[{y:0,w:0.6,d:0.55,z:-0.2,roundness:0.4},{y:1,w:1,d:1}]},{id:"hollow",shape:"loft",parent:"tray",op:"subtract",size:[0.62,0.3,0.88],position:[0,0.03,0],sections:[{y:0,w:0.6,d:0.55,z:-0.2,roundness:0.4},{y:1,w:1,d:1}]},{id:"handle",shape:"tube",mirror:true,size:[0.25,0.36,1.61],position:[0.165,0.36,-0.165],color:"#2f4f39",material:"metal",thickness:0.04,path:[[0.5,0.5,-0.5],[0.405,0.125,-0.18],[0.167,-0.094,0.26],[-0.5,-0.5,0.5]]},{id:"grip",shape:"cylinder",mirror:true,size:[0.05,0.16,0.05],position:[0.27,0.51,-0.9],rotation:[104,0,0],color:"#1f2b23",material:"rubber"},{id:"leg",shape:"cylinder",mirror:true,size:[0.035,0.36,0.035],position:[0.2,0.18,-0.32],color:"#2f4f39"},{id:"foot",shape:"box",mirror:true,size:[0.05,0.02,0.1],position:[0.2,0.01,-0.32],color:"#1f2b23"},{id:"brace",shape:"cylinder",size:[0.025,0.4,0.025],position:[0,0.14,-0.32],rotation:[0,0,90],color:"#2f4f39"},{id:"tyre",shape:"torus",size:[0.4,0.4,0.08],position:[0,0.2,0.62],rotation:[0,90,0],color:"#1f2b23",material:"rubber"},{id:"rim",shape:"torus",size:[0.3,0.3,0.035],position:[0,0.2,0.62],rotation:[0,90,0],color:"#2f4f39"},{id:"hub",shape:"cylinder",size:[0.08,0.1,0.08],position:[0,0.2,0.62],rotation:[0,0,90],color:"#2f4f39"},{id:"axle",shape:"cylinder",size:[0.025,0.16,0.025],position:[0,0.2,0.62],rotation:[0,0,90],color:"#2f4f39"},{id:"spoke",shape:"cylinder",size:[0.014,0.12,0.014],position:[0,0.28,0.62],color:"#2f4f39",repeat:{count:8,turn:[45,0,0],pivot:[0,0.2,0.62]}}]}' },
	mutation('object.remove', 'Remove objects', input({ ids })),
	mutation('object.rename', 'Rename object', input({ id, name: { type: 'string', maxLength: 240 } })),
	mutation('object.group', 'Group objects', input({ parent: id, children: ids })),
	mutation('object.ungroup', 'Ungroup objects', input({ children: ids })),
	// The Outliner's "Group under new Empty": the Empty and the reparent are one write, so one undo.
	{ ...mutation('object.groupUnderEmpty', 'Group object under a new Empty', input({ id })), exposure: 'ui-only' },
	{ ...mutation('object.update', 'Update object', input({ id, patch: { type: 'object', properties: {}, additionalProperties: true } }, [])), agentHidden: true },
	// agentHidden: object.update silently ignores unknown keys, so the agent's action index and inspect_studio leave it out
	// and the prompt points at object.set / arrange_objects; MCP, the CLI and the UI keep it.
	mutation('objects.arrange', 'Arrange objects', STUDIO_TOOL_SCHEMAS.arrange_objects),
];
const batch = { id: 'objects.batch', label: 'Batch objects', description: 'Apply legacy object operations in one retained entry.', kind: 'job', domain: 'objects',
	input: input({ ops: { type: 'array', maxItems: 100, items: input({ name: { type: 'string' }, args: { type: 'object', properties: {}, additionalProperties: true } }) }, atomic: { type: 'boolean' }, stopOnError: { type: 'boolean' }, label: { type: 'string' } }, ['ops']) };
const replace = { ...mutation('objects.replace', 'Replace authored objects', input({ objects: { type: 'array', items: { type: 'object', properties: {}, additionalProperties: true } } })), exposure: 'ui-only' };
const changedIds = (before, after) => [...new Set([...before, ...after].map(row => row.id))].filter(id => JSON.stringify(before.find(row => row.id === id)) !== JSON.stringify(after.find(row => row.id === id)));
const assetProperties = { ...studioActionDeclaration('asset.import').input.properties, placement,
	...Object.fromEntries(['x', 'y', 'z', 'rot', 'height'].map(key => [key, number])), clay: { type: 'boolean' }, mimeType: { type: 'string' } };
const assetImport = { ...studioActionDeclaration('asset.import'), kind: 'job', domain: 'objects',
	input: { ...input({ ...assetProperties, assetId: id, fileToken: id }, ['placeAs']), oneOf: [
		input(assetProperties, ['source', 'name', 'placeAs']),
		input({ assetId: id, placement, placeAs: assetProperties.placeAs }, ['assetId', 'placeAs']),
		input({ fileToken: id, placeAs: { type: 'string', enum: ['mesh', 'cutout'] } }, ['fileToken', 'placeAs']),
	] } };
const matte = { id: 'object.matte', label: 'Apply object matte', description: 'Prepare derived assets, then publish one fenced object edit.', kind: 'job', domain: 'objects', exposure: 'ui-only', input: input({ objectId: id }) };
export const declarations = Object.freeze([...semantic, replace, batch, ...['object.attach', 'object.detach', 'object.duplicate'].map(studioActionDeclaration), matte, sculptCompare, assetImport]);

export function register(registry, ports) {
	const objectOf = objectId => ports.state().objects.find(object => object.id === objectId)
		?? fail("STALE_TARGET", `Object ${objectId} is not in this scene.`);
	const owned = () => ports.storeDomain('objects');
	const available = () => Boolean(ports.storeDomain?.('objects')) || 'The objects document owner is not mounted.';
	const result = (before, summary) => ({ affectedIds: changedIds(before, owned().read()), summary });
	const methods = {
		'object.add': args => {
			const before = owned().read();
			if (args.parent !== undefined) objectOf(args.parent);
			const object = createSceneObject(args.kind, before, args.placement, args.text);
			if (!object) fail('INVALID_ARGUMENT', `Unknown object kind: ${args.kind}`);
			const placed = updateSceneObject([object], object.id, { ...(args.placement ?? {}), ...(args.name === undefined ? {} : { name: args.name }) })[0];
			// `first`: the Outliner lists Props in record order, so a UI-made object
			// goes to the top where it is seen, not below a long expanded group.
			const next = args.first ? [placed, ...before] : [...before, placed];
			owned().write(args.parent === undefined ? next : setSceneObjectParent(next, placed.id, args.parent));
			return withLightWarnings(result(before, 'Added object.'), owned().read());
		},
		'object.sculpt': args => {
			const before = owned().read();
			if ((args.recipe === undefined) === (args.edits === undefined)) argumentFail(`$.args: give exactly one of recipe (a whole recipe { version: 1, parts: [...] }) or edits (part by part, with id)${args.recipe === undefined ? '; neither was sent' : '; both were sent'}.`, '$.args.recipe', 'variant');
			if (args.edits !== undefined && args.id === undefined) argumentFail('$.args.edits patch an existing sculpt: give its id (an object id whose kind is sculpt), or send a whole recipe without id to make a new one.', '$.args.id', 'missing');
			let refused, changedParts = null;
			if (args.edits !== undefined) {
				const target = objectOf(args.id);
				if (target.renderer !== SCULPT_KIND) argumentFail(`$.args.id: ${args.id} is a ${target.renderer}, not a sculpt; edits patch a sculpt only.`, '$.args.id');
				refused = patchSculptRecipe(target.recipe, args.edits);
				changedParts = refused.changed;
			} else refused = normalizeSculptRecipe(args.recipe);
			// The failing recipe field rides on the refusal for studio:refused (#1042); a shape's refusal adds a valid example of it.
			if (!refused.ok) throw new StudioProtocolError('INVALID_ARGUMENT', `Recipe refused at ${refused.error}${sculptRefusalExample(refused.example)}`, { path: sculptRefusalPath(refused.path), rule: 'recipe' });
			const patch = { ...(args.placement ?? {}), ...(args.name === undefined ? {} : { name: args.name }) };
			let objectId = args.id;
			if (objectId !== undefined) {
				const target = objectOf(objectId);
				if (target.renderer !== SCULPT_KIND) argumentFail(`$.args.id: ${objectId} is a ${target.renderer}, not a sculpt; omit id to create a new sculpt.`, '$.args.id');
				owned().write(updateSceneObject(before, objectId, { ...patch, recipe: refused.recipe }));
			} else {
				if (args.parent !== undefined) objectOf(args.parent);
				const made = createSculptObject({ recipe: refused.recipe, name: args.name }, before, args.placement);
				objectId = made.object.id;
				const next = [...before, updateSceneObject([made.object], objectId, patch)[0]];
				owned().write(args.parent === undefined ? next : setSceneObjectParent(next, objectId, args.parent));
			}
			const sculpted = owned().read().find(row => row.id === objectId);
			const parts = expandSculptParts(sculpted.recipe).length;
			const size = `${sculpted.footprint.width} × ${sculpted.footprint.depth} m, ${sculpted.height} m tall`;
			// A receipt summary holds 240 characters: the head stays short and the box check takes what is left.
			const patched = changedParts && `${changedParts.slice(0, 4).join(', ')}${changedParts.length > 4 ? ` +${changedParts.length - 4}` : ''}`;
			const head = `${args.id === undefined ? 'Sculpted' : patched ? `Patched ${patched} on` : 'Re-sculpted'} ${String(sculpted.name).slice(0, 40)} (${objectId}): ${parts} parts, ${size}.`.slice(0, 150);
			return { affectedIds: [objectId, ...result(before, '').affectedIds.filter(row => row !== objectId)], summary: `${head} ${sculptBuildReport(sculpted.recipe, 239 - head.length)}` };
		},
		'object.remove': ({ ids }) => {
			const before = owned().read(); ids.forEach(objectOf);
			owned().write(ids.reduce((rows, id) => removeSceneObject(rows, id), before));
			return result(before, 'Removed objects.');
		},
		'object.rename': ({ id, name }) => {
			objectOf(id); const before = owned().read();
			owned().write(updateSceneObject(before, id, { name }));
			return result(before, 'Renamed object.');
		},
		'object.update': ({ id, patch }, context) => {
			const target = objectOf(id), before = owned().read();
			// Wire callers get an error for a key nothing reads; the UI's own patches stay lenient.
			const unknown = Object.keys(patch ?? {}).filter(key => !objectPatchFields(target).includes(key));
			if (unknown.length && context?.origin && context.origin !== 'ui') fail('INVALID_ARGUMENT', `object.update cannot set ${unknown.join(', ')}${unknown.some(key => PATCH_HINTS[key]) ? ` (${unknown.filter(key => PATCH_HINTS[key]).map(key => `${key}: ${PATCH_HINTS[key]}`).join('; ')})` : ''}. Supported fields: ${objectPatchFields(target).join(', ')}.`);
			const next = updateSceneObject(before, id, patch);
			owned().write(next);
			const kept = next.find(row => row.id === id);
			const warning = clampWarning(id, Object.fromEntries(['x', 'y', 'z', 'scaleX', 'scaleY', 'scaleZ'].filter(key => Object.hasOwn(patch ?? {}, key)).map(key => [key, Number(patch[key])])), kept);
			return { ...result(before, 'Updated object.'), ...(warning ? { warnings: [warning] } : {}) };
		},
		'object.group': ({ parent, children }) => {
			objectOf(parent); children.forEach(objectOf);
			const before = owned().read();
			if (children.some(id => id === parent || descendantsOf(before, id).some(row => row.id === parent))) fail('INVALID_ARGUMENT', 'Grouping would create a cycle.');
			owned().group(parent, children);
			return result(before, 'Grouped objects.');
		},
		'object.ungroup': ({ children }) => {
			children.forEach(objectOf); const before = owned().read();
			owned().write(children.reduce((rows, id) => setSceneObjectParent(rows, id, null), before));
			return result(before, 'Ungrouped objects.');
		},
		'object.groupUnderEmpty': ({ id }) => {
			const object = objectOf(id); const before = owned().read();
			if (object.attach) fail('CAPABILITY_MISSING', 'Detach the object from its character before grouping it.');
			const grouped = groupUnderNewEmpty(before, id);
			if (!grouped) fail('INVALID_ARGUMENT', 'Cannot group this object.');
			owned().write(grouped.objects);
			return { affectedIds: [grouped.emptyId, id], summary: 'Grouped the object under a new Empty.' };
		},
		'objects.arrange': args => {
			const plan = owned().arrange(args);
			return withLightWarnings({ affectedIds: plan.affectedIds, summary: 'Arranged objects.', checks: plan.checks, warnings: plan.warnings }, owned().read());
		},
	};
	// Scalar scale is a convenience at the command boundary; the registry still
	// owns all field mapping, normalization, publication and patch aliases.
	registerElementSet({ register(entry) {
		const expand = op => effectPresetSet(typeof op.set.scale === 'number' ? { ...op, set: { ...op.set, scale: { x: op.set.scale, y: op.set.scale, z: op.set.scale } } } : op, ports.state().objects);
		registry.register({ ...entry, available, run: args => {
			const ops = (args.ops ?? [args]).map(expand);
			let draft = owned().read();
			for (const { id, set } of ops) if (Object.hasOwn(set, 'parent')) {
				const object = objectOf(id), parent = set.parent;
				if (parent !== null) objectOf(parent);
				if (parent === id || descendantsOf(draft, id).some(row => row.id === parent)) fail('INVALID_ARGUMENT', 'Grouping would create a cycle.');
				if (object.attach) fail('CAPABILITY_MISSING', 'Use object.group to preserve an attached object world transform.');
				draft = setSceneObjectParent(draft, id, parent);
			}
			return withLightWarnings(entry.run(args.ops ? { ops } : ops[0]), owned().read());
		} });
	} }, ports, semantic[0]);
	for (const declaration of semantic.slice(1)) registry.register({ ...declaration, available, run: methods[declaration.id] });
	// Native adapters stay usable until their owner is mounted. In the editor,
	// domains mount before registry construction, so this is always the bus alias.
	if (ports.storeDomain?.('objects')) registry.registerToolAlias('arrange_objects', 'objects.arrange');
	registry.register({ ...replace, available, run: ({ objects }) => {
		const next = objects.map(normalizeSceneObject);
		if (next.some(row => !row) || new Set(next.map(row => row.id)).size !== next.length) fail('INVALID_ARGUMENT', 'Objects require valid records and unique ids.');
		const before = owned().read(); owned().write(next);
		return result(before, 'Replaced authored objects.');
	} });
	registry.register({ ...batch, available, run: (args, context) => {
		const before = owned().read();
		const output = context.commit(() => owned().batch(args));
		return { ...result(before, 'Applied object batch.'), output };
	} });
	registry.register({ ...studioActionDeclaration("object.attach"),
		available: state => state.objects.length === 0 ? "There are no scene objects to attach."
			: state.characters.length === 0 ? "There are no characters to attach an object to." : true,
		run: ({ objectId, characterId, bone }) => {
			const object = objectOf(objectId), character = characterOf(ports, characterId), before = ports.state().objects;
			ports.attachSceneObject(objectId, { characterId, bone: bone ?? null });
			const frameName = `${characterName(character)}'s ${bone ?? "root"}`;
			return { affectedIds: [objectId], summary: ports.state().objects === before
				? `${object.name || objectId} already rides ${frameName}; nothing changed.`
				: `Attached ${object.name || objectId} to ${frameName}, keeping its place on screen.` };
		} });
	registry.register({ ...studioActionDeclaration("object.detach"),
		available: state => state.objects.some(object => object.attach || object.parent) || "No scene object is attached to a character or grouped.",
		run: ({ objectId }) => {
			const object = objectOf(objectId);
			if (!object.attach && !object.parent) fail("TARGET_NOT_READY", `${object.name || objectId} is not attached to a character or in a group.`);
			ports.attachSceneObject(objectId, null);
			return { affectedIds: [objectId], summary: `Put ${object.name || objectId} back in the world where it is now.` };
		} });
	registry.register({ ...studioActionDeclaration("object.duplicate"),
		available: state => state.objects.length > 0 || "There are no scene objects to duplicate.",
		run: ({ objectId, copies }) => {
			const state = ports.state(), id = objectId ?? state.selectedObjectId;
			if (!id) fail("TARGET_NOT_READY", "Name objectId or select an object first.");
			const source = state.objects.find(object => object.id === id) ?? fail("STALE_TARGET", `Object ${id} is not in this scene.`);
			if (copies) {
				// Every copy in one write: one undo entry takes them all back.
				let placed;
				try { placed = placeObjectCopies(owned().read(), id, copies); } catch (error) { if (error.code !== 'INVALID_ARGUMENT') throw error; argumentFail(error.message, error.path); }
				owned().write(placed.objects);
				const sizes = placed.made.map(copy => copy.size.height);
				return { affectedIds: placed.ids, output: { sourceId: id, copies: placed.made },
					summary: `Made ${placed.made.length} copies of ${(source.name || id).slice(0, 60)}: ${placed.made[0].id} .. ${placed.made.at(-1).id} (${placed.ids.length} objects), ${Math.min(...sizes)}-${Math.max(...sizes)} m tall.`.slice(0, 240) };
			}
			ports.duplicateSelectedSceneObject(id);
			const after = ports.state().objects, affectedIds = changedIds(state.objects, after);
			const copy = after.find(object => affectedIds.includes(object.id));
			return { affectedIds, summary: copy ? `Duplicated ${source.name || source.id} as ${copy.name || copy.id}.` : "Duplicate object: nothing changed." };
		} });
	// The live import_asset path (validate, store the bytes, ONE atomic store
	// entry), fed a data URL; an http(s) source is fetched into one first.
	registry.register({ ...matte, available, run: async ({ objectId }, context) => {
		await owned().applyMatte(objectId, context);
		return { affectedIds: [objectId], summary: 'Applied the object matte.' };
	} });
	registry.register({ ...sculptCompare, available, run: runSculptCompare(ports, objectOf) });
	registry.register({ ...assetImport, available: () => true,
		run: async (args, context) => {
			const { source, ...options } = args;
			const { name, placeAs } = options;
			let dataUrl = source;
			if (source && !source.startsWith("data:")) {
				try { dataUrl = await ports.fetchImportSource(source); }
				catch (error) { fail("TARGET_NOT_READY", `Could not fetch the source (${error?.message || error}); its server must allow cross-origin reads.`); }
			}
			let imported;
			try { imported = await (ports.storeDomain?.('objects')?.importAsset ?? ports.importAsset)({ ...options, dataUrl }, context); }
			catch (error) { fail(error.code ?? "INVALID_ARGUMENT", `Not imported: ${error?.message || error}`); }
			return { affectedIds: [imported.objectId], output: imported, summary: `Imported ${name ?? imported.objectId} as a ${placeAs} (object ${imported.objectId}, asset ${imported.assetId}).` };
		} });
}
