#!/usr/bin/env node
import assert from "node:assert/strict";
import * as analytics from "../src/analytics.js";
import { startExportAttempt } from "../src/export-attempt.js";
import * as friction from "../src/analytics-friction.js";
import { clickFrictionSeam, noteBusReceipt, notePointerDown } from "../src/click-friction.js";
import { frictionHintSeam, hintNoSelection } from "../src/friction-hint.js";
import { noteRefusal as noteBusRefusal } from "../src/command-bus-telemetry.js";
import { STRICT_EVENT_KEYS, bucketAge, bucketLong, refusalCodeOf, strictPropValidator } from "../src/analytics-strict.js";
import * as postTurn from "../src/post-turn-edits.js";
import { draftTelemetrySeam, noteDraftCompiled } from "../src/motion-draft-telemetry.js";
import { crashTelemetrySeam, reportGlLost, reportRenderCrash } from "../src/crash-telemetry.js";
import { noteNoticeShown, noteUpdateClicked, noteUpdatePolled, updateTelemetrySeam } from "../src/update/update-telemetry.js";
import * as promptTelemetry from "../src/workflow/prompt-telemetry.js";
import * as shortcuts from "../src/shortcut-friction.js";
import * as search from "../src/search-friction.js";
import * as thrash from "../src/thrash-friction.js";
import { createAppContext } from "../src/app-context.js";
import { exportMenuOpenedProps } from "../src/export-menu-telemetry.js";
import { readFileSync } from "node:fs";
import packageInfo from "../package.json" with { type: "json" };
import {
	bucketMs,
	scrubEventUrls,
	isOriginAllowed,
	normalizeOrigin,
	parseAllowlist,
	resolveAnalyticsRuntime,
	sanitizeProps,
	bucketCount,
	bucketProjectAge,
	bucketSessionDuration,
} from "../src/analytics.js";

assert.equal(normalizeOrigin("HTTPS://CozyClay.Org/"), "https://cozyclay.org");
assert.equal(normalizeOrigin("https://www.cozyclay.org.../"), "https://www.cozyclay.org");
assert.equal(normalizeOrigin("https://COZYCLAY.ORG:8443/"), "https://cozyclay.org:8443");

assert.deepEqual(parseAllowlist(), ["https://cozyclay.org", "https://www.cozyclay.org"]);
assert.deepEqual(
	parseAllowlist(" HTTPS://Preview.CozyClay.Org/ ,https://cozyclay.org... "),
	["https://preview.cozyclay.org", "https://cozyclay.org"],
);

const allowlist = parseAllowlist();
assert.equal(isOriginAllowed("https://cozyclay.org", allowlist), true);
assert.equal(isOriginAllowed("https://www.cozyclay.org", allowlist), true);
assert.equal(isOriginAllowed("https://evilcozyclay.org", allowlist), false);
assert.equal(isOriginAllowed("https://preview.cozyclay.org", allowlist), false);
assert.equal(isOriginAllowed("https://cozyclay.org.evil.example", allowlist), false);

assert.deepEqual(
	sanitizeProps("project:saved", {
		object_count_bucket: "1-3",
		shot_count_bucket: "0",
		prompt: "secret prompt",
		name: "private name",
		unknown: "discarded",
	}),
	{ object_count_bucket: "1-3", shot_count_bucket: "0" },
);
assert.deepEqual(
	sanitizeProps("scene:created", {
		scene_source: "quick start",
		path: "private",
		url: "https://private.example",
		file: "private.blend",
	}),
	{},
	"free text and hard-denied keys are never captured",
);
assert.deepEqual(sanitizeProps("motion:generate_blocked", { surface: "timeline", prompt: "private" }), {});

import { readStudioSource } from "./bus/verify-domain-modules.mjs";
const appSource = readStudioSource();
const appFunction = (name) => {
	const start = appSource.indexOf(`function ${name}(`);
	assert.notEqual(start, -1, `${name} exists`);
	return appSource.slice(start, appSource.indexOf("\n\t}\n", start) + 3);
};
assert.doesNotMatch(appSource, /trackGenerateBlocked|motion:generate_blocked/);

// The 2.x motion-generation funnel and the sample player have no emitter in
// 3.0: their events left the allowlist, so nothing can send them again.
const removedEvents = ["motion:generate_requested", "motion:preflight_blocked", "motion:preflight_passed", "motion:job_started", "motion:job_succeeded", "motion:job_failed", "motion:result_applied", "sample:played"];
for (const event of removedEvents) {
	assert.deepEqual(sanitizeProps(event, { surface: "timeline", backend: "hosted", request_id: "0123456789abcdef0123456789abcdef", from: "x" }), {}, `${event} is off the allowlist`);
}
for (const name of ["prompt_block_add", "shot_add", "shot_cut", "export_pose", "mcp_connected", "plan_view", "fal_motion_open"]) {
	assert.deepEqual(sanitizeProps("feature:used", { name }), {}, `never-called feature name ${name} is gone`);
}
assert.doesNotMatch(appSource, /latency_bucket/);
assert.deepEqual(sanitizeProps("feature:used", { name: "pose_edit", prompt: "secret" }), { name: "pose_edit" });
assert.deepEqual(sanitizeProps("feature:used", { name: "private-feature" }), {});
assert.deepEqual(sanitizeProps("install:first_launch", { heard_from: "github" }), { heard_from: "github" });
assert.deepEqual(sanitizeProps("install:first_launch", { heard_from: "skip" }), {});
assert.equal(bucketCount(0), "0");
assert.equal(bucketCount(4), "4-10");
assert.equal(bucketSessionDuration(0), "lt1m");
assert.equal(bucketProjectAge(2 * 24 * 60 * 60 * 1000), "1-7d");

assert.equal(bucketMs(0), "lt1s");
assert.equal(bucketMs(999), "lt1s");
assert.equal(bucketMs(1000), "1-3s");
assert.equal(bucketMs(2999), "1-3s");
assert.equal(bucketMs(3000), "3-10s");
assert.equal(bucketMs(9999), "3-10s");
assert.equal(bucketMs(10000), "10-30s");
assert.equal(bucketMs(29999), "10-30s");
assert.equal(bucketMs(30000), "gte30s");

const scrubbedEvent = scrubEventUrls({
		event: "$pageview",
		properties: {
			$current_url: "https://cozyclay.org/app/?token=secret#pose=7",
			$referrer: "https://news.ycombinator.com/item?id=123",
			$referring_domain: "news.ycombinator.com",
			$pathname: "/app/",
			$set_once: {
				$initial_current_url: "https://cozyclay.org/app/?prompt=secret#pose=7",
				$initial_referrer: "https://search.example/?q=private",
				$initial_utm_source: "private-source",
				ph_keyword: "private search",
			},
			utm_source: "private-source",
			fbclid: "private-click-id",
		},
		$set_once: {
			$initial_current_url: "https://cozyclay.org/app/?token=secret",
			$initial_referrer: "https://search.example/?q=private",
			$initial_utm_campaign: "private-campaign",
			ph_keyword: "private search",
			$session_entry_url: "https://cozyclay.org/app/?token=secret",
			$session_entry_utm_source: "private-source",
		},
	});
assert.deepEqual(
	scrubbedEvent.properties,
	{
		$current_url: "https://cozyclay.org/app/",
		$referrer: "https://news.ycombinator.com/item",
		$referring_domain: "news.ycombinator.com",
		$pathname: "/app/",
		$set_once: {
			$initial_current_url: "https://cozyclay.org/app/",
			$initial_referrer: "https://search.example/",
		},
	},
	"URL tails, search terms, and campaign values never leave the browser",
);
assert.deepEqual(scrubbedEvent.$set_once, {
	$initial_current_url: "https://cozyclay.org/app/",
	$initial_referrer: "https://search.example/",
});
assert.equal(scrubEventUrls(null), null);

const installationId = "018f0d66-3a4b-7c2d-8e9f-123456789abc";
assert.deepEqual(
	resolveAnalyticsRuntime({
		env: { PROD: true, VITE_POSTHOG_KEY: "phc_hosted", VITE_POSTHOG_HOST: "https://t.cozyclay.org" },
		origin: "https://cozyclay.org",
		runtime: null,
	}),
	{
		kind: "enabled",
		distribution: "hosted",
		apiKey: "phc_hosted",
		apiHost: "https://t.cozyclay.org",
		appVersion: packageInfo.version,
		installationId: null,
		firstLaunch: false,
		firstLaunchHeardFrom: null,
		installKind: null,
		originKind: "hosted",
		internalQa: false,
		updateStatus: null,
	},
);
const npmRuntime = {
	distribution: "npm",
	telemetryEnabled: true,
	installationId,
	appVersion: "1.5.0",
	apiKey: "phc_npm",
	apiHost: "https://t.cozyclay.org",
	firstLaunch: true,
};
const expectedNpmRuntime = {
	kind: "enabled",
	distribution: "npm",
	apiKey: "phc_npm",
	apiHost: "https://t.cozyclay.org",
	appVersion: "1.5.0",
	installationId,
	firstLaunch: true,
	firstLaunchHeardFrom: null,
	installKind: "npx",
	originKind: "local",
	internalQa: false,
	updateStatus: "unknown",
};
assert.deepEqual(
	resolveAnalyticsRuntime({ env: { PROD: true }, origin: "http://127.0.0.1:5180", runtime: npmRuntime }),
	expectedNpmRuntime,
	"the official package can enable 127.0.0.1 with its injected runtime contract",
);
assert.deepEqual(
	resolveAnalyticsRuntime({ env: { PROD: true }, origin: "http://localhost:5180", runtime: npmRuntime }),
	expectedNpmRuntime,
	"the official package can enable localhost with its injected runtime contract",
);
assert.deepEqual(
	resolveAnalyticsRuntime({
		env: { PROD: true, VITE_POSTHOG_KEY: "phc_hosted" },
		origin: "http://127.0.0.1:5180",
		runtime: null,
	}),
	{ kind: "disabled", reason: "unapproved origin" },
	"a clone or preview cannot enable localhost by origin alone",
);
assert.deepEqual(
	resolveAnalyticsRuntime({
		env: { PROD: false, VITE_POSTHOG_KEY: "phc_hosted" },
		origin: "http://127.0.0.1:5180",
		runtime: {
			distribution: "npm",
			telemetryEnabled: true,
			installationId,
			appVersion: "1.5.0",
			apiKey: "phc_npm",
			apiHost: "https://t.cozyclay.org",
			firstLaunch: false,
		},
	}),
	{ kind: "disabled", reason: "not production" },
	"source development remains excluded even if a hostile page defines the global",
);
assert.deepEqual(
	resolveAnalyticsRuntime({
		env: { PROD: true },
		origin: "http://127.0.0.1:5180",
		runtime: {
			distribution: "npm",
			telemetryEnabled: false,
			installationId,
			appVersion: "1.5.0",
			apiKey: "phc_npm",
			apiHost: "https://t.cozyclay.org",
			firstLaunch: false,
		},
	}),
	{ kind: "disabled", reason: "opted out" },
);

assert.deepEqual(sanitizeProps("export:keyframe_pack", {
	entries: 6, source: "workflow", name: "private.zip", path: "/private", prompt: "secret",
}), { entries: 6, source: "workflow" }, "existing Workflow pack properties survive the export allowlist");
for (const entries of [-1, Infinity, NaN, "6", true]) {
	assert.deepEqual(sanitizeProps("export:keyframe_pack", { entries, source: "private" }), {});
}
assert.deepEqual(sanitizeProps("export:keyframe_pack", { entries: 0, source: "workflow" }), { entries: 0, source: "workflow" });

const descriptor = { export_kind: "video", format: "mp4", surface: "studio" };
function fixture(metadata = descriptor, captureOverride) {
	let clock = 100;
	const events = [];
	const attempt = startExportAttempt(metadata, {
		now: () => clock,
		capture: captureOverride ?? ((event, props) => events.push({ event, props })),
	});
	return { attempt, events, advance(ms) { clock += ms; } };
}
const success = fixture({ ...descriptor, filename: "private.mp4", prompt: "secret" });
assert.equal(success.events.length, 1);
assert.equal(success.events[0].event, "export:attempt_started");
assert.match(success.events[0].props.attempt_id, /^[a-f0-9]{32}$/);
assert.deepEqual(Object.keys(success.events[0].props).sort(), ["attempt_id", "export_kind", "format", "is_retry", "surface"]);
assert.equal(success.events[0].props.is_retry, false, "a first run is never a retry");
success.advance(3500);
success.attempt.succeed();
success.attempt.fail(new Error("late failure"));
success.attempt.succeed();
assert.deepEqual(success.events[1], {
	event: "export:attempt_succeeded",
	props: { ...success.events[0].props, duration_bucket: "3-10s" },
});
assert.equal(success.events.length, 2, "success suppresses all subsequent terminal calls");
assert.notEqual(fixture().events[0].props.attempt_id, success.events[0].props.attempt_id);

for (const [error, fallback, code, terminal] of [
	[Object.assign(new Error("private codec message"), { exportFailureCode: "unsupported_codec" }), "unknown", "unsupported_codec", "failed"],
	[Object.assign(new Error("private encode message"), { exportFailureCode: "encode_failed" }), "render_failed", "encode_failed", "failed"],
	[new Error("private render message"), "render_failed", "render_failed", "failed"],
	[new DOMException("private cancellation message", "AbortError"), "encode_failed", "aborted", "cancelled"],
	[{ exportFailureCode: "aborted" }, "unknown", "aborted", "cancelled"],
]) {
	const run = fixture();
	try {
		await Promise.reject(error);
	} catch (caught) {
		run.advance(1200);
		run.attempt.fail(caught, fallback);
	}
	run.attempt.fail(error);
	run.attempt.succeed();
	assert.equal(run.events.length, 2, `${code} emits exactly one terminal after async rejection`);
	assert.deepEqual(run.events[1], {
		event: `export:attempt_${terminal}`,
		props: { ...run.events[0].props, duration_bucket: "1-3s", failure_code: code, stage: "preparing", progress: "0" },
	});
}
assert.equal(analytics.exportFailureCode(new Error("unsupported codec encode failed aborted")), "unknown", "messages never determine classification");
assert.equal(analytics.exportFailureCode({ exportFailureCode: "private" }, "private"), "unknown");
assert.equal(analytics.exportFailureCode({ name: "AbortError", exportFailureCode: "encode_failed" }), "aborted");
const hostileError = new Proxy({}, { get() { throw new Error("property failure"); } });
assert.equal(analytics.exportFailureCode(hostileError, "render_failed"), "render_failed");

const lifecycleEvents = ["started", "succeeded", "failed", "cancelled"].map((result) => `export:attempt_${result}`);
const allProps = {
	attempt_id: "a".repeat(32), ...descriptor, duration_bucket: "1-3s", failure_code: "encode_failed",
	entries: 4, source: "workflow", filename: "private", url: "https://private", path: "/private", prompt: "secret", arbitrary: 1,
};
for (const event of lifecycleEvents) {
	const expected = { attempt_id: allProps.attempt_id, ...descriptor };
	if (event !== "export:attempt_started") expected.duration_bucket = "1-3s";
	if (event.endsWith("failed") || event.endsWith("cancelled")) expected.failure_code = "encode_failed";
	assert.deepEqual(sanitizeProps(event, allProps), expected);
	for (const key of Object.keys(expected)) {
		for (const unsafe of ["private", "https://private", "private text", 7, true, null, {}]) {
			assert.equal(Object.hasOwn(sanitizeProps(event, { [key]: unsafe }), key), false, `${event} rejects unsafe ${key}`);
		}
	}
}
for (const export_kind of ["video", "depth_video", "frame", "keyframe_pack", "animation_project"]) {
	for (const format of ["mp4", "png", "zip"]) {
		for (const surface of ["studio", "workflow", "embed"]) {
			const props = { export_kind, format, surface };
			assert.deepEqual(sanitizeProps("export:attempt_started", props), props);
		}
	}
}
for (const code of ["unsupported_codec", "encode_failed", "render_failed", "aborted", "unknown"]) {
	assert.deepEqual(sanitizeProps("export:attempt_failed", { failure_code: code }), { failure_code: code });
}
for (const duration of ["lt1s", "1-3s", "3-10s", "10-30s", "gte30s"]) {
	assert.deepEqual(sanitizeProps("export:attempt_succeeded", { duration_bucket: duration }), { duration_bucket: duration });
}
assert.deepEqual(sanitizeProps("export:video_succeeded", { format: "mp4", ...allProps }), { format: "mp4" });

