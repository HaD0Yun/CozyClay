"""Pure (bpy-free) tests for animation-curve summarization and inspect_entity params.

Covers the G002 fix: a fully-keyed rig (~113k keyframes) must serialize far
under the model context window, the per-curve keyframes are withheld when the
budget is exceeded, and the narrowing params (data_path_filter / frame_start /
frame_end) recover exact keys. Also pins the closed param validation in
``Connection._inspect_entity_result``.
"""

from __future__ import annotations

import pathlib
import sys
import unittest
from unittest import mock

ADDON_ROOT = pathlib.Path(__file__).parents[1]
sys.path.insert(0, str(ADDON_ROOT))

from cclay.entity_animation import (
    AnimationBudgetError,
    MAX_ANIMATION_BYTES,
    MAX_CURVES,
    MAX_GROUPS,
    MAX_KEYFRAMES,
    MAX_RESULT_BYTES,
    fit_result_to_budget,
    _js_json_size,
    _js_number,
    _group_name,
    summarize_animation_curves,
)
from cclay.connection import Connection, ConnectionError

REVISION = "a" * 64
ENTITY_ID = "a1b2c3d4-e5f4-4a1b-8c2d-3e4f5a6b7c8d"

def _animation_payload_size(result):
    """Size the projection manifest._entity_detail actually publishes.

    The summarizer returns the summary under "summary"; the detail publishes it
    under "animationSummary", and the extension bridge measures JSON.stringify
    bytes. Measuring anything else would test a shape no caller ever sees.
    """
    return _js_json_size(
        {"animations": result["animations"], "animationSummary": result["summary"]}
    )


def _curve(source, data_path, array_index, keyframes):
    return {
        "source": source,
        "dataPath": data_path,
        "arrayIndex": array_index,
        "keyframes": keyframes,
    }


def _kp(frame, value=0.0, interpolation="LINEAR"):
    return {"frame": frame, "value": value, "interpolation": interpolation}


def _synthetic_rig(bones=65, channels=7, frames=250):
    """65 bones x 7 channels x 250 keyframes (~113750 keyframes)."""
    curves = []
    for b in range(bones):
        bone = f"mixamorig:Bone{b:02d}"
        for c in range(channels):
            channel = ("location", "rotation_euler", "scale")[c % 3]
            array_index = c % 3
            data_path = f'pose.bones["{bone}"].{channel}'
            keyframes = [
                _kp(f, value=float((b * channels + c) * 1000 + f))
                for f in range(1, frames + 1)
            ]
            curves.append(_curve("data", data_path, array_index, keyframes))
    return curves


class LargeRigBudgetTests(unittest.TestCase):
    def test_113k_keyframe_rig_serializes_under_200kb(self):
        curves = _synthetic_rig()
        raw_count = sum(len(c["keyframes"]) for c in curves)
        self.assertGreater(raw_count, 110000)
        result = summarize_animation_curves(curves)
        # The 2 MB incident payload is provably impossible: the bounded summary
        # of a 113k-keyframe rig sits under the 32 KB animation ceiling, three
        # orders of magnitude below the payload that killed the session.
        self.assertLessEqual(_animation_payload_size(result), MAX_ANIMATION_BYTES)

    def test_keyframes_absent_from_every_curve_when_over_budget(self):
        curves = _synthetic_rig()
        result = summarize_animation_curves(curves)
        self.assertGreater(len(result["animations"]), 0)
        for entry in result["animations"]:
            self.assertNotIn("keyframes", entry)

    def test_summary_counts_are_truthful_and_truncated_set(self):
        curves = _synthetic_rig()
        result = summarize_animation_curves(curves)
        summary = result["summary"]
        expected_curves = 65 * 7  # 455
        expected_keyframes = 65 * 7 * 250  # 113750
        # curveCount reports the full filtered selection, not the capped rows.
        self.assertEqual(summary["curveCount"], expected_curves)
        self.assertEqual(summary["keyframeCount"], expected_keyframes)
        truncated = summary["truncated"]
        self.assertIsNotNone(truncated)
        # When over budget every keyframes list is withheld.
        self.assertEqual(truncated["keyframesOmitted"], expected_keyframes)
        # Hint names the narrowing params.
        self.assertIn("data_path_filter", truncated["hint"])
        self.assertIn("frame_start", truncated["hint"])
        self.assertIn("frame_end", truncated["hint"])

    def test_curve_rows_bounded_by_byte_ceiling(self):
        # The 65x7 rig is over the keyframe budget (so no keyframes emitted) and
        # its 455 summary rows exceed the 32 KB animation ceiling, so the byte
        # budget drops trailing rows until it fits. The row count is therefore
        # below MAX_CURVES, and curvesOmitted counts both the count-cap drop and
        # the byte-budget drop.
        curves = _synthetic_rig()
        result = summarize_animation_curves(curves)
        self.assertLess(len(result["animations"]), MAX_CURVES)
        self.assertLessEqual(_animation_payload_size(result), MAX_ANIMATION_BYTES)
        truncated = result["summary"]["truncated"]
        self.assertIsNotNone(truncated)
        # curvesOmitted is truthful: full selection minus emitted rows.
        self.assertEqual(
            truncated["curvesOmitted"], (65 * 7) - len(result["animations"])
        )


