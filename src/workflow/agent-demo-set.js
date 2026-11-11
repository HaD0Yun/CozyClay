// The sets the hosted Agent panel's demos build (AgentHostedDemos.jsx), laid out around the character: grey-box
// buildings down both sides of the way the sample walk comes in, and a chair beside it with the take that sits on it.
// Offsets are metres behind the character (`back`) and to its left (`left`); heading 0 faces +z, the same frame as
// sample-motions.js.
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

// The chair stands a step to the character's right and faces the way it faces, clear of the way the walk comes in.
// The seat is narrower than the hips' reach so hanging hands pass beside it, and the back stands behind the seat's rear edge.
const CHAIR = { left: -1.1, width: 0.36, depth: 0.5, height: 0.45, back: 0.55, thick: 0.08 };
const SIT_AT = 44, SIT_HOLD = 110;

/** The chair's two boxes around a character at { x, z, rot }: the seat first, then its back. */
export function demoChair({ x = 0, z = 0, rot = 0 } = {}) {
	const heading = Number.isFinite(rot) ? rot : 0, r = heading * Math.PI / 180, c = CHAIR;
	const at = (back, left) => ({ x: +(x - Math.sin(r) * back + Math.cos(r) * left).toFixed(3), z: +(z - Math.cos(r) * back - Math.sin(r) * left).toFixed(3) });
	return [
		{ name: "Chair seat", ...at(0, c.left), rot: heading, scaleX: c.width, scaleY: c.height, scaleZ: c.depth, color: "#9a7b5c" },
		{ name: "Chair back", ...at((c.depth + c.thick) / 2, c.left), rot: heading, scaleX: c.width, scaleY: c.height + c.back, scaleZ: c.thick, color: "#9a7b5c" },
	];
}

/**
 * The take that sits on the chair whose seat is scene object `seatId` (and back `backId`): the character stands in
 * front of the seat, then sits (the compiler's sitInSeat skill, with the arms left hanging: there is no wheel), and
 * stays seated to the end. `ankle` is the rig's ankle height (m): with it the standing feet are planted where the
 * seated pose has them, so they do not slide as the body goes down.
 */
export function demoSitSpec({ x = 0, z = 0, rot = 0 } = {}, seatId, backId, ankle) {
	const [seat] = demoChair({ x, z, rot }), heading = Number.isFinite(rot) ? rot : 0, r = heading * Math.PI / 180;
	// sitInSeat's own numbers: the hips 0.02 m ahead of the seat's centre, the feet 0.452 m ahead of the hips and 0.17 m to each side
	const ahead = 0.02 + 0.452, spot = (side) => [+(seat.x + Math.cos(r) * side + Math.sin(r) * ahead).toFixed(3), +(seat.z - Math.sin(r) * side + Math.cos(r) * ahead).toFixed(3)];
	const sit = f0 => ({ skill: "sitInSeat", f0, args: { seat: seatId, ...(backId ? { seatBack: backId } : {}) } });
	// the arms hang, and the yaw is the standing one as written: read back from the box, 180 can come out as -180 and turn the body once around
	const seated = f => ({ f, set: { armw_l: 0, armw_r: 0, yaw: heading, fyaw_l: heading, fyaw_r: heading } });
	const foot = (side) => { const [fx, fz] = spot(side); return [fx, ankle, fz]; };
	const planted = Number.isFinite(ankle) ? [{ f: 0, set: { foot_l: foot(0.17), foot_r: foot(-0.17) } }] : [];
	return { schema: "cozyclay.motion-spec.v1", fps: 24, frames: "auto",
		use: [{ skill: "standIdle", f0: 0, args: { at: spot(0), heading } }, sit(SIT_AT), sit(SIT_HOLD)], keys: [...planted, seated(SIT_AT), seated(SIT_HOLD)] };
}