// PR 0 hygiene: the storyboard, render-pass and OTIO flows, retries, the scene
// size, where a failed export stood, and where each saved file went.
for (const [export_kind, format] of [["storyboard", "png"], ["render_pass", "png"], ["otio", "otio"]]) {
	assert.deepEqual(sanitizeProps("export:attempt_started", { export_kind, format, surface: "studio" }), { export_kind, format, surface: "studio" });
}
assert.deepEqual(sanitizeProps("export:attempt_started", { is_retry: true, retry_of: "b".repeat(32), objects: "4-10" }), { is_retry: true, retry_of: "b".repeat(32), objects: "4-10" });
for (const [key, value] of [["is_retry", "true"], ["retry_of", "B".repeat(32)], ["retry_of", "private"], ["objects", 5], ["objects", "5"]]) {
	assert.deepEqual(sanitizeProps("export:attempt_started", { [key]: value }), {}, `attempt_started rejects ${key}=${value}`);
}
for (const stage of ["preparing", "encoding", "finalizing", "handoff"]) {
	for (const progress of ["0", "1-25", "26-50", "51-75", "76-99"]) {
		for (const event of ["export:attempt_failed", "export:attempt_cancelled"]) assert.deepEqual(sanitizeProps(event, { stage, progress }), { stage, progress });
	}
}
for (const [key, value] of [["stage", "mux"], ["progress", "100"], ["progress", 50]]) assert.deepEqual(sanitizeProps("export:attempt_failed", { [key]: value }), {});
assert.deepEqual(sanitizeProps("export:attempt_succeeded", { stage: "encoding", progress: "0" }), {}, "only a stopped export carries stage and progress");
for (const method of ["workspace", "download"]) {
	for (const reason of ["none", "unsupported", "no_workspace", "permission", "write_failed"]) {
		assert.deepEqual(sanitizeProps("export:saved", { method, reason, name: "private.png", path: "/private" }), { method, reason });
	}
}
assert.deepEqual(sanitizeProps("export:saved", { method: "folder", reason: "no-workspace" }), {}, "export:saved values are closed");
{
	const events = [];
	const capture = (event, props) => events.push({ event, props });
	const request = Object.freeze({ kind: "video" });
	const first = startExportAttempt({ ...descriptor, objects: 5, request }, { capture });
	first.note("preparing", { stage: "depth", completedFrames: 4, frameCount: 4 });
	first.note("encoding", { completedFrames: 3, frameCount: 10 });
	first.fail(new Error("private encode message"), "encode_failed");
	const retry = startExportAttempt({ ...descriptor, objects: 5, request }, { capture });
	retry.note("encoding", { completedFrames: 10, frameCount: 10 });
	retry.note("finalizing", { stage: "mux" });
	retry.note("failed", { completedFrames: 0, frameCount: 10 });
	retry.fail(new DOMException("private", "AbortError"));
	const fresh = startExportAttempt({ ...descriptor, request: Object.freeze({ kind: "video" }) }, { capture });
	fresh.note("finalizing", { stage: "download" });
	fresh.fail(new Error("private handoff"), "unknown");
	const [firstStart, firstEnd, retryStart, retryEnd, freshStart, freshEnd] = events;
	assert.equal(firstStart.props.objects, "4-10", "a numeric scene size crosses only as its bucket");
	assert.deepEqual([firstEnd.event, firstEnd.props.stage, firstEnd.props.progress], ["export:attempt_failed", "encoding", "26-50"]);
	assert.equal(Object.hasOwn(firstStart.props, "request"), false, "the request identity never crosses");
	assert.deepEqual([retryStart.props.is_retry, retryStart.props.retry_of], [true, firstStart.props.attempt_id], "the same request again is a retry of its last attempt");
	assert.deepEqual([retryEnd.event, retryEnd.props.stage, retryEnd.props.progress], ["export:attempt_cancelled", "finalizing", "76-99"], "terminal phases do not move the stop point");
	assert.deepEqual([freshStart.props.is_retry, Object.hasOwn(freshStart.props, "retry_of")], [false, false], "a new request is not a retry");
	assert.equal(freshEnd.props.stage, "handoff", "the download step is the handoff stage");
	const handed = startExportAttempt(descriptor, { capture });
	handed.note("preparing", { completedFrames: 1, frameCount: 2 });
	handed.fail(new Error("private"), "unknown", 1);
	assert.deepEqual([events.at(-1).props.stage, events.at(-1).props.progress], ["handoff", "26-50"], "a file already handed off ends the run in handoff");
}
console.log("PASS export retries, scene size, stop stage/progress, new export kinds and export:saved values");

// PR F: the friction counter module. Closed buckets, caps, and no-op detection.
{
	friction.reset();
	assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 10, 11, 500, -1, NaN].map(friction.bucketFrictionCount), ["0", "1", "2", "3", "4-5", "4-5", "6-10", "6-10", "gte11", "gte11", "0", "0"]);
	assert.equal(friction.bump("private_counter"), false, "an unknown counter name is ignored");
	for (const n of [0, -2, NaN, Infinity]) assert.equal(friction.bump("undos", n), false, `bump rejects n=${n}`);
	for (let i = 0; i < 12; i += 1) friction.bump("errors");
	friction.noteLongTask(60); friction.noteLongTask(2400); friction.noteLongTask(-5); friction.noteLongTask("90");
	friction.noteTick(1, 10); friction.noteTick(4, 10); friction.noteTick(5, 2); friction.noteTick(1.5, 3);
	const snap = friction.snapshot();
	assert.deepEqual([snap.errors, snap.long_tasks, snap.long_task_max, snap.late_tick_ratio, snap.undos], ["gte11", "2", "gte2000", "20-50", "0"]);
	assert.deepEqual(Object.keys(snap).sort(), friction.FRICTION_SUMMARY_KEYS.filter((key) => key !== "active_time").sort(), "the snapshot is exactly the summary keys");
	assert.deepEqual(sanitizeProps("app:friction_summary", { active_time: "5-15m", ...snap }), { active_time: "5-15m", ...snap }, "every snapshot value passes the validator");
	for (const [key, value] of [["active_time", "lt1s"], ["errors", 12], ["errors", "12"], ["long_task_max", 2400], ["late_tick_ratio", "30"], ["refusal_text", "x"], ["undos", "1-3"]]) {
		assert.deepEqual(sanitizeProps("app:friction_summary", { [key]: value }), {}, `friction summary rejects ${key}=${value}`);
	}
	// A detector's own event is capped per session; the counter keeps counting.
	const admitted = [];
	for (let i = 0; i < 5; i += 1) { friction.bump("rage_clicks"); admitted.push(friction.admit("ui:rage_click", 2)); }
	assert.deepEqual(admitted, [true, true, false, false, false], "past its cap a detector stops emitting");
	assert.equal(friction.snapshot().rage_clicks, "4-5", "the counter still counts what the cap held back");
	assert.equal(friction.admit("ui:other", 0), false, "a zero cap admits nothing");
	friction.reset();
	assert.ok(Object.values(friction.snapshot()).every((value) => value === "0" || value === "lt50"), "reset clears counters, caps and maxima");
	assert.equal(friction.admit("ui:rage_click", 2), true, "reset clears the caps too");
	friction.reset();
	// Long tasks: feature-detected, a no-op where the browser lacks them.
	assert.equal(friction.observeLongTasks(undefined), false, "no PerformanceObserver is a no-op");
	class NoLongTask { static supportedEntryTypes = ["mark"]; observe() { throw new Error("unexpected observe"); } }
	assert.equal(friction.observeLongTasks(NoLongTask), false, "a PerformanceObserver without longtask is a no-op");
	class Throws { static get supportedEntryTypes() { throw new Error("hostile"); } }
	assert.equal(friction.observeLongTasks(Throws), false, "a throwing detector is a no-op");
	let feed;
	class LongTasks { static supportedEntryTypes = ["longtask"]; constructor(callback) { feed = callback; } observe(options) { assert.deepEqual(options, { type: "longtask" }); } }
	assert.equal(friction.observeLongTasks(LongTasks), true);
	feed({ getEntries: () => [{ duration: 70 }, { duration: 620 }] });
	assert.deepEqual([friction.snapshot().long_tasks, friction.snapshot().long_task_max], ["2", "500-2000"], "observed long tasks feed the counters");
	assert.equal(friction.observeLongTasks(LongTasks), true, "the observer installs once");
	friction.reset();
}
console.log("PASS friction counters: closed buckets, per-event caps, validator, and feature-detected long tasks");

// P2-a: rage and dead clicks from one pointerdown listener. A fake element answers the
// selectors the detector asks; the 1 s window and the 500 ms effect wait run on real timers.
{
	friction.reset();
	const sent = [];
	let clock = 0;
	const restoreClicks = clickFrictionSeam({ capture: (event, props) => sent.push({ event, props }), clock: () => clock });
	const element = ({ fid = null, disabled = false, typing = false, control = true, area = null, title = null } = {}) => {
		const el = {
			getAttribute: (name) => (name === "data-fid" ? fid : name === "title" ? title : null),
			closest: (selector) => {
				if (selector.includes("textarea")) return typing ? el : null;
				// Studio areas are matched by class (analytics-controls.js AREAS).
				if (selector.startsWith(".")) return area && selector.split(", ").includes(area) ? el : null;
				if (selector === "[data-fid]") return fid ? el : null;
				if (selector.includes("aria-disabled")) return disabled ? el : null;
				return control || fid ? el : null;
			},
		};
		return el;
	};
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const click = (target, x = 10, y = 10, step = 150) => { notePointerDown({ target, x, y }); clock += step; };
	const take = (event) => sent.splice(0).filter((row) => row.event === event).map((row) => row.props);
	// Four fast clicks on Play, no receipt and no DOM change: a rage burst that changed nothing, and dead clicks.
	const play = element({ fid: "tl_play" });
	for (let i = 0; i < 4; i += 1) click(play);
	await wait(1100);
	const rows = sent.splice(0);
	assert.deepEqual(rows.filter((row) => row.event === "ui:rage_click").map((row) => row.props), [{ control: "tl_play", clicks: "4-5", changed: false }]);
	assert.deepEqual(rows.filter((row) => row.event === "ui:dead_click").map((row) => row.props), [{ control: "tl_play", reason: "no_effect" }, { control: "tl_play", reason: "no_effect" }], "dead clicks stop at 2 per control");
	// The same burst again within 10 s: cooldown, so only the counter moves; a burst whose clicks led to a receipt is changed.
	for (let i = 0; i < 3; i += 1) click(play);
	await wait(1100);
	assert.deepEqual(take("ui:rage_click"), [], "a second burst inside the 10 s cooldown is not sent");
	clock += 11_000;
	const send = element({ fid: "agent_send" });
	click(send); noteBusReceipt(true); click(send); click(send); click(send); click(send); click(send);
	await wait(1100);
	assert.deepEqual(take("ui:rage_click"), [{ control: "agent_send", clicks: "gte6", changed: true }]);
	// Too far apart (24 px) or too slow (1 s) is no burst.
	clock += 11_000;
	const shot = element({ fid: "shot_add" });
	click(shot, 10, 10); click(shot, 60, 10); click(shot, 110, 10);
	clock += 1200; click(shot); click(shot); clock += 1000; click(shot);
	await wait(1100);
	assert.deepEqual(take("ui:rage_click"), [], "distance and the 1 s window both break a burst");
	// A disabled control is an aria_disabled dead click at once; a refusal within 500 ms is refused.
	const exportEntry = element({ fid: "export_video", disabled: true });
	click(exportEntry);
	assert.deepEqual(take("ui:dead_click"), [{ control: "export_video", reason: "aria_disabled" }]);
	const undo = element({ fid: "menu_undo" });
	click(undo, 10, 10, 10); noteBusReceipt(false);
	await wait(600);
	assert.deepEqual(take("ui:dead_click"), [{ control: "menu_undo", reason: "refused" }]);
	// #930 review: a right or middle click runs no action, so it is neither a dead nor a rage click.
	for (let i = 0; i < 4; i += 1) { notePointerDown({ target: element({ fid: "mode_pose" }), x: 10, y: 10, event: { button: 2 } }); clock += 100; }
	await wait(1100);
	assert.deepEqual(sent.splice(0), [], "non-primary buttons are ignored");
	// #930 review: an agent's refusal in the same 500 ms is not the user's click; a UI refusal is.
	const mode = element({ fid: "mode_camera" });
	click(mode, 10, 10, 10); noteBusRefusal({ code: "TARGET_BUSY", phase: "admission" }, "agent", "shot.create");
	await wait(600);
	assert.deepEqual(take("ui:dead_click"), [{ control: "mode_camera", reason: "no_effect" }], "an agent refusal is not attributed to the click");
	clock += 5000;
	const tools = element({ fid: "tool_move" });
	click(tools, 10, 10, 10); noteBusRefusal({ code: "TARGET_BUSY", phase: "admission" }, "ui", "object.update");
	await wait(600);
	assert.deepEqual(take("ui:dead_click"), [{ control: "tool_move", reason: "refused" }], "a UI refusal is");
	// A control outside the list is "other": only its disabled clicks are dead (its effect is not watched).
	click(element({ control: true })); await wait(600);
	assert.deepEqual(take("ui:dead_click"), [], "an unlisted live control is not watched for effect");
	click(element({ control: true, disabled: true }));
	assert.deepEqual(take("ui:dead_click"), [{ control: "other", reason: "aria_disabled" }]);
	// #973: an unnamed control inside a known Studio area reports the area, and a disabled click shows its reason.
	const hints = [];
	const restoreHints = frictionHintSeam({ capture: (text) => hints.push(text), clock: () => clock });
	click(element({ control: true, disabled: true, area: ".menubar", title: "Nothing to export yet" }));
	click(element({ control: true, disabled: true, area: ".menubar", title: "Nothing to export yet" }));
	assert.deepEqual(take("ui:dead_click"), [{ control: "other_menu", reason: "aria_disabled" }, { control: "other_menu", reason: "aria_disabled" }]);
	assert.deepEqual(hints, ["Nothing to export yet"], "the disabled control's own title shows, and the same hint does not repeat within 4 s");
	click(element({ fid: "tool_pin", disabled: true }));
	assert.equal(hints.at(-1), "Select a bone to pin first", "a named control without a title uses its fallback");
	assert.equal(strictPropValidator("ui:dead_click")("control", "other_timeline"), true, "area ids pass the strict validator");
	assert.equal(strictPropValidator("ui:dead_click")("control", "other_somewhere"), false, "an unlisted area does not");
	hintNoSelection(); hintNoSelection();
	assert.equal(hints.filter((text) => text === "Select something first").length, 1, "the selection hint shows at most once a minute");
	restoreHints();
	take("ui:dead_click");
	// Typing targets and plain surfaces never feed the detector, counters included.
	const before = friction.snapshot();
	for (let i = 0; i < 5; i += 1) click(element({ fid: "agent_send", typing: true }));
	for (let i = 0; i < 5; i += 1) click(element({ control: false }));
	await wait(1100);
	assert.deepEqual(sent.splice(0), [], "the composer and non-controls emit nothing");
	assert.deepEqual([friction.snapshot().rage_clicks, friction.snapshot().dead_clicks], [before.rage_clicks, before.dead_clicks], "and move no counter");
	assert.ok(["3", "4-5", "6-10", "gte11"].includes(friction.snapshot().rage_clicks), "every rage burst bumped the counter, past the cooldown too");
	for (const [event, props] of [["ui:rage_click", { control: "tl_play", clicks: "3", changed: false }], ["ui:dead_click", { control: "other", reason: "no_effect" }]]) {
		assert.deepEqual(sanitizeProps(event, { ...props, x: 10, text: "Play", id: "obj-1" }), props, `${event} keeps only its closed values`);
	}
	for (const [event, key, value] of [["ui:rage_click", "control", "tl_pause"], ["ui:rage_click", "clicks", "2"], ["ui:dead_click", "reason", "hover"]]) {
		assert.deepEqual(sanitizeProps(event, { [key]: value }), {}, `${event} rejects ${key}=${value}`);
	}
	restoreClicks();
	friction.reset();
}
console.log("PASS rage and dead clicks: 1 s and 24 px bursts, cooldown and caps, aria_disabled/refused/no_effect, typing targets and non-primary buttons ignored, agent refusals not attributed");