class SmallAnimationTests(unittest.TestCase):
    def setUp(self):
        self.curves = [
            _curve("object", "location", 0, [_kp(1, 1.0), _kp(5, 5.0)]),
            _curve("object", "location", 1, [_kp(2, 2.0), _kp(6, 6.0)]),
        ]

    def test_small_animation_keeps_full_keyframes_and_no_truncation(self):
        result = summarize_animation_curves(self.curves)
        for entry in result["animations"]:
            self.assertIn("keyframes", entry)
            self.assertEqual(len(entry["keyframes"]), 2)
        self.assertIsNone(result["summary"]["truncated"])

    def test_summary_fields_for_small_animation(self):
        result = summarize_animation_curves(self.curves)
        summary = result["summary"]
        self.assertEqual(summary["curveCount"], 2)
        self.assertEqual(summary["keyframeCount"], 4)
        self.assertEqual(summary["frameStart"], 1)
        self.assertEqual(summary["frameEnd"], 6)
        self.assertEqual(summary["groups"], [
            {"name": "location", "curveCount": 2, "keyframeCount": 4},
        ])

    def test_per_curve_summary_fields(self):
        result = summarize_animation_curves(self.curves)
        entry = result["animations"][0]
        for field in (
            "source",
            "dataPath",
            "arrayIndex",
            "keyframeCount",
            "frameStart",
            "frameEnd",
            "valueMin",
            "valueMax",
            "interpolations",
            "keyframes",
        ):
            self.assertIn(field, entry)
        self.assertEqual(entry["valueMin"], 1.0)
        self.assertEqual(entry["valueMax"], 5.0)
        self.assertEqual(entry["interpolations"], ["LINEAR"])


class DataPathFilterTests(unittest.TestCase):
    def test_filter_narrows_to_one_bone_with_exact_keyframes(self):
        curves = [
            _curve("data", 'pose.bones["mixamorig:LeftFoot"].location', 0,
                   [_kp(1, 1.0), _kp(5, 5.0)]),
            _curve("data", 'pose.bones["mixamorig:RightFoot"].location', 0,
                   [_kp(2, 2.0), _kp(6, 6.0)]),
        ]
        result = summarize_animation_curves(curves, data_path_filter="LeftFoot")
        self.assertEqual(len(result["animations"]), 1)
        entry = result["animations"][0]
        self.assertEqual(entry["dataPath"], 'pose.bones["mixamorig:LeftFoot"].location')
        self.assertIn("keyframes", entry)
        self.assertEqual([kp["frame"] for kp in entry["keyframes"]], [1, 5])

    def test_filter_case_sensitive_substring(self):
        curves = [
            _curve("data", 'pose.bones["Foot"].location', 0, [_kp(1)]),
            _curve("data", 'pose.bones["foot"].location', 0, [_kp(2)]),
        ]
        result = summarize_animation_curves(curves, data_path_filter="Foot")
        self.assertEqual(len(result["animations"]), 1)
        self.assertEqual(result["animations"][0]["dataPath"], 'pose.bones["Foot"].location')

    def test_filtered_out_curve_not_counted_as_omitted(self):
        # Filtering is the caller's intent, not the budget's doing.
        curves = [
            _curve("object", "location", 0, [_kp(1), _kp(2)]),
            _curve("object", "rotation_euler", 0, [_kp(1), _kp(2)]),
        ]
        result = summarize_animation_curves(curves, data_path_filter="location")
        self.assertIsNone(result["summary"]["truncated"])
        self.assertEqual(result["summary"]["curveCount"], 1)


