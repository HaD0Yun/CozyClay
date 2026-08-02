// Motion-archive byte fixtures for tests that drive the real
// MotionArchiveStore (and through it, the real commit/recovery machinery).
// A real npz is a ZIP container of NPY members; the store's validator parses
// both, so the fixture has to be real enough for the real parser.
//
// validMotionArchive() produces a structurally valid single-frame cskel27
// motion: identity rotations, posed joints with a +Y-dominant Hips (the
// write-time invariant), and an integral fps scalar -- the same shape the
// add-on and the wrapper produce.

function u16(value: number): number[] {
	return [value & 255, value >>> 8];
}
function u32(value: number): number[] {
	return [value & 255, value >>> 8, value >>> 16, value >>> 24];
}
function npy(descr: string, shape: string, payload: Uint8Array): Uint8Array {
	const header = new TextEncoder().encode(`{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape}), }`);
	const padding = (16 - ((10 + header.length + 1) % 16)) % 16;
	const text = new Uint8Array([...header, ...new Array(padding).fill(32), 10]);
	return new Uint8Array([0x93, 78, 85, 77, 80, 89, 1, 0, ...u16(text.length), ...text, ...payload]);
}
function zip(members: readonly [string, Uint8Array][]): Uint8Array {
	const chunks: number[] = [];
	const central: number[] = [];
	for (const [name, payload] of members) {
		const nameBytes = new TextEncoder().encode(name);
		const offset = chunks.length;
		chunks.push(
			...u32(0x04034b50),
			...u16(20),
			...u16(0),
			...u16(0),
			...u16(0),
			...u16(0),
			...u32(0),
			...u32(payload.length),
			...u32(payload.length),
			...u16(nameBytes.length),
			...u16(0),
			...nameBytes,
			...payload,
		);
		central.push(
			...u32(0x02014b50),
			...u16(20),
			...u16(20),
			...u16(0),
			...u16(0),
			...u16(0),
			...u16(0),
			...u32(0),
			...u32(payload.length),
			...u32(payload.length),
			...u16(nameBytes.length),
			...u16(0),
			...u16(0),
			...u16(0),
			...u16(0),
			...u32(0),
			...u32(offset),
			...nameBytes,
		);
	}
	const centralOffset = chunks.length;
	chunks.push(
		...central,
		...u32(0x06054b50),
		...u16(0),
		...u16(0),
		...u16(members.length),
		...u16(members.length),
		...u32(central.length),
		...u32(centralOffset),
		...u16(0),
	);
	return new Uint8Array(chunks);
}

export function validMotionArchive(options: { fps?: number; y?: number } = {}): Uint8Array {
	const rotations = new Float32Array(27 * 9);
	for (let joint = 0; joint < 27; joint++)
		for (let axis = 0; axis < 3; axis++) rotations[joint * 9 + axis * 3 + axis] = 1;
	const joints = new Float32Array(27 * 3);
	joints[1] = options.y ?? 1;
	return zip([
		["local_rot_mats.npy", npy("<f4", "1, 27, 3, 3", new Uint8Array(rotations.buffer))],
		["posed_joints.npy", npy("<f4", "1, 27, 3", new Uint8Array(joints.buffer))],
		["fps.npy", npy("<i4", "", new Uint8Array(new Int32Array([options.fps ?? 20]).buffer))],
	]);
}
