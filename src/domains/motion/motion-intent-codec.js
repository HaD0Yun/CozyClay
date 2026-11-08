import * as THREE from "three";

const sameMotionIntent = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const emptyMotionLayer = id => ({ id, take: null, fullTake: null, ikKeys: [], ikPins: [], ikPinResiduals: [], committedIkEdits: [], takeRecipe: null, takeVersions: [] });
const keyVector = p => ({ x: p.x, y: p.y, z: p.z });
const keyQuaternion = q => ({ ...keyVector(q), w: q.w });
function encodeMotionKeys(keys) {
	return [...keys].sort(([a], [b]) => a - b).map(([frame, tracks]) => ({ frame, tracks: Object.fromEntries([...tracks].map(([track, key]) => [track, {
		...(key.q ? { q: key.q.map(keyQuaternion) } : {}), ...(key.p ? { p: keyVector(key.p) } : {}),
		...(key.baseQ ? { baseQ: key.baseQ.map(keyQuaternion) } : {}), ...(key.basePos ? { basePos: keyVector(key.basePos) } : {}),
		...(key.chainP ? { chainP: key.chainP.map(keyVector) } : {}), ...(key.keepTranslations ? { keepTranslations: true } : {}),
		...(key.correctionRange ? { correctionRange: { start: key.correctionRange.start, end: key.correctionRange.end } } : {}),
		...(key.blend != null ? { blend: key.blend } : {}),
		...(key.pin ? { pin: key.pin } : {}),
		...(key.fix ? { fix: { ...key.fix } } : {}),
	}])) }));
}
function decodeMotionKeys(rows) {
	const q = value => new THREE.Quaternion(value.x, value.y, value.z, value.w).normalize();
	const p = value => new THREE.Vector3(value.x, value.y, value.z);
	return new Map(rows.map(row => [row.frame, new Map(Object.entries(row.tracks).map(([track, key]) => [track, {
		q: key.q?.map(q) ?? null, p: key.p ? p(key.p) : null,
		...(key.baseQ ? { baseQ: key.baseQ.map(q) } : {}), ...(key.basePos ? { basePos: p(key.basePos) } : {}),
		...(key.chainP ? { chainP: key.chainP.map(p) } : {}), ...(key.keepTranslations ? { keepTranslations: true } : {}),
		...(key.correctionRange ? { correctionRange: { start: key.correctionRange.start, end: key.correctionRange.end } } : {}),
		...(key.blend != null ? { blend: key.blend } : {}),
		...(key.pin ? { pin: key.pin } : {}),
		...(key.fix ? { fix: { ...key.fix } } : {}),
	}]))]));
}
function cloneRangePin(pin) {
	return {
		...pin,
		target: pin.target.space === "world"
			? { space: "world", position: [...pin.target.position] }
			: { space: "object", objectId: pin.target.objectId, local: [...pin.target.local] },
	};
}
function encodeRangePins(pins) {
	return [...(pins instanceof Map ? pins.values() : pins ?? [])].map(cloneRangePin);
}
function decodeRangePins(rows) {
	return new Map((rows ?? []).map((pin) => [pin.id, cloneRangePin(pin)]));
}
function encodeRangePinResiduals(values) {
	return [...(values instanceof Map ? values.entries() : values ?? [])].map(([id, entries]) => [id, (entries ?? []).map((entry) => ({ ...entry }))]);
}
function decodeRangePinResiduals(rows) {
	return new Map((rows ?? []).map(([id, entries]) => [id, (entries ?? []).map((entry) => ({ ...entry }))]));
}

export { sameMotionIntent, emptyMotionLayer, encodeMotionKeys, decodeMotionKeys, cloneRangePin, encodeRangePins, decodeRangePins, encodeRangePinResiduals, decodeRangePinResiduals };