class FrameRangeTests(unittest.TestCase):
    def setUp(self):
        self.curves = [
            _curve("object", "location", 0, [
                _kp(1, 1.0), _kp(5, 5.0), _kp(10, 10.0), _kp(20, 20.0),
            ]),
        ]

    def test_frame_start_clips_inclusively(self):
        result = summarize_animation_curves(self.curves, frame_start=5)
        entry = result["animations"][0]
        self.assertEqual([kp["frame"] for kp in entry["keyframes"]], [5, 10, 20])
        self.assertEqual(entry["keyframeCount"], 3)
        self.assertEqual(entry["frameStart"], 5)
        self.assertEqual(entry["frameEnd"], 20)

    def test_frame_end_clips_inclusively(self):
        result = summarize_animation_curves(self.curves, frame_end=10)
        entry = result["animations"][0]
        self.assertEqual([kp["frame"] for kp in entry["keyframes"]], [1, 5, 10])
        self.assertEqual(entry["keyframeCount"], 3)
        self.assertEqual(entry["frameStart"], 1)
        self.assertEqual(entry["frameEnd"], 10)

    def test_both_bounds_clip_and_update_summary(self):
        result = summarize_animation_curves(self.curves, frame_start=5, frame_end=10)
        entry = result["animations"][0]
        self.assertEqual([kp["frame"] for kp in entry["keyframes"]], [5, 10])
        summary = result["summary"]
        self.assertEqual(summary["keyframeCount"], 2)
        self.assertEqual(summary["frameStart"], 5)
        self.assertEqual(summary["frameEnd"], 10)

    def test_curve_with_all_keyframes_filtered_out_is_dropped(self):
        result = summarize_animation_curves(self.curves, frame_start=100)
        self.assertEqual(result["animations"], [])
        self.assertEqual(result["summary"]["curveCount"], 0)
        self.assertIsNone(result["summary"]["truncated"])


class GroupNameTests(unittest.TestCase):
    def test_pose_bone_name_double_quoted(self):
        self.assertEqual(
            _group_name('pose.bones["mixamorig:LeftFoot"].location'),
            "mixamorig:LeftFoot",
        )

    def test_pose_bone_name_single_quoted(self):
        self.assertEqual(
            _group_name("pose.bones['mixamorig:LeftFoot'].location"),
            "mixamorig:LeftFoot",
        )

    def test_object_level_path_returns_itself(self):
        self.assertEqual(_group_name("location"), "location")
        self.assertEqual(_group_name("rotation_euler"), "rotation_euler")

    def test_malformed_path_does_not_raise(self):
        # Non-string input falls back to itself.
        self.assertEqual(_group_name(None), None)
        # A pose path with an empty bone name falls back to the path.
        self.assertEqual(_group_name('pose.bones[""].location'), 'pose.bones[""].location')

    def test_pose_bone_custom_property_access_groups_under_bone(self):
        # ``pose.bones["Bone"]["custom_prop"]`` has no trailing dot; the regex
        # must still group it under ``Bone``.
        self.assertEqual(
            _group_name('pose.bones["Bone"]["custom_prop"]'),
            "Bone",
        )

    def test_pose_bone_single_quoted_location_groups_under_bone(self):
        # ``pose.bones['Bone'].location`` -- single-quoted with trailing dot.
        self.assertEqual(
            _group_name("pose.bones['Bone'].location"),
            "Bone",
        )

    def test_groups_capped_at_max_groups(self):
        # 300 distinct data paths -> 300 groups, capped to MAX_GROUPS.
        curves = [
            _curve("object", f"path{i}", 0, [_kp(i)])
            for i in range(MAX_GROUPS + 44)
        ]
        result = summarize_animation_curves(curves)
        self.assertEqual(len(result["summary"]["groups"]), MAX_GROUPS)


