// Route sketch geometry and timeline note records (pure): a stroke becomes at
// most 64 Douglas-Peucker points with the first on the character's feet; the
// walk pins it at a constant 1.4 m/s; a note defaults to the pin ±12 frames,
// clamped to the clip, and survives the scene's layer normalization.
import assert from "node:assert/strict";
import { ROUTE_MAX_POINTS, routeFromStroke, walkWaypoints } from "../src/route-sketch.js";
import { NOTE_HALF_RANGE, clampNoteRange, createTimelineNote, normalizeTimelineNotes, noteStillFrames } from "../src/timeline-notes.js";
import { createCharacterEntry } from "../src/scenes.js";

// A dense wavy stroke, 600 samples over ~12 m.
const stroke = Array.from({ length: 600 }, (_, i) => ({ x: 0.3 + i * 0.02, z: Math.sin(i / 25) * 1.5 }));
const route = routeFromStroke(stroke, { x: 0, z: 0 });
assert.ok(route.points.length <= ROUTE_MAX_POINTS && route.points.length > 4, `simplified to ${route.points.length} points`);
assert.deepEqual(route.points[0], { x: 0, z: 0 }, "the first point snaps to the character");
assert.deepEqual(route.points.at(-1), { x: Math.round(stroke.at(-1).x * 100) / 100, z: Math.round(stroke.at(-1).z * 100) / 100 }, "the stroke's end is kept");
assert.ok(route.lengthM > 12 && route.lengthM < 40, `length ${route.lengthM}`);
assert.equal(routeFromStroke([{ x: 0, z: 0 }, { x: 0.05, z: 0 }], { x: 0, z: 0 }), null, "a tap is no route");

const pins = walkWaypoints(route.points, { fps: 24, maxPins: 32 });
assert.ok(pins.length >= 2 && pins.length <= 32);
let previous = { frame: 0, ...route.points[0] }, walked = 0;
for (const pin of pins) {
	walked += Math.hypot(pin.x - previous.x, pin.z - previous.z);
	// Constant speed: every pin's frame is the metres walked to it at 1.4 m/s, to the nearest frame.
	assert.ok(Math.abs(pin.frame - (walked / 1.4) * 24) <= 0.5, `pin at frame ${pin.frame} after ${walked.toFixed(2)} m`);
	assert.ok(pin.frame - previous.frame >= 8, "pins keep the root path's 8-frame gap");
	previous = pin;
}
assert.deepEqual([pins.at(-1).x, pins.at(-1).z], [route.points.at(-1).x, route.points.at(-1).z], "the walk ends where the route does");

const note = createTimelineNote({ id: "note-1", frame: 42, frameCount: 240 });
assert.deepEqual([note.frameStart, note.frame, note.frameEnd, note.bone], [42 - NOTE_HALF_RANGE, 42, 42 + NOTE_HALF_RANGE, null]);
assert.deepEqual(createTimelineNote({ id: "n", frame: 3, frameCount: 240 }), { id: "n", frame: 3, frameStart: 0, frameEnd: 15, bone: null, takeId: null }, "clamped at the start");
assert.deepEqual(clampNoteRange(230, 220, 400, 240), { frameStart: 220, frameEnd: 239 }, "clamped at the end");
assert.deepEqual(clampNoteRange(50, 60, 40, 240), { frameStart: 50, frameEnd: 50 }, "a range always holds its pin");
assert.deepEqual(noteStillFrames(2, 240), [0, 2, 8]);
assert.deepEqual(normalizeTimelineNotes([note, note, { id: "", frame: 1 }, null]), [note], "duplicates and junk are dropped");

const kept = createCharacterEntry({ id: "c", layer: { waypoints: [], notes: [{ ...note, bone: "lArm" }] } });
assert.equal(kept.layer.notes[0].bone, "lArm", "notes survive the character normalizer (save and load)");
assert.equal("notes" in createCharacterEntry({ id: "c", layer: { waypoints: [] } }).layer, false, "a layer without notes stays as it was");
console.log("PASS route sketch: <=64 points snapped to the feet, 1.4 m/s walk pins; notes default ±12 clamped and persist through the layer");
