// The look new rig characters are drawn in (prototype), and the size a new figure of that look starts at.
// COZYCLAY_FIGURE given at launch (tools/lowvis/pi/try.mjs --figure) sets both, in the page (vite.config.js hands it over)
// and in the agent sidecar (its own environment), so a motion is written for the size the Studio gives a new figure.
// ?figure=<look> in the page's address only draws that look, at size 1. No figure: the block look at size 1, as before.
// No three.js here: the Studio's commands and the sidecar import it.

/** The size a new figure of each look starts at, as a character scale (1: the rig's own body, rig17.js). cube: its big
 *  head stands over the rig's head, so at 1 it is 1.90 m tall against the block look's 1.75 m; at 0.9 it is 1.71 m. */
const STATURE = { cube: 0.9 };

const LAUNCHED = import.meta.env?.VITE_COZYCLAY_FIGURE || null;
/** The look this page draws rig characters in, or null for the block look. */
export const FIGURE = (typeof location === "undefined" ? null : new URLSearchParams(location.search).get("figure")) || LAUNCHED;

/** The scale a new character starts at for the look given at launch (or `look`). */
export const figureStature = (look = LAUNCHED) => STATURE[look] ?? 1;