def _realistic_rig(bones=65, channels=10, frames=400):
    """65 bones x 10 channels x 400 keyframes (~260000 keyframes).

    Matches the red-team's realistic rig shape: a retargeted character with
    location/rotation_euler/scale/rotation_quaternion channels across every
    bone, fully keyed across a long frame range.
    """
    curves = []
    for b in range(bones):
        bone = f"mixamorig:Bone{b:02d}"
        for c in range(channels):
            channel = ("location", "rotation_euler", "scale", "rotation_quaternion")[c % 4]
            array_index = c % 4
            data_path = f'pose.bones["{bone}"].{channel}'
            keyframes = [
                _kp(f, value=float((b * channels + c) * 1000 + f))
                for f in range(1, frames + 1)
            ]
            curves.append(_curve("data", data_path, array_index, keyframes))
    return curves


def _long_data_path_curves(count=200, path_len=1000):
    """``count`` curves whose data paths are ~``path_len`` characters each.

    Matches the red-team's pathological-width case: MAX_CURVES rows with
    1000-character data paths, which the count caps alone cannot bound.
    """
    prefix = 'pose.bones["X"].'
    suffix = "p" * (path_len - len(prefix))
    curves = []
    for i in range(count):
        data_path = f"{prefix}{suffix}{i}"
        curves.append(_curve("data", data_path, 0, [_kp(j) for j in range(5)]))
    return curves


class AnimationByteCeilingTests(unittest.TestCase):
    """The 32 KB serialized-byte ceiling is the real bound, not the count caps."""

    def test_realistic_rig_serializes_under_32kb(self):
        curves = _realistic_rig()
        result = summarize_animation_curves(curves)
        measured = _animation_payload_size(result)
        # Report the measured size for the acceptance record.
        self.assertLessEqual(measured, MAX_ANIMATION_BYTES, measured)
        # Over the keyframe budget, so no keyframes emitted.
        for entry in result["animations"]:
            self.assertNotIn("keyframes", entry)

    def test_long_data_path_curves_serialize_under_32kb(self):
        curves = _long_data_path_curves()
        result = summarize_animation_curves(curves)
        measured = _animation_payload_size(result)
        self.assertLessEqual(measured, MAX_ANIMATION_BYTES, measured)
        # The byte budget must have dropped rows: 200 long-path summary rows
        # cannot fit in 32 KB, so fewer than MAX_CURVES are emitted.
        self.assertLess(len(result["animations"]), MAX_CURVES)

    def test_byte_driven_reduction_keeps_counts_truthful(self):
        curves = _long_data_path_curves()
        result = summarize_animation_curves(curves)
        summary = result["summary"]
        truncated = summary["truncated"]
        self.assertIsNotNone(truncated)
        # curveCount is the full filtered selection, not the emitted row count.
        self.assertEqual(summary["curveCount"], 200)
        # curvesOmitted = full selection minus emitted rows (truthful).
        self.assertEqual(
            truncated["curvesOmitted"], 200 - len(result["animations"])
        )
        # groupCount reports the full group set; groupsOmitted is truthful too.
        self.assertGreaterEqual(summary["groupCount"], len(summary["groups"]))
        self.assertEqual(
            truncated["groupsOmitted"], summary["groupCount"] - len(summary["groups"])
        )
        # The byte-budget reason is appended to truncated.reason.
        self.assertIn("byte budget", truncated["reason"])

    def test_byte_driven_keyframes_omitted_truthful_when_fits_all_but_over_bytes(self):
        # A selection that fits every count budget (so keyframes are emitted)
        # but exceeds the byte ceiling: the byte-dropped rows' keyframes must be
        # counted in keyframesOmitted.
        long_path = 'pose.bones["X"].' + "p" * 990
        curves = [
            _curve("data", f"{long_path}{i}", 0, [_kp(j) for j in range(2)])
            for i in range(200)
        ]
        # 200 curves <= MAX_CURVES, 400 keyframes <= MAX_KEYFRAMES, 1 group.
        result = summarize_animation_curves(curves)
        truncated = result["summary"]["truncated"]
        self.assertIsNotNone(truncated)
        self.assertGreater(truncated["keyframesOmitted"], 0)
        # Every withheld keyframe came from a byte-dropped row.
        emitted_kf = sum(e["keyframeCount"] for e in result["animations"])
        self.assertEqual(
            truncated["keyframesOmitted"], 400 - emitted_kf
        )


