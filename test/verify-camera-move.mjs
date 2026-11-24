#!/usr/bin/env node
// The camera-move contract: interpolation reproduces its endpoints, an orbit
// stays on the arc instead of cutting the chord, and the classifier only
// claims a move the two framings geometrically prove.
import { PerspectiveCamera, Vector3 } from "three";
import {
	CAMERA_PRESETS,
	EASES,
	cameraMoveAt,
	cameraPresetFraming,
	captureFraming,
	classifyMove,
	easeInOut,
	interpolateFraming,
	moveSequencePhrase,
	moveSequenceSlate,
	moveSlate,
	shortestArc,
} from "../src/camera-move.js";
import {
	DEFAULT_SENSOR_FORMAT,
	FRAMING_PIVOT_Y,
	SENSOR_FORMATS,
	deriveShot,
	focalMmToFov,
	fovToFocalMm,
	usedSensorHeightMm,
} from "../src/shot.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

const SUBJECT = { x: 0, z: 0, rot: 180 }; // facing +z-ish per shot.js convention
const linear = (t) => t;

/** a framing at (r, azimuthDeg, height) aimed at the subject's framing pivot */
function framingAt(r, azimuthDeg, height, fovDeg = 40) {
	const az = (azimuthDeg * Math.PI) / 180;
	const pos = { x: SUBJECT.x + r * Math.sin(az), y: height, z: SUBJECT.z + r * Math.cos(az) };
	const dx = SUBJECT.x - pos.x;
	const dy = FRAMING_PIVOT_Y - pos.y;
	const dz = SUBJECT.z - pos.z;
	return captureFraming({
		pos,
		yaw: Math.atan2(-dx, -dz),
		pitch: Math.atan2(dy, Math.max(Math.hypot(dx, dz), 1e-6)),
		fovDeg,
	});
}

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// The YXZ camera convention defines the screen top even at a vertical aim.
{
	for (const pitch of [-Math.PI / 2, Math.PI / 2]) for (const yaw of [0, 0.7, -2]) for (const roll of [0, 90]) {
		const camera = new PerspectiveCamera();
		camera.rotation.set(pitch, yaw, roll * Math.PI / 180, "YXZ");
		const forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
		const up = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
		const expectedUp = roll ? new Vector3(-Math.cos(yaw), 0, Math.sin(yaw)) : new Vector3(Math.sign(pitch) * Math.sin(yaw), 0, Math.sign(pitch) * Math.cos(yaw));
		expect("pole camera has finite forward and yaw-defined up", forward.distanceTo(new Vector3(0, Math.sign(pitch), 0)) < 1e-10 && up.distanceTo(expectedUp) < 1e-10 && [...forward, ...up].every(Number.isFinite));
	}
	const a = { pos: { x: 0, y: 4, z: 0 }, yaw: 1, pitch: -Math.PI / 2, fovDeg: 40 };
	const b = { ...a, yaw: 0.3, pitch: -Math.PI / 3 };
	let previous = null;
	for (let frame = 0; frame <= 100; frame++) {
		const sample = cameraMoveAt([{ frame: 0, framing: a }, { frame: 100, framing: b }], SUBJECT, frame);
		const q = new PerspectiveCamera(); q.rotation.set(sample.pitch, sample.yaw, 0, "YXZ");
		expect("pole interpolation stays finite and continuous", [sample.pos.x, sample.pos.y, sample.pos.z, sample.yaw, sample.pitch].every(Number.isFinite) && (!previous || previous.angleTo(q.quaternion) < 0.03));
		previous = q.quaternion.clone();
	}
}

/* ----------------------------------------------------------- filmbacks --- */
{
	expect("fullFrame is the default sensor", DEFAULT_SENSOR_FORMAT === "fullFrame");
	expect("the four public sensor ids are stable", ["super16", "super35", "fullFrame", "65mm"].every((id) => SENSOR_FORMATS[id]?.id === id));
	expect("4:3 uses the full fullFrame height", near(usedSensorHeightMm("fullFrame", 4 / 3), 24));
	expect("16:9 crops fullFrame to 20.25mm high", near(usedSensorHeightMm("fullFrame", 16 / 9), 20.25));
	expect("2.39:1 crops fullFrame to width/aspect", near(usedSensorHeightMm("fullFrame", 2.39), 36 / 2.39));
	for (const sensorId of Object.keys(SENSOR_FORMATS)) {
		for (const aspectRatio of [1, 16 / 9, 2.39]) {
			const fov = focalMmToFov(35, sensorId, aspectRatio);
			expect(
				`${sensorId} ${aspectRatio}:1 focal/FOV round-trip`,
				near(fovToFocalMm(fov, sensorId, aspectRatio), 35, 1e-9),
			);
		}
	}
}

