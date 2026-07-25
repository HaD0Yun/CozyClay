import { type Static, type TSchema, Type } from "typebox";
import { Parse } from "typebox/value";

const HASH_64 = "^[0-9a-f]{64}$";
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

// Fail-closed on purpose: the bridge turns every captured view into a model
// image content block built from {mime_type, data_base64}. A malformed view
// that slips through with an undefined mime type serializes as
// `data:undefined;base64,undefined`, and once that block enters the model
// conversation the provider API rejects every subsequent request for that
// session -- the conversation is permanently poisoned. This schema closes the
// wire shape in both directions and re-checks each view's base64/size, so a
// broken add-on payload fails loudly here instead of emitting an unusable
// content block downstream.
export const VIEWPORT_CAPTURE_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const VIEWPORT_CAPTURE_MAX_VIEWS = 8;
const MAX_IMAGE_BASE64_LENGTH = 4 * Math.ceil(VIEWPORT_CAPTURE_MAX_IMAGE_BYTES / 3);

const ViewportCaptureViewV1Schema = exact({
	name: Type.String({ minLength: 1, maxLength: 64 }),
	mime_type: Type.Union([Type.Literal("image/jpeg"), Type.Literal("image/png")]),
	data_base64: Type.String({ minLength: 12 }),
	width: Type.Integer({ minimum: 1, maximum: 4096 }),
	height: Type.Integer({ minimum: 1, maximum: 4096 }),
	method: Type.String({ minLength: 1, maxLength: 32 }),
});

export const ViewportCaptureResultV1Schema = exact({
	revision: Type.String({ pattern: HASH_64 }),
	views: Type.Array(ViewportCaptureViewV1Schema, { minItems: 1, maxItems: VIEWPORT_CAPTURE_MAX_VIEWS }),
});

// The request is closed in the same direction as the result: the bridge
// envelope carries an untyped `params` record, so exactness has to live in the
// method contract or it lives nowhere. `subject`/`views`/`project_id` are
// always present and explicitly null when unset, which keeps the add-on's
// `.get()` reads honest and makes an unknown key a hard failure.
export const VIEWPORT_CAPTURE_VIEW_NAMES = ["three_quarter", "front", "side", "top", "contact_low"] as const;
const UUID_V4_LOWERCASE = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

export const ViewportCaptureRequestV1Schema = exact({
	subject: Type.Union([Type.String({ pattern: UUID_V4_LOWERCASE }), Type.Null()]),
	views: Type.Union([
		Type.Array(Type.Union(VIEWPORT_CAPTURE_VIEW_NAMES.map((name) => Type.Literal(name))), {
			minItems: 1,
			maxItems: VIEWPORT_CAPTURE_MAX_VIEWS,
		}),
		Type.Null(),
	]),
	project_id: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
});

export type ViewportCaptureRequestV1 = Static<typeof ViewportCaptureRequestV1Schema>;

export function parseViewportCaptureRequest(input: unknown): ViewportCaptureRequestV1 {
	const parsed = Parse(ViewportCaptureRequestV1Schema, input);
	if (parsed.views !== null && parsed.subject === null) {
		// The no-subject capture is the human's live viewport and cannot honour
		// named views. Accepting the combination would return a different image
		// than the caller asked for, which is worse than failing.
		throw new Error("INVALID_CAPTURE_VIEWPORT_REQUEST: named views require a subject entity id");
	}
	if (parsed.views !== null && new Set(parsed.views).size !== parsed.views.length) {
		throw new Error("INVALID_CAPTURE_VIEWPORT_REQUEST: view names must be unique");
	}
	return parsed;
}

export type ViewportCaptureViewV1 = Static<typeof ViewportCaptureViewV1Schema>;
export type ViewportCaptureResultV1 = Static<typeof ViewportCaptureResultV1Schema>;

/** Fail an oversized view with its coded error before schema parsing walks it. */
function rejectOversizedEncodedViews(input: unknown): void {
	if (typeof input !== "object" || input === null || !("views" in input) || !Array.isArray(input.views)) return;
	for (const view of input.views) {
		if (typeof view !== "object" || view === null || !("data_base64" in view)) continue;
		const dataBase64 = view.data_base64;
		if (typeof dataBase64 === "string" && dataBase64.length > MAX_IMAGE_BASE64_LENGTH) {
			throw new Error("CAPTURE_VIEWPORT_IMAGE_LIMIT: view image exceeds 2 MiB");
		}
	}
}

export function parseViewportCaptureResult(input: unknown): ViewportCaptureResultV1 {
	rejectOversizedEncodedViews(input);
	const parsed = Parse(ViewportCaptureResultV1Schema, input);
	const seen = new Set<string>();
	for (const view of parsed.views) {
		if (seen.has(view.name)) {
			throw new Error(`INVALID_CAPTURE_VIEWPORT_RESULT: duplicate view name ${view.name}`);
		}
		seen.add(view.name);

		const bytes = Buffer.from(view.data_base64, "base64");
		if (bytes.byteLength > VIEWPORT_CAPTURE_MAX_IMAGE_BYTES) {
			throw new Error("CAPTURE_VIEWPORT_IMAGE_LIMIT: view image exceeds 2 MiB");
		}
		if (bytes.toString("base64") !== view.data_base64) {
			throw new Error("INVALID_CAPTURE_VIEWPORT_RESULT: view data must be canonical base64");
		}
	}
	return parsed;
}