class ZeroKeyframeCurveTests(unittest.TestCase):
    """A zero-keyframe curve is preserved without a filter, dropped with one."""

    def test_zero_keyframe_curve_preserved_without_filter(self):
        curves = [
            _curve("data", 'pose.bones["Bone"].location', 0, []),
            _curve("data", 'pose.bones["Bone"].scale', 0, [_kp(1), _kp(2)]),
        ]
        result = summarize_animation_curves(curves)
        # The empty curve appears with keyframeCount 0 and null bounds.
        empty = next(
            e for e in result["animations"] if e["dataPath"].endswith(".location")
        )
        self.assertEqual(empty["keyframeCount"], 0)
        self.assertIsNone(empty["frameStart"])
        self.assertIsNone(empty["frameEnd"])
        self.assertIsNone(empty["valueMin"])
        self.assertIsNone(empty["valueMax"])
        self.assertEqual(empty["interpolations"], [])
        # The non-empty curve is still present.
        self.assertEqual(len(result["animations"]), 2)
        # No filter was supplied, so nothing was withheld.
        self.assertIsNone(result["summary"]["truncated"])

    def test_zero_keyframe_curve_dropped_with_filter(self):
        # A filter is caller intent: a zero-keyframe curve that matches the
        # filter is still dropped (its absence is not withheld), while a
        # non-empty curve that matches the filter survives.
        curves = [
            _curve("data", 'pose.bones["Bone"].location', 0, []),
            _curve("data", 'pose.bones["Bone"].location_scale', 0, [_kp(1), _kp(2)]),
            _curve("data", 'pose.bones["Bone"].rotation', 0, [_kp(3), _kp(4)]),
        ]
        result = summarize_animation_curves(curves, data_path_filter="location")
        # The empty location curve is dropped; the non-empty location_scale
        # curve survives; rotation does not match the filter.
        self.assertEqual(len(result["animations"]), 1)
        self.assertEqual(
            result["animations"][0]["dataPath"], 'pose.bones["Bone"].location_scale'
        )
        self.assertEqual(result["animations"][0]["keyframeCount"], 2)
        # Nothing was withheld by a budget -- the drop is caller intent.
        self.assertIsNone(result["summary"]["truncated"])


