// The motion writer's scene and spec kept with each installed take (src/lowvis/studio/install.js source, stored by
// motion.v4.install as the take's spec.lowvis), read back from the Studio scene the describe answer holds. They are
// saved, reloaded, duplicated and undone with the take, so a follow-up (motion-run.mjs) and a refit (motion-refit.mjs)
// start from the motion that plays now, whatever conversation made it, and never from a spec no take plays.
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);

/** { kept: { <Studio character id>: { name, scene, spec } }, bare: [<Studio character id>] } of the open scene's
 *  characters (describe answer `read`: its document holds each character's saved take, src/document-mirrors.js): kept,
 *  those whose take keeps the writer's scene and spec; bare, those that play a take that keeps none. */
export function keptTakes(read) {
	const document = read?.document, open = document?.scenes?.find(scene => scene?.id === document?.activeSceneId), kept = {}, bare = [];
	for (const row of open?.stage?.characters ?? []) {
		if (typeof row?.id !== "string" || !plain(row.motionTake)) continue;
		const entry = row.motionTake.spec?.lowvis;
		if (plain(entry) && typeof entry.name === "string" && plain(entry.scene) && Array.isArray(entry.scene.characters) && plain(entry.spec)) kept[row.id] = entry;
		else bare.push(row.id);
	}
	return { kept, bare };
}

/**
 * The motion a follow-up starts from: { name, scene, spec, cast } or null. A motion counts while every character of its
 * scene that the Studio lists (ids: studioScene ids.characters, the writer's id -> the Studio's) plays a take of it; of
 * those, the one named `prefer` (the conversation's last), else the latest (names carry their time, motion-run.mjs).
 * cast: the Studio ids that play it. none: the listed characters whose take keeps no spec (made before specs were kept,
 * or by another tool), told to the agent.
 */
export function keptMotion(kept, ids, prefer = null) {
	const whole = playingMotions(kept, ids);
	return whole.find(motion => motion.name === prefer) ?? whole[0] ?? null;
}

/** What the installs of the playing takes put on a bone (install.js source attached), of keptTakes' answer: { objects:
 *  { <Studio object id>: { characterId, bone, at, quat } }, its place and turn in that bone's frame as the install set
 *  them; older: the characters whose take does not say what its install put there (a take that keeps no source, or a
 *  source written before it held that list) }. An attached object whose numbers differ from these, or that rides a
 *  character no take of which put it there, was placed by the user or the agent, and a later install keeps it
 *  (install.js keepsPlace); on an `older` character the clip's place is taken, as before the list was kept. */
export function attachedBefore({ kept = {}, bare = [] } = {}) {
	const objects = {}, older = [...bare];
	for (const [characterId, entry] of Object.entries(kept)) {
		if (!Array.isArray(entry?.attached)) { older.push(characterId); continue; }
		for (const row of entry.attached) if (typeof row?.id === "string" && Array.isArray(row.at) && Array.isArray(row.quat)) objects[row.id] = { characterId, bone: row.bone, at: row.at, quat: row.quat };
	}
	return { objects, older };
}

/** Every motion keptMotion may start from, the latest first: [{ name, scene, spec, cast }]. */
export function playingMotions(kept, ids) {
	const byName = new Map();
	for (const [studioId, entry] of Object.entries(kept)) {
		const motion = byName.get(entry.name) ?? { ...entry, cast: [] };
		motion.cast.push(studioId);
		byName.set(entry.name, motion);
	}
	return [...byName.values()].filter(motion => motion.scene.characters.some(c => ids?.[c.id]) && motion.scene.characters.every(c => { const id = ids?.[c.id]; return !id || kept[id]?.name === motion.name; }))
		.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}