// PR C: motion:draft_compiled buckets, flags, the closed schema and the 50-per-session cap.
{
	friction.reset();
	const drafts = [];
	const restoreDrafts = draftTelemetrySeam((event, props) => drafts.push({ event, props }));
	const result = (problems, total, ms, frameCount, search) => ({ qa: { ok: problems === 0, problems, total, groups: [] }, ms: { total: ms, compile: ms, qa: 1 }, frameCount, ...(search ? { search: {} } : {}) });
	noteDraftCompiled({ n: 1 }, result(3, 640, 812, 200, true), { installed: false, stuck: false, repaired: true, adjusted: true });
	noteDraftCompiled({ n: 6 }, result(0, 0, 40, 24), { installed: true, stuck: true });
	// A repaired draft is timed by its whole repair loop (ms.repair), not the one candidate it kept.
	noteDraftCompiled({ n: 2 }, { ...result(0, 0, 90, 24), ms: { total: 90, compile: 80, qa: 1, repair: 3200 } }, { repaired: true });
	assert.equal(drafts.pop().props.compile, "gte2000", "ms.repair wins over ms.total");
	assert.deepEqual(drafts.map(({ props }) => props), [
		{ draft_index: "1", qa_clean: false, qa_problems: "3", qa_frames: "gte201", compile: "500-2000", installed: false, stuck: false, repaired: true, searched: true, adjusted: true, frames: "121-480" },
		{ draft_index: "6-10", qa_clean: true, qa_problems: "0", qa_frames: "0", compile: "lt50", installed: true, stuck: true, repaired: false, searched: false, adjusted: false, frames: "lt30" },
	], "counts, buckets and flags only");
	for (const { props } of drafts) assert.deepEqual(sanitizeProps("motion:draft_compiled", { ...props, spec: "private", skill: "walk" }), props, "every draft value passes the closed schema");
	for (const [key, value] of [["draft_index", 6], ["qa_frames", "12"], ["compile", "lt1s"], ["frames", 200], ["qa_clean", "true"], ["qa_ms", "lt50"]]) {
		assert.deepEqual(sanitizeProps("motion:draft_compiled", { [key]: value }), {}, `motion:draft_compiled rejects ${key}=${value}`);
	}
	assert.doesNotThrow(() => noteDraftCompiled(null, { get qa() { throw new Error("hostile"); } }), "a malformed result cannot break a compile");
	drafts.length = 0;
	for (let i = 0; i < 60; i += 1) noteDraftCompiled({ n: 1 }, result(0, 0, 10, 24));
	assert.equal(drafts.length, 47, "the 50-per-session cap holds (three drafts were sent above)");
	assert.equal(friction.snapshot().compiles, "gte11", "past the cap the compiles counter keeps counting");
	restoreDrafts();
	friction.reset();
}
console.log("PASS motion:draft_compiled: buckets, flags, closed schema, and the 50 cap with the compiles counter");

// PR E: the connect funnel's closed schemas. Never a key, token, account, email or message.
{
	const valid = {
		"agent:connect_opened": { entry: "failure_card" },
		"agent:connect_started": { provider: "openai-compatible", method: "oauth" },
		"agent:connect_finished": { provider: "other", method: "api_key", outcome: "abandoned", step: "prompt", duration: "1-2m", reason: "callback_error" },
		"agent:model_changed": { provider: "cliproxy", after_failure: true },
	};
	for (const [event, props] of Object.entries(valid)) {
		assert.deepEqual(sanitizeProps(event, { ...props, key: "sk-private", email: "a@b.c", message: "private" }), props, `${event} keeps only its closed values`);
	}
	for (const [event, key, value] of [
		["agent:connect_opened", "entry", "toolbar"], ["agent:connect_started", "provider", "private-cloud"], ["agent:connect_started", "method", "password"],
		["agent:connect_finished", "outcome", "timeout"], ["agent:connect_finished", "step", "callback"], ["agent:connect_finished", "duration", "lt1s"],
		["agent:connect_finished", "reason", "EADDRINUSE"], ["agent:connect_finished", "reason", "access_denied: the user said no"],
		["agent:model_changed", "after_failure", "yes"],
	]) assert.deepEqual(sanitizeProps(event, { [key]: value }), {}, `${event} rejects ${key}=${value}`);
}
console.log("PASS connect funnel schemas: closed entries, providers, methods, outcomes, steps, durations and failure reasons");

// U1: the update notice's closed schemas and caps. Never a version string, path, command or npm output.
{
	friction.reset();
	const sent = [];
	const restoreUpdate = updateTelemetrySeam((event, props) => sent.push({ event, props }), null);
	const valid = {
		"update:notice_shown": { kind: "npx", behind: "major" },
		"update:clicked": { action: "release_notes", kind: "global" },
		"update:finished": { outcome: "failed", error_class: "node_version", duration: "1-2m" },
	};
	for (const [event, props] of Object.entries(valid)) {
		assert.deepEqual(sanitizeProps(event, { ...props, version: "3.1.5", command: "npm install -g cozyclay@latest", stderr: "npm error code EACCES" }), props, `${event} keeps only its closed values`);
	}
	for (const [event, key, value] of [
		["update:notice_shown", "kind", "clone"], ["update:notice_shown", "behind", "3.1.5"], ["update:clicked", "action", "retry"], ["update:clicked", "kind", "hosted"],
		["update:finished", "outcome", "restart_needed"], ["update:finished", "error_class", "EACCES"], ["update:finished", "duration", 41000],
	]) assert.deepEqual(sanitizeProps(event, { [key]: value }), {}, `${event} rejects ${key}=${value}`);
	const shown = { view: "available", kind: "global", behind: "patch" };
	for (let i = 0; i < 3; i += 1) noteNoticeShown(shown);
	for (let i = 0; i < 14; i += 1) noteUpdateClicked(i % 2 ? "later" : "copy_command", "npx");
	for (let i = 0; i < 5; i += 1) noteUpdatePolled({ phase: "failed", errorClass: "network", durationMs: 1000 * (i + 1), latest: "3.1.5" });
	const count = (event) => sent.filter((row) => row.event === event).length;
	assert.deepEqual([count("update:notice_shown"), count("update:clicked"), count("update:finished")], [1, 10, 3], "caps: notice once, clicks 10, finished 3 per session");
	for (const { event, props } of sent) assert.deepEqual(sanitizeProps(event, props), props, `${event} passes its closed schema`);
	restoreUpdate();
	friction.reset();
}
console.log("PASS update:notice_shown, update:clicked and update:finished: closed schemas and the 1/10/3 caps");

// PR A: agent:prompt_sent. Words stay on the device; only a length bucket and a similarity grade leave.
{
	const { promptTokens, similarityGrade, bucketPromptLength } = promptTelemetry;
	assert.deepEqual([...promptTokens("Make HER walk, slowly! 2 steps—then wave.")], ["make", "her", "walk", "slowly", "2", "steps", "then", "wave"], "lowercase words split on non-letters/digits");
	assert.deepEqual([...promptTokens("Café 走る café")], ["café", "走る"], "letters of any script; a Set");
	const base = promptTokens("make the actor walk to the door and wave");
	assert.equal(similarityGrade(null, base), "first");
	assert.equal(similarityGrade(base, promptTokens("Make the actor walk to the door, and wave!")), "same");
	assert.equal(similarityGrade(base, promptTokens("make the actor run to the door and wave twice")), "near");
	assert.equal(similarityGrade(base, promptTokens("frame a close shot of the cup")), "different");
	assert.equal(similarityGrade(new Set(), new Set()), "same", "two prompts with no words are the same");
	assert.deepEqual([1, 20, 21, 80, 81, 240, 241, 5000].map(bucketPromptLength), ["1-20", "1-20", "21-80", "21-80", "81-240", "81-240", "gte241", "gte241"]);
	const valid = { turn_id: "f".repeat(32), provider: "anthropic", via: "retry_button", prompt_len: "21-80", compose_ms: "10-30s", similarity: "near",
		gap: "first", prev_outcome: "failed", turn_index: "3", attached: false, task_mode: true };
	assert.deepEqual(sanitizeProps("agent:prompt_sent", { ...valid, prompt: "secret", text: "secret" }), valid, "agent:prompt_sent keeps only closed values");
	assert.deepEqual(sanitizeProps("agent:prompt_sent", { gap: "2-5m" }), { gap: "2-5m" });
	for (const [key, value] of [["via", "keyboard"], ["prompt_len", 42], ["similarity", 0.7], ["gap", "lt1s"], ["prev_outcome", "error"], ["turn_index", 3], ["provider", "private-cloud"]]) {
		assert.deepEqual(sanitizeProps("agent:prompt_sent", { [key]: value }), {}, `agent:prompt_sent rejects ${key}=${value}`);
	}
}
// #929 review: an accepted steering message consumed the draft, so its typing time is not the next prompt's.
{
	let clock = 0;
	const restore = promptTelemetry.promptTelemetrySeam(() => clock);
	const composed = (consumed) => {
		promptTelemetry.noteDraftInput(); clock += 2000;                 // a steering message typed during a turn
		if (consumed) promptTelemetry.noteDraftConsumed();               // the running turn took it
		clock += 180_000;
		promptTelemetry.noteDraftInput(); clock += 500;                  // the next prompt, typed in half a second
		promptTelemetry.stagePrompt("next prompt", { via: "typed" });
		return promptTelemetry.takePrompt("e".repeat(32)).compose_ms;
	};
	assert.equal(composed(false), "2-5m", "without the reset the steer's keystroke inflates the next prompt");
	assert.equal(composed(true), "lt10s", "after an accepted steer composing starts over");
	restore();
}
console.log("PASS agent:prompt_sent: device-side words, Jaccard grades, length buckets and the closed schema");