/* ------------------------------------------------ endpoints are exact --- */
{
	const a = framingAt(4, 10, 1.6);
	const b = framingAt(1.5, 55, 2.4, 28);
	const t0 = interpolateFraming(a, b, SUBJECT, 0, linear);
	const t1 = interpolateFraming(a, b, SUBJECT, 1, linear);
	expect(
		"t=0 reproduces framing A exactly",
		near(t0.pos.x, a.pos.x) && near(t0.pos.y, a.pos.y) && near(t0.pos.z, a.pos.z) && near(t0.yaw, a.yaw, 1e-9) && near(t0.pitch, a.pitch, 1e-9) && near(t0.fovDeg, a.fovDeg, 1e-9),
		JSON.stringify(t0),
	);
	expect(
		"t=1 reproduces framing B exactly",
		near(t1.pos.x, b.pos.x) && near(t1.pos.y, b.pos.y) && near(t1.pos.z, b.pos.z) && near(t1.yaw, b.yaw, 1e-9) && near(t1.pitch, b.pitch, 1e-9) && near(t1.fovDeg, b.fovDeg, 1e-9),
		JSON.stringify(t1),
	);
}

/* --------------------------------------- orbit walks the arc, not chord --- */
{
	const a = framingAt(3, 0, 1.6);
	const b = framingAt(3, 90, 1.6);
	const mid = interpolateFraming(a, b, SUBJECT, 0.5, linear);
	const midR = Math.hypot(mid.pos.x - SUBJECT.x, mid.pos.z - SUBJECT.z);
	expect("orbit midpoint keeps the full 3m radius", near(midR, 3, 1e-6), `r=${midR}`);
	// a straight lerp would cut to r = 3/sqrt(2) ≈ 2.12 and shove the lens at the subject
	const move = classifyMove(a, b, SUBJECT);
	expect("90° same-radius move classifies as orbit", move.id === "orbit", move.id);
	expect("orbit phrase reports the arc", /arcing 90 degrees/.test(move.phrase), move.phrase);
}

/* -------------------------------------------------- azimuth wraps short --- */
{
	expect("shortestArc wraps 170°->-170° to +20°", near(shortestArc((170 * Math.PI) / 180, (-170 * Math.PI) / 180) * (180 / Math.PI), 20, 1e-9));
	const a = framingAt(3, 170, 1.6);
	const b = framingAt(3, -170, 1.6);
	const mid = interpolateFraming(a, b, SUBJECT, 0.5, linear);
	const midAzDeg = (Math.atan2(mid.pos.x, mid.pos.z) * 180) / Math.PI;
	expect("interpolation crosses 180°, not the long way", near(Math.abs(midAzDeg), 180, 1e-6), `az=${midAzDeg}`);
}

/* ------------------------------------------------------- classification --- */
{
	const push = classifyMove(framingAt(4, 20, 1.6), framingAt(1.6, 20, 1.6), SUBJECT);
	expect("straight approach classifies as push-in", push.id === "push-in", push.id);
	expect("push-in phrase names both shot sizes", /from a .+ to a /.test(push.phrase), push.phrase);

	const pull = classifyMove(framingAt(1.6, 20, 1.6), framingAt(4, 20, 1.6), SUBJECT);
	expect("the reverse classifies as pull-out", pull.id === "pull-out", pull.id);

	const crane = classifyMove(framingAt(3, 20, 0.8), framingAt(3, 20, 2.8), SUBJECT);
	expect("vertical rise classifies as crane up", crane.id === "crane-up", crane.id);

	const still = classifyMove(framingAt(3, 20, 1.6), framingAt(3, 20, 1.6), SUBJECT);
	expect("identical framings classify as static", still.id === "static", still.id);
	expect("static phrase matches composePrompt's default", still.phrase === "static, locked-off shot", still.phrase);
}

/* ------------------------------------------------------------- pan/tilt --- */
{
	const a = framingAt(3, 0, 1.6);
	const b = { ...a, yaw: a.yaw + (25 * Math.PI) / 180 };
	const pan = classifyMove(a, b, SUBJECT);
	expect("rotation-only move classifies as a pan", pan.id === "pan-left", pan.id);
	const c = { ...a, pitch: a.pitch + (25 * Math.PI) / 180 };
	const tilt = classifyMove(a, c, SUBJECT);
	expect("pitch-only move classifies as a tilt up", tilt.id === "tilt-up", tilt.id);
}

