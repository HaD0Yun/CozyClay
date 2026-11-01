#!/usr/bin/env node
// The relation list of inspect_studio scope "relations" (src/studio-relations.js, #1030).
import assert from "node:assert/strict";
import { studioRelations } from "../src/studio-relations.js";
import { encodeStudioContext } from "../src/studio-agent-context.js";
import { contextFixture } from "./verify-studio-agent-protocol.mjs";

const object = (id, name, x, y, z, w, h, d, extra = {}) => ({ id, name, renderer: "cube", x, y, z, rot: 0, rotX: 0, rotZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1, footprint: { width: w, depth: d }, height: h, ...extra });
const hero = { id: "char-a", subject: "Hero", x: 0, y: 0, z: 0, rot: 0 };
// A camera 10 m in front of the origin (+z), looking back at it: +x reads on the picture's right.
const state = (objects, over = {}) => ({ objects, characters: [hero], frame: 0, camera: { position: { x: 0, y: 1, z: 10 }, lookAt: { x: 0, y: 1, z: 0 }, focalMm: 18 }, filmback: { sensorId: "full-frame", aspectRatio: 16 / 9 }, ...over });
const ports = { bounds: ({ entity }) => ({ min: { x: entity.x - 0.3, y: 0, z: entity.z - 0.2 }, max: { x: entity.x + 0.3, y: 1.8, z: entity.z + 0.2 } }) };
const rows = (objects, over) => studioRelations(state(objects, over), ports);
const sensor = (await import("../src/shot.js")).SENSOR_FORMATS;
const sensorId = Object.keys(sensor)[0];
const at = (objects, over = {}) => rows(objects, { filmback: { sensorId, aspectRatio: 16 / 9 }, ...over });
const has = (r, pattern) => r.relations.some(line => pattern.test(line));

const empty = at([]);
assert.ok(has(empty, /^Hero#char-a IN_FRAME 1\.00 height 0\.\d+$/), empty.relations.join("|"));
assert.deepEqual(empty.characters[0], { id: "char-a", bounds: { min: { x: -0.3, y: 0, z: -0.2 }, max: { x: 0.3, y: 1.8, z: 0.2 } } }, "characters carry world bounds");
assert.deepEqual(empty.camera.inFrame, ["char-a"]);

const onTable = at([object("table", "Table", 1.5, 0, 0, 1, 0.8, 1), object("lamp", "Lamp", 1.5, 0.8, 0, 0.2, 0.4, 0.2)]);
assert.ok(has(onTable, /^Lamp#lamp ON Table#table$/), onTable.relations.join("|"));
assert.ok(!has(onTable, /Table#table ON/), "the floor is no row");
const floating = at([object("table", "Table", 1.5, 0, 0, 1, 0.8, 1), object("lamp", "Lamp", 1.5, 1.2, 0, 0.2, 0.4, 0.2)]);
assert.ok(!has(floating, / ON /), "a gap is not support");

const pillar = at([object("pillar", "Pillar", 0, 0, 2, 2, 3, 0.2)]);
assert.ok(has(pillar, /^Hero#char-a OCCLUDED_BY Pillar#pillar 100%$/), pillar.relations.join("|"));
assert.ok(pillar.relations[0].includes("OCCLUDED_BY"), "occlusion reads first");
const partial = at([object("pillar", "Pillar", 0.3, 0, 2, 0.3, 3, 0.2)]);
const share = Number(/OCCLUDED_BY Pillar#pillar (\d+)%/.exec(partial.relations.join("|"))?.[1]);
assert.ok(share > 0 && share < 100, `a thin pillar hides part: ${partial.relations.join("|")}`);
assert.ok(!has(at([object("wall", "Wall", 0, 0, -2, 4, 3, 0.2)]), /OCCLUDED_BY/), "a wall behind the character hides nothing");
assert.ok(!has(at([object("room", "Room", 0, 0, 0, 30, 10, 30)]), /OCCLUDED_BY/), "a set the camera stands inside hides nothing");
assert.ok(!has(at([object("hat", "Hat", 0, 0, 2, 2, 3, 0.2, { attach: { characterId: "char-a" } })]), /OCCLUDED_BY/), "what it wears does not hide it");
assert.ok(!has(at([object("ghost", "Ghost", 0, 0, 2, 2, 3, 0.2, { hidden: true })]), /Ghost/), "a hidden object is no row");

const sides = at([object("left", "L", -1.5, 0, 0, 0.5, 1, 0.5), object("right", "R", 1.5, 0, 0, 0.5, 1, 0.5)]);
assert.ok(has(sides, /^L#left LEFT_OF Hero#char-a$/) && has(sides, /^R#right RIGHT_OF Hero#char-a$/), sides.relations.join("|"));
assert.ok(has(at([object("near", "N", 0.8, 0, 0, 0.5, 1, 0.5)]), /^N#near NEAR Hero#char-a 0\.25m$/), "the gap between boxes");
assert.ok(!has(at([object("far", "F", 3, 0, 0, 0.5, 1, 0.5)]), /NEAR/), "far things are not near");

const away = at([], { camera: { position: { x: 0, y: 1, z: 10 }, lookAt: { x: 0, y: 1, z: 20 }, focalMm: 18 } });
assert.ok(has(away, /^Hero#char-a OUT_OF_FRAME$/) && away.camera.outOfFrame.includes("char-a") && !away.camera.inFrame.length, away.relations.join("|"));
const lens = at([], { camera: { position: { x: 0, y: 1, z: 0.25 }, lookAt: { x: 0, y: 1, z: 20 }, focalMm: 18 } });
assert.ok(!has(lens, /IN_FRAME 0\.00/), lens.relations.join("|"));
const none = at([object("lamp", "Lamp", 1, 0, 0, 1, 1, 1)], { camera: null });
assert.equal(none.camera, null, "no camera, no framing rows");
assert.ok(!has(none, /IN_FRAME|LEFT_OF/));
const many = at(Array.from({ length: 80 }, (_, i) => object(`o${i}`, `O${i}`, -2 + (i % 9) * 0.5, 0, 0.5 * (i % 3), 0.2, 0.2, 0.2)));
assert.equal(many.relations.length, 40, "rows are capped");
assert.ok(many.truncated > 0, "and say how many were left out");

// ---- it rides in the turn's context while it fits ----
const c = contextFixture(), plain = encodeStudioContext(c);
assert.equal(encodeStudioContext(c, { relations: null }), plain, "no relations, the same context");
assert.match(encodeStudioContext(c, { relations: { rows: ["a<b ON c"] } }), /"relations":\{"rows":\["a\\u003cb ON c"\]\}/, "escaped like the rest");
assert.equal(encodeStudioContext(c, { relations: { rows: ["x".repeat(4_000_000)] } }), plain, "too large: the context goes without, it never fails");
console.log("PASS studio relations");
