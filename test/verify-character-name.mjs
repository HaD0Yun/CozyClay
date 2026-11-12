#!/usr/bin/env node
// #1212: a character without a description has none, and its name comes from
// its model (plus a suffix from its id), never from an invented description.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCharacterEntry, createSceneStage, readSceneDocument } from "../src/scenes.js";
import { validateStudioCommand } from "../src/studio-agent-protocol.js";
import { arrangement } from "../src/studio-agent-commands.js";

const PLACEHOLDERS = ["a young woman in a tan coat", "a man in a dark coat", "a person"];

test("a character created without a subject carries no placeholder text", () => {
	const made = [createCharacterEntry({ id: "char-1" }, 0), createCharacterEntry({ id: "char-2", model: "x-bot-tpose" }, 1), createCharacterEntry(null, 2)];
	const legacy = createSceneStage({ showB: true, charA: {}, charB: {} }).characters;
	for (const entry of [...made, ...legacy]) {
		assert.ok(!PLACEHOLDERS.includes(entry.subject), `${entry.id} got an invented subject: ${JSON.stringify(entry.subject)}`);
		assert.equal(entry.subject, "", `${entry.id} has no subject`);
	}
	assert.equal(createCharacterEntry({ id: "char-1", subject: "Alex in a red scarf" }).subject, "Alex in a red scarf", "a typed subject is kept");
});

test("a stored scene whose character subject is a placeholder loads with no subject", () => {
	const stage = createSceneStage({ characters: PLACEHOLDERS.map((subject, i) => ({ id: `char-${i + 1}`, subject })) });
	assert.deepEqual(stage.characters.map((entry) => entry.subject), ["", "", ""]);
	const raw = JSON.stringify({ version: 5, activeSceneId: "s1", scenes: [{ id: "s1", name: "SCENE 01", objects: [], stage: { characters: [
		{ id: "char-a", model: "y-bot-tpose", subject: "a young woman in a tan coat" },
		{ id: "char-b", model: "x-bot-tpose", subject: "a man in a dark coat" },
		{ id: "char-3", model: "proxy-figure", subject: "a person" },
		{ id: "char-4", model: "y-bot-tpose", subject: "Mina, the courier" },
	] } }] });
	const loaded = readSceneDocument(raw).document.scenes[0].stage.characters;
	assert.deepEqual(loaded.map((entry) => entry.subject), ["", "", "", "Mina, the courier"]);
});

const state = (characters) => ({ host: { workspaceId: "w", documentEpoch: "d", sceneId: "s", sceneEpoch: "e" }, frame: 0, frameCount: 24, floorY: 0, activeCharacterId: characters[0].id,
	selectedShotId: null, objects: [], characters, shotDocument: { shots: [] }, camera: null, filmback: null, manual: false });
const ports = { bounds: ({ entity }) => ({ min: { x: entity.x - 0.25, y: entity.y ?? 0, z: entity.z - 0.15 }, max: { x: entity.x + 0.25, y: (entity.y ?? 0) + 1.8, z: entity.z + 0.15 } }) };

test("a reference by a model-built name resolves to that character", () => {
	const cast = [createCharacterEntry({ id: "char-1", model: "y-bot-tpose", x: 0, z: 0 }, 0), createCharacterEntry({ id: "char-2", model: "y-bot-tpose", x: 3, z: 0 }, 1)];
	const place = (relativeTo) => arrangement(validateStudioCommand({ name: "arrange_objects", args: { ops: [
		{ op: "create", source: { kind: "cube" }, name: "Crate", position: { relativeTo, basis: "world", side: "left", gapM: 0.5, support: "floor" } },
	] } }), state(cast), ports).draft.find((row) => row.name === "Crate");
	const nearOne = place("Y Bot 1"), nearTwo = place("Y Bot 2");
	assert.ok(nearOne.x < 0, `"Y Bot 1" resolves to char-1 at x 0 (crate x ${nearOne.x})`);
	assert.ok(nearTwo.x > 1, `"Y Bot 2" resolves to char-2 at x 3 (crate x ${nearTwo.x})`);
});
