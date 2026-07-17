# Scene Snapshot v2 Specification

Status: approved for implementation
Supersedes: `SceneSnapshot` schemaVersion 1 (`packages/blender-director/src/manifest.ts`, `blender-addon/oh_my_blender/manifest.py`)
Converges toward: `SceneManifestV1` (BLENDER-HARNESS-ARCHITECTURE.md §6)

## 1. Purpose and scope

Snapshot v1 proves the round trip but cannot serve the directing loop:

- `rotationEuler` alone loses rotation for `QUATERNION`/`AXIS_ANGLE` objects, and cameras in this
  pipeline are authored via `to_track_quat` (see `scripts/ardy_blender_handoff.py` in the ARDY
  workspace).
- No camera intrinsics, no animation channels, no timeline markers, no render configuration —
  the four things `apply_camera_plan` and `render_qa_frames` will read and write.
- The v1 revision hash violates the architecture hashing contract: TypeScript sorts keys with
  locale-sensitive `localeCompare` and serializes numbers with engine-native `JSON.stringify`,
  while Python emits non-canonical `indent=2` JSON and never computes a hash at all. Cross-language
  byte parity (§6, "Stable identity and hashing") is unimplemented and untested.

Snapshot v2 fixes all of the above. It remains a **read-only extraction artifact**: it records
Blender ground truth and nothing else. Directing interpretation (action axis, cut motivation,
approval state) is product state and lives in `.omb/project.json`, never in the snapshot.

Out of scope for v2, deferred to `SceneManifestV1` (§8): stable entity IDs, rational timebase,
bones/armature channels, lights, materials, artifact references.

## 2. Schema (normative)

Top level:

```jsonc
{
  "schemaVersion": 2,
  "scene": Scene,
  "render": Render,
  "objects": [SceneObject, ...],   // sorted, §4
  "cameras": [Camera, ...],        // sorted, §4
  "markers": [Marker, ...],        // sorted, §4
  "animations": [Animation, ...]   // sorted, §4
}
```

Both parsers MUST reject unknown fields at every level (TypeBox: no additional properties;
Python: explicit key check). All fields below are required unless marked nullable.

### 2.1 Scene

| field | type | constraints |
|---|---|---|
| `name` | string | 1..256 chars, NFC |
| `frameStart` | integer | `0 <= frameStart <= frameEnd` |
| `frameEnd` | integer | `frameEnd <= 1_048_574` (Blender max) |
| `fps` | integer | `1..240` |
| `activeCamera` | string \| null | object name of `scene.camera`, null if unset |

`render.fps_base != 1.0` is rejected at export with `UNSUPPORTED_FPS_BASE`. Fractional frame
rates arrive with the rational timebase in `SceneManifestV1`, not as floats here.

### 2.2 Render

| field | type | constraints |
|---|---|---|
| `resolutionX` | integer | `1..65536` |
| `resolutionY` | integer | `1..65536` |
| `resolutionPercentage` | integer | `1..100` |

### 2.3 SceneObject

| field | type | constraints |
|---|---|---|
| `name` | string | 1..256 chars, NFC, unique within `objects` |
| `type` | string | Blender `Object.type` enum value (`"MESH"`, `"CAMERA"`, `"EMPTY"`, ...) |
| `parent` | string \| null | name of parent object; must exist in `objects` |
| `visible` | boolean | `visible_get()` in the export view layer |
| `location` | [number, number, number] | local translation, meters |
| `rotationMode` | string | Blender `rotation_mode` enum value |
| `rotationQuaternion` | [number, number, number, number] | `[w, x, y, z]`, canonical (below) |
| `scale` | [number, number, number] | local scale |

`rotationQuaternion` is the **only** rotation representation and is authoritative regardless of
`rotationMode`. The exporter converts the object's local rotation channels (mode-aware:
`rotation_euler.to_quaternion()`, `rotation_quaternion`, or axis-angle conversion), normalizes to
unit length, and canonicalizes sign: `w > 0`; if `w == 0`, the first nonzero component is
positive. `q` and `-q` therefore always hash identically. v1's `rotationEuler` field is removed —
machines consume this document, and dual representations drift.

`rotationMode` is retained because animation f-curves (§2.6) target mode-specific data paths;
consumers need it to interpret `dataPath` values.

### 2.4 Camera

One entry per object with `type == "CAMERA"`, keyed by the owning object's name.

| field | type | constraints |
|---|---|---|
| `name` | string | must match a `SceneObject` with `type == "CAMERA"` |
| `lens` | number | focal length mm, `> 0` |
| `sensorFit` | string | `"AUTO" \| "HORIZONTAL" \| "VERTICAL"` |
| `sensorWidth` | number | mm, `> 0` |
| `sensorHeight` | number | mm, `> 0` |
| `verticalFovRadians` | number | `Camera.angle_y`, `(0, π)` |
| `clipStart` | number | `> 0` |
| `clipEnd` | number | `> clipStart` |

