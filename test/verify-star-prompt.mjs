#!/usr/bin/env node
/**
 * The per-version star question at launch (#900), without a terminal, gh, or the network.
 *
 * gh, the question, the star count and the browser are injected, and every call is
 * recorded, so each case proves both what happened and what did not: a declined
 * question never stars, an account that already starred is never asked again, an
 * update asks again, and the guards stop before gh is even run.
 */

import assert from "node:assert/strict";

import { maybeAskForStar } from "../bin/star-prompt.mjs";

function pass(message) {
	console.log(`PASS ${message}`);
}

const STARRED = "/user/starred/HaD0Yun/CozyClay";
const VERSION = "9.9.9";

/** One run of the prompt with fakes; returns everything it touched. */
async function run({ opts = { star: true }, env = {}, interactive = true, elapsed = 120_000, state = {}, ghResults = {}, answer = "", version = VERSION } = {}) {
	const calls = { gh: [], ask: [], open: [], log: [], writes: [] };
	const store = { ...state };
	await maybeAskForStar(opts, {
		readState: () => store,
		writeState: (patch) => {
			calls.writes.push(patch);
			Object.assign(store, patch);
		},
		version,
		env,
		interactive,
		now: () => elapsed,
		gh: async (args) => {
			calls.gh.push(args.join(" "));
			return ghResults[args.join(" ")] ?? false;
		},
		ask: async (question) => {
			calls.ask.push(question);
			return answer;
		},
		stars: async () => 42,
		open: (url) => calls.open.push(url),
		log: (line) => calls.log.push(line),
	});
	return { calls, store };
}

const signedIn = { "auth status": true };
const starPut = `api --method PUT ${STARRED} --silent`;

{
	const { calls, store } = await run({ ghResults: { ...signedIn, [starPut]: true }, answer: "y" });
	assert.deepEqual(calls.gh, ["auth status", `api ${STARRED} --silent`, starPut]);
	assert.equal(calls.ask.length, 1);
	assert.match(calls.ask[0], /\[y\/N\]/);
	assert.match(calls.ask[0], /42 so far/);
	assert.deepEqual(calls.open, []);
	assert.match(calls.log.at(-1), /^Starred HaD0Yun\/CozyClay/);
	assert.ok(store.starredAt);
	assert.equal(store.starPromptedVersion, VERSION);
	pass("signed-in gh: y stars the repo through gh and opens no browser");
}

for (const answer of ["", "n", "no", "nah"]) {
	const { calls } = await run({ ghResults: { ...signedIn, [starPut]: true }, answer });
	assert.ok(!calls.gh.includes(starPut), `answer ${JSON.stringify(answer)} must not star`);
	assert.deepEqual(calls.open, []);
}
pass("signed-in gh: anything but y/yes (Enter included) stars nothing and opens nothing");

{
	const { calls, store } = await run({ ghResults: { ...signedIn, [`api ${STARRED} --silent`]: true }, answer: "y" });
	assert.equal(calls.ask.length, 0);
	assert.ok(!calls.gh.includes(starPut));
	assert.ok(store.starredAt);
	pass("an account that already starred the repo is not asked, and is not asked again");
}

{
	const { calls } = await run({ ghResults: signedIn, answer: "yes" });
	assert.ok(calls.gh.includes(starPut));
	assert.deepEqual(calls.open, ["https://github.com/HaD0Yun/CozyClay"]);
	pass("a star gh refuses falls back to opening the repo");
}

{
	const { calls } = await run({ answer: "" });
	assert.deepEqual(calls.gh, ["auth status"]);
	assert.match(calls.ask[0], /Open GitHub\? \[Y\/n\]/);
	assert.deepEqual(calls.open, ["https://github.com/HaD0Yun/CozyClay"]);
	const declined = await run({ answer: "n" });
	assert.deepEqual(declined.calls.open, []);
	pass("without a signed-in gh the browser prompt is unchanged");
}

const guards = [
	["--no-star", { opts: { star: false } }],
	["CI", { env: { CI: "1" } }],
	["COZYCLAY_NO_STAR", { env: { COZYCLAY_NO_STAR: "1" } }],
	["no terminal", { interactive: false }],
	["an earlier prompt for this version", { state: { starPromptedVersion: VERSION } }],
	["a confirmed star", { state: { starredAt: "2026-01-01T00:00:00.000Z" } }],
];
for (const [name, overrides] of guards) {
	const { calls } = await run({ ghResults: { ...signedIn, [starPut]: true }, answer: "y", ...overrides });
	assert.deepEqual(calls.gh, [], `${name}: gh must not run`);
	assert.deepEqual(calls.ask, [], `${name}: nothing is asked`);
	assert.deepEqual(calls.writes, [], `${name}: state is untouched`);
}
pass(`guards stop before gh runs: ${guards.map(([name]) => name).join(", ")}`);

{
	const { calls, store } = await run({ state: { starPromptedVersion: "0.0.1" }, ghResults: { ...signedIn, [starPut]: true }, answer: "y" });
	assert.equal(calls.ask.length, 1);
	assert.equal(store.starPromptedVersion, VERSION);
	pass("an update asks again, even after a decline on the previous version");
}

console.log("star prompt verification passed");
