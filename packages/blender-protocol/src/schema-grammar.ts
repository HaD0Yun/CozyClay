// Shared ARDY protocol grammar: the exact regexes and shape helpers every
// ARDY bridge surface (ardy-regenerate, ardy-generate, ardy-inbetween) uses.
// Extracted from ardy-regenerate.ts so the closed request/result/outcome
// schemas stay byte-for-byte identical across bridges instead of each file
// re-deriving the patterns and drifting apart. The regexes are the source of
// truth for what the bridge layer admits; changing one changes every bridge.
import { type TSchema, Type } from "typebox";

export const UUID_V4_LOWERCASE = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
export const HASH_64 = "^[0-9a-f]{64}$";
// Request ids are uuid4 hex (`uuid.uuid4().hex`) used VERBATIM as durable
// queue filenames (`f"{_require_request_id(request_id)}.json"`), so the
// grammar is exactly the add-on's: blender-addon/cclay/constraint_capture.py
// :62 (_REQUEST_ID = `[0-9a-f]{32}`), :945 and :1104 (filename
// construction), :1115-1116 (new_request_id()). Path separators, dot-dot,
// and over-length components must be unrepresentable, because the id is
// joined into a path without any escaping.
// The legacy ardy_regenerate shape predates this grammar and is
// intentionally untouched.
export const REQUEST_ID_PATTERN = "^[0-9a-f]{32}$";
// Mirrors the addon grammar documented inline in scripts/cclay-ardy-generate
// (line 329: `# motion_id: addon grammar ^[a-z0-9][a-z0-9-]{0,63}$`) and
// _MOTION_ID in blender-addon/cclay/stage_scene.py — the same slug the addon
// and the generate wrapper validate, so the bridge cannot admit a motion id
// that apply_motion would later reject.
export const MOTION_ID_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";
export const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
export const uuid = () => Type.String({ pattern: UUID_V4_LOWERCASE });
export const hash = () => Type.String({ pattern: HASH_64 });
// The length is pinned as well as anchored. JavaScript's `$` outside multiline
// mode already anchors at true end-of-input — `/^[0-9a-f]{32}$/u.test("a"*32 +
// "\n")` is false, matching Python's `re.fullmatch` — but an explicit
// minLength/maxLength keeps the 32-byte filename component guaranteed even if
// the pattern is ever recompiled with different flags.
export const requestId = () => Type.String({ pattern: REQUEST_ID_PATTERN, minLength: 32, maxLength: 32 });
export const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
export const motionId = () => Type.String({ pattern: MOTION_ID_PATTERN });
