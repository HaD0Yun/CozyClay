import assert from "node:assert/strict";
import { test } from "node:test";
import type { ViewportCaptureResultV1 } from "@cclay/protocol";
import { createCaptureViewportTool } from "../src/capture-viewport.ts";

const REVISION = "a".repeat(64);
// A small canonical base64 image payload: a 1x1 PNG. The tool never decodes it,
// so it only has to be a stable non-empty string the assertions can compare.
const IMAGE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

function singleViewResult(): ViewportCaptureResultV1 {
	return {
		revision: REVISION,
		views: [
			{
				name: "viewport",
				mime_type: "image/jpeg",
				data_base64: IMAGE_BASE64,
				width: 1024,
				height: 576,
				method: "offscreen",
			},
		],
	};
}

function threeViewResult(): ViewportCaptureResultV1 {
	return {
		revision: REVISION,
		views: [
			{
				name: "three_quarter",
				mime_type: "image/jpeg",
				data_base64: IMAGE_BASE64,
				width: 1024,
				height: 576,
				method: "three_quarter",
			},
			{
				name: "side",
				mime_type: "image/jpeg",
				data_base64: IMAGE_BASE64,
				width: 1024,
				height: 576,
				method: "side",
			},
			{
				name: "contact_low",
				mime_type: "image/jpeg",
				data_base64: IMAGE_BASE64,
				width: 1024,
				height: 576,
				method: "contact_low",
			},
		],
	};
}

test("capture_viewport no-subject call forwards an empty request and emits text+image+summary blocks in order", async () => {
	let received: { subject?: string; views?: readonly string[] } | undefined;
	const tool = createCaptureViewportTool({
		captureViewport: async (request) => {
			received = request;
			return singleViewResult();
		},
	});
	const output = await tool.execute("call", {}, undefined, undefined, undefined as never);
	// The no-subject request forwards a {}-shaped object (no subject, no views).
	assert.deepEqual(received, {});
	// details is the exact result object the bridge returned.
	assert.deepEqual(output.details, singleViewResult());
	assert.equal(output.content.length, 3);
	assert.deepEqual(output.content[0], { type: "text", text: "view viewport: 1024x576 via offscreen" });
	assert.deepEqual(output.content[1], { type: "image", mimeType: "image/jpeg", data: IMAGE_BASE64 });
	assert.deepEqual(output.content[2], {
		type: "text",
		text: `capture_viewport: 1 view(s), revision ${REVISION.slice(0, 12)}`,
	});
});

test("capture_viewport three-view payload emits label/image pairs in capture order", async () => {
	const tool = createCaptureViewportTool({
		captureViewport: async () => threeViewResult(),
	});
	const output = await tool.execute(
		"call",
		{ subject: "12345678-1234-4abc-9def-1234567890ab" },
		undefined,
		undefined,
		undefined as never,
	);
	// Assert the exact sequence, not filtered groups: a regression that emitted
	// every label first and every image afterwards would still satisfy counts,
	// and the model would lose which image belongs to which view.
	assert.deepEqual(output.content, [
		{ type: "text", text: "view three_quarter: 1024x576 via three_quarter" },
		{ type: "image", mimeType: "image/jpeg", data: IMAGE_BASE64 },
		{ type: "text", text: "view side: 1024x576 via side" },
		{ type: "image", mimeType: "image/jpeg", data: IMAGE_BASE64 },
		{ type: "text", text: "view contact_low: 1024x576 via contact_low" },
		{ type: "image", mimeType: "image/jpeg", data: IMAGE_BASE64 },
		{ type: "text", text: `capture_viewport: 3 view(s), revision ${REVISION.slice(0, 12)}` },
	]);
});

test("capture_viewport forwards subject and views verbatim to the bridge", async () => {
	let received: { subject?: string; views?: readonly string[] } | undefined;
	const subjectId = "12345678-1234-4abc-9def-1234567890ab";
	const views = ["front", "top"] as const;
	const tool = createCaptureViewportTool({
		captureViewport: async (request) => {
			received = request;
			return threeViewResult();
		},
	});
	await tool.execute("call", { subject: subjectId, views: [...views] }, undefined, undefined, undefined as never);
	assert.equal(received?.subject, subjectId);
	assert.deepEqual(received?.views, [...views]);
});

test("capture_viewport regression guard: every emitted image block has a non-empty string mimeType and data", async () => {
	const tool = createCaptureViewportTool({
		captureViewport: async () => threeViewResult(),
	});
	const output = await tool.execute("call", {}, undefined, undefined, undefined as never);
	for (const block of output.content) {
		if (block.type === "image") {
			assert.ok(
				typeof block.mimeType === "string" && block.mimeType.length > 0,
				"regression: image block mimeType must be a non-empty string",
			);
			assert.ok(
				typeof block.data === "string" && block.data.length > 0,
				"regression: image block data must be a non-empty string",
			);
		}
	}
});

test("capture_viewport refuses named views without a subject", async () => {
	let called = false;
	const tool = createCaptureViewportTool({
		captureViewport: async () => {
			called = true;
			return singleViewResult();
		},
	});
	await assert.rejects(
		tool.execute("call", { views: ["side"] }, undefined, undefined, undefined as never),
		/`views` requires `subject`/,
	);
	assert.equal(called, false, "the bridge is never reached for an unsatisfiable request");
});

test("capture_viewport refuses to emit an image block for a malformed view", async () => {
	// Defense in depth: the extension bridge already parses this payload, but
	// CaptureViewportBridge is an interface. A skewed implementation reaching
	// the tool directly must still never produce
	// `data:undefined;base64,undefined` (or an unsupported mime type, or
	// non-canonical base64), which permanently poisons the model conversation.
	const poisoned = [
		{ mime_type: undefined, data_base64: undefined },
		{ mime_type: "", data_base64: IMAGE_BASE64 },
		{ mime_type: "image/jpeg", data_base64: "" },
		{ mime_type: "application/octet-stream", data_base64: IMAGE_BASE64 },
		{ mime_type: "image/jpeg", data_base64: `${IMAGE_BASE64}\n` },
	];
	for (const overrides of poisoned) {
		const tool = createCaptureViewportTool({
			captureViewport: async () =>
				({
					revision: REVISION,
					views: [{ name: "viewport", width: 1024, height: 576, method: "offscreen", ...overrides }],
				}) as unknown as ViewportCaptureResultV1,
		});
		await assert.rejects(tool.execute("call", {}, undefined, undefined, undefined as never));
	}
});
