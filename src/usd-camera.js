// Dependency-free UsdGeomCamera export. USDA is text; keeping the writer here
// makes every unit, axis and time-sampling decision visible in review.

import { shotMetadata } from "./otio.js";
import { sampleAt } from "./sample-at.js";
import { DEFAULT_ASPECT_RATIO, DEFAULT_SENSOR_FORMAT, SENSOR_FORMATS } from "./shot.js";

const MILLIMETRES_PER_TENTH_METRE = 100;

function finite(value, label) {
	if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
	return value;
}

function number(value) {
	const clean = Math.abs(finite(value, "USD number")) < 1e-12 ? 0 : value;
	return Number(clean.toPrecision(15)).toString();
}

function tuple(values) {
	return `(${values.map(number).join(", ")})`;
}

function quoted(value) {
	return JSON.stringify(String(value));
}

function samplesBlock(samples, valueAt) {
	return samples
		.map((sample) => `        ${sample.frame}: ${valueAt(sample)},`)
		.join("\n");
}

function checkedCamera(sampled, requestedFrame) {
	if (sampled.frame !== requestedFrame) {
		throw new RangeError(`Camera frame ${requestedFrame} is outside the scene range`);
	}
	const camera = sampled.camera;
	if (!camera?.pos) throw new Error(`Shot has no camera at frame ${requestedFrame}`);
	finite(camera.pos.x, `Camera x at frame ${requestedFrame}`);
	finite(camera.pos.y, `Camera y at frame ${requestedFrame}`);
	finite(camera.pos.z, `Camera z at frame ${requestedFrame}`);
	finite(camera.yaw, `Camera yaw at frame ${requestedFrame}`);
	finite(camera.pitch, `Camera pitch at frame ${requestedFrame}`);
	finite(camera.focalMm, `Camera focalMm at frame ${requestedFrame}`);
	return camera;
}

function cameraSamples(scene, shot, startFrame, endFrame) {
	const samples = [];
	for (let frame = startFrame; frame <= endFrame; frame += 1) {
		samples.push({ frame, camera: checkedCamera(sampleAt(scene, shot, frame), frame) });
	}
	return samples;
}

function aperturesMm(scene, metadata) {
	const aspectRatio = Number.isFinite(scene.filmback?.aspectRatio) && scene.filmback.aspectRatio > 0
		? scene.filmback.aspectRatio
		: DEFAULT_ASPECT_RATIO;
	const sensor = SENSOR_FORMATS[metadata.lens.sensorId]
		?? SENSOR_FORMATS[DEFAULT_SENSOR_FORMAT];
	const vertical = finite(metadata.lens.verticalApertureMm, "verticalApertureMm");
	// shotMetadata names the used VERTICAL gate. Rebuild the horizontal gate
	// from the output aspect and cap it at the physical sensor width.
	const horizontal = Math.min(sensor.widthMm, vertical * aspectRatio);
	return { horizontal, vertical };
}

/**
 * Serialize one inclusive Shot range as an animated UsdGeomCamera.
 *
 * CozyClay and USD cameras are both right-handed, Y-up and look down local
 * -Z. Three's YXZ Euler composes as qY(yaw) * qX(pitch); exporting that result
 * as one quaternion avoids USD Euler packing's different composition order.
 */
export function serializeUsdCamera(scene, shot) {
	const source = scene && typeof scene === "object" ? scene : {};
	const metadata = shotMetadata(source, shot);
	const { startFrame, endFrame, fps } = metadata.range;
	const samples = cameraSamples(source, shot, startFrame, endFrame);
	const first = samples[0];
	const aperture = aperturesMm(source, metadata);
	const toUsdOpticalUnit = (millimetres) => millimetres / MILLIMETRES_PER_TENTH_METRE;
	const translation = ({ camera }) => tuple([camera.pos.x, camera.pos.y, camera.pos.z]);
	const orientation = ({ camera }) => {
		const halfPitch = camera.pitch / 2;
		const halfYaw = camera.yaw / 2;
		const sinPitch = Math.sin(halfPitch);
		const cosPitch = Math.cos(halfPitch);
		const sinYaw = Math.sin(halfYaw);
		const cosYaw = Math.cos(halfYaw);
		// USDA quaternion tuples are (real, i, j, k). For Three's YXZ,
		// qY * qX = (cy*cp, cy*sp, sy*cp, -sy*sp), then times the roll qZ.
		const [w, x, y, z] = [cosYaw * cosPitch, cosYaw * sinPitch, sinYaw * cosPitch, -sinYaw * sinPitch];
		const halfRoll = ((camera.rollDeg ?? 0) * Math.PI) / 360;
		const [cosRoll, sinRoll] = [Math.cos(halfRoll), Math.sin(halfRoll)];
		return tuple([w * cosRoll - z * sinRoll, x * cosRoll + y * sinRoll, y * cosRoll - x * sinRoll, w * sinRoll + z * cosRoll]);
	};
	const focalMm = ({ camera }) => number(camera.focalMm);
	const focalUsd = ({ camera }) => number(toUsdOpticalUnit(camera.focalMm));

	return `#usda 1.0
(
    defaultPrim = "Camera"
    metersPerUnit = 1
    upAxis = "Y"
    timeCodesPerSecond = ${number(fps)}
    startTimeCode = ${number(startFrame)}
    endTimeCode = ${number(endFrame)}
)

# UsdGeomCamera optical lengths are tenths of a stage unit. On this metre
# stage the schema values are millimetres / 100; cozyclay:*Mm records the
# authored millimetres explicitly.
def Camera "Camera"
{
    custom float cozyclay:focalLengthMm = ${focalMm(first)}
    custom float cozyclay:focalLengthMm.timeSamples = {
${samplesBlock(samples, focalMm)}
    }
    custom float cozyclay:horizontalApertureMm = ${number(aperture.horizontal)}
    custom string cozyclay:sensorId = ${quoted(metadata.lens.sensorId)}
    custom float cozyclay:verticalApertureMm = ${number(aperture.vertical)}
    float focalLength = ${focalUsd(first)}
    float focalLength.timeSamples = {
${samplesBlock(samples, focalUsd)}
    }
    float horizontalAperture = ${number(toUsdOpticalUnit(aperture.horizontal))}
    token projection = "perspective"
    float verticalAperture = ${number(toUsdOpticalUnit(aperture.vertical))}
    quatf xformOp:orient = ${orientation(first)}
    quatf xformOp:orient.timeSamples = {
${samplesBlock(samples, orientation)}
    }
    double3 xformOp:translate = ${translation(first)}
    double3 xformOp:translate.timeSamples = {
${samplesBlock(samples, translation)}
    }
    uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:orient"]
}
`;
}
