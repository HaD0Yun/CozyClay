// Aim recording's feel: slower than the Studio's look by default, the user's own
// setting in this browser, and a smoothing filter whose time constant and lag
// are what the panel says.
import assert from "node:assert/strict";
import { RAIL_AIM_FEEL, aimRadiansPerPixel, readRailAimFeel, smoothAim, writeRailAimFeel } from "../src/rail-aim-feel.js";

const DEG = Math.PI / 180;
const memory = () => { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), map }; };

// The numbers: the old recorder and the Studio's right-drag look/walk camera turn 0.0032 rad/px.
const LOOK = 0.0032, perHundred = radians => radians * 100 / DEG;
assert.ok(Math.abs(perHundred(LOOK) - 18.33) < 0.01, "old default: 18.3 degrees per 100 px");
const fresh = readRailAimFeel(memory());
assert.deepEqual(fresh, { sensitivity: 7, smoothing: 0.2 }, "defaults when nothing is stored");
assert.ok(Math.abs(perHundred(aimRadiansPerPixel(fresh)) - 7) < 1e-9, "new default: 7 degrees per 100 px");
assert.ok(aimRadiansPerPixel(fresh) < LOOK / 2.5, "the default reacts clearly slower than before (2.6x)");
assert.ok(RAIL_AIM_FEEL.sensitivity.min <= 1 && RAIL_AIM_FEEL.sensitivity.max >= 2 * perHundred(LOOK), "the range spans far below and past the old speed");

// The user's own setting: kept across a reload, bounded, unreadable bytes give the defaults.
const storage = memory();
writeRailAimFeel({ sensitivity: 12.5, smoothing: 0.45 }, storage);
assert.deepEqual(readRailAimFeel(storage), { sensitivity: 12.5, smoothing: 0.45 }, "a reload reads the setting back");
writeRailAimFeel({ sensitivity: 400, smoothing: -3 }, storage);
assert.deepEqual(readRailAimFeel(storage), { sensitivity: RAIL_AIM_FEEL.sensitivity.max, smoothing: 0 }, "out-of-range values are bounded");
storage.setItem("cozyclay.railAimFeel", "{not json");
assert.deepEqual(readRailAimFeel(storage), fresh, "unreadable bytes fall back to the defaults");
assert.doesNotThrow(() => writeRailAimFeel(fresh, { setItem() { throw new Error("quota"); } }), "a full storage never breaks recording");

// The filter: first order on production time. Smoothing 0 is the raw mouse.
assert.deepEqual(smoothAim({ yaw: 0, pitch: 0 }, { yaw: 1, pitch: -0.5 }, 1 / 24, 0), { yaw: 1, pitch: -0.5 });
assert.deepEqual(smoothAim({ yaw: 0, pitch: 0 }, { yaw: 1, pitch: 0 }, 0, 0.2), { yaw: 0, pitch: 0 }, "no production time, no change");
// a step: 63 % after one time constant, 95 % after three, whatever the frame rate
for (const fps of [25, 30, 60]) {
	let shown = { yaw: 0, pitch: 0 };
	const steps = Math.round(0.2 * fps);
	for (let i = 0; i < steps; i += 1) shown = smoothAim(shown, { yaw: 1, pitch: 0 }, 1 / fps, 0.2);
	assert.ok(Math.abs(shown.yaw - (1 - Math.exp(-steps / fps / 0.2))) < 1e-12 && Math.abs(shown.yaw - 0.632) < 0.01, `${fps} fps: 63 % at one time constant`);
}
// a steady pan (the hand moving at a constant speed) comes out at the same speed, 0.2 s late
let shown = { yaw: 0, pitch: 0 }, last = 0;
const speed = 30 * DEG; // per second
for (let frame = 1; frame <= 96; frame += 1) { last = shown.yaw; shown = smoothAim(shown, { yaw: speed * frame / 24, pitch: 0 }, 1 / 24, 0.2); }
const lagSeconds = (speed * 96 / 24 - shown.yaw) / speed;
assert.ok(Math.abs((shown.yaw - last) * 24 - speed) < 0.001, "a steady pan keeps its speed");
assert.ok(Math.abs(lagSeconds - 0.2) < 0.03, `the lag is about one time constant: ${lagSeconds.toFixed(3)} s`);

console.log(`PASS rail aim feel: old 18.3 deg/100 px, new default 7 deg/100 px, range ${RAIL_AIM_FEEL.sensitivity.min}-${RAIL_AIM_FEEL.sensitivity.max}; smoothing 0.2 s time constant, ${lagSeconds.toFixed(3)} s lag on a steady pan at 24 fps; stored per browser`);
