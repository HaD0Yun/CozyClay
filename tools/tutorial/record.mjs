#!/usr/bin/env node
// Records one tutorial episode: optional voice clips first (voice.mjs), then
// one continuous capture over CDP (steps.mjs runs each step, the page carries
// the cursor and teaching overlays), then captions in a band under the frame
// and the mux (mux.mjs). A chaptered episode is also cut into one file per
// chapter. Run it through tools/tutorial/launch.mjs (npm run tutorial:record
// -- <episode>) or inside tools/qa-browser.mjs with QA_URL pointing at a dev
// server. See tools/tutorial/README.md.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { encode, findFfmpeg } from "./assemble.mjs";
import { renderCaptions } from "./captions.mjs";
import { connectPage } from "./cdp.mjs";
import { createInput } from "./cursor.mjs";
import { DEFAULT_WPS, actionOf, chapterFileName, normalizeEpisode, stepHoldMs, toSrt, validateEpisode } from "./episode.mjs";
import { bandHeightFor, chapterCutArgs, muxArgs } from "./mux.mjs";
import { TEACHING_OVERLAY } from "./overlay.mjs";
import { localeScript, openStudio, runStep } from "./steps.mjs";
import { TERMINAL_URL } from "./terminal.mjs";
import { prepareVoice } from "./voice.mjs";

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(0, ms)));

function parseArgs(argv) {
	const options = { episode: null, locale: "en", size: "1600x1000", "wps-ko": DEFAULT_WPS.ko, "wps-en": DEFAULT_WPS.en, voice: "off", fps: 30, out: "dist/tutorial" };
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		if (flag.startsWith("--")) options[flag.slice(2)] = argv[(index += 1)];
		else options.episode = flag;
	}
	const [width, height] = String(options.size).split("x").map(Number);
	if (!options.episode) throw new Error("usage: record.mjs <episode> [--locale en|ko] [--size 1600x1000|1920x1080] [--voice off|say] [--wps-ko 1.6] [--wps-en 2.5] [--fps 30] [--out dist/tutorial]");
	if (!["en", "ko"].includes(options.locale)) throw new Error(`--locale must be en or ko (got ${options.locale})`);
	if (!(width > 0 && height > 0)) throw new Error(`--size must look like 1600x1000 (got ${options.size})`);
	if (!["off", "say"].includes(options.voice)) throw new Error(`--voice must be off or say (got ${options.voice})`);
	return { ...options, width, height, wps: { ko: Number(options["wps-ko"]), en: Number(options["wps-en"]) }, fps: Number(options.fps) };
}

async function loadEpisode(name) {
	const base = existsSync(name) ? resolve(name) : resolve(import.meta.dirname, "episodes", name);
	const file = [base, `${base}.mjs`, `${base}.json`].find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
	if (!file) throw new Error(`no episode ${name} (looked in tools/tutorial/episodes/)`);
	const episode = file.endsWith(".json") ? JSON.parse(readFileSync(file, "utf8")) : (await import(pathToFileURL(file).href)).default;
	const errors = validateEpisode(episode);
	if (errors.length) throw new Error(`episode ${name} is invalid:\n  ${errors.join("\n  ")}`);
	return normalizeEpisode(episode);
}

