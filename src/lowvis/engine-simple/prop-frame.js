// A static prop's own frame and the hand pad, shared by the spec layers and the clip build (moved unchanged from engine.js).
import { clamp } from "./math.js";

export const PAD = 0.03; // wrist centre to the surface it holds
// A prop's own frame: the scene's turn about Y (radians) at its centre. A static prop keeps it; a moving prop starts with it.
// toOwn / toWorld take a floor-plane offset [x, z] from the centre into that frame and back (exact at turn 0).
export const toOwn = (p, x, z) => { const cs = Math.cos(p.turn), sn = Math.sin(p.turn); return [x * cs - z * sn, x * sn + z * cs]; };
export const toWorld = (p, x, z) => { const cs = Math.cos(p.turn), sn = Math.sin(p.turn); return [x * cs + z * sn, z * cs - x * sn]; };
/** The prop's width along world X as it stands (two hands hold it across that width). */
export const across = p => Math.abs(Math.cos(p.turn)) * p.size[0] + Math.abs(Math.sin(p.turn)) * p.size[2];
/** The point of a static prop's box nearest to a world point, as the world offset from it (zero inside). */
export const offBox = (o, pt) => {
	const [x, z] = toOwn(o, pt[0] - o.c[0], pt[2] - o.c[2]), l = [x, pt[1] - o.c[1], z];
	const d = l.map((v, a) => v - clamp(v, -o.size[a] / 2, o.size[a] / 2)), [wx, wz] = toWorld(o, d[0], d[2]);
	return [wx, d[1], wz];
};
