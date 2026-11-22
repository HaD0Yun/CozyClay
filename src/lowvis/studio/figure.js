// The look new rig characters are drawn in (prototype), and the body that look stands for.
// COZYCLAY_FIGURE given at launch (tools/lowvis/pi/try.mjs --figure) sets both, in the page (vite.config.js hands it over)
// and in the agent sidecar (its own environment), so a motion is written for the body the Studio draws.
// ?figure=<look> in the page's address only draws that look, over the rig's own body. No figure: the block look, as before.
// No three.js here: the Studio's commands, the scene document and the sidecar import it.

/** The rig the looks are drawn over (take.js TRACK_RIG): only its characters have a look's body. */
const LOOK_RIG = "x-bot-tpose";

/** The body of each look, as a share of the rig's own body (rig17.js, 1.82 m to the top of its head): a character of
 *  that look at scale 1 is that body, and its scale is times that body. cube: the owner's body (2026-11-20), 1.50 m in
 *  the T-pose (1.49 m standing with the arms down); the look's drawn head stands over the rig's head, so the rig's own
 *  body would draw it 1.85 m tall. Any other look: the rig's own body (block: 1.75 m). */
const BODY = { cube: 0.81 };

const LAUNCHED = import.meta.env?.VITE_COZYCLAY_FIGURE || null;
/** The look this page draws rig characters in, or null for the block look. */
export const FIGURE = (typeof location === "undefined" ? null : new URLSearchParams(location.search).get("figure")) || LAUNCHED;

/** The body of the look given at launch (or `look`), as a share of the rig's own body: 1 but for the cube look. */
export const lookBody = (look = LAUNCHED) => BODY[look] ?? 1;

/** How large a character stands in the world, as a share of its model's own body: its scale times its look's body
 *  (only a character of the rig the looks are drawn over has one). */
export const bodyScale = (character, look = LAUNCHED) => (Number.isFinite(character?.scale) ? character.scale : 1) * (character?.model === LOOK_RIG ? lookBody(look) : 1);

/** The scales a stored row may hold: the Studio's limits of a character's scale ({ min, max }), and for a character of
 *  the rig the looks are drawn over every size those limits give under any look's body, so a row carried over from
 *  another look (carriedOver) keeps its size at both ends of the range. */
export function scaleRoom({ min, max }, model, look = LAUNCHED) {
	if (model !== LOOK_RIG) return { min, max };
	const to = lookBody(look), bodies = [1, ...Object.values(BODY)];
	return { min: Math.min(min, min * Math.min(...bodies) / to), max: Math.max(max, max * Math.max(...bodies) / to) }; // as carriedOver multiplies
}

/** A size the engine built (a share of the rig's own body) as a character's scale of the look's body `body`: the size
 *  itself for the rig's own body, else to six decimals (0.81 x 0.9 / 0.81 is 0.9). */
export const scaleOf = (size, body = 1) => (body === 1 ? size : Math.round(size / body * 1e6) / 1e6);

/** A stored character row whose scale is of the body `stored` (a stage's figureBody, scenes.js; 1 when not given) as a
 *  row of this page's look: a character of the rig the looks are drawn over gets the scale that stands it as large as
 *  before; any other row, or one of the same body, is the row itself. */
export function carriedOver(row, stored, look = LAUNCHED) {
	const from = Number.isFinite(stored) && stored > 0 ? stored : 1, to = lookBody(look);
	return from === to || row?.model !== LOOK_RIG ? row : { ...row, scale: (Number.isFinite(row.scale) ? row.scale : 1) * from / to };
}