const run = (ffmpeg, args, what) => {
	const result = spawnSync(ffmpeg, args, { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`ffmpeg ${what} failed (exit ${result.status}): ${result.stderr.trim()}`);
};

const options = parseArgs(process.argv.slice(2));
const ffmpeg = findFfmpeg();
console.log(`ffmpeg: ${ffmpeg.path} (${ffmpeg.version})`);
const episode = await loadEpisode(options.episode);
const steps = episode.chapters.flatMap((chapter) => chapter.steps);
const episodeName = options.episode.replace(/^.*\//, "").replace(/\.(mjs|json)$/, "");
const outDir = episode.chaptered ? join(options.out, episodeName) : options.out;
const fullPath = episode.chaptered ? join(outDir, `${episodeName}.${options.locale}.mp4`) : join(outDir, `${options.locale === "en" ? episodeName : `${episodeName}-${options.locale}`}.mp4`);
const frameDir = mkdtempSync(join(tmpdir(), "cozyclay-tutorial-"));
// Voice first: each cue's hold comes from its clip, so the clips exist before the capture.
const clips = options.voice === "say" ? prepareVoice({ steps, language: options.locale, voiceDir: resolve(import.meta.dirname, "voice", episodeName), workDir: frameDir, ffprobe: ffmpeg.path.replace(/ffmpeg$/, "ffprobe") }) : new Map();
console.log(clips.size ? `voice (${options.locale}): ${clips.size} clips` : `voice (${options.locale}): off, captions only`);
const url = process.env.QA_URL || "http://127.0.0.1:5594/app/";
const cdp = await connectPage(Number(process.env.CDP_PORT || 9222));
try {
	// An export step's download lands in the scratch dir, never in the user's Downloads.
	await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: join(frameDir, "downloads") });
	await cdp.send("Emulation.setDeviceMetricsOverride", { width: options.width, height: options.height, deviceScaleFactor: 1, mobile: false });
	await cdp.send("Page.enable");
	const input = createInput(cdp, { mac: (await cdp.evaluate("navigator.platform")).startsWith("Mac") });
	await input.install(TEACHING_OVERLAY, localeScript(new URL(url).origin, options.locale));
	// An episode that opens the Studio itself starts on its first scene; otherwise on the project chooser.
	const firstScene = steps.map(actionOf).find((action) => action === "terminal" || action === "studio");
	if (firstScene === "terminal") {
		const loaded = cdp.once("Page.loadEventFired");
		await cdp.send("Page.navigate", { url: TERMINAL_URL });
		await loaded;
	} else if (!firstScene) await openStudio(cdp, url);

	const frames = [];
	let started = 0;
	cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
		void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
		const at = Date.now();
		if (!started) started = at;
		const file = `${String(frames.length).padStart(6, "0")}.jpg`;
		writeFileSync(join(frameDir, file), Buffer.from(data, "base64"));
		frames.push({ file, ms: at - started });
	});
	const firstFrame = cdp.once("Page.screencastFrame", 10000);
	await cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: options.width, maxHeight: options.height, everyNthFrame: 1 });
	await firstFrame;
	const clock = () => Date.now() - started;
	await sleep(500);

	// A narrated step opens a cue; the silent steps after it run inside that cue,
	// and the cue closes once the narration has had its time, or at a chapter end.
	const cues = [];
	const marks = [];
	const timeline = [];
	let open = null;
	const closeCue = async () => {
		if (!open) return;
		await sleep(open.startMs + stepHoldMs(clock() - open.startMs, open.narration, options.wps, clips.get(open.id)?.audioS ?? null, options.locale) - clock());
		cues.push({ ...open, endMs: clock() });
		open = null;
	};
	for (const chapter of episode.chapters) {
		await closeCue();
		marks.push({ chapter, startMs: marks.length ? clock() : 0 });
		for (const step of chapter.steps) {
			// A card is a new scene: the caption before it ends where it starts.
			if (step.narration || step.card) {
				await closeCue();
				if (step.narration) open = { id: step.id, startMs: clock(), narration: step.narration };
			}
			const stepStart = clock();
			await runStep({ cdp, input, wps: options.wps, locale: options.locale, url, episode, chapter }, step);
			timeline.push({ chapter: chapter.id, id: step.id, action: actionOf(step), startMs: stepStart, endMs: clock() });
		}
		console.log(`chapter ${chapter.id}: ${((clock() - marks.at(-1).startMs) / 1000).toFixed(1)}s`);
	}
	await closeCue();
	await sleep(800);
	const endMs = clock();
	await cdp.send("Page.stopScreencast");
	if (frames.length === 0) throw new Error("the screencast produced no frames");

	mkdirSync(outDir, { recursive: true });
	const base = join(frameDir, "capture.mp4");
	console.log(`ffmpeg command: ${await encode({ ffmpeg: ffmpeg.path, dir: frameDir, frames, endMs, fps: options.fps, output: base })}`);
	const bandHeight = bandHeightFor(options.height);
	const captions = await renderCaptions(cdp, { texts: cues.map((cue) => cue.narration[options.locale]), width: options.width, height: bandHeight, dir: frameDir, language: options.locale });
	run(ffmpeg.path, muxArgs({ base, output: fullPath, cues, clips, captions, endMs, bandHeight }), "mux");
	console.log(`ffmpeg mux: ${clips.size ? "h264 + aac" : "h264, no audio"}, ${captions.length} captions, ${options.width}x${options.height + bandHeight}`);
	const srtBase = fullPath.replace(/\.mp4$/, "");
	for (const language of episode.chaptered ? [options.locale] : ["ko", "en"]) writeFileSync(`${srtBase}${episode.chaptered ? "" : `.${language}`}.srt`, toSrt(cues, language));
	// When each step ran, for QA frames (one per spotlight) and for timing a re-record.
	writeFileSync(`${srtBase}.steps.json`, `${JSON.stringify(timeline, null, "\t")}\n`);
	console.log(`wrote ${fullPath} (${(endMs / 1000).toFixed(1)}s, ${frames.length} frames)`);
	if (episode.chaptered) marks.forEach((mark, index) => {
		const endAt = index + 1 < marks.length ? marks[index + 1].startMs : endMs;
		const output = join(outDir, chapterFileName(episode.firstChapter + index, mark.chapter.id, options.locale));
		run(ffmpeg.path, chapterCutArgs({ input: fullPath, output, startMs: mark.startMs, endMs: endAt, audio: clips.size > 0 }), `cut ${mark.chapter.id}`);
		console.log(`wrote ${output} (${((endAt - mark.startMs) / 1000).toFixed(1)}s)`);
	});
} finally {
	cdp.close();
	rmSync(frameDir, { recursive: true, force: true });
}
