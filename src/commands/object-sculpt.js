// object.sculpt (docs/sculpt-from-image.md): with `id` it re-sculpts that object in place (one undo), and a
// non-sculpt object (a cube, a sphere) becomes a sculpt keeping its id, place, turn, scale, path, parent and
// name; without `id` it creates one. A refused part or edit is left out and reported, the rest lands
// (sculpt-recipe-partial.js); a call where nothing can land is refused whole.
import { createSculptObject, normalizeSceneObject, setSceneObjectParent, updateSceneObject, SCULPT_KIND } from '../scene-objects.js';
import { expandSculptParts } from '../sculpt-recipe.js';
import { normalizeSculptRecipeKeeping, patchSculptRecipeKeeping } from '../sculpt-recipe-partial.js';
import { sculptRefusalPath } from '../sculpt-refusal-path.js';
import { sculptRefusalExample } from '../sculpt-shape-examples.js';
import { sculptBuildReport } from '../sculpt-report.js';
import { StudioProtocolError } from '../studio-agent-protocol.js';

const argumentFail = (message, path, rule = 'check') => { throw new StudioProtocolError('INVALID_ARGUMENT', message, { path, rule }); };
const WARNING_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
// Fields a sculpt record does not take from the object it replaces: what the recipe decides.
const RECIPE_OWNED = new Set(['renderer', 'recipe', 'footprint', 'height']);

/** One warning per left-out part or edit: its path, the reason and the accepted range (receipt warnings hold 120 characters). */
function leftOutWarnings(skipped) {
	return skipped.map(item => {
		const text = `Left out ${item.error}`;
		return { code: 'PART_REFUSED', ...(item.id && WARNING_ID.test(item.id) ? { id: item.id } : {}), message: text.length > 120 ? `${text.slice(0, 119)}…` : text };
	});
}

/** A non-sculpt object turned into a sculpt: every field a sculpt record carries comes from the object, except what the recipe decides. */
function sculptInPlace(target, recipe, rows) {
	const made = createSculptObject({ recipe }, rows.filter(row => row.id !== target.id)).object;
	const kept = Object.fromEntries(Object.keys(made).filter(key => !RECIPE_OWNED.has(key) && Object.hasOwn(target, key)).map(key => [key, target[key]]));
	return normalizeSceneObject({ ...made, ...kept });
}

export function sculptMethod({ owned, objectOf, changed }) {
	return args => {
		const before = owned().read();
		if ((args.recipe === undefined) === (args.edits === undefined)) argumentFail(`$.args: give exactly one of recipe (a whole recipe { version: 1, parts: [...] }) or edits (part by part, with id)${args.recipe === undefined ? '; neither was sent' : '; both were sent'}.`, '$.args.recipe', 'variant');
		if (args.edits !== undefined && args.id === undefined) argumentFail('$.args.edits patch an existing sculpt: give its id (an object id whose kind is sculpt), or send a whole recipe without id to make a new one.', '$.args.id', 'missing');
		const target = args.id === undefined ? null : objectOf(args.id);
		let refused, changedParts = null;
		if (args.edits !== undefined) {
			if (target.renderer !== SCULPT_KIND) argumentFail(`$.args.id: ${args.id} is a ${target.renderer}, not a sculpt; edits patch a sculpt only. A whole recipe with this id turns it into a sculpt in place.`, '$.args.id');
			refused = patchSculptRecipeKeeping(target.recipe, args.edits);
			changedParts = refused.changed;
		} else refused = normalizeSculptRecipeKeeping(args.recipe);
		// The failing recipe field rides on the refusal for studio:refused (#1042); a shape's refusal adds a valid example of it.
		if (!refused.ok) {
			// Every item refused: the head names one, the rest follow. A recipe-wide limit: every item left out before it is listed too.
			const others = refused.skipped.filter(item => item.error !== refused.error).slice(0, 6).map(item => item.error).join(' | ');
			const more = !others ? '' : (refused.allRefused ? ` Every ${args.edits ? 'edit' : 'part'} was refused; the others: ${others}` : ` Also refused: ${others}`).slice(0, 900);
			throw new StudioProtocolError('INVALID_ARGUMENT', `Recipe refused at ${refused.error}${sculptRefusalExample(refused.example)}${more}`, { path: sculptRefusalPath(refused.path), rule: 'recipe' });
		}
		const patch = { ...(args.placement ?? {}), ...(args.name === undefined ? {} : { name: args.name }) };
		let objectId = args.id, converted = null;
		if (target && target.renderer !== SCULPT_KIND) {
			converted = target.renderer;
			const sculpted = sculptInPlace(target, refused.recipe, before);
			owned().write(updateSceneObject(before.map(row => (row.id === target.id ? sculpted : row)), target.id, patch));
		} else if (target) owned().write(updateSceneObject(before, objectId, { ...patch, recipe: refused.recipe }));
		else {
			if (args.parent !== undefined) objectOf(args.parent);
			const made = createSculptObject({ recipe: refused.recipe, name: args.name }, before, args.placement);
			objectId = made.object.id;
			const next = [...before, updateSceneObject([made.object], objectId, patch)[0]];
			owned().write(args.parent === undefined ? next : setSceneObjectParent(next, objectId, args.parent));
		}
		const sculpted = owned().read().find(row => row.id === objectId);
		const parts = expandSculptParts(sculpted.recipe).length;
		const size = `${sculpted.footprint.width} × ${sculpted.footprint.depth} m, ${sculpted.height} m tall`;
		const scale = [sculpted.scaleX, sculpted.scaleY, sculpted.scaleZ];
		const kept = converted ? ` (was a ${converted}; id, place, turn${scale.every(v => v === 1) ? '' : `, scale ${scale.join('×')}`}, parent and path kept)` : '';
		const left = refused.skipped.length ? ` Left out ${refused.skipped.length} ${args.edits ? 'edits' : 'parts'}: ${refused.skipped.map(item => item.id ?? `#${item.index ?? '?'}`).slice(0, 6).join(', ')}.` : '';
		// A receipt summary holds 240 characters: the head stays short and the box check takes what is left.
		const patched = changedParts && `${changedParts.slice(0, 4).join(', ')}${changedParts.length > 4 ? ` +${changedParts.length - 4}` : ''}`;
		const head = `${args.id === undefined ? 'Sculpted' : converted ? 'Sculpted in place' : patched ? `Patched ${patched} on` : 'Re-sculpted'} ${String(sculpted.name).slice(0, 40)} (${objectId}): ${parts} parts, ${size}.${kept}${left}`.slice(0, 200);
		return { affectedIds: [objectId, ...changed(before).filter(row => row !== objectId)], summary: `${head} ${sculptBuildReport(sculpted.recipe, 239 - head.length)}`.slice(0, 240),
			...(refused.skipped.length ? { warnings: leftOutWarnings(refused.skipped) } : {}) };
	};
}
