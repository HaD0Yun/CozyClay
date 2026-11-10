// The street the hosted Agent panel's demo builds (AgentHostedDemos.jsx): grey-box buildings down both sides of the
// way the sample walk comes in, laid out around the character so it walks up the middle of it. Offsets are metres
// behind the character (`back`) and to its left (`left`); heading 0 faces +z, the same frame as sample-motions.js.
const GREYS = ["#8d9299", "#a3a7ad", "#7b8088", "#b4b7bc"];
const ROWS = [
	{ back: 14, w: 3.2, d: 3.4, h: 6.5 }, { back: 10, w: 3.6, d: 3.0, h: 9 }, { back: 6, w: 3.0, d: 3.6, h: 5 }, { back: 2, w: 3.4, d: 3.2, h: 7.5 },
];

/** The buildings to add around a character at { x, z, rot }: [{ name, x, z, rot, scaleX, scaleY, scaleZ, color }]. */
export function demoStreet({ x = 0, z = 0, rot = 0 } = {}) {
	const heading = Number.isFinite(rot) ? rot : 0, r = heading * Math.PI / 180;
	const at = (back, left) => ({ x: +(x - Math.sin(r) * back + Math.cos(r) * left).toFixed(3), z: +(z - Math.cos(r) * back - Math.sin(r) * left).toFixed(3) });
	return [1, -1].flatMap((side, sideIndex) => ROWS.map((row, index) => {
		// the right-hand row is the left one read backwards, so the two sides do not mirror each other
		const size = side === 1 ? row : ROWS[ROWS.length - 1 - index];
		return { name: `Building ${sideIndex * ROWS.length + index + 1}`, ...at(row.back, side * (4.5 + size.w / 2)), rot: heading, scaleX: size.w, scaleY: size.h, scaleZ: size.d, color: GREYS[(index + sideIndex) % GREYS.length] };
	}));
}
