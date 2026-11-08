// The encoded raw track (cozyclay.raw-track.v1): a RawTrack (a world-frame take v3, store.js) as JSON, its numbers
// as little-endian Float32 bytes in base64. The track store sends it to the editor (motion.v4.install), and the
// document keeps it at motionTake.spec.raw, so save, reload and the bench export read the same bytes.
// Browser-safe: no Buffer and no node:* import, so the editor bundle can load it.
const SCHEMA = "cozyclay.raw-track.v1";
const TAKE_SCHEMA = "cozyclay.take.v3";
const SPEC_SCHEMA = "cozyclay.motion-spec.v1";
const FPS = 24;
const ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CHARS = Array.from(ABC, ch => ch.charCodeAt(0));
const CODE = new Int16Array(128).fill(-1);
CHARS.forEach((ch, i) => { CODE[ch] = i; });
const PAD = 61; // "="
// bytes per String.fromCharCode call: a multiple of 3, small enough for any engine's argument limit
const CHUNK = 3 * 8192;

const invalid = reason => { throw new Error(`RAW_TRACK_INVALID: ${reason}`); };
const plain = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function toBase64(bytes) {
	const parts = [], n = bytes.length;
	for (let start = 0; start < n; start += CHUNK) {
		const end = Math.min(n, start + CHUNK), codes = [];
		for (let i = start; i < end; i += 3) {
			const t = (bytes[i] << 16) | ((i + 1 < end ? bytes[i + 1] : 0) << 8) | (i + 2 < end ? bytes[i + 2] : 0);
			codes.push(CHARS[t >> 18], CHARS[(t >> 12) & 63], i + 1 < end ? CHARS[(t >> 6) & 63] : PAD, i + 2 < end ? CHARS[t & 63] : PAD);
		}
		parts.push(String.fromCharCode.apply(null, codes));
	}
	return parts.join("");
}

function fromBase64(text, what) {
	if (typeof text !== "string" || text.length % 4) invalid(`${what} is not base64`);
	const n = text.length, pad = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0, bytes = new Uint8Array(n / 4 * 3 - pad);
	for (let i = 0, j = 0; i < n; i += 4) {
		let t = 0;
		for (let k = i; k < i + 4; k++) {
			const ch = text.charCodeAt(k), v = k >= n - pad ? 0 : ch < 128 ? CODE[ch] : -1;
			if (v < 0) invalid(`${what} is not base64`);
			t = (t << 6) | v;
		}
		bytes[j++] = t >> 16;
		if (j < bytes.length) bytes[j++] = (t >> 8) & 255;
		if (j < bytes.length) bytes[j++] = t & 255;
	}
	return bytes;
}

const encodeFloats = values => {
	const view = new DataView(new ArrayBuffer(values.length * 4));
	for (let i = 0; i < values.length; i++) view.setFloat32(i * 4, values[i], true);
	return toBase64(new Uint8Array(view.buffer));
};

/** base64 -> Float32Array of exactly `count` finite numbers, or RAW_TRACK_INVALID. */
function decodeFloats(text, count, what) {
	const bytes = fromBase64(text, what);
	if (bytes.length !== count * 4) invalid(`${what} has ${bytes.length} bytes; ${count} floats need ${count * 4}`);
	const view = new DataView(bytes.buffer), out = new Float32Array(count);
	for (let i = 0; i < count; i++) {
		const v = view.getFloat32(i * 4, true);
		if (!Number.isFinite(v)) invalid(`${what}[${i}] is not a finite number`);
		out[i] = v;
	}
	return out;
}

/** RawTrack -> EncodedRawTrack (design 2.6). */
export function encodeRawTrack(raw) {
	const objects = {};
	for (const [id, track] of Object.entries(raw.objects ?? {})) objects[id] = { pos: encodeFloats(track.pos), quat: encodeFloats(track.quat) };
	return { schema: SCHEMA, rig: raw.rig, fps: FPS, frames: raw.frameCount, bones: raw.bones.slice(),
		rot: encodeFloats(raw.rot), hips: encodeFloats(raw.hips), objects };
}

/** EncodedRawTrack on skeleton sk -> RawTrack; throws RAW_TRACK_INVALID: <reason> when it does not fit sk. */
export function decodeRawTrack(encoded, sk) {
	if (!plain(encoded) || encoded.schema !== SCHEMA) invalid(`schema must be "${SCHEMA}"`);
	if (encoded.rig !== sk.model) invalid(`rig is ${JSON.stringify(encoded.rig)}; the character's rig is ${sk.model}`);
	if (encoded.fps !== FPS) invalid(`fps must be ${FPS}`);
	const F = encoded.frames, B = sk.names.length;
	if (!Number.isSafeInteger(F) || F < 1) invalid("frames must be a positive integer");
	if (!Array.isArray(encoded.bones) || encoded.bones.length !== B || encoded.bones.some((name, i) => name !== sk.names[i])) invalid(`bones must be the ${B} ${sk.model} bones in rig order`);
	if (encoded.objects !== undefined && !plain(encoded.objects)) invalid("objects must be an object");
	const rot = decodeFloats(encoded.rot, F * B * 4, "rot"), hips = decodeFloats(encoded.hips, F * 3, "hips"), objects = {};
	for (const [id, track] of Object.entries(encoded.objects ?? {})) {
		if (!plain(track)) invalid(`objects.${id} must be { pos, quat }`);
		objects[id] = { pos: decodeFloats(track.pos, F * 3, `objects.${id}.pos`), quat: decodeFloats(track.quat, F * 4, `objects.${id}.quat`) };
	}
	return { schema: TAKE_SCHEMA, fps: FPS, frameCount: F, rig: sk.model, bones: sk.names.slice(), rot, hips, objects,
		placement: { position: [0, 0, 0], yaw: 0 }, spec: { schema: SPEC_SCHEMA, fps: FPS, frames: F } };
}