/* ----------------------------------------------------------- dolly-zoom --- */
{
	// double the distance and double the focal length: the subject's screen
	// size holds while the background compresses — the textbook vertigo.
	const fovA = (focalMmToFov(35) * 180) / Math.PI;
	const fovB = (focalMmToFov(70) * 180) / Math.PI;
	const a = framingAt(2, 0, FRAMING_PIVOT_Y, fovA);
	const b = framingAt(4, 0, FRAMING_PIVOT_Y, fovB);
	const move = classifyMove(a, b, SUBJECT);
	expect("distance x2 + focal x2 classifies as dolly-zoom", move.id === "dolly-zoom", `${move.id} drift=${move.deltas.sizeDrift}`);
	expect("dolly-zoom kept subject size within drift budget", move.deltas.sizeDrift <= 0.15, `${move.deltas.sizeDrift}`);
}

/* -------------------------------------------------------------- zooming --- */
{
	const a = framingAt(3, 0, 1.6, (focalMmToFov(24) * 180) / Math.PI);
	const b = { ...a, fovDeg: (focalMmToFov(85) * 180) / Math.PI };
	const zoom = classifyMove(a, b, SUBJECT);
	expect("focal-only change classifies as zoom in", zoom.id === "zoom-in", zoom.id);
}

/* ---------------------------------------------------- lens interpolation --- */
{
	const a = framingAt(3, 0, 1.6, (focalMmToFov(20) * 180) / Math.PI);
	const b = framingAt(3, 0, 1.6, (focalMmToFov(80) * 180) / Math.PI);
	const mid = interpolateFraming(a, b, SUBJECT, 0.5, linear);
	const midMm = fovToFocalMm((mid.fovDeg * Math.PI) / 180);
	expect("lens interpolates in millimetres (20->80 mid is 50)", near(midMm, 50, 1e-6), `${midMm}mm`);
}

/* ---------------------------------------- cropped-filmback interpolation --- */
{
	const filmback = { sensorId: "super35", aspectRatio: 2.39 };
	const a = framingAt(3, 0, 1.6, (focalMmToFov(20, filmback.sensorId, filmback.aspectRatio) * 180) / Math.PI);
	const b = framingAt(3, 0, 1.6, (focalMmToFov(80, filmback.sensorId, filmback.aspectRatio) * 180) / Math.PI);
	const mid = interpolateFraming(a, b, SUBJECT, 0.5, linear, filmback);
	const midMm = fovToFocalMm((mid.fovDeg * Math.PI) / 180, filmback.sensorId, filmback.aspectRatio);
	expect("lens interpolation keeps one cropped filmback (20->80 mid is 50)", near(midMm, 50, 1e-6), `${midMm}mm`);
	const sameFovA = framingAt(3, 0, 1.6, 50);
	const sameFovB = framingAt(3, 0, 1.6, 25);
	const fullFrameZoom = classifyMove(sameFovA, sameFovB, SUBJECT, { sensorId: "fullFrame", aspectRatio: 16 / 9 });
	const super16Zoom = classifyMove(sameFovA, sameFovB, SUBJECT, { sensorId: "super16", aspectRatio: 2.39 });
	expect("filmback does not rename the same FOV zoom", fullFrameZoom.id === "zoom-in" && super16Zoom.id === fullFrameZoom.id, `${fullFrameZoom.id}/${super16Zoom.id}`);

	const storedFov = 45;
	const oldScreenFraction = deriveShot(a.pos, SUBJECT, (storedFov * Math.PI) / 180).screenFraction;
	const scopeShot = deriveShot(a.pos, SUBJECT, (storedFov * Math.PI) / 180, undefined, {
		sensorId: "fullFrame",
		aspectRatio: 2.39,
	});
	const old24mmGateFocal = 12 / Math.tan((storedFov * Math.PI) / 360);
	expect("a stored 2.39:1 shot keeps its authored vertical framing", near(scopeShot.screenFraction, oldScreenFraction, 1e-12));
	expect("2.39:1 reinterprets the lens against its cropped gate", !near(scopeShot.exactFocalMm, old24mmGateFocal, 1e-6));
}

/* ------------------------------------------------------------------ ease --- */
{
	expect("easeInOut pins both ends", near(easeInOut(0), 0) && near(easeInOut(1), 1));
	expect("easeInOut midpoint is halfway", near(easeInOut(0.5), 0.5));
	expect("easeInOut starts gently", easeInOut(0.1) < 0.1);
}

