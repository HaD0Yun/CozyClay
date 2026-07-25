import assert from "node:assert/strict";
import { test } from "node:test";
import {
	parseViewportCaptureRequest,
	parseViewportCaptureResult,
	VIEWPORT_CAPTURE_MAX_IMAGE_BYTES,
	VIEWPORT_CAPTURE_MAX_VIEWS,
} from "../src/viewport-capture.ts";

const revision = "a".repeat(64);
const jpegBase64 = Buffer.from("viewport-jpeg-payload").toString("base64");

function view(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name: "viewport",
		mime_type: "image/jpeg",
		data_base64: jpegBase64,
		width: 480,
		height: 270,
		method: "offscreen",
		...overrides,
	};
}

function result(views: Record<string, unknown>[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { revision, views, ...overrides };
}

test("capture: a valid single-view payload parses", () => {
	const parsed = parseViewportCaptureResult(result([view()]));
	assert.equal(parsed.revision, revision);
	assert.equal(parsed.views.length, 1);
	assert.equal(parsed.views[0]!.name, "viewport");
	assert.equal(parsed.views[0]!.mime_type, "image/jpeg");
});

test("capture: a valid three-view payload parses", () => {
	const parsed = parseViewportCaptureResult(
		result([
			view({ name: "three_quarter" }),
			view({ name: "side", mime_type: "image/png" }),
			view({ name: "contact_low" }),
		]),
	);
	assert.deepEqual(
		parsed.views.map((v) => v.name),
		["three_quarter", "side", "contact_low"],
	);
});

test("capture: a view missing mime_type is rejected", () => {
	const { mime_type: _omit, ...withoutMime } = view();
	assert.throws(() => parseViewportCaptureResult(result([withoutMime])));
});

test("capture: a view missing data_base64 is rejected", () => {
	const { data_base64: _omit, ...withoutData } = view();
	assert.throws(() => parseViewportCaptureResult(result([withoutData])));
});

test("capture: an unsupported mime type throws", () => {
	assert.throws(() => parseViewportCaptureResult(result([view({ mime_type: "application/octet-stream" })])));
});

test("capture: an empty views array throws", () => {
	assert.throws(() => parseViewportCaptureResult(result([])));
});

test("capture: nine views exceeds the view cap", () => {
	const views = Array.from({ length: 9 }, (_, index) => view({ name: `view_${index}` }));
	assert.throws(() => parseViewportCaptureResult(result(views)));
});

test("capture: an unknown extra field throws (closed schema)", () => {
	assert.throws(() => parseViewportCaptureResult(result([view({ extra: true })])));
	assert.throws(() => parseViewportCaptureResult(result([view()], { extra: true })));
});

test("capture: duplicate view names throw INVALID_CAPTURE_VIEWPORT_RESULT", () => {
	assert.throws(
		() => parseViewportCaptureResult(result([view({ name: "front" }), view({ name: "front" })])),
		/INVALID_CAPTURE_VIEWPORT_RESULT: duplicate view name/,
	);
});

test("capture: non-canonical base64 throws INVALID_CAPTURE_VIEWPORT_RESULT", () => {
	// Valid base64 alphabet but with trailing padding/whitespace that decodes
	// to bytes that re-encode to a different string -- not canonical.
	assert.throws(
		() => parseViewportCaptureResult(result([view({ data_base64: `${jpegBase64}\n` })])),
		/INVALID_CAPTURE_VIEWPORT_RESULT: view data must be canonical base64/,
	);
	// A second non-canonical form: same bytes but with interior whitespace,
	// which the decoder strips so the re-encoded string differs.
	assert.throws(
		() =>
			parseViewportCaptureResult(
				result([view({ data_base64: `${jpegBase64.slice(0, 12)} ${jpegBase64.slice(12)}` })]),
			),
		/INVALID_CAPTURE_VIEWPORT_RESULT: view data must be canonical base64/,
	);
});

test("capture: an oversized image throws CAPTURE_VIEWPORT_IMAGE_LIMIT", () => {
	assert.equal(VIEWPORT_CAPTURE_MAX_IMAGE_BYTES, 2 * 1024 * 1024);
	assert.equal(VIEWPORT_CAPTURE_MAX_VIEWS, 8);
	const oversized = Buffer.alloc(VIEWPORT_CAPTURE_MAX_IMAGE_BYTES + 1, 7);
	assert.throws(
		() => parseViewportCaptureResult(result([view({ data_base64: oversized.toString("base64") })])),
		/CAPTURE_VIEWPORT_IMAGE_LIMIT/,
	);
});

test("capture request: a closed no-subject request parses", () => {
	const parsed = parseViewportCaptureRequest({ subject: null, views: null, project_id: "project-1" });
	assert.deepEqual(parsed, { subject: null, views: null, project_id: "project-1" });
});

test("capture request: a subject with named views parses", () => {
	const parsed = parseViewportCaptureRequest({
		subject: "12345678-1234-4abc-9def-1234567890ab",
		views: ["three_quarter", "side"],
		project_id: null,
	});
	assert.deepEqual(parsed.views, ["three_quarter", "side"]);
});

test("capture request: views without a subject are refused", () => {
	assert.throws(
		() => parseViewportCaptureRequest({ subject: null, views: ["side"], project_id: null }),
		/INVALID_CAPTURE_VIEWPORT_REQUEST: named views require a subject/,
	);
});

test("capture request: duplicate view names are refused", () => {
	assert.throws(
		() =>
			parseViewportCaptureRequest({
				subject: "12345678-1234-4abc-9def-1234567890ab",
				views: ["side", "side"],
				project_id: null,
			}),
		/INVALID_CAPTURE_VIEWPORT_REQUEST: view names must be unique/,
	);
});

test("capture request: unknown keys, unknown view names, and missing keys are refused", () => {
	assert.throws(() => parseViewportCaptureRequest({ subject: null, views: null, project_id: null, quality: 90 }));
	assert.throws(() =>
		parseViewportCaptureRequest({
			subject: "12345678-1234-4abc-9def-1234567890ab",
			views: ["worm_eye"],
			project_id: null,
		}),
	);
	assert.throws(() => parseViewportCaptureRequest({ subject: null, views: null }));
	assert.throws(() => parseViewportCaptureRequest({ subject: "not-a-uuid", views: null, project_id: null }));
});