class InspectEntityParamValidationTests(unittest.TestCase):
    """Closed param validation in Connection._inspect_entity_result."""

    def _call(self, params, entity_detail=None):
        if entity_detail is None:
            def entity_detail(entity_id, scope, animation_query=None):
                return {"name": "ok"}
        # manifest.py imports bpy at module level, so it is not importable on
        # plain CPython. Stub the module in sys.modules so the inline
        # ``from .manifest import _entity_detail`` inside the method resolves.
        fake_manifest = mock.MagicMock(_entity_detail=entity_detail)
        with mock.patch.dict(sys.modules, {"cclay.manifest": fake_manifest}):
            return Connection._inspect_entity_result(None, REVISION, params)

    def test_non_dict_params_are_refused_rather_than_coerced(self):
        for params in ("entity", 3, [ENTITY_ID]):
            with self.subTest(params=params):
                with self.assertRaises(ConnectionError) as raised:
                    self._call(params)
                self.assertIn("params must be an object", str(raised.exception))

    def test_unknown_param_rejected(self):
        with self.assertRaises(ConnectionError) as raised:
            self._call({
                "entity_id": ENTITY_ID,
                "scope": "animation",
                "bogus": 1,
            })
        self.assertIn("unknown params", str(raised.exception))

    def test_missing_scope_rejected(self):
        # scope is required on both sides: no "all" default.
        with self.assertRaises(ConnectionError) as raised:
            self._call({"entity_id": ENTITY_ID})
        self.assertIn("scope is required", str(raised.exception))

    def test_non_uuid_entity_id_rejected(self):
        with self.assertRaises(ConnectionError) as raised:
            self._call({"entity_id": "e1", "scope": "animation"})
        self.assertIn("entity_id must be a lowercase UUID v4", str(raised.exception))

    def test_uppercase_uuid_entity_id_rejected(self):
        with self.assertRaises(ConnectionError) as raised:
            self._call({"entity_id": ENTITY_ID.upper(), "scope": "animation"})
        self.assertIn("entity_id must be a lowercase UUID v4", str(raised.exception))

    def test_missing_entity_id_rejected(self):
        with self.assertRaises(ConnectionError) as raised:
            self._call({"scope": "animation"})
        self.assertIn("entity_id is required", str(raised.exception))

    def test_non_string_data_path_filter_rejected(self):
        with self.assertRaises(ConnectionError) as raised:
            self._call({
                "entity_id": ENTITY_ID,
                "scope": "animation",
                "data_path_filter": 7,
            })
        self.assertIn("data_path_filter must be a non-empty string", str(raised.exception))

    def test_empty_data_path_filter_rejected(self):
        with self.assertRaises(ConnectionError) as raised:
            self._call({
                "entity_id": ENTITY_ID,
                "scope": "animation",
                "data_path_filter": "",
            })
        self.assertIn("data_path_filter must be a non-empty string", str(raised.exception))

    def test_boolean_frame_start_rejected(self):
        with self.assertRaises(ConnectionError) as raised:
            self._call({
                "entity_id": ENTITY_ID,
                "scope": "animation",
                "frame_start": True,
            })
        self.assertIn("frame_start must be an integer", str(raised.exception))

    def test_inverted_frame_range_rejected(self):
        with self.assertRaises(ConnectionError) as raised:
            self._call({
                "entity_id": ENTITY_ID,
                "scope": "animation",
                "frame_start": 10,
                "frame_end": 5,
            })
        self.assertIn("frame_start must be <= frame_end", str(raised.exception))

    def test_valid_uuid_and_scope_forwarded_to_entity_detail(self):
        seen = {}

        def entity_detail(entity_id, scope, animation_query=None):
            seen.update(entity_id=entity_id, scope=scope, animation_query=animation_query)
            return {"name": "ok"}

        result = self._call(
            {"entity_id": ENTITY_ID, "scope": "animation"},
            entity_detail=entity_detail,
        )
        self.assertEqual(seen["entity_id"], ENTITY_ID)
        self.assertEqual(seen["scope"], "animation")
        self.assertEqual(result["entity_id"], ENTITY_ID)
        self.assertEqual(result["scope"], "animation")

    def test_valid_narrowing_params_forwarded_to_entity_detail(self):
        seen = {}

        def entity_detail(entity_id, scope, animation_query=None):
            seen.update(entity_id=entity_id, scope=scope, animation_query=animation_query)
            return {"name": "ok"}

        self._call(
            {
                "entity_id": ENTITY_ID,
                "scope": "animation",
                "data_path_filter": "LeftFoot",
                "frame_start": 1,
                "frame_end": 100,
            },
            entity_detail=entity_detail,
        )
        self.assertEqual(seen["entity_id"], ENTITY_ID)
        self.assertEqual(seen["scope"], "animation")
        self.assertEqual(seen["animation_query"], {
            "data_path_filter": "LeftFoot",
            "frame_start": 1,
            "frame_end": 100,
        })

    def test_no_narrowing_params_passes_none_animation_query(self):
        seen = {}

        def entity_detail(entity_id, scope, animation_query=None):
            seen["animation_query"] = animation_query
            return {"name": "ok"}

        self._call({"entity_id": ENTITY_ID, "scope": "animation"}, entity_detail=entity_detail)
        self.assertIsNone(seen["animation_query"])


class JsNumberParityTests(unittest.TestCase):
    """The add-on must size a payload exactly as JSON.stringify would.

    The extension bridge refuses an inspect_entity result over the same ceiling
    by measuring JSON.stringify(result). If the two spellings disagree -- Python
    writes 1e-06 where JavaScript writes 0.000001 -- a legitimate near-ceiling
    response is refused after the work is done. These expectations were verified
    against real node JSON.stringify output.
    """

    def test_matches_javascript_spelling(self):
        cases = [
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (1e16, "10000000000000000"),
            (1e21, "1e+21"),
            (3.0, "3"),
            (-0.000001, "-0.000001"),
            (0.1, "0.1"),
            (0.30000000000000004, "0.30000000000000004"),
            (True, "true"),
            (7, "7"),
        ]
        for value, expected in cases:
            with self.subTest(value=value):
                self.assertEqual(_js_number(value), expected)

    def test_sizes_a_payload_in_utf8_bytes(self):
        # Korean bone names are three bytes per character, not one.
        self.assertEqual(_js_json_size({"name": "\ubc1c"}), len('{"name":"\ubc1c"}'.encode("utf-8")))
        self.assertEqual(_js_json_size([1e-6, 3.0]), len("[0.000001,3]"))

    def test_refuses_to_size_an_unsupported_type(self):
        with self.assertRaises(TypeError):
            _js_json_size({"when": object()})