// PR B base: the four bus friction events have closed schemas, and the
// post-turn window counts only the user's edit gestures for 120 s.
{
	const turn = "c".repeat(32);
	assert.deepEqual([0, 9999, 10_000, 30_000, 60_000, 120_000, 300_000, NaN].map(bucketLong), ["lt10s", "lt10s", "10-30s", "30-60s", "1-2m", "2-5m", "gte5m", "lt10s"]);
	assert.deepEqual([0, 1999, 2000, 10_000, 60_000, -1].map(bucketAge), ["lt2s", "lt2s", "2-10s", "10-60s", "gte60s", "lt2s"]);
	assert.deepEqual(["STALE_SCENE", "PRIVATE", "", undefined].map(refusalCodeOf), ["STALE_SCENE", "other", "other", "other"]);
	const valid = {
		"studio:refused": { code: "TARGET_BUSY", origin: "agent", phase: "admission", group: "shot", command: "shot.setCameraRail" },
		"edit:undone": { age: "2-10s", kind: "agent_turn", via: "key", result: "done" },
		"agent:turn_summary": { turn_id: turn, outcome: "cancelled", wall: "1-2m", first_tool: "lt10s", tool_calls: "4-5", tool_failed: "1", refused: "1", refusal_top: "STALE_SCENE",
			stale_retry: "0", authored: true, drafts: "3", qa_first: "problems", qa_last: "clean", qa_trend: "improved", stuck: false, cancel_phase: "during_tool" },
		"agent:post_turn_edit": { turn_id: turn, edited: true, pose: "2", camera: "0", object: "1", shot: "0", prompt_block: "0", first_delay: "10-30s" },
	};
	for (const [event, props] of Object.entries(valid)) {
		assert.deepEqual(sanitizeProps(event, { ...props, prompt_text: "private", name: "Private" }), props, `${event} keeps its closed values and nothing else`);
		for (const key of Object.keys(props)) {
			for (const unsafe of ["private value", "PRIVATE", 7, null, {}, "gte12", "TURN".repeat(8)]) {
				if (props[key] === unsafe) continue;
				assert.equal(Object.hasOwn(sanitizeProps(event, { [key]: unsafe }), key), false, `${event} rejects ${key}=${JSON.stringify(unsafe)}`);
			}
		}
	}
	assert.deepEqual(sanitizeProps("agent:turn_summary", { refusal_top: "none" }), { refusal_top: "none" });
	assert.deepEqual(sanitizeProps("studio:refused", { origin: "mcp" }), {}, "an MCP refusal is reported as agent, never mcp");
	assert.equal(strictPropValidator("scene:loaded"), null, "events without a closed schema keep the generic rule");


	let clock = 1000, timer = null;
	const timers = { now: () => clock, set: (fn, ms) => { timer = { fn, ms }; return 1; }, clear: () => { timer = null; } };
	const emitted = [];
	const emit = (event, props) => emitted.push({ event, props });
	const userEdit = (group) => postTurn.noteEditGesture(group);
	assert.equal(userEdit("pose"), false, "no window, nothing counted");
	postTurn.openPostTurnWindow(turn, emit, timers);
	assert.equal(timer.ms, postTurn.POST_TURN_WINDOW_MS);
	clock += 15_000; userEdit("pose"); userEdit("pose"); userEdit("object");
	assert.equal(userEdit("private_group"), false);
	timer.fn();
	assert.deepEqual(emitted.pop(), { event: "agent:post_turn_edit", props: { turn_id: turn, edited: true, pose: "2", camera: "0", object: "1", shot: "0", prompt_block: "0", first_delay: "10-30s" } }, "the 120 s timer closes the window");
	assert.deepEqual(sanitizeProps("agent:post_turn_edit", valid["agent:post_turn_edit"]), valid["agent:post_turn_edit"]);
	assert.equal(postTurn.closePostTurnWindow(), null, "a closed window closes once");
	postTurn.openPostTurnWindow(turn, emit, timers);
	postTurn.openPostTurnWindow("d".repeat(32), emit, timers);
	assert.deepEqual(emitted.pop().props, { turn_id: turn, edited: false, pose: "0", camera: "0", object: "0", shot: "0", prompt_block: "0" }, "the next window closes the previous one; no edit, no first_delay");
	clock += postTurn.POST_TURN_WINDOW_MS;
	assert.equal(userEdit("shot"), false, "a late edit past 120 s (timer not yet fired) closes the window instead of counting");
	assert.equal(emitted.pop().props.edited, false);
	postTurn.openPostTurnWindow(turn, () => { throw new Error("transport"); }, timers);
	assert.doesNotThrow(() => postTurn.closePostTurnWindow(), "a failing transport cannot break editing");
	console.log("PASS bus friction schemas, and the post-turn window: 120 s, next turn, closed groups only");
}
// export:menu_opened: surface, mode, a synchronous WebCodecs check and the shot
// (storyboard: panel) count bucket; nothing else leaves.
{
	const encoder = { VideoEncoder: class {}, VideoFrame: class {} };
	const shots = [{ kind: "clip" }, { kind: "still" }, { kind: "still" }, { kind: "clip" }, { kind: "clip" }];
	assert.deepEqual(exportMenuOpenedProps({ embedMode: false, previsMode: "animation", shots }, encoder),
		{ surface: "studio", mode: "animation", webcodecs: true, shots: "4-10" });
	assert.deepEqual(exportMenuOpenedProps({ embedMode: true, previsMode: "storyboard", shots }, {}),
		{ surface: "embed", mode: "storyboard", webcodecs: false, shots: "1-3" }, "storyboard counts panels; no VideoEncoder reads false");
	assert.deepEqual(exportMenuOpenedProps({ previsMode: undefined, shots: undefined }, { VideoEncoder: class {} }),
		{ surface: "studio", mode: "animation", webcodecs: false, shots: "0" }, "VideoEncoder without VideoFrame is not WebCodecs");
	const props = exportMenuOpenedProps({ embedMode: false, previsMode: "animation", shots }, encoder);
	assert.deepEqual(sanitizeProps("export:menu_opened", { ...props, shot_id: "s1", name: "Private" }), props, "only the closed properties pass");
	assert.deepEqual(STRICT_EVENT_KEYS["export:menu_opened"], ["surface", "mode", "webcodecs", "shots"]);
	for (const [key, value] of [["surface", "workflow"], ["mode", "film"], ["webcodecs", "true"], ["shots", 5], ["shots", "2"]]) {
		assert.deepEqual(sanitizeProps("export:menu_opened", { [key]: value }), {}, `export:menu_opened rejects ${key}=${value}`);
	}
	console.log("PASS export:menu_opened closed props: surface, mode, webcodecs, shots bucket");
}
// P2-b: shortcut:ignored, shortcut:unbound, help:shortcuts_opened, search:no_results,
// nav:thrash and camera:thrash. Closed values only, input elements and IME never
// read, each detector's window, threshold, cooldown and cap.
{
	friction.reset();
	const valid = {
		"shortcut:ignored": { key_class: "undo", reason: "empty_history" },
		"shortcut:unbound": { combo: "select_all" },
		"search:no_results": { surface: "outliner", query_len: "4-8" },
		"nav:thrash": { surface: "dock_tab", switches: "6-10", window_s: 10 },
		"camera:thrash": { gestures: "gte11", kind_mix: "mixed", window_s: 20 },
	};
	for (const [event, props] of Object.entries(valid)) {
		assert.deepEqual(sanitizeProps(event, { ...props, key: "z", query: "private", name: "Private" }), props, `${event} keeps only its closed values`);
	}
	for (const [event, key, value] of [
		["shortcut:ignored", "key_class", "KeyZ"], ["shortcut:ignored", "key_class", "escape"], ["shortcut:ignored", "key_class", "play"], ["shortcut:ignored", "reason", "nothing"],
		["shortcut:unbound", "combo", "save"], ["shortcut:unbound", "combo", "c"], ["search:no_results", "surface", "log"], ["search:no_results", "query_len", 3],
		["nav:thrash", "switches", "3"], ["nav:thrash", "window_s", "10"], ["nav:thrash", "surface", "assets"], ["camera:thrash", "gestures", "4-5"], ["camera:thrash", "window_s", 10], ["camera:thrash", "kind_mix", "dolly"],
	]) assert.deepEqual(sanitizeProps(event, { [key]: value }), {}, `${event} rejects ${key}=${value}`);
	assert.deepEqual(sanitizeProps("help:shortcuts_opened", { from: "menu", key: "?" }), {}, "help:shortcuts_opened carries nothing");
	assert.deepEqual(STRICT_EVENT_KEYS["help:shortcuts_opened"], []);

	// The combo list is closed (at most 12 names) and every name passes the schema; the key character never leaves.
	assert.ok(shortcuts.UNBOUND_COMBOS.length <= 12);
	for (const combo of shortcuts.UNBOUND_COMBOS) assert.deepEqual(sanitizeProps("shortcut:unbound", { combo }), { combo });
	const key = (code, mods = {}, rest = {}) => ({ code, key: rest.key ?? code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, defaultPrevented: false, target: { tagName: "BODY" }, ...mods, ...rest });
	assert.deepEqual([
		key("KeyC", { ctrlKey: true }), key("KeyV", { metaKey: true }), key("KeyX", { ctrlKey: true }), key("KeyA", { metaKey: true }), key("KeyG", { ctrlKey: true }),
		key("KeyF", { metaKey: true }), key("F2"), key("Slash", { shiftKey: true }), key("Slash", { ctrlKey: true }),
		key("KeyC"), key("KeyC", { ctrlKey: true, shiftKey: true }), key("KeyC", { ctrlKey: true, altKey: true }), key("KeyS", { ctrlKey: true }), key("KeyZ", { metaKey: true }), key("F2", { shiftKey: true }), key("Slash"),
	].map(shortcuts.comboOf), ["copy", "paste", "cut", "select_all", "group", "find", "rename", "help", "help", null, null, null, null, null, null, null]);

	let deferred = [];
	const sent = [];
	const restoreShortcuts = shortcuts.shortcutFrictionSeam({ track: (event, props) => sent.push({ event, props }), defer: (run) => deferred.push(run) });
	const flush = () => { for (const run of deferred.splice(0)) run(); };
	// The input guard: text fields, list boxes, editable areas and IME composition are never read.
	for (const target of [{ tagName: "INPUT" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" }, { tagName: "DIV", isContentEditable: true }]) {
		assert.equal(shortcuts.noteUnboundKey(key("KeyA", { ctrlKey: true }, { target })), null, `${target.tagName} is typing`);
	}
	assert.equal(shortcuts.noteUnboundKey(key("KeyA", { ctrlKey: true }, { isComposing: true })), null, "an IME composition is typing");
	assert.equal(shortcuts.noteUnboundKey(key("KeyA", { ctrlKey: true }, { keyCode: 229 })), null, "the legacy IME keyCode is typing");
	assert.equal(shortcuts.noteUnboundKey(key("KeyA", { ctrlKey: true }, { repeat: true })), null, "a held key is one press");
	assert.equal(deferred.length, 0);
	// Judged after dispatch: a combo some handler claimed is bound.
	const claimed = key("KeyF", { ctrlKey: true });
	assert.equal(shortcuts.noteUnboundKey(claimed), "find");
	claimed.defaultPrevented = true; flush();
	for (let i = 0; i < 5; i += 1) { shortcuts.noteUnboundKey(key("KeyG", { metaKey: true })); flush(); }
	assert.deepEqual(sent.splice(0), Array.from({ length: 3 }, () => ({ event: "shortcut:unbound", props: { combo: "group" } })), "3 per combo per session; a claimed combo sends nothing");

	// shortcut:ignored: 5 per class, the counter counts every press.
	for (let i = 0; i < 7; i += 1) shortcuts.noteShortcutIgnored("mode", "workflow_mode");
	assert.equal(sent.splice(0).length, 5, "5 per key class per session");
	assert.equal(friction.snapshot().shortcut_ignored, "6-10", "past the cap the shortcut_ignored counter keeps counting");
	shortcuts.noteHistoryKey("undo", { ok: true, status: "noop" });
	shortcuts.noteHistoryKey("redo", { ok: false, code: "TARGET_BUSY" });
	shortcuts.noteHistoryKey("undo", { ok: true, status: "undone" });
	assert.deepEqual(sent.splice(0).map(({ props }) => props), [{ key_class: "undo", reason: "empty_history" }, { key_class: "redo", reason: "busy" }], "an undo that stepped is not ignored");
	// The selection gate: F, Ctrl/Cmd+D and Delete with nothing selected; another handler's claim wins.
	for (const event of [key("KeyF"), key("KeyD", { metaKey: true }), key("Delete", {}, { key: "Delete" }), key("Backspace", {}, { key: "Backspace" }), key("KeyF", { ctrlKey: true }), key("Escape", {}, { key: "Escape" }), key("KeyF", {}, { isComposing: true })]) shortcuts.noteUnselectedKey(event);
	const owned = key("Delete", {}, { key: "Delete" }); shortcuts.noteUnselectedKey(owned); owned.defaultPrevented = true;
	flush();
	assert.deepEqual(sent.splice(0).map(({ props }) => props.key_class), ["frame", "duplicate", "delete", "delete"], "Ctrl+F is left to find, Escape and IME are not classes, a claimed Delete is not ignored");
	for (let i = 0; i < 4; i += 1) shortcuts.noteShortcutsOpened();
	assert.deepEqual(sent.splice(0), Array.from({ length: 3 }, () => ({ event: "help:shortcuts_opened", props: {} })), "help: 3 per session");
	restoreShortcuts();

	// search:no_results: 1 s stable, once per query, 3 per surface per session.
	assert.deepEqual([1, 2, 3, 4, 8, 9, 40].map(search.bucketQueryLength), ["1", "2-3", "2-3", "4-8", "4-8", "gte9", "gte9"]);
	let timers = new Map(), nextTimer = 1;
	const searchSent = [];
	const restoreSearch = search.searchFrictionSeam({ track: (event, props) => searchSent.push({ event, props }), set: (run, ms) => { timers.set(nextTimer, { run, ms }); return nextTimer++; }, clear: (id) => timers.delete(id) });
	const fire = () => { for (const [id, { run }] of [...timers]) { timers.delete(id); run(); } };
	search.watchNoResults("assets", "")(); search.watchNoResults("assets", "   "); search.watchNoResults("timeline", "abc");
	assert.equal(timers.size, 0, "an empty query or an unknown surface watches nothing");
	const cancel = search.watchNoResults("assets", "chai");
	assert.equal([...timers.values()][0].ms, 1000);
	cancel();
	assert.equal(timers.size, 0, "a query changed (or results back) within 1 s sends nothing");
	search.watchNoResults("outliner", "  my private sofa  "); fire();
	assert.deepEqual(searchSent.splice(0), [{ event: "search:no_results", props: { surface: "outliner", query_len: "gte9" } }], "only the trimmed length leaves");
	for (let i = 0; i < 4; i += 1) { search.watchNoResults("assets", "zz"); fire(); }
	assert.equal(searchSent.splice(0).length, 3, "3 per surface per session");
	assert.equal(friction.snapshot().search_empty, "4-5", "the search_empty counter counts every empty search");
	restoreSearch();

	// nav:thrash and camera:thrash: window, threshold, edits in between, cooldown.
	let clock = 100_000, lastEdit = -Infinity;
	timers = new Map();
	const thrashSent = [];
	const restoreThrash = thrash.thrashSeam({ track: (event, props) => thrashSent.push({ event, props }), now: () => clock, lastEditAt: () => lastEdit,
		set: (run, ms) => { timers.set(nextTimer, { run, at: clock + ms }); return nextTimer++; }, clear: (id) => timers.delete(id) });
	const advance = (ms) => { clock += ms; for (const [id, { run, at }] of [...timers]) if (at <= clock) { timers.delete(id); run(); } };
	const flip = (surface, times, gap = 500) => { for (let i = 0; i < times; i += 1) { thrash.noteNavSwitch(surface); advance(gap); } };
	flip("dock_tab", 3); advance(20_000);
	assert.equal(thrashSent.length, 0, "3 switches are not a thrash");
	flip("dock_tab", 4, 4000); advance(20_000);
	assert.equal(thrashSent.length, 0, "4 switches spread over more than 10 s are not a thrash");
	flip("dock_tab", 4);
	assert.equal(thrashSent.length, 0, "the window stays open until 10 s after its first switch");
	flip("dock_tab", 3); advance(10_000);
	assert.deepEqual(thrashSent.splice(0), [{ event: "nav:thrash", props: { surface: "dock_tab", switches: "6-10", window_s: 10 } }], "7 switches inside the 10 s window");
	flip("dock_tab", 5); advance(10_000);
	assert.equal(thrashSent.length, 0, "inside the 30 s cooldown only the counter moves");
	flip("mode", 4); advance(10_000);
	assert.deepEqual(thrashSent.splice(0).map(({ props }) => props), [{ surface: "mode", switches: "4-5", window_s: 10 }], "the cooldown is per surface");
	advance(30_000);
	flip("dock_tab", 2); lastEdit = clock; flip("dock_tab", 3); advance(10_000);
	assert.equal(thrashSent.length, 0, "an edit in between resets the count");
	flip("dock_tab", 2); lastEdit = clock + 1; flip("dock_tab", 2); advance(10_000);
	assert.equal(thrashSent.length, 0, "an edit inside an open window drops the switches before it");
	// #932 review: switches at 0-3 s open a window; an edit at 4 s; then 6, 7, 8 and 11 s are four
	// switches in five seconds with no edit between them: the old window gives way to a new one.
	advance(31_000);
	flip("dock_tab", 4, 1000); lastEdit = clock; advance(2000); flip("dock_tab", 3, 1000); advance(2000); thrash.noteNavSwitch("dock_tab"); advance(10_000);
	assert.deepEqual(thrashSent.splice(0).map(({ props }) => props), [{ surface: "dock_tab", switches: "4-5", window_s: 10 }], "an edit inside an open window restarts it with the switches after the edit");
	assert.equal(timers.size, 0, "the cancelled window leaves no timer");
	thrash.noteNavSwitch("details"); assert.equal(timers.size, 0, "an unknown surface is ignored");
	flip("agent_panel", 12, 100); advance(10_000);
	assert.deepEqual(thrashSent.splice(0).map(({ props }) => props.switches), ["gte11"], "agent_panel thrashes like any surface"); assert.match(readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8"), /const toggle = \(event\) => \{ notePanelToggled\([^;]*\); noteNavSwitch\("agent_panel"\); setAgentCollapsed/, "the agent panel toggle reports an agent_panel switch");
	assert.equal(friction.snapshot().nav_thrash, "4-5", "nav_thrash counts every thrash: dock_tab, its cooled-down repeat, mode and agent_panel");
	const move = (kinds, gap = 1000) => { for (const kind of kinds) { thrash.noteCameraGesture(kind); advance(gap); } };
	move(["orbit", "orbit", "orbit", "orbit", "orbit"]); advance(30_000);
	assert.equal(thrashSent.length, 0, "5 gestures are not a camera thrash");
	move(["orbit", "orbit", "orbit", "orbit", "orbit", "orbit", "dolly"]); advance(20_000);
	assert.deepEqual(thrashSent.splice(0), [{ event: "camera:thrash", props: { gestures: "6-10", kind_mix: "orbit", window_s: 20 } }], "6 orbits in 20 s; an unknown kind is ignored");
	advance(30_000);
	move(["orbit", "fly", "pan", "pan", "fly", "orbit"], 3000); advance(20_000);
	assert.deepEqual(thrashSent.splice(0).map(({ props }) => props.kind_mix), ["mixed"], "6 gestures over 15 s of mixed kinds");
	move(["pan", "pan", "pan", "pan", "pan", "pan"], 5000); advance(20_000);
	assert.equal(thrashSent.length, 0, "6 gestures over 25 s are outside the 20 s window");
	assert.equal(friction.snapshot().camera_thrash, "2");
	restoreThrash();
	friction.reset();
}
console.log("PASS shortcut, search and thrash friction: closed combos and classes, input/IME guard, 1 s search, 10 s/20 s windows, 30 s cooldowns and caps");
assert.deepEqual(sanitizeProps("export:blocking_frame_succeeded", { ...allProps, format: "png" }), { format: "png" });

// Previs events (#653): closed values only, never a caption, name or prompt.
for (const previs_mode of ["storyboard", "animation"]) assert.deepEqual(sanitizeProps("scene:created", { scene_source: "ui", previs_mode }), { scene_source: "ui", previs_mode });
assert.deepEqual(sanitizeProps("scene:created", { scene_source: "ui", previs_mode: "private mode" }), { scene_source: "ui" });
const previsContracts = {
	"storyboard:panel_created": { key: "source", good: ["agent", "manual"], bad: ["mcp", "private", true, 1, null] },
	"storyboard:panel_stylized": { key: "outcome", good: ["ok", "error"], bad: ["succeeded", "private", true, 1, null] },
	"cast:proxy_added": { key: "surface", good: ["assets", "agent", "mcp"], bad: ["studio", "private", true, 1, null] },
};
for (const [event, { key, good, bad }] of Object.entries(previsContracts)) {
	for (const value of good) assert.deepEqual(sanitizeProps(event, { [key]: value }), { [key]: value }, `${event} keeps ${key}=${value}`);
	for (const value of bad) assert.deepEqual(sanitizeProps(event, { [key]: value }), {}, `${event} rejects ${key}=${String(value)}`);
	assert.deepEqual(
		sanitizeProps(event, { [key]: good[0], caption: "A man opens the door", name: "Panel 1", prompt: "secret", text: "x", shot_id: "shot-1", character_id: "c1", count: 3 }),
		{ [key]: good[0] },
		`${event} drops captions, names, prompts and ids`,
	);
	assert.deepEqual(sanitizeProps(event, { caption: "A man opens the door" }), {}, `${event} with only a caption sends nothing`);
}
for (const export_kind of ["contact_sheet", "panel_pack", "animatic", "animation_project", "workflow_send"]) {
	assert.deepEqual(sanitizeProps("export:attempt_started", { export_kind }), { export_kind }, `export_kind ${export_kind}`);
}
assert.deepEqual(sanitizeProps("export:attempt_started", { export_kind: "panel pack" }), {});

// Sculpt mode (#739): one sculpt_run per ended run; closed outcome, bounded numbers.
const sculptRunContracts = {
	outcome: { good: ["done", "cancelled", "failed"], bad: ["score", "idle", "private", true, 1, null] },
	rounds: { good: [0, 1, 3], bad: [-1, 1.5, 11, "2", true, null] },
	final_iou: { good: [0, 0.5, 0.95, 1], bad: [-0.1, 1.2, NaN, "0.9", true, null] },
	duration_ms: { good: [0, 1200, 180000], bad: [-1, Infinity, "100", true, null] },
	had_target: { good: [true, false], bad: ["true", 1, null] },
};
for (const [key, { good, bad }] of Object.entries(sculptRunContracts)) {
	for (const value of good) assert.deepEqual(sanitizeProps("sculpt_run", { [key]: value }), { [key]: value }, `sculpt_run keeps ${key}=${value}`);
	for (const value of bad) assert.deepEqual(sanitizeProps("sculpt_run", { [key]: value }), {}, `sculpt_run rejects ${key}=${String(value)}`);
}
assert.deepEqual(sanitizeProps("sculpt_run", { final_iou: 0.9449, duration_ms: 1234.6, recipe: {}, sculpt_id: "obj-1", name: "Snorlax" }), { final_iou: 0.94, duration_ms: 1235 });
assert.equal(analytics.sculptRunTelemetry({ stage: "score", round: 1, iou: 0.8, elapsedMs: 10 }), null);
assert.deepEqual(
	analytics.sculptRunTelemetry({ stage: "done", round: 2, iou: 0.9449, elapsedMs: 61234.4 }, { hadTarget: true }),
	{ outcome: "done", rounds: 2, final_iou: 0.94, duration_ms: 61234, had_target: true },
);
assert.deepEqual(
	analytics.sculptRunTelemetry({ stage: "failed", round: 0, iou: null, elapsedMs: 900 }),
	{ outcome: "failed", rounds: 0, duration_ms: 900, had_target: false },
);

const privacyHtml = readFileSync(new URL("../tools/dev/pages/privacy.html", import.meta.url), "utf8");
for (const event of removedEvents) assert.equal(privacyHtml.includes(event), false, `the privacy page no longer lists ${event}`);
console.log("PASS removed motion-generation and sample events stay off the allowlist and the privacy page");
const shippedPrivacyHtml = readFileSync(new URL("../privacy/index.html", import.meta.url), "utf8");
assert.ok(shippedPrivacyHtml.includes(privacyHtml.split("\n---\n")[1].trimEnd()), "the shipped privacy body matches its source disclosure");
const exportDisclosure = new Map();
for (const row of privacyHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
	const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => cell[1].replace(/<[^>]*>/g, " "));
	for (const event of cells[0]?.match(/\bexport:[a-z_]+\b/g) ?? []) {
		exportDisclosure.set(event, new Set(cells[1]?.match(/\b[a-z][a-z0-9_]*\b/g) ?? []));
	}
}
assert.deepEqual([...exportDisclosure.keys()].sort(), [
	...lifecycleEvents, "export:keyframe_pack", "export:video_succeeded", "export:blocking_frame_succeeded", "export:saved", "export:menu_opened",
].sort(), "the disclosure event tokens match the export contract");
for (const property of STRICT_EVENT_KEYS["export:menu_opened"]) {
	assert.ok(exportDisclosure.get("export:menu_opened").has(property), `export:menu_opened discloses ${property}`);
}
for (const event of [...lifecycleEvents, "export:keyframe_pack"]) {
	for (const property of Object.keys(sanitizeProps(event, allProps))) {
		assert.ok(exportDisclosure.get(event).has(property), `${event} discloses schema token ${property}`);
	}
}
for (const failure_code of ["unsupported_codec", "encode_failed", "render_failed", "aborted", "unknown"]) {
	assert.ok(exportDisclosure.get("export:attempt_failed").has(failure_code), `disclosed failure enum includes ${failure_code}`);
}

for (const capture of [() => { throw new Error("transport failed"); }, async () => { throw new Error("async transport failed"); }]) {
	const run = fixture(descriptor, capture);
	assert.doesNotThrow(() => run.attempt.succeed());
	assert.doesNotThrow(() => run.attempt.fail(hostileError));
}
const clockEvents = [];
const brokenClock = startExportAttempt(descriptor, {
	now() { throw new Error("clock unavailable"); },
	capture(event, props) { clockEvents.push({ event, props }); },
});
assert.doesNotThrow(() => brokenClock.succeed());
assert.equal(clockEvents.length, 2, "clock failure does not lose pairing");
assert.equal(clockEvents[1].props.duration_bucket, "lt1s");
const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
try {
	Object.defineProperty(globalThis, "crypto", { configurable: true, get() { throw new Error("random unavailable"); } });
	const run = fixture();
	assert.doesNotThrow(() => run.attempt.succeed());
	assert.doesNotThrow(() => run.attempt.fail(new Error("export error")));
	assert.deepEqual(run.events, [], "without a secure random ID telemetry is omitted rather than affecting export");
} finally {
	Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
}
const performanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, "performance");
try {
	Object.defineProperty(globalThis, "performance", { configurable: true, get() { throw new Error("global clock unavailable"); } });
	const events = [];
	const attempt = startExportAttempt(descriptor, { capture(event, props) { events.push({ event, props }); } });
	assert.doesNotThrow(() => attempt.fail(new Error("render failure"), "render_failed"));
	assert.equal(events.length, 2, "a throwing global clock cannot prevent the terminal event");
	assert.equal(events[1].props.duration_bucket, "lt1s");
	assert.equal(events[1].props.failure_code, "render_failed");
} finally {
	Object.defineProperty(globalThis, "performance", performanceDescriptor);
}
try {
	Object.defineProperty(globalThis, "crypto", {
		configurable: true, value: { getRandomValues() { throw new Error("random generation failed"); } },
	});
	const run = fixture();
	assert.doesNotThrow(() => run.attempt.fail(new Error("render failure"), "render_failed"));
	assert.deepEqual(run.events, [], "a throwing random generator cannot block export error handling");
} finally {
	Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
}
// Drain rejected capture promises without timers; any unhandled rejection fails Node.
await Promise.resolve();
console.log("PASS export lifecycle pairing, async failure/cancellation, durations and duplicate suppression");
console.log("PASS export allowlists, legacy payloads and analytics failure noninterference");
console.log("PASS disclosure event/schema tokens and global clock/random failure noninterference");

// First-edit version 2 is a closed vocabulary, never a free-text payload; version 1 rows are no longer sent.
const disclosedEvents = new Set([...privacyHtml.matchAll(/<td>([a-z_]+:[a-z_]+)<\/td>/g)].map((match) => match[1]));
const editKinds = ["pose_edit", "object_insert", "cutout_insert", "object_transform", "shot_add", "shot_edit", "camera_key_record", "rail_edit", "prompt_block_add", "prompt_block_edit"];
for (const event of ["craft:first_edit", "playground:first_edit"]) {
	assert.ok(disclosedEvents.has(event), `${event} has a telemetry disclosure row`);
	for (const edit_kind of editKinds) assert.deepEqual(sanitizeProps(event, { edit_kind, definition_version: 2, prompt: "private" }), { edit_kind, definition_version: 2 });
	for (const edit_kind of ["private-name", "path/to/file", 1, true, null]) assert.deepEqual(sanitizeProps(event, { edit_kind }), {});
	for (const definition_version of ["2", 1, 0, true, "private", null]) assert.deepEqual(sanitizeProps(event, { definition_version }), {});
}

// First edits and edit buckets come from the user's own command-bus receipts (#924,
// command-bus-telemetry.js), one per committed receipt, never from a domain diff.
const { createHistoryReceipts, startUserEdits, telemetrySeam } = await import("../src/command-bus-telemetry.js");
{
	const sent = [];
	const restoreSeam = telemetrySeam({ track: (event, props) => sent.push({ event, props }) });
	const receipts = createHistoryReceipts({});
	let n = 0;
	const commit = (id, { origin = "ui", authored = true, ok = true, txId = `tx-${n}`, action, args } = {}) =>
		receipts.remember({ ok, authored, receiptId: `r-${++n}`, txId }, { id, origin, action, args });
	const firstEdits = () => sent.splice(0).filter(({ event }) => event.endsWith(":first_edit"));
	const buckets = () => analytics.sessionEditBuckets();
	const groupOf = (kind) => Object.entries(analytics.EDIT_GROUPS).find(([, kinds]) => kinds.includes(kind))[0];
	const matrix = [
		["pose_edit", "character.setPose"], ["object_insert", "object.add"], ["cutout_insert", "asset.import", { placeAs: "cutout" }],
		["object_transform", "object.set"], ["shot_add", "shot.create"], ["shot_edit", "shot.setRange"],
		["camera_key_record", "shot.addKey"], ["rail_edit", "shot.setCamera", { patch: { cameraRail: [] } }], ["prompt_block_edit", "motion.set"],
	];
	try {
		for (const surface of ["craft", "playground"]) {
			for (const [kind, id, args] of matrix) {
				startUserEdits(surface);
				const before = buckets();
				commit(id, { authored: false, args }); // passive write or no-op
				commit(id, { ok: false, authored: false, args }); // refused
				commit(id, { origin: "agent", args });
				commit(id, { origin: "mcp", args });
				commit("edit.undo"); commit("edit.redo");
				assert.deepEqual(firstEdits(), [], `${surface}: ${kind}: passive, refused, agent, MCP and history receipts`);
				assert.deepEqual(buckets(), before, `${surface}: ${kind}: and they move no edit bucket`);
				commit(id, { args });
				commit(id, { args }); // a second edit still dedupes at the mount boundary
				assert.deepEqual(firstEdits(), [{ event: `${surface}:first_edit`, props: { edit_kind: kind, definition_version: 2 } }], `${surface}: ${kind}`);
				assert.notEqual(buckets()[`${groupOf(kind)}_edit_bucket`], "0", `${surface}: ${kind} moves its edit bucket`);
			}
		}
		// The first edit is once per surface per mount; a new mount starts a new boundary.
		startUserEdits("craft");
		commit("object.set"); commit("shot.create");
		startUserEdits("playground");
		commit("shot.create");
		assert.deepEqual(firstEdits().map(({ event, props }) => [event, props.edit_kind]), [["craft:first_edit", "object_transform"], ["playground:first_edit", "shot_add"]]);
		// A drag is one transaction: its begin patch names the rail, its commit is one rail_edit.
		startUserEdits("craft");
		commit("run.begin", { authored: false, txId: "drag", args: { args: { patch: { craneHeight: {} } } } });
		commit("run.commit", { txId: "drag", action: "shot.setCamera" });
		assert.deepEqual(firstEdits().map(({ props }) => props.edit_kind), ["rail_edit"], "a crane drag commits one rail edit");
	} finally { restoreSeam(); }
}
console.log("first-edit receipt matrix PASS (9 bus kinds x 2 surfaces; passive/refused/agent/MCP/history/duplicates/drag)");

// The camera tutorial was removed: its events carry no properties any more,
// its feature name is gone, and the privacy table no longer lists them.
for (const event of ["tutorial:started", "tutorial:step_entered", "tutorial:step_completed", "tutorial:completed", "tutorial:dismissed"]) {
	assert.deepEqual(sanitizeProps(event, { surface: "studio", tutorial_version: 1, start_source: "query", step_kind: "fly", elapsed_bucket: "1-3s" }), {}, `${event}: off the allow-list`);
	assert.equal(privacyHtml.includes(event), false, `${event}: not disclosed`);
}
assert.deepEqual(sanitizeProps("feature:used", { name: "camera_tutorial" }), {}, "camera_tutorial is no longer a feature name");
console.log("PASS removed tutorial events stay off the allow-list and the privacy table");

// Run the real init/capture/unload path with only the build environment and
// SDK transport replaced. Each module load is a fresh browser/CLI restart.
const runtimeSource = readFileSync(new URL("../src/analytics.js", import.meta.url), "utf8");
const runtimeGlobals = ["localStorage", "location", "navigator", "window", "fetch", "__COZYCLAY_RUNTIME__", "__cozyclayAnalytics", "__analyticsSdkFixture"];
const savedGlobals = runtimeGlobals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
let runtimeFixtureId = 0;
async function runtimeFixture({
	runtime = { distribution: "npm", telemetryEnabled: true, installationId, appVersion: "1.8.1", apiKey: "test", apiHost: "https://telemetry.invalid", internalQa: false, installKind: "npx" },
	origin = "http://127.0.0.1:5180", search = "", store = new Map(),
	env = { PROD: true, VITE_POSTHOG_KEY: "test", VITE_APP_VERSION: "1.8.1" },
	dnt = false, beacon = true, sync, sessionId = "0192f0d6-3a4b-7c2d-8e9f-abcdefabcdef",
} = {}) {
	const records = [], beacons = [], requests = [];
	const listeners = new Map();
	let options, globals = {}, optedOut = false, distinctId;
	const sdk = {
		init(_key, config) { options = config; distinctId = config.bootstrap?.distinctID ?? `hosted-${runtimeFixtureId}`; },
		register(props) { globals = { ...globals, ...props }; },
		capture(event, props = {}) {
			if (this.has_opted_out_capturing()) return;
			const payload = options.before_send({ event, properties: { ...globals, ...props, distinct_id: distinctId } });
			if (payload) records.push(payload);
		},
		get_distinct_id() { return distinctId; },
		get_session_id() { return sessionId; },
		has_opted_out_capturing() { return optedOut || dnt; },
		opt_out_capturing() { optedOut = true; },
		opt_in_capturing() { optedOut = false; },
	};
	const values = {
		localStorage: {
			getItem: (key) => store.get(key) ?? null,
			setItem: (key, value) => store.set(key, value),
			removeItem: (key) => store.delete(key),
			key: (i) => [...store.keys()][i],
			get length() { return store.size; },
		},
		location: { origin, search, reload() {} },
		navigator: { platform: "MacIntel", doNotTrack: dnt ? "1" : "0",
			...(beacon ? { sendBeacon(url, body) { beacons.push({ url, body }); return true; } } : {}),
		},
		window: { addEventListener(name, handler) { listeners.set(name, handler); } },
		fetch: async (url, init) => {
			requests.push({ url, init });
			if (url === "/__cozyclay/telemetry") {
				if (sync) return sync(url, init);
				const telemetryEnabled = JSON.parse(init.body).enabled;
				return { ok: true, json: async () => ({ ...runtime, telemetryEnabled, installationId: telemetryEnabled ? runtime.installationId : null }) };
			}
			return { ok: false };
		},
		__COZYCLAY_RUNTIME__: runtime, __analyticsSdkFixture: sdk,
	};
	for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	const source = runtimeSource
		// A data: module cannot resolve analytics.js's relative imports itself.
		.replace(/from "\.\/([a-z-]+\.js)"/g, (_match, file) => `from ${JSON.stringify(new URL(`../src/${file}`, import.meta.url).href)}`)
		.replace("import.meta.env", JSON.stringify(env))
		.replace('import("posthog-js")', "Promise.resolve({ default: globalThis.__analyticsSdkFixture })");
	const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${++runtimeFixtureId}`);
	await module.initAnalytics();
	await Promise.resolve(); // settle the resolved health probe, never a timing wait
	return {
		module, records, beacons, requests, store, sdk, options, listeners,
		async unload() {
			listeners.get("pagehide")?.();
			listeners.get("beforeunload")?.();
			return Promise.all(beacons.map(async ({ body }) => JSON.parse(await body.text())));
		},
	};
}
try {
	const globalKeys = ["distribution", "origin_kind", "install_kind", "app_version", "internal_qa", "os"];
	const cohortFixtures = [];
	for (const internalQa of [false, true]) {
		for (const distribution of ["npm", "hosted"]) {
			const run = await runtimeFixture({
				...(distribution === "hosted" ? { runtime: null, origin: "https://cozyclay.org", search: internalQa ? "?internal_qa=1" : "" }
					: { runtime: { distribution, telemetryEnabled: true, installationId, apiKey: "test", appVersion: "1.8.1", apiHost: "https://telemetry.invalid", installKind: "global", internalQa } }),
			});
			run.module.track("scene:loaded", { scene_source: "library", internal_qa: !internalQa, distribution: "forged", prompt: "private" });
			const [ended] = await run.unload();
			assert.equal(run.beacons.length, 2, "pagehide plus beforeunload sends each end event exactly once");
			assert.equal(ended.properties.session_id, "0192f0d6-3a4b-7c2d-8e9f-abcdefabcdef", `${distribution} session end carries the SDK session id`);
			for (const record of run.records) {
				assert.equal(record.properties.internal_qa, internalQa, "every capture carries the declared marker, never event-supplied overrides");
				for (const key of globalKeys) assert.equal(ended.properties[key], record.properties[key], `${distribution} beacon/capture parity: ${key}`);
				assert.equal(ended.properties.distinct_id, record.properties.distinct_id);
				assert.equal(Object.hasOwn(record.properties, "prompt"), false);
			}
			assert.equal(run.options.bootstrap?.isIdentifiedID, distribution === "npm" ? false : undefined);
			cohortFixtures.push(...run.records);
		}
	}
	{
		const run = await runtimeFixture({ runtime: null, origin: "https://cozyclay.org", env: { PROD: true, VITE_POSTHOG_KEY: "test" } });
		run.module.track("scene:loaded", { scene_source: "library" });
		const [ended] = await run.unload();
		assert.equal(run.records.at(-1).properties.app_version, packageInfo.version, "a hosted build without VITE_APP_VERSION registers the package version");
		assert.equal(ended.properties.app_version, packageInfo.version, "the hosted beacon carries the same app_version");
		console.log("PASS hosted builds fall back to the package version for app_version");
	}
	{
		const run = await runtimeFixture({ sessionId: "private session" });
		const before = run.records.length;
		run.module.track("private:unlisted", { scene_source: "library" });
		run.module.track("motion:compile_private", {});
		assert.equal(run.records.length, before, "an event the allowlist does not name is dropped, not sent with empty props");
		run.module.track("scene:loaded", { scene_source: "library" });
		assert.equal(run.records.at(-1).event, "scene:loaded", "allowlisted events still send");
		const [ended] = await run.unload();
		assert.equal(Object.hasOwn(ended.properties, "session_id"), false, "a malformed session id is dropped by the validator");
		assert.equal(ended.properties.action_count_bucket, "1-3", "dropped events do not count as actions");
		assert.equal(ended.properties.scenes_touched, 1);
		assert.deepEqual(sanitizeProps("app:session_ended", { duration_bucket: "1-3s", scenes_touched: 21, action_count_bucket: "lt1m", pose_edit_bucket: 2, distinct_id: "x" }), {},
			"session end values are its own closed buckets and a capped count");
		console.log("PASS allowlist gate drops unlisted events; session end goes through the validator with session_id");
	}
	{
		friction.reset();
		const run = await runtimeFixture();
		friction.bump("refusals_ui");
		friction.bump("refusals_agent", 4);
		friction.bump("undos");
		friction.noteLongTask(180);
		// Every error counts, including repeats the app:error signature dedupe does not send again.
		for (let i = 0; i < 2; i += 1) run.listeners.get("error")({ error: new TypeError("private"), filename: "http://127.0.0.1:5180/src/App.jsx", lineno: 3, colno: 4 });
		run.listeners.get("error")({ message: "ResizeObserver loop limit exceeded" });
		assert.equal(run.records.filter(({ event }) => event === "app:error").length, 1, "one app:error per signature");
		run.module.track("app:friction_summary", { active_time: "lt1m", undos: "private" });
		const [ended, summary] = await run.unload();
		assert.equal(ended.event, "app:session_ended");
		assert.equal(ended.properties.action_count_bucket, "0", "app:friction_summary is passive and never counts as an action");
		assert.equal(summary.event, "app:friction_summary");
		assert.equal(summary.properties.distinct_id, ended.properties.distinct_id);
		assert.equal(summary.properties.distribution, ended.properties.distribution, "the summary carries the same global properties");
		const { distinct_id: _id, distribution: _d, app_version: _v, origin_kind: _o, os: _os, install_kind: _k, update_status: _u, internal_qa: _q, ...counters } = summary.properties;
		assert.deepEqual(counters, {
			active_time: ended.properties.duration_bucket,
			refusals_ui: "1", refusals_agent: "4-5", undos: "1", errors: "2", rage_clicks: "0", dead_clicks: "0", shortcut_ignored: "0",
			search_empty: "0", nav_thrash: "0", camera_thrash: "0", long_tasks: "1", compiles: "0", long_task_max: "150-500", late_tick_ratio: "0",
		}, "the end beacon sends the session's counters as closed buckets");
		friction.reset();
		console.log("PASS app:friction_summary rides the end beacon, validated, passive, with active_time = the session duration bucket");
	}
	{
		const run = await runtimeFixture();
		run.module.track("update:notice_shown", { kind: "global", behind: "minor" });
		run.module.track("update:clicked", { action: "update_now", kind: "global" });
		run.module.track("update:finished", { outcome: "ok", error_class: "none", duration: "30-60s", version: "3.1.5" });
		const [ended] = await run.unload();
		const update = run.records.filter(({ event }) => event.startsWith("update:"));
		assert.deepEqual(update.map(({ event }) => event), ["update:notice_shown", "update:clicked", "update:finished"], "the update events are allowlisted");
		assert.equal(Object.hasOwn(update[2].properties, "version"), false, "never a version string");
		assert.equal(ended.properties.action_count_bucket, "0", "the update events are passive and never count as actions");
		console.log("PASS update:* events are allowlisted through STRICT_EVENT_KEYS and passive");
	}
	const external = cohortFixtures.filter((row) => row.properties.internal_qa !== true);
	assert.equal(external.some((row) => row.properties.internal_qa === true), false);
	assert.ok(external.some((row) => row.properties.origin_kind === "local"), "unmarked localhost remains external");
	assert.ok(external.some((row) => row.properties.origin_kind === "hosted"));
	const firstPort = await runtimeFixture();
	const secondPort = await runtimeFixture({ origin: "http://127.0.0.1:5250" });
	assert.equal(firstPort.records[0].properties.distinct_id, secondPort.records[0].properties.distinct_id, "fresh SDK + another port retains the CLI anonymous ID");
	assert.equal(new Set([...firstPort.records, ...secondPort.records].map((row) => row.properties.distinct_id)).size, 1, "cohorts dedupe sessions and ports by distinct ID");
	const other = await runtimeFixture({ runtime: { distribution: "npm", telemetryEnabled: true, installationId: "018f0d66-3a4b-7c2d-8e9f-abcdefabcdef", apiKey: "test" } });
	assert.notEqual(other.records[0].properties.distinct_id, firstPort.records[0].properties.distinct_id, "unrelated installations are not merged");
	const hosted = await runtimeFixture({ runtime: null, origin: "https://cozyclay.org", search: "?internal_qa=1&prompt=private" });
	assert.equal(hosted.store.get("cozyclay.internalQa"), "1");
	const hostedRestart = await runtimeFixture({ runtime: null, origin: "https://cozyclay.org", store: hosted.store });
	assert.equal(hostedRestart.records[0].properties.internal_qa, true, "explicit hosted marker persists across reloads");
	const hostedOff = await runtimeFixture({ runtime: null, origin: "https://cozyclay.org", store: hosted.store, search: "?internal_qa=0" });
	assert.equal(hostedOff.records[0].properties.internal_qa, false);
	for (const search of ["?internal_qa=private", "?internal_qa=true", "?internal_qa=1&internal_qa=0"]) {
		const run = await runtimeFixture({ runtime: null, origin: "https://cozyclay.org", search });
		assert.equal(run.records[0].properties.internal_qa, false, "only an unambiguous explicit 1/0 can set the flag");
	}
	for (const input of [
		{ env: { PROD: false, VITE_POSTHOG_KEY: "test" } },
		{ runtime: null, origin: "https://unapproved.invalid" },
		{ runtime: null, origin: "https://cozyclay.org", env: { PROD: true } },
		{ runtime: null, origin: "https://cozyclay.org", store: new Map([["cozyclay.analyticsOptOut", "1"]]) },
		{ runtime: { distribution: "npm", telemetryEnabled: false, internalQa: true, installationId, apiKey: "test" } },
		{ dnt: true },
	]) {
		const run = await runtimeFixture({ ...input, search: "?internal_qa=1" });
		run.module.track("scene:created");
		await run.unload();
		assert.deepEqual(run.records, [], "internal marking cannot enable disabled telemetry");
		assert.deepEqual(run.beacons, [], "disabled telemetry never sends an end beacon, including SDK DNT");
	}
	for (const beacon of [true, false]) {
		const run = await runtimeFixture({ beacon });
		const initialCount = run.records.length;
		assert.equal(await run.module.setAnalyticsOptOut(true), true);
		run.module.track("scene:created");
		await run.unload();
		assert.equal(run.records.length, initialCount, "opt-out suppresses later captures");
		assert.equal(run.beacons.length, 0, "opt-out suppresses the direct end beacon");
		assert.equal(run.requests.filter(({ init }) => init?.keepalive).length, 0, "opt-out suppresses fallback fetch too");
	}
	{
		let finishSync;
		const syncResponse = new Promise((resolve) => { finishSync = resolve; });
		const run = await runtimeFixture({ sync: () => syncResponse });
		const initialCount = run.records.length;
		const disabling = run.module.setAnalyticsOptOut(true);
		run.module.track("scene:created");
		await run.unload();
		assert.equal(run.records.length, initialCount, "consent revocation applies while the CLI response is pending");
		assert.equal(run.beacons.length, 0, "closing during opt-out cannot leak a last beacon");
		finishSync({ ok: true, json: async () => ({ distribution: "npm", telemetryEnabled: false, installationId: null }) });
		assert.equal(await disabling, true);
	}
	for (const internalQa of ["true", 1, "private@example.com", {}]) {
		const run = await runtimeFixture({ runtime: { distribution: "npm", telemetryEnabled: true, installationId, apiKey: "test", internalQa } });
		assert.equal(run.records[0].properties.internal_qa, false, "runtime internal marker accepts only boolean true");
	}
	for (const invalidId of [null, "private@example.com", "not-a-random-id"]) {
		const run = await runtimeFixture({ runtime: { distribution: "npm", telemetryEnabled: true, installationId: invalidId, apiKey: "test" } });
		assert.deepEqual(run.records, [], "invalid CLI identity must not leak or silently fork into a per-session ID");
	}
	const fallback = await runtimeFixture({ beacon: false });
	await fallback.unload();
	const keepalive = fallback.requests.filter(({ init }) => init?.keepalive);
	assert.deepEqual(keepalive.map(({ init }) => JSON.parse(init.body).event), ["app:session_ended", "app:friction_summary"], "without sendBeacon each end event is one keepalive request");
	assert.equal(JSON.parse(keepalive[0].init.body).properties.distribution, "npm");
	console.log("PASS internal/external fixtures, restart identity, capture/beacon parity, opt-out and build policy");
} finally {
	for (const [key, descriptor] of savedGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else delete globalThis[key];
	}
}

console.log("all analytics checks PASS");

// Issue #274: execution contracts (existing analytics sections above retained).
const { mcpToolCategory, mcpToolName, startWorkflowExecution } = await import("../src/execution-telemetry.js");
{
	// tool_name is the live tool list plus "other"; the two lists cannot drift.
	const handlers = readFileSync(new URL("../mcp/tool-handlers.mjs", import.meta.url), "utf8");
	const liveTools = [...handlers.match(/const liveWorkspaceTools = new Set\(\[([\s\S]*?)\]\)/)[1].matchAll(/"([a-z_]+)"/g)].map(([, name]) => name);
	assert.equal(liveTools.length, 26);
	assert.deepEqual([...analytics.MCP_TOOL_NAMES].sort(), [...liveTools, "other"].sort());
	for (const name of liveTools) assert.equal(mcpToolName(name), name);
	for (const name of ["private_unlisted_tool", "live_status", "", null, undefined, 42]) assert.equal(mcpToolName(name), "other");
	assert.equal(mcpToolCategory("studio_commands"), "read");
	assert.equal(mcpToolCategory("studio_run"), "other");
}
const executionId = "0123456789abcdef0123456789abcdef";
assert.deepEqual(
	sanitizeProps("workflow:run_requested", {
		surface: "workflow", run_id: executionId, node_count_bucket: "1-3",
		prompt: "private", graph: "private",
	}),
	{ surface: "workflow", run_id: executionId, node_count_bucket: "1-3" },
);
assert.deepEqual(
	sanitizeProps("agent:tool_executed", {
		turn_id: executionId, tool_category: "workflow_run", outcome: "succeeded", duration_bucket: "1-3s",
		name: "private_tool", args: "private",
	}),
	{ turn_id: executionId, tool_category: "workflow_run", outcome: "succeeded", duration_bucket: "1-3s" },
);
assert.deepEqual(
	sanitizeProps("mcp:tool_executed", {
		request_id: executionId, tool_category: "motion_generate", outcome: "uncertain", duration_bucket: "gte30s",
		path: "/private",
	}),
	{ request_id: executionId, tool_category: "motion_generate", outcome: "uncertain", duration_bucket: "gte30s" },
);
assert.deepEqual(
	sanitizeProps("mcp:tool_executed", { request_id: executionId, tool_category: "read", tool_name: "describe_scene", outcome: "succeeded", duration_bucket: "lt1s" }),
	{ request_id: executionId, tool_category: "read", tool_name: "describe_scene", outcome: "succeeded", duration_bucket: "lt1s" },
);
assert.deepEqual(sanitizeProps("mcp:tool_requested", { request_id: executionId, tool_category: "other", tool_name: "private_unlisted_tool" }), { request_id: executionId, tool_category: "other" });
assert.deepEqual(sanitizeProps("mcp:tool_requested", { request_id: executionId, tool_category: "other", tool_name: "other" }), { request_id: executionId, tool_category: "other", tool_name: "other" });
assert.deepEqual(sanitizeProps("agent:tool_executed", { turn_id: executionId, tool_category: "other", tool_name: "describe_scene" }), { turn_id: executionId, tool_category: "other" });
assert.deepEqual(sanitizeProps("mcp:tool_executed", { request_id: executionId, tool_category: "workflow_run", outcome: "succeeded" }), { request_id: executionId, outcome: "succeeded" });
assert.deepEqual(sanitizeProps("workflow:run_failed", { run_id: executionId, duration_bucket: "1-3s", failure_code: "generation_failed" }), {
	run_id: executionId, duration_bucket: "1-3s", failure_code: "generation_failed",
});
assert.deepEqual(sanitizeProps("agent:turn_failed", { turn_id: executionId, duration_bucket: "1-3s", failure_code: "private" }), {
	turn_id: executionId, duration_bucket: "1-3s",
});
assert.deepEqual(sanitizeProps("mcp:result_applied", { request_id: executionId, prompt: "private" }), { request_id: executionId });
{
	const events = [];
	let now = 100;
	const run = startWorkflowExecution(
		{ node_count_bucket: "1-3" },
		{ capture: (event, props) => events.push({ event, props }), now: () => now, durationBucket: bucketMs },
	);
	assert.match(run.runId, /^[a-f0-9]{32}$/);
	now += 3500;
	run.succeed();
	run.fail(new Error("late failure"));
	assert.deepEqual(events.map(({ event }) => event), ["workflow:run_requested", "workflow:run_succeeded"]);
	assert.equal(events[1].props.duration_bucket, "3-10s");
}

const executionDisclosure = new Map(), strictRows = new Set();
for (const row of privacyHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
	const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => cell[1].replace(/<[^>]*>/g, " "));
	for (const event of cells[0]?.match(/\b(?:workflow|agent|mcp):[a-z_]+\b/g) ?? []) {
		// Closed-schema agent events (turn summary, post-turn edits) are checked below with the other strict events.
		if (!Object.hasOwn(STRICT_EVENT_KEYS, event)) executionDisclosure.set(event, new Set(cells[1]?.match(/\b[a-z][a-z0-9_]*\b/g) ?? []));
	}
}
// Every strict event's row names each of its properties.
for (const row of privacyHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
	const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => cell[1].replace(/<[^>]*>/g, " "));
	const event = cells[0]?.trim();
	if (!Object.hasOwn(STRICT_EVENT_KEYS, event) || event === "app:friction_summary") continue;
	const tokens = new Set(cells[1]?.match(/[A-Za-z0-9][A-Za-z0-9_-]*/g) ?? []);
	for (const key of STRICT_EVENT_KEYS[event]) assert.ok(tokens.has(key), `the privacy page discloses ${event} ${key}`);
	strictRows.add(event);
}
assert.deepEqual([...strictRows].sort(), Object.keys(STRICT_EVENT_KEYS).filter((event) => event !== "app:friction_summary").sort(), "each strict event has its own privacy row");
const executionSchemas = {
	"workflow:run_requested": ["surface", "run_id", "node_count_bucket"],
	"workflow:run_succeeded": ["run_id", "duration_bucket"],
	"workflow:run_failed": ["run_id", "duration_bucket", "failure_code"],
	"workflow:run_cancelled": ["run_id", "duration_bucket", "failure_code"],
	"workflow:result_applied": ["run_id"],
	"agent:turn_requested": ["surface", "turn_id"],
	"agent:tool_executed": ["turn_id", "tool_category", "outcome", "duration_bucket"],
	"agent:turn_succeeded": ["turn_id", "duration_bucket"],
	"agent:turn_failed": ["turn_id", "duration_bucket", "failure_code"],
	"agent:turn_cancelled": ["turn_id", "duration_bucket", "failure_code"],
	"agent:result_applied": ["turn_id"],
	"mcp:tool_requested": ["tool_category", "tool_name", "request_id"],
	"mcp:tool_executed": ["tool_category", "tool_name", "outcome", "duration_bucket", "request_id"],
	"mcp:result_applied": ["request_id"],
};
assert.deepEqual([...executionDisclosure.keys()].sort(), Object.keys(executionSchemas).sort());
const executionProps = {
	surface: "workflow", run_id: executionId, turn_id: executionId, request_id: executionId,
	node_count_bucket: "1-3", tool_category: "other", tool_name: "describe_scene", outcome: "succeeded",
	duration_bucket: "1-3s", failure_code: "unknown",
};
for (const [event, properties] of Object.entries(executionSchemas)) {
	assert.deepEqual(Object.keys(sanitizeProps(event, executionProps)).sort(), [...properties].sort(), `${event}: exact property contract`);
	for (const property of properties) assert.ok(executionDisclosure.get(event).has(property), `${event} discloses ${property}`);
}
for (const event of Object.keys(executionSchemas)) {
	assert.deepEqual(sanitizeProps(event, { ...executionProps, prompt: "private", text: "private", path: "/private", url: "https://private" }), sanitizeProps(event, executionProps));
	for (const key of executionSchemas[event]) {
		for (const value of ["private", "private text", "https://private", "/private", 42, true, null, {}, [], Infinity, NaN]) {
			assert.deepEqual(sanitizeProps(event, { [key]: value }), {}, `${event} rejects unsafe ${key}`);
		}
	}
	for (const id of ["run_id", "turn_id", "request_id"].filter((key) => executionSchemas[event].includes(key))) {
		for (const value of [executionId.toUpperCase(), executionId.slice(1), `${executionId}0`]) {
			assert.deepEqual(sanitizeProps(event, { [id]: value }), {});
		}
	}
}
const executionEnums = [
	["workflow:run_requested", "surface", ["workflow"]],
	["agent:turn_requested", "surface", ["studio", "workflow"]],
	["workflow:run_requested", "node_count_bucket", ["0", "1-3", "4-10", "gte11"]],
	["workflow:run_failed", "failure_code", ["aborted", "capture_failed", "generation_failed", "unknown"]],
	["agent:turn_failed", "failure_code", ["aborted", "auth", "rate_limited", "tool_failed", "upstream", "network", "unknown"]],
	["agent:tool_executed", "tool_category", ["workflow_read", "workflow_write", "workflow_run", "frame_capture", "image_generate", "scene_write", "other"]],
	["mcp:tool_executed", "tool_category", ["read", "camera", "scene_write", "prompt_authoring", "frame_capture", "motion_generate", "motion_apply", "project_io", "other"]],
	["agent:tool_executed", "outcome", ["succeeded", "failed", "cancelled"]],
	["mcp:tool_executed", "outcome", ["succeeded", "failed", "uncertain", "cancelled"]],
	["mcp:tool_requested", "tool_name", analytics.MCP_TOOL_NAMES],
	["mcp:tool_executed", "tool_name", analytics.MCP_TOOL_NAMES],
];
for (const [event, key, values] of executionEnums) {
	const row = [...privacyHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].find(([row]) => row.includes(event))?.[0] ?? "";
	const tokens = new Set(row.match(/[a-z0-9][a-z0-9_-]*/g) ?? []);
	for (const value of values) {
		assert.deepEqual(sanitizeProps(event, { [key]: value }), { [key]: value });
		assert.ok(tokens.has(value), `${event} discloses enum token ${value}`);
	}
}
for (const event of Object.keys(executionSchemas).filter((event) => executionSchemas[event].includes("duration_bucket"))) {
	for (const duration_bucket of ["lt1s", "1-3s", "3-10s", "10-30s", "gte30s"]) {
		assert.deepEqual(sanitizeProps(event, { duration_bucket }), { duration_bucket });
	}
}
assert.deepEqual(sanitizeProps("workflow:run_requested", { surface: "studio" }), {});
assert.deepEqual(sanitizeProps("agent:tool_executed", { outcome: "uncertain" }), {});
for (const capture of [() => { throw new Error("transport"); }, () => Promise.reject(new Error("transport"))]) {
	const run = startWorkflowExecution({ node_count_bucket: "0", prompt: "private" }, { capture, now() { throw new Error("clock"); }, durationBucket: bucketMs });
	assert.doesNotThrow(() => { run.apply(); run.succeed(); run.fail(new Error("late")); });
}
const executionCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
try {
	Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
	const events = [];
	const run = startWorkflowExecution({ node_count_bucket: "0" }, { capture: (...args) => events.push(args), durationBucket: bucketMs });
	run.succeed(); run.apply();
	assert.deepEqual(events, [], "missing randomness omits telemetry rather than issuing a weak ID");
} finally {
	Object.defineProperty(globalThis, "crypto", executionCrypto);
}
await Promise.resolve();
const publishedPrivacy = readFileSync(new URL("../privacy/index.html", import.meta.url), "utf8");
const executionRows = (html) => [...html.matchAll(/<tr><td>(?:workflow|agent|mcp):[\s\S]*?<\/tr>/g)].map(([row]) => row);
assert.deepEqual(executionRows(publishedPrivacy), executionRows(privacyHtml), "shipped execution disclosure equals its source");
console.log("PASS Workflow, Agent and MCP execution allowlists and disclosure schema tokens");

// Issue #466: builder telemetry. Real pose edits and per-group edit gestures,
// the Fal A->B request on the motion contract, closed error/device/use-case
// vocabularies, install source values and the npm update status.
{
	const {
		EDIT_BUCKET_KEYS, EDIT_GROUPS, FEATURE_USAGE_NAMES, HEARD_FROM_SOURCES, TEAM_VALUES, USE_CASE_VALUES,
		bucketCpu, bucketFrameRate, bucketMemory, classifyGpu, describeError,
	} = analytics;
	const rowTokens = (event) => {
		for (const row of privacyHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
			const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => cell[1].replace(/<[^>]*>/g, " "));
			if ((cells[0] ?? "").split(/[\s,]+/).includes(event)) return new Set(cells[1]?.match(/[A-Za-z0-9][A-Za-z0-9_-]*/g) ?? []);
		}
		return null;
	};
	const closedSchemas = {
		"app:error": {
			error_kind: ["error", "unhandled_rejection"],
			error_type: ["TypeError", "DOMException", "other", "non_error"],
			error_source: ["app", "extension", "external", "unknown"],
		},
		"device:profile": {
			gpu_vendor: ["nvidia", "amd", "intel", "apple", "qualcomm", "arm", "software", "other", "unknown"],
			gpu_class: ["discrete", "integrated", "software", "unknown"],
			webgl: ["webgl2", "webgl1", "none"],
			cpu_bucket: ["1-4", "5-8", "9-16", "gte17", "unknown"],
			memory_bucket: ["lt4", "4-7", "gte8", "unknown"],
			frame_rate_bucket: ["lt20", "20-40", "40-55", "gte55", "unknown"],
		},
		"survey:use_case": { use_case: USE_CASE_VALUES, team: TEAM_VALUES },
	};
	for (const [event, properties] of Object.entries(closedSchemas)) {
		const tokens = rowTokens(event);
		assert.ok(tokens, `${event} has a telemetry disclosure row`);
		for (const [property, values] of Object.entries(properties)) {
			assert.ok(tokens.has(property), `${event} discloses ${property}`);
			for (const value of values) {
				assert.deepEqual(sanitizeProps(event, { [property]: value, prompt: "private" }), { [property]: value });
				assert.ok(tokens.has(value), `${event} discloses enum ${value}`);
			}
			for (const unsafe of ["private text", "https://private", "Private-Name", 7, true, null, {}]) {
				assert.deepEqual(sanitizeProps(event, { [property]: unsafe }), {}, `${event} rejects ${String(unsafe)} as ${property}`);
			}
		}
	}
	const errorTokens = rowTokens("app:error");
	for (const key of ["error_file", "error_line", "error_col"]) assert.ok(errorTokens.has(key), `app:error discloses ${key}`);
	assert.deepEqual(
		sanitizeProps("app:error", { error_file: "index-D4x9aQ1b.js", error_line: 1, error_col: 23456 }),
		{ error_file: "index-D4x9aQ1b.js", error_line: 1, error_col: 23456 },
	);
	for (const error_file of ["/Users/me/project.js", "https://cozyclay.org/a.js", "a b.js", "notes.txt", `${"x".repeat(81)}.js`]) {
		assert.deepEqual(sanitizeProps("app:error", { error_file }), {}, `error_file rejects ${error_file}`);
	}
	for (const value of [-1, 1.5, "12", 10_000_001]) assert.deepEqual(sanitizeProps("app:error", { error_line: value, error_col: value }), {});

	const origin = "http://127.0.0.1:5180";
	const secret = "private prompt /Users/me/secret.cclayproject";
	const typeError = new TypeError(secret);
	typeError.stack = `TypeError: ${secret}\n    at pose (chrome-extension://abcdef/content.js:4:2)\n    at run (${origin}/app/assets/index-D4x9aQ1b.js:1:23456)\n    at https://cdn.example.com/lib.js:9:9`;
	const described = describeError({ error: typeError, kind: "unhandled_rejection" }, origin);
	assert.deepEqual(described, { error_kind: "unhandled_rejection", error_type: "TypeError", error_source: "app", error_file: "index-D4x9aQ1b.js", error_line: 1, error_col: 23456 });
	assert.equal(JSON.stringify(described).includes("private"), false, "never the message, stack text or paths");
	assert.deepEqual(sanitizeProps("app:error", described), described, "a described error survives its own allowlist");
	assert.deepEqual(
		describeError({ error: new RangeError(secret), filename: `${origin}/app/assets/App-9f8e7d6c.js?token=private`, lineno: 12, colno: 7 }, origin),
		{ error_kind: "error", error_type: "RangeError", error_source: "app", error_file: "App-9f8e7d6c.js", error_line: 12, error_col: 7 },
		"an ErrorEvent location in our bundle wins and loses its query string",
	);
	assert.deepEqual(describeError({ error: null, filename: "chrome-extension://abc/inject.js", lineno: 1, colno: 1 }, origin), { error_kind: "error", error_type: "non_error", error_source: "extension" });
	assert.deepEqual(describeError({ error: new Error(secret), filename: "https://cdn.example.com/lib.js", lineno: 3, colno: 4 }, origin), { error_kind: "error", error_type: "Error", error_source: "external" });
	class CustomerNamedError extends Error { constructor() { super(secret); this.name = "AcmeStudioError"; } }
	assert.equal(describeError({ error: new CustomerNamedError() }, origin).error_type, "other", "custom error names are authored text");
	assert.equal(describeError({ error: "string rejection" }, origin).error_type, "non_error");
	assert.equal(describeError({ error: Object.assign(new Error(secret), { name: "AbortError" }) }, origin).error_type, "AbortError");
	const hostile = { get name() { throw new Error("getter"); }, get stack() { throw new Error("getter"); } };
	assert.doesNotThrow(() => describeError({ error: hostile }, origin));
	console.log("PASS app:error closed vocabulary: type, source and same-origin bundle location only");

	// PR D: app:render_crash (error type only, 2 per session, bumps errors) and app:gl_lost (1 per kind).
	{
		friction.reset();
		const sent = [];
		const restoreCrash = crashTelemetrySeam((event, props) => sent.push({ event, props }));
		reportRenderCrash(typeError);
		reportRenderCrash(new CustomerNamedError());
		reportRenderCrash("string throw");
		assert.deepEqual(sent, [
			{ event: "app:render_crash", props: { error_type: "TypeError" } },
			{ event: "app:render_crash", props: { error_type: "other" } },
		], "a type label only, and at most two per session");
		assert.equal(friction.snapshot().errors, "3", "every caught crash moves the errors counter, past the cap too");
		assert.equal(JSON.stringify(sent).includes("private"), false, "never the message or stack");
		assert.doesNotThrow(() => reportRenderCrash(hostile), "a hostile thrown value cannot break the crash net");
		sent.length = 0;
		for (const kind of ["context_lost", "unavailable", "context_lost", "unavailable", "lost", undefined]) reportGlLost(kind);
		assert.deepEqual(sent, [{ event: "app:gl_lost", props: { kind: "context_lost" } }, { event: "app:gl_lost", props: { kind: "unavailable" } }], "one per kind, closed kinds only");
		for (const { event, props } of sent) assert.deepEqual(sanitizeProps(event, { ...props, message: "private" }), props, `${event} passes its closed schema`);
		assert.deepEqual(sanitizeProps("app:render_crash", { error_type: "AcmeStudioError", stack: secret }), {}, "app:render_crash rejects an open type and a stack");
		assert.deepEqual(sanitizeProps("app:render_crash", { error_type: "RangeError" }), { error_type: "RangeError" });
		assert.deepEqual(sanitizeProps("app:gl_lost", { kind: "restored" }), {}, "app:gl_lost rejects an unknown kind");
		assert.deepEqual(STRICT_EVENT_KEYS["app:render_crash"], ["error_type"]);
		assert.deepEqual(STRICT_EVENT_KEYS["app:gl_lost"], ["kind"]);
		restoreCrash();
		friction.reset();
	}
	console.log("PASS app:render_crash and app:gl_lost: closed values, 2 crashes and 1 per GL kind per session");
	// P2-c: playback:summary, the first-success guide, agent:panel_toggled, studio:ready and delete regret.
	{
		const { bucketCatchup, bucketPlaybackFps, bucketSpeed, playbackTelemetrySeam, startPlaybackRun } = await import("../src/playback-telemetry.js");
		const { guideTelemetrySeam, noteGuideDismissed, noteGuideOpened, noteGuideStep } = await import("../src/guide-telemetry.js");
		const studio = await import("../src/studio-telemetry.js");
		friction.reset();
		assert.deepEqual([0, 1, 2, 3, 5, 6, 40, NaN].map(bucketCatchup), ["1", "1", "2", "3-5", "3-5", "gte6", "gte6", "1"]);
		assert.deepEqual([12, 24, 25, 30, 60, 120, "24"].map(bucketPlaybackFps), ["12", "24", "other", "30", "60", "other", "other"]);
		assert.deepEqual([0.5, 1, 1.5, 2, 4, "1"].map(bucketSpeed), ["0.5", "1", "other", "2", "other", "other"]);
		assert.deepEqual([0, 1999, 2000, 4999, 5000, 14_999, 15_000, NaN].map(studio.bucketBoot), ["lt2s", "lt2s", "2-5s", "2-5s", "5-15s", "5-15s", "gte15s", "lt2s"]);

		// One summary per run: 3 s at 24 fps, 72 timer ticks of which 9 caught up; rAF ran at 60 Hz.
		const sent = [];
		const restorePlayback = playbackTelemetrySeam((event, props) => sent.push({ event, props }));
		// #931 review: a run still playing when the page goes away. Late ticks reach the friction
		// summary as they happen, and pagehide ends the active run (React runs no cleanup on unload).
		{
			const listeners = new Map();
			const savedAdd = globalThis.addEventListener;
			globalThis.addEventListener = (type, listener) => listeners.set(type, listener);
			try {
				friction.reset();
				const playing = startPlaybackRun(24, 1, { now: () => 0, active: () => true, raf: null });
				for (const steps of [3, 2, 1, 1]) playing.tick(steps);
				assert.equal(friction.snapshot().late_tick_ratio, "gte50", "2 of 4 ticks were late before any end()");
				assert.equal(typeof listeners.get("pagehide"), "function", "the first run installs a pagehide flush");
				listeners.get("pagehide")();
				assert.deepEqual(sent.splice(0).map((row) => [row.event, row.props.late_ticks]), [["playback:summary", "gte50"]], "pagehide ends the run and sends its summary");
				playing.end();
				assert.deepEqual(sent, [], "the run ends once");
				friction.reset();
			} finally {
				if (savedAdd) globalThis.addEventListener = savedAdd; else delete globalThis.addEventListener;
			}
		}
		let clock = 0, frame = null;
		const fakeRaf = { raf: (callback) => { frame = callback; return 1; }, cancelRaf: () => { frame = null; } };
		assert.equal(startPlaybackRun(24, 1, { active: () => false, ...fakeRaf }).tick(3), undefined, "analytics off: a no-op run");
		assert.equal(frame, null, "analytics off: no rAF sampler");
		const run = startPlaybackRun(24, 1, { now: () => clock, active: () => true, ...fakeRaf });
		for (let i = 0; i <= 180; i += 1) frame?.(i * (1000 / 60));
		for (let i = 0; i < 72; i += 1) run.tick(i < 9 ? (i === 0 ? 7 : 2) : (i % 10 === 0 ? 0 : 1));
		clock = 3000;
		run.end();
		run.end();
		run.tick(5);
		assert.equal(frame, null, "end() cancels the rAF sample");
		assert.deepEqual(sent, [{ event: "playback:summary", props: { duration: "lt10s", late_ticks: "5-20", max_catchup: "gte6", fps: "24", speed: "1", measured_fps: "gte55" } }], "one summary per run, idempotent end");
		assert.equal(friction.snapshot().late_tick_ratio, "5-20", "the run feeds app:friction_summary.late_tick_ratio");
		assert.deepEqual(sanitizeProps("playback:summary", { ...sent[0].props, scene: "private" }), sent[0].props, "playback:summary passes its closed schema");
		sent.length = 0;
		startPlaybackRun(24, 1, { active: () => true, raf: null }).end();
		assert.deepEqual(sent, [], "a run without ticks sends nothing");
		for (let i = 0; i < 12; i += 1) { const each = startPlaybackRun(30, 0.5, { now: () => 0, active: () => true, raf: null }); each.tick(1); each.end(); }
		assert.equal(sent.length, 9, "10 summaries per session (one was the 3 s run)");
		assert.deepEqual(sent[0].props, { duration: "lt10s", late_ticks: "0", max_catchup: "1", fps: "30", speed: "0.5", measured_fps: "unknown" }, "no rAF sample is unknown");
		for (const value of ["lt20", "20-40", "40-55", "gte55", "unknown"]) {
			assert.deepEqual(sanitizeProps("device:profile", { frame_rate_bucket: value }), { frame_rate_bucket: value });
			assert.deepEqual(sanitizeProps("playback:summary", { measured_fps: value }), { measured_fps: value }, `measured_fps reuses frame_rate_bucket ${value}`);
		}
		for (const fps of [0, 10, 20, 39, 45, 60, NaN]) assert.ok(sanitizeProps("playback:summary", { measured_fps: bucketFrameRate(fps) }).measured_fps);
		for (const [late, total] of [[0, 1], [1, 100], [1, 10], [3, 10], [9, 10]]) {
			const value = friction.bucketLateTicks(late, total);
			assert.deepEqual(sanitizeProps("playback:summary", { late_ticks: value }), { late_ticks: value }, "late_ticks is the late_tick_ratio set");
			assert.deepEqual(sanitizeProps("app:friction_summary", { late_tick_ratio: value }), { late_tick_ratio: value });
		}
		assert.deepEqual(sanitizeProps("playback:summary", { fps: 24, speed: 1, late_ticks: "12", duration: 3000 }), {}, "raw numbers never pass");
		restorePlayback();

		// The guide: once per step, a step clock, completion, and no dismissal after completion.
		const guide = [];
		let now = 0;
		const restoreGuide = guideTelemetrySeam((event, props) => guide.push({ event, props }), () => now);
		noteGuideOpened("private"); noteGuideOpened("animation"); noteGuideOpened("animation");
		now = 4000; noteGuideStep("animation", 1, 4);
		now = 40_000; noteGuideStep("animation", 2, 4); noteGuideStep("animation", 2, 4); noteGuideStep("animation", 9, 4);
		noteGuideDismissed("animation", 3); noteGuideDismissed("animation", 3);
		now = 50_000; noteGuideStep("animation", 3, 4); now = 400_000; noteGuideStep("animation", 4, 4);
		assert.deepEqual(guide, [
			{ event: "guide:opened", props: { mode: "animation" } },
			{ event: "guide:step", props: { mode: "animation", step: "1", step_ms: "lt10s" } },
			{ event: "guide:step", props: { mode: "animation", step: "2", step_ms: "30-60s" } },
			{ event: "guide:dismissed", props: { mode: "animation", reached: "3" } },
			{ event: "guide:step", props: { mode: "animation", step: "3", step_ms: "lt10s" } },
			{ event: "guide:step", props: { mode: "animation", step: "4", step_ms: "gte5m" } },
			{ event: "guide:completed", props: { mode: "animation" } },
		], "each guide event and step once per session; closed modes and steps only");
		for (const { event, props } of guide) assert.deepEqual(sanitizeProps(event, { ...props, text: "private" }), props, `${event} passes its closed schema`);
		assert.deepEqual(sanitizeProps("guide:step", { mode: "film", step: 5, step_ms: 4000 }), {}, "guide values are closed");
		const guideSource = readFileSync(new URL("../src/first-success-guide.jsx", import.meta.url), "utf8");
		assert.match(guideSource, /const STEPS_BY_MODE = \{ animation: ANIMATION_STEPS, storyboard: STORYBOARD_STEPS \};/, "the schema's modes are the component's own");
		for (const name of ["ANIMATION_STEPS", "STORYBOARD_STEPS"]) {
			const block = guideSource.slice(guideSource.indexOf(`const ${name} = [`), guideSource.indexOf("];", guideSource.indexOf(`const ${name} = [`)));
			assert.equal(block.match(/^\t\ten: /gm)?.length, 4, `${name} has the schema's 4 steps`);
		}
		restoreGuide();

		// studio:ready once, agent:panel_toggled 10 per session, deletes of session-created ids, the 7 s undo window.
		const shell = [];
		now = 0;
		const restoreStudio = studio.studioTelemetrySeam((event, props) => shell.push({ event, props }), () => now);
		studio.noteStudioReady(NaN); studio.noteStudioReady(3200); studio.noteStudioReady(900);
		for (let i = 0; i < 12; i += 1) studio.notePanelToggled(i % 2 === 0, i === 0 ? "key" : "button");
		studio.notePanelToggled("yes", "key"); studio.notePanelToggled(true, "menu");
		studio.noteObjectCreated("cube");
		now = 1500; studio.noteObjectDeleted("cube");
		now = 2500; studio.noteObjectDeleted("chair");
		now = 4000; studio.noteDeleteUndone("cube");
		now = 10_000; studio.noteDeleteUndone("chair");
		studio.noteDeleteUndone("cube");
		const byEvent = (name) => shell.filter(({ event }) => event === name);
		assert.deepEqual(byEvent("studio:ready"), [{ event: "studio:ready", props: { boot: "2-5s" } }], "studio:ready once per session");
		assert.equal(byEvent("agent:panel_toggled").length, 10, "agent:panel_toggled is capped at 10");
		assert.deepEqual(byEvent("agent:panel_toggled").slice(0, 2).map(({ props }) => props), [{ open: true, via: "key" }, { open: false, via: "button" }]);
		assert.deepEqual(byEvent("object:deleted_soon"), [{ event: "object:deleted_soon", props: { age: "lt2s" } }], "only an id this session created counts");
		assert.deepEqual(byEvent("object:delete_undone"), [{ event: "object:delete_undone", props: { age: "2-10s" } }], "undo at 2.5 s counts; 7.5 s is past the window; one undo per delete");
		now = 20_000; studio.noteObjectDeleted("lamp"); now = 27_000; studio.noteDeleteUndone("lamp");
		assert.equal(byEvent("object:delete_undone").length, 2, "exactly 7 s is still inside the window");
		for (let i = 0; i < 12; i += 1) { studio.noteObjectCreated(`box-${i}`); studio.noteObjectDeleted(`box-${i}`); }
		assert.equal(byEvent("object:deleted_soon").length, 10, "object:deleted_soon is capped at 10");
		for (const { event, props } of shell) assert.deepEqual(sanitizeProps(event, { ...props, id: "cube" }), props, `${event} passes its closed schema`);
		assert.equal(JSON.stringify(shell).includes("cube"), false, "never an object id");
		const undoWindow = readFileSync(new URL("../src/stage-startup-defaults.js", import.meta.url), "utf8").match(/OBJECT_DELETE_UNDO_MS = (\d+)/)?.[1];
		assert.equal(Number(undoWindow), studio.DELETE_UNDO_WINDOW_MS, "the telemetry window is the toast's undo window");
		restoreStudio();
		for (const event of ["studio:ready", "playback:summary", "guide:opened", "guide:step", "guide:dismissed", "guide:completed", "agent:panel_toggled", "object:deleted_soon", "object:delete_undone"]) {
			assert.ok(Object.hasOwn(STRICT_EVENT_KEYS, event), `${event} has a closed schema (and so is passive)`);
		}
		friction.reset();
	}
	// #931 review: guide events wait for analytics initialization, so an early guide:opened is
	// sent rather than spending its cap on a no-op track() (the same path as studio:ready).
	{
		const guideSource = readFileSync(new URL("../src/guide-telemetry.js", import.meta.url), "utf8");
		assert.match(guideSource, /let send = \(event, props\) => \{ initAnalytics\(\)\.then\(\(\) => track\(event, props\)/, "the guide's default send waits on initAnalytics()");
	}
	console.log("PASS P2-c: playback:summary one per run and late ticks fed, guide once per step, 7 s delete-undo window, studio:ready once; pagehide flushes a playing run, early guide events wait for init");

	for (const [renderer, gpu_vendor, gpu_class] of [
		["ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)", "nvidia", "discrete"],
		["ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)", "intel", "integrated"],
		["ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics (0x000056A0) Direct3D11 vs_5_0 ps_5_0, D3D11)", "intel", "discrete"],
		["ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)", "amd", "integrated"],
		["ANGLE (AMD, AMD Radeon RX 6700 XT (0x000073DF) Direct3D11 vs_5_0 ps_5_0, D3D11)", "amd", "discrete"],
		["ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version)", "apple", "integrated"],
		["ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)", "software", "software"],
		["ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)", "software", "software"],
		["Adreno (TM) 740", "qualcomm", "integrated"],
		["Mali-G78", "arm", "integrated"],
		["Mozilla", "other", "unknown"],
		["", "unknown", "unknown"],
	]) assert.deepEqual(classifyGpu(renderer), { gpu_vendor, gpu_class }, renderer || "(empty renderer)");
	assert.deepEqual([0, 4, 8, 12, 32, undefined].map(bucketCpu), ["unknown", "1-4", "5-8", "9-16", "gte17", "unknown"]);
	assert.deepEqual([undefined, 2, 4, 8].map(bucketMemory), ["unknown", "lt4", "4-7", "gte8"]);
	assert.deepEqual([null, 12, 30, 50, 60, 144].map(bucketFrameRate), ["unknown", "lt20", "20-40", "40-55", "gte55", "gte55"]);
	console.log("PASS device:profile buckets and GPU vendor/class without the renderer string");

	const { FIRST_EDIT_KINDS } = await import("../src/semantic-edit.js");
	assert.deepEqual(Object.values(EDIT_GROUPS).flat().sort(), [...FIRST_EDIT_KINDS].sort(), "every semantic edit kind belongs to exactly one group");
	const fresh = await import("../src/analytics.js?issue-466-edits");
	assert.deepEqual(Object.keys(fresh.sessionEditBuckets()), [...EDIT_BUCKET_KEYS]);
	assert.ok(Object.values(fresh.sessionEditBuckets()).every((bucket) => bucket === "0"));
	let now = 0;
	for (let i = 0; i < 30; i += 1) fresh.recordSemanticEdit("pose_edit", now += 40);
	assert.equal(fresh.sessionEditBuckets().pose_edit_bucket, "1-3", "one continuous bone drag is one gesture");
	for (let i = 0; i < 11; i += 1) fresh.recordSemanticEdit("pose_edit", now += 2000);
	fresh.recordSemanticEdit("camera_key_record", now += 10);
	fresh.recordSemanticEdit("rail_edit", now += 10);
	fresh.recordSemanticEdit("object_insert", now += 10);
	fresh.recordSemanticEdit("shot_add", now += 10);
	fresh.recordSemanticEdit("prompt_block_add", now += 10);
	assert.equal(fresh.recordSemanticEdit("private-kind", now += 10), false);
	assert.deepEqual(fresh.sessionEditBuckets(), {
		pose_edit_bucket: "gte11", camera_edit_bucket: "1-3", object_edit_bucket: "1-3", shot_edit_bucket: "1-3", prompt_edit_bucket: "1-3",
	});
	const sessionTokens = rowTokens("app:session_ended");
	for (const key of EDIT_BUCKET_KEYS) assert.ok(sessionTokens.has(key), `session end discloses ${key}`);
	const frictionTokens = rowTokens("app:friction_summary");
	for (const key of friction.FRICTION_SUMMARY_KEYS) assert.ok(frictionTokens?.has(key), `the privacy page discloses friction summary ${key}`);
	for (const value of ["4-5", "6-10", "gte11", "150-500", "gte2000", "5-20", "gte50"]) assert.ok(frictionTokens.has(value), `the privacy page lists friction value ${value}`);
	assert.ok(FEATURE_USAGE_NAMES.includes("pose_save"));
	for (const name of ["export_depth_video", "export_keyframe_pack", "export_render_pass", "export_storyboard"]) assert.ok(FEATURE_USAGE_NAMES.includes(name), `${name} is no longer silently dropped`);
	assert.deepEqual(sanitizeProps("feature:used", { name: "pose_save" }), { name: "pose_save" });
	for (const name of ["pose_edit", "pose_save"]) {
		assert.ok(FEATURE_USAGE_NAMES.includes(name), `${name} is a closed feature name`);
		assert.ok(rowTokens("feature:used").has(name), `feature:used discloses ${name}`);
	}
	console.log("PASS per-group edit gestures, real pose_edit vs pose_save, and session-end disclosure");


	const { FIRST_LAUNCH_SOURCES } = await import("../bin/telemetry-state.mjs");
	assert.deepEqual([...HEARD_FROM_SOURCES].sort(), [...FIRST_LAUNCH_SOURCES].sort(), "the CLI and the browser agree on install sources");
	for (const heard_from of ["site", "playground"]) {
		assert.deepEqual(sanitizeProps("install:first_launch", { heard_from }), { heard_from });
		assert.ok(rowTokens("install:first_launch").has(heard_from), `install source ${heard_from} is disclosed`);
	}
	assert.ok(privacyHtml.includes("update_status (latest, outdated or unknown)"), "update_status is disclosed");
	assert.equal(analytics.shouldAskUseCase(), false, "never asks while telemetry is off");
}
try {
	const npmRuntime = { distribution: "npm", telemetryEnabled: true, installationId, appVersion: "1.8.1", apiKey: "test", apiHost: "https://telemetry.invalid", internalQa: false, installKind: "npx" };
	const outdated = await runtimeFixture({ runtime: { ...npmRuntime, updateStatus: "outdated" } });
	outdated.module.track("app:error", { error_kind: "error", error_type: "TypeError", error_source: "app" });
	outdated.module.track("device:profile", { gpu_vendor: "nvidia" });
	const [ended] = await outdated.unload();
	for (const record of outdated.records) assert.equal(record.properties.update_status, "outdated", `${record.event} carries update_status`);
	assert.equal(ended.properties.update_status, "outdated", "beacon/capture parity: update_status");
	assert.equal(ended.properties.action_count_bucket, "0", "passive session signals are not user actions");
	for (const key of analytics.EDIT_BUCKET_KEYS) assert.equal(ended.properties[key], "0", `the end beacon carries ${key}`);
	const forged = await runtimeFixture({ runtime: { ...npmRuntime, updateStatus: "private" } });
	assert.equal(forged.records[0].properties.update_status, "unknown", "only a closed update status crosses");
	const hostedRun = await runtimeFixture({ runtime: null, origin: "https://cozyclay.org" });
	assert.equal(Object.hasOwn(hostedRun.records[0].properties, "update_status"), false, "hosted builds have no update status");

	const survey = await runtimeFixture();
	assert.equal(survey.module.shouldAskUseCase(), true);
	survey.module.recordUseCase("film", "team");
	assert.equal(survey.module.shouldAskUseCase(), false, "asked once per browser profile and origin");
	survey.module.recordUseCase("private text", "somebody");
	const answers = survey.records.filter((record) => record.event === "survey:use_case").map((record) => [record.properties.use_case, record.properties.team]);
	assert.deepEqual(answers, [["film", "team"], ["skip", "skip"]]);
	console.log("PASS update_status parity, passive action counts, edit buckets in the end beacon and the one-time use-case answer");
} finally {
	for (const [key, descriptor] of savedGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else delete globalThis[key];
	}
}