`verticalFovRadians` is exported even though it is derivable from lens/sensor, because it is the
native quantity of the ARDY camera plan contract (§5); consumers MUST treat it as derived,
read-only truth and never hash-compare it against an independently recomputed value.

### 2.5 Marker

Timeline markers are Blender's native multi-camera cut representation and are the landing site
for plan `"cut"` transitions (§5).

| field | type | constraints |
|---|---|---|
| `name` | string | 1..256 chars, NFC |
| `frame` | integer | any |
| `camera` | string \| null | bound camera object name, null if unbound |

### 2.6 Animation

One entry per animated datablock. v2 supports exactly two target kinds.

| field | type | constraints |
|---|---|---|
| `objectName` | string | must exist in `objects` |
| `target` | string | `"object"` (Object animation data) or `"cameraData"` (Camera datablock animation data) |
| `fcurves` | [FCurve, ...] | sorted, §4 |

FCurve:

| field | type | constraints |
|---|---|---|
| `dataPath` | string | e.g. `"location"`, `"rotation_euler"`, `"angle"` |
| `arrayIndex` | integer | `>= 0` |
| `keyframes` | [Keyframe, ...] | sorted by `frame` ascending, frames strictly increasing |

Keyframe:

| field | type | constraints |
|---|---|---|
| `frame` | number | `co.x`; float, subframes preserved |
| `value` | number | `co.y` |
| `interpolation` | string | Blender keyframe interpolation enum (`"BEZIER"`, `"LINEAR"`, `"CONSTANT"`, ...) |
| `handleLeft` | [number, number] | `[frame, value]` |
| `handleRight` | [number, number] | `[frame, value]` |

Handles are included because two scenes differing only in Bezier handles are different motion;
excluding them would make the revision hash blind to real edits. Easing/back/period fields of
non-Bezier interpolation modes are out of scope for v2; the exporter rejects f-curves using
modifiers or non-default easing with `UNSUPPORTED_FCURVE_FEATURE` rather than silently dropping
information.

## 3. Export validation (Blender side)

The exporter fails the whole snapshot — never a partial document — on the first violation:

| error | condition |
|---|---|
| `EXPORT_NONFINITE` | any NaN/±Inf in any float channel. Python must serialize with `allow_nan=False`; the check happens per-value at extraction for a precise error message |
| `EXPORT_MAGNITUDE` | any float with absolute value `>= 1e15` (guarantees fixed-point canonical form, §4) |
| `UNSUPPORTED_FPS_BASE` | `render.fps_base != 1.0` |
| `UNSUPPORTED_LINKED_DATABLOCK` | any object/camera from a linked library |
| `UNSUPPORTED_FCURVE_FEATURE` | f-curve modifiers, drivers, or non-default easing |
| `SNAPSHOT_TOO_LARGE` | canonical bytes (§4) exceed 1 MiB (protocol single-message cap; larger scenes wait for the artifact channel) |