class ResultEnvelopeBudgetTests(unittest.TestCase):
    """The add-on must bound the exact envelope the extension bridge measures."""

    def _envelope(self, detail):
        return {
            "revision": REVISION,
            "entity_id": ENTITY_ID,
            "scope": "all",
            "detail": detail,
        }

    def _size(self, result):
        return _js_json_size(result)

    def test_envelope_is_measured_not_just_detail(self):
        # A detail that fits 65536 bytes on its own but not once the revision,
        # entity_id, and scope fields are added must still be trimmed.
        bones = [
            {"name": f"mixamorig:LongBoneName{i:04d}", "parent": "mixamorig:Hips",
             "head": [0.123456, 0.234567, 0.345678],
             "tail": [0.456789, 0.567891, 0.678912],
             "length": 1.234567, "useConnect": False}
            for i in range(512)
        ]
        detail = {"name": "Rig", "type": "ARMATURE", "bones": bones}
        self.assertGreater(self._size(self._envelope(detail)), MAX_RESULT_BYTES)
        result = fit_result_to_budget(self._envelope(detail))
        self.assertLessEqual(self._size(result), MAX_RESULT_BYTES)
        self.assertLess(len(result["detail"]["bones"]), 512)
        self.assertEqual(
            result["detail"]["bonesOmitted"],
            512 - len(result["detail"]["bones"]),
        )

    def test_non_ascii_names_are_counted_as_utf8_bytes(self):
        # Korean bone names cost three bytes each, so a character-based ceiling
        # would let this through at roughly a third of its real size.
        bones = [
            {"name": "\uc65c\ubc1c\ubaa9" * 20, "parent": None,
             "head": [0.0, 0.0, 0.0], "tail": [0.0, 0.0, 1.0],
             "length": 1.0, "useConnect": False}
            for _ in range(512)
        ]
        result = fit_result_to_budget(self._envelope({"name": "Rig", "bones": bones}))
        self.assertLessEqual(self._size(result), MAX_RESULT_BYTES)

    def test_animation_rows_are_trimmed_last_and_counted(self):
        curves = [
            _curve("data", f'pose.bones["b{i:04d}"].location' + "x" * 200, 0, [_kp(1)])
            for i in range(200)
        ]
        summarized = summarize_animation_curves(curves)
        detail = {
            "name": "Rig",
            "bones": [],
            "animations": summarized["animations"],
            "animationSummary": summarized["summary"],
        }
        before = len(detail["animations"])
        # Just under the payload's own size, so trimming is forced without
        # driving the budget below the fixed summary metadata.
        budget = self._size(self._envelope(detail)) - 2000
        result = fit_result_to_budget(self._envelope(detail), budget=budget)
        after = len(result["detail"]["animations"])
        self.assertLessEqual(self._size(result), budget)
        self.assertLess(after, before)
        truncated = result["detail"]["animationSummary"]["truncated"]
        self.assertIn("byte budget exceeded", truncated["reason"])
        self.assertEqual(
            truncated["curvesOmitted"],
            result["detail"]["animationSummary"]["curveCount"] - after,
        )

    def test_null_truncated_is_created_when_rows_are_dropped_for_bytes(self):
        curves = [_curve("data", f"location{i}" + "y" * 300, 0, [_kp(1)]) for i in range(20)]
        summarized = summarize_animation_curves(curves)
        self.assertIsNone(summarized["summary"]["truncated"])
        detail = {
            "name": "Object",
            "animations": summarized["animations"],
            "animationSummary": summarized["summary"],
        }
        budget = self._size(self._envelope(detail)) - 1500
        result = fit_result_to_budget(self._envelope(detail), budget=budget)
        truncated = result["detail"]["animationSummary"]["truncated"]
        self.assertIsNotNone(truncated)
        self.assertGreater(truncated["curvesOmitted"], 0)
        self.assertGreater(truncated["keyframesOmitted"], 0)

    def test_a_payload_without_detail_is_returned_unchanged(self):
        envelope = {"revision": REVISION, "entity_id": ENTITY_ID, "scope": "all"}
        self.assertIs(fit_result_to_budget(envelope), envelope)

    def test_irreducible_envelope_raises_rather_than_returning_oversized(self):
        detail = {"name": "x" * 100000}
        with self.assertRaises(AnimationBudgetError):
            fit_result_to_budget(self._envelope(detail))


if __name__ == "__main__":
    unittest.main()
