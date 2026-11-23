// The look rig characters are drawn in, and the body that look stands for. The one home of the default: DEFAULT_LOOK.
// COZYCLAY_FIGURE given at launch (COZYCLAY_FIGURE=block npx cozyclay, tools/lowvis/pi/try.mjs --figure) names the look in the page
// and in the agent sidecar alike, both through launchLook: the sidecar reads its own environment (figureOf), the page the
// value the server that serves it hands over (bin/cozyclay.mjs writes window.__COZYCLAY_FIGURE__ into the page from the
// same environment; a dev server bakes it in at its start, vite.config.js). Nothing given: DEFAULT_LOOK; "block": the block look.
// ?figure=<look> in the page's address only draws that look, over the launched look's body.
// No three.js here: the Studio's commands, the scene document and the sidecar import it.

/** The rig the looks are drawn over (take.js TRACK_RIG): only its characters have a look's body. */
const LOOK_RIG = "x-bot-tpose";

/** The body of each look, as a share of the rig's own body (rig17.js, 1.82 m to the top of its head): a character of
 *  that look at scale 1 is that body, and its scale is times that body. cube: the owner's body (2026-11-23), 1.70 m
 *  standing with the arms down (STANDS.cube x 0.943). Any other look: the rig's own body. */
const BODY = { cube: 0.943 };

/** How tall each look stands at the rig's own body with the arms down, in metres: the top of the drawn look over the
 *  floor in the engine's stand pose, to a tenth of a millimetre (three.js bounds; test/lowvis/verify-look-body.mjs
 *  measures them again). */
const STANDS = { block: 1.7385, box: 1.8104, capsule: 1.8111, stick: 1.8046, man: 1.7679, woman: 1.7635, cube: 1.8024 };

/** The look rig characters are drawn in when the launch names none. */
const DEFAULT_LOOK = "cube";
/** The look a launch value names, or null for the block look: nothing (unset or empty) is DEFAULT_LOOK. */
const launchLook = value => { const name = typeof value === "string" ? value.trim() : ""; return !name ? DEFAULT_LOOK : name === "block" ? null : name; };
/** The look of a launch environment (its COZYCLAY_FIGURE): what the sidecar draws and builds bodies in. */
export const figureOf = (env = globalThis.process?.env) => launchLook(env?.COZYCLAY_FIGURE);
// the page served by bin/cozyclay.mjs: the value it was started with; a dev server's page: the value baked in at its start
const handed = typeof window === "undefined" ? undefined : window.__COZYCLAY_FIGURE__, baked = import.meta.env?.VITE_COZYCLAY_FIGURE;
const LAUNCHED = typeof handed === "string" ? launchLook(handed) : typeof baked === "string" ? launchLook(baked) : figureOf();
/** The look this page draws rig characters in, or null for the block look. */
export const FIGURE = (typeof location === "undefined" ? null : new URLSearchParams(location.search).get("figure")) || LAUNCHED;

/** The body of the look given at launch (or `look`), as a share of the rig's own body: 1 but for the cube look. */
export const lookBody = (look = LAUNCHED) => BODY[look] ?? 1;

/** How large a character stands in the world, as a share of its model's own body: its scale times its look's body
 *  (only a character of the rig the looks are drawn over has one). */
export const bodyScale = (character, look = LAUNCHED) => (Number.isFinite(character?.scale) ? character.scale : 1) * (character?.model === LOOK_RIG ? lookBody(look) : 1);

/** How tall `character` stands with the arms down, in metres (to the millimetre), drawn in the look `drawn` (this page's;
 *  skin.jsx draws an unknown look as the block look); by default a character of the rig at scale 1. null for a
 *  character of another model (no look draws it). */
export function standingHeight(character = { model: LOOK_RIG }, drawn = FIGURE) {
	return character?.model === LOOK_RIG ? Math.round((STANDS[drawn] ?? STANDS.block) * bodyScale(character) * 1000) / 1000 : null;
}

/** The scales a stored row may hold: the Studio's limits of a character's scale ({ min, max }), and for a character of
 *  the rig the looks are drawn over as far up as the largest body any look's limit allows, so a row carried over from a
 *  look of a larger body (carriedOver) keeps its size up to that limit. Under the rig's own body: the limits themselves. */
export function scaleRoom({ min, max }, model, look = LAUNCHED) {
	if (model !== LOOK_RIG) return { min, max };
	return { min, max: Math.max(max, max * Math.max(1, ...Object.values(BODY)) / lookBody(look)) }; // as carriedOver multiplies
}

/** A size the engine built (a share of the rig's own body) as a character's scale of the look's body `body`: the size
 *  itself for the rig's own body, else to six decimals (0.943 x 0.9 / 0.943 is 0.9). */
export const scaleOf = (size, body = 1) => (body === 1 ? size : Math.round(size / body * 1e6) / 1e6);

/** The character scale a take was made for, or null: a raw take (source.spec.raw, motion-v4/track/codec.js) is of one
 *  body size, and played on a body of another scale it plays scaled about the character's place (the panel says so). */
export const takeScaleOf = (source, model, look = LAUNCHED) => (source?.spec?.raw ? scaleOf(source.spec.raw.scale ?? 1, model === LOOK_RIG ? lookBody(look) : 1) : null);

/** A stored character row whose scale is of the body `stored` (a stage's figureBody, scenes.js; 1 when not given) as a
 *  row of this page's look: a character of the rig the looks are drawn over gets the scale that stands it as large as
 *  before; any other row, or one of the same body, is the row itself. */
export function carriedOver(row, stored, look = LAUNCHED) {
	const from = Number.isFinite(stored) && stored > 0 ? stored : 1, to = lookBody(look);
	return from === to || row?.model !== LOOK_RIG ? row : { ...row, scale: (Number.isFinite(row.scale) ? row.scale : 1) * from / to };
}