/* ----------------------------------------------------------------- slate --- */
{
	const move = classifyMove(framingAt(4, 20, 1.6), framingAt(1.6, 20, 1.6), SUBJECT);
	const slate = moveSlate(move);
	expect("move slate reads A → B · MOVE", /^[A-Z0-9 -]+ \d+MM → [A-Z0-9 -]+ \d+MM · PUSH-IN/.test(slate), slate);
}
/* --------------------------------------------- multi-key cameraMoveAt --- */
{
	const keys = [
		{ frame: 0, framing: framingAt(4, 0, 1.6) },
		{ frame: 40, framing: framingAt(4, 90, 1.6) },
		{ frame: 80, framing: framingAt(1.5, 90, 1.6) },
	];
	expect("no keys samples null", cameraMoveAt([], SUBJECT, 10) === null);
	const before = cameraMoveAt(keys, SUBJECT, -5);
	expect("before the first key holds its framing", near(before.pos.x, keys[0].framing.pos.x) && near(before.fovDeg, keys[0].framing.fovDeg, 1e-9));
	const after = cameraMoveAt(keys, SUBJECT, 200);
	expect("after the last key holds its framing", near(after.pos.x, keys[2].framing.pos.x) && near(after.fovDeg, keys[2].framing.fovDeg, 1e-9));
	const onKey = cameraMoveAt(keys, SUBJECT, 40);
	expect("landing on a key reproduces it exactly", near(onKey.pos.x, keys[1].framing.pos.x) && near(onKey.yaw, keys[1].framing.yaw, 1e-9));
	// frame 20 is half of segment 0→40 (azimuth 0→90 at r=4): the midpoint
	// stays on the arc, and frame 60 is half of segment 40→80 (radius 4→1.5).
	const mid0 = cameraMoveAt(keys, SUBJECT, 20);
	expect("first segment midpoint keeps the 4m arc", near(Math.hypot(mid0.pos.x - SUBJECT.x, mid0.pos.z - SUBJECT.z), 4, 1e-6), `r=${Math.hypot(mid0.pos.x, mid0.pos.z)}`);
	const mid1 = cameraMoveAt(keys, SUBJECT, 60);
	const midAz = (Math.atan2(mid1.pos.x - SUBJECT.x, mid1.pos.z - SUBJECT.z) * 180) / Math.PI;
	expect("second segment midpoint halves the radius, holds the azimuth",
		near(Math.hypot(mid1.pos.x - SUBJECT.x, mid1.pos.z - SUBJECT.z), 2.75, 1e-6) && near(midAz, 90, 1e-6),
		`r=${Math.hypot(mid1.pos.x, mid1.pos.z)} az=${midAz}`);
	const one = cameraMoveAt([keys[1]], SUBJECT, 999);
	expect("a single key holds everywhere", near(one.pos.x, keys[1].framing.pos.x));
}

/* ---------------------------------------------- sequence slate / phrase --- */
{
	const segs = [
		classifyMove(framingAt(4, 20, 1.6), framingAt(1.6, 20, 1.6), SUBJECT),
		classifyMove(framingAt(1.6, 20, 1.6), framingAt(3, 110, 1.6), SUBJECT),
	];
	expect("one segment renders exactly like moveSlate", moveSequenceSlate([segs[0]]) === moveSlate(segs[0]));
	const slate = moveSequenceSlate(segs);
	expect("sequence slate chains segments through the middle framing",
		/· PUSH-IN \(DOLLY IN\) → .+ · .+ → .+ \d+MM$/.test(slate), slate);
	const phrase = moveSequencePhrase(segs);
	expect("sequence phrase chains in time order", phrase.includes(", then ") && phrase.startsWith(segs[0].phrase), phrase);
	expect("one segment phrase is the segment phrase", moveSequencePhrase([segs[0]]) === segs[0].phrase);
}