Duplicate object names cannot occur within one Blender file; the TypeScript parser still rejects
them (defense at the process boundary, same policy as v1's fps bounds).

## 4. Canonical serialization and revision hash

This section implements BLENDER-HARNESS-ARCHITECTURE.md §6 for snapshot v2 and MUST produce
byte-identical output in Python and TypeScript. `JSON.stringify` / `json.dumps` are **not** the
canonical serializer; both languages implement the same explicit writer.

1. **Strings** are Unicode NFC, serialized with JSON minimal escaping (`"` `\` and control
   characters only; no `\uXXXX` escaping of non-ASCII).
2. **Map keys** sort by Unicode code point (TypeScript: `a < b` on code units is insufficient for
   astral keys — compare code points; in practice all v2 keys are ASCII).
3. **Array order** is semantic and fixed before serialization:
   - `objects`, `cameras`, `markers` sort by `name` (code-point order); `markers` tie-break by
     `frame` then `camera`;
   - `animations` sort by (`objectName`, `target`);
   - `fcurves` sort by (`dataPath`, `arrayIndex`);
   - `keyframes` sort by `frame`.
4. **Integers** (fields typed integer in §2) serialize base-10, no leading zeros, no sign for zero.
5. **Floats** (fields typed number) are interpreted from exact IEEE-754 binary64 bits and written
   as decimal rounded **half-even to 1e-9** (9 fractional digits), then trailing fractional zeros
   and a bare trailing `.` are stripped; `-0` becomes `0`. No exponent notation (guaranteed
   representable by the `EXPORT_MAGNITUDE` bound). Language-native `round()`/`toFixed` are not the
   contract; the implementation must be big-decimal exact (e.g. scaled-integer arithmetic over the
   exact binary64 decimal expansion).
6. **Whitespace**: none. **Booleans/null**: JSON literals.
7. `revision` is lowercase-hex SHA-256 over the UTF-8 canonical bytes of the full snapshot.

The snapshot **file** written by Blender MAY be pretty-printed for humans; the canonical bytes
are recomputed from parsed values by both sides. Parity is over the hash, not the file.

Consequence for v1 code: `canonicalize()`'s `localeCompare` and native number serialization in
`manifest.ts` are removed, replaced by the shared canonical writer. `manifest.py` gains the same
writer plus `scene_hash` computation so Python can assert parity in its own tests.

## 5. ARDY camera plan mapping (fixture contract)

The ARDY camera plan v1 (`{version, output_format, keyframes[{frame, pose{position, look_at, up,
vertical_fov_radians}, transition}]}`) is adopted as a **committed protocol fixture**. The mapping
from plan to Blender scene, applied by the fixture builder (and later by `apply_camera_plan`):

- One camera object; plan `position`/`look_at` produce location and a `to_track_quat("-Z", "Y")`
  rotation keyed on the camera object; `vertical_fov_radians` keys `Camera.angle` on the camera
  datablock (`target: "cameraData"`, `dataPath: "angle"`).
- `transition: "smooth"` spans use `BEZIER` interpolation with default auto-clamped handles.
- `transition: "cut"` is an adjacent-frame keyframe pair (N−1 hold, N new pose) with `CONSTANT`
  interpolation on the N−1 key, plus a timeline marker named `CUT_<N>` bound to the camera at
  frame N. Markers make cuts first-class in the snapshot instead of an inference over keyframe
  spacing.
- Plan `up` must be `[0, 1, 0]` in v1; anything else is `UNSUPPORTED_PLAN_UP`.
- Round-trip verification compares plan-derived pose values against snapshot f-curve values with
  absolute tolerance `1e-6` (euler/quaternion conversion is not byte-exact); the snapshot hash
  itself remains byte-exact.

The committed fixture is the boxing v4 plan (5 shots, cuts at 80/161/199/243, 320 source frames,
24 fps) — the same contract already validated end-to-end by the rendered `boxing-16s-cinematic-v4`
QA evidence.

## 6. Version policy

Pre-release, single consumer: the TypeScript parser accepts `schemaVersion: 2` only. v1 documents
are rejected with the standard schema error; migration is re-export. No dual-version support, no
silent upgrade.

## 7. Test contract

1. **Cross-language hash parity**: Python exports the boxing fixture snapshot and prints its own
   canonical SHA-256; the TypeScript suite parses the same JSON and asserts an identical
   `revision`. This test is required CI for any change touching either serializer.
2. **Number canonicalization table**: shared fixture of adversarial binary64 values (halfway
   cases at 1e-9, `-0`, values near the 1e15 bound, shortest-repr disagreements like `0.1+0.2`)
   with expected canonical strings, executed against both writers.
3. **Quaternion fidelity**: fixture object with `rotation_mode = "QUATERNION"` and one with
   negative-`w` quaternion; snapshot must contain the canonical-sign unit quaternion, and the two
   sign variants must hash identically.
4. **ARDY plan round-trip**: build the scene from the committed v4 plan, export, assert camera
   f-curves and `CUT_*` markers match §5 within tolerance, and assert the snapshot hash is stable
   across two exports of the same scene.
5. **Boundary rejection**: unknown field, duplicate object name, non-increasing keyframe frames,
   `fps: 0`, non-finite float, oversized snapshot — each rejected by the TypeScript parser (and
   by the Python exporter where the error class is export-side).
6. **Reparse idempotence**: `parse(canonical_bytes)` re-canonicalizes to the same bytes.

## 8. Deferred to SceneManifestV1 (convergence map)

| concern | v2 | SceneManifestV1 |
|---|---|---|
| identity | object names (unique per file, not rename-stable) | `omb.entity_id` UUIDs via `Initialize Project` |
| sort keys | names | stable IDs |
| timebase | integer fps, `fps_base == 1.0` enforced | reduced integer rationals |
| coverage | objects, cameras, markers, object/camera-data f-curves | + bones, lights, selected-ID sets |
| transport | file / inline JSON ≤ 1 MiB | `omb-artifact://sha256/<digest>` |
| numeric + key canonicalization | §4 (already final) | unchanged |

The §4 rules are written to be identical to §6 of the architecture document so that the migration
to `SceneManifestV1` changes identity and coverage, never the arithmetic of hashing.
