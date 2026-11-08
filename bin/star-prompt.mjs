/**
 * The "star the repo" question, asked once per release, right after install (#900).
 *
 * With the GitHub CLI installed and signed in, a "y" stars the repo through `gh` on
 * the spot: no browser hop, which is where most people who meant to star it got lost.
 * Without gh, a "yes" opens the repo page as before. Asked once per version per
 * machine — so an update asks again — never in CI or without a terminal, and never
 * again to an account gh confirms has starred it. Every failure here is silent:
 * the studio is already open by the time the question appears in the terminal.
 */
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { openBrowser } from "./open-browser.mjs";

const REPO = "HaD0Yun/CozyClay";
const REPO_URL = `https://github.com/${REPO}`;
const STARRED_PATH = `/user/starred/${REPO}`;
const ANSWER_TIMEOUT_MS = 12_000;

/** Runs gh and resolves true on exit 0. No gh on PATH, a timeout or an error status is false. */
function runGh(args) {
	return new Promise((resolve) => {
		try {
			execFile("gh", args, {
				timeout: 4000,
				windowsHide: true,
				env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
			}, (error) => resolve(!error));
		} catch {
			resolve(false);
		}
	});
}

async function starCount() {
	try {
		const res = await fetch(`https://api.github.com/repos/${REPO}`, {
			headers: { accept: "application/vnd.github+json" },
			signal: AbortSignal.timeout(2500),
		});
		if (!res.ok) return null;
		const body = await res.json();
		return Number.isInteger(body?.stargazers_count) ? body.stargazers_count : null;
	} catch {
		return null;
	}
}

function askLine(question) {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((done) => {
		const timer = setTimeout(() => {
			rl.close();
			done("");
		}, ANSWER_TIMEOUT_MS);
		rl.question(question, (answer) => {
			clearTimeout(timer);
			rl.close();
			done(answer);
		});
	});
}

/**
 * Asked once per version per machine, right after install: an update asks again,
 * an account gh confirms as starred is never asked again. A CLI that nags on
 * every run is worse than one that never asks. Everything after `state` is injectable
 * so the test can drive it without a terminal, gh, or the network.
 */
export async function maybeAskForStar(opts, {
	readState,
	writeState,
	version = "",
	env = process.env,
	interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
	now = Date.now,
	gh = runGh,
	ask = askLine,
	stars = starCount,
	open = openBrowser,
	log = console.log,
}) {
	if (!opts.star) return;
	if (env.CI || env.COZYCLAY_NO_STAR) return;
	if (!interactive) return;
	const state = readState();
	if (state.starredAt) return;
	if (version && state.starPromptedVersion === version) return;

	const promptedAt = new Date(now()).toISOString();
	const viaGh = await gh(["auth", "status"]);
	// GET /user/starred/<repo> answers 204 for a starred repo and 404 otherwise.
	if (viaGh && await gh(["api", STARRED_PATH, "--silent"])) {
		writeState({ starredAt: promptedAt, starPromptedVersion: version });
		return;
	}
	writeState({ starPromptedVersion: version });
	const count = await stars();
	const tally = count === null ? "" : ` (${count} so far)`;

	if (viaGh) {
		const answer = await ask(`\nWas CozyClay any good? A star helps people find it${tally}. Star ${REPO} with your gh account? [y/N] `);
		if (!/^y(es)?$/i.test(answer.trim())) {
			log(`No problem. ${REPO_URL} if you change your mind.`);
			return;
		}
		if (await gh(["api", "--method", "PUT", STARRED_PATH, "--silent"])) {
			writeState({ starredAt: promptedAt });
			log(`Starred ${REPO}. Thank you!`);
			return;
		}
		log("gh could not star it, so opening the repo instead.");
		open(REPO_URL);
		return;
	}

	const answer = await ask(`\nWas CozyClay any good? A star helps people find it${tally}. Open GitHub? [Y/n] `);
	if (/^(y|yes|)$/i.test(answer.trim())) {
		open(REPO_URL);
		log("Thanks. Opening the repo.");
	} else {
		log(`Fair enough. ${REPO_URL} if you change your mind.`);
	}
}