/* ------------------------------------------------- camera presets --- */
{
	// A preset is only useful if the frame it builds actually holds the body it
	// was asked to hold, at both output ratios and for both shipped presets.
	const filmbacks = [
		{ label: "16:9", sensorId: DEFAULT_SENSOR_FORMAT, aspectRatio: 16 / 9 },
		{ label: "12:7", sensorId: DEFAULT_SENSOR_FORMAT, aspectRatio: 12 / 7 },
	];
	for (const id of Object.keys(CAMERA_PRESETS)) {
		const preset = CAMERA_PRESETS[id];
		for (const filmback of filmbacks) {
			const f = cameraPresetFraming(id, { x: 0, z: 0, height: 1.8 }, filmback);
			expect(`${id} @ ${filmback.label} builds a framing`, !!f);
			expect(`${id} @ ${filmback.label} stands at the preset height`, Math.abs(f.pos.y - preset.height) < 1e-9,
				`${f.pos.y} != ${preset.height}`);
			expect(`${id} @ ${filmback.label} keeps the preset focal length`, f.focalMm === preset.focalMm);
			// Azimuth is measured off +z the way framingAt does it above.
			const azDeg = (Math.atan2(f.pos.x, f.pos.z) * 180) / Math.PI;
			expect(`${id} @ ${filmback.label} sits at the preset azimuth`, Math.abs(azDeg - preset.azimuthDeg) < 1e-6,
				`${azDeg} != ${preset.azimuthDeg}`);
			// The subject must project to the requested fraction of frame height:
			// half the body subtends atan((h/2)/d) against half the vertical fov.
			const dist = Math.hypot(f.pos.x, f.pos.z);
			const halfFov = (f.fovDeg * Math.PI) / 360;
			const fraction = Math.atan((1.8 / 2) / dist) / halfFov;
			expect(`${id} @ ${filmback.label} frames the body at its subject fraction`,
				Math.abs(fraction - preset.subjectFraction) < 0.06, `${fraction.toFixed(3)} vs ${preset.subjectFraction}`);
			expect(`${id} @ ${filmback.label} leaves the whole body inside the frame`, fraction < 1,
				`body fills ${fraction.toFixed(3)} of the frame height`);
		}
	}
	// The interaction preset is the wider of the two: that is its whole purpose,
	// holding a tall prop and the ground under it beside the subject.
	const loco = cameraPresetFraming("mocapLocomotion", { x: 0, z: 0, height: 1.8 }, filmbacks[1]);
	const inter = cameraPresetFraming("mocapInteraction", { x: 0, z: 0, height: 1.8 }, filmbacks[1]);
	expect("the interaction preset is wider than the locomotion preset", inter.fovDeg > loco.fovDeg);
	// A 4 m prop standing 2 m from the subject still fits the interaction frame.
	const interDist = Math.hypot(inter.pos.x, inter.pos.z);
	const propHalfAngle = Math.atan((4 / 2) / Math.max(interDist - 2, 0.1));
	expect("a 4 m prop fits the interaction frame", propHalfAngle < (inter.fovDeg * Math.PI) / 360,
		`prop ${(propHalfAngle * 360 / Math.PI).toFixed(1)} deg vs fov ${inter.fovDeg.toFixed(1)} deg`);
	expect("an unknown preset id builds nothing", cameraPresetFraming("nope", { x: 0, z: 0 }, filmbacks[0]) === null);
}

// Cover outgoing easing and the legacy default.
{
 const keys = [0, 10, 20].map((frame, i) => ({ frame, framing: framingAt(2 + i, 0, 1.6), ease: "linear" }));
 const x = (frame) => cameraMoveAt(keys, SUBJECT, frame).pos.z;
 expect("linear segment midpoint", near(x(5), 2.5));
 expect("linear camera crosses the middle key at constant nonzero speed", near(x(10) - x(9), 0.1) && near(x(11) - x(10), 0.1));
 for (const frame of [1, 5, 9, 11, 15, 19]) {
  const plain = keys.map(({ ease, ...key }) => key), i = frame <= 10 ? 0 : 1;
  expect(`default easing matches legacy at ${frame}`, JSON.stringify(cameraMoveAt(plain, SUBJECT, frame)) === JSON.stringify(interpolateFraming(plain[i].framing, plain[i + 1].framing, SUBJECT, (frame - plain[i].frame) / 10, easeInOut)));
 }
 expect("unknown easing falls back", JSON.stringify(cameraMoveAt([{ ...keys[0], ease: "__proto__" }, ...keys.slice(1)], SUBJECT, 5)) === JSON.stringify(interpolateFraming(keys[0].framing, keys[1].framing, SUBJECT, 0.5, easeInOut)));
 for (const name of ["easeIn", "easeOut"]) {
  const values = Array.from({ length: 101 }, (_, i) => EASES[name](i / 100));
  expect(`${name} endpoints and monotonicity`, values[0] === 0 && values[100] === 1 && values.every ( (v, i) => i === 0 || v >= values[i - 1] ));
 }
}

if (failures > 0) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nAll camera-move checks passed");
