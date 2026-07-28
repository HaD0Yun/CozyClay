"""Pure deterministic tests for the generated hand-shape library (no bpy/numpy)."""

import json
import math
import pathlib
import subprocess
import sys
import tempfile
import unittest

ADDON_ROOT = pathlib.Path(__file__).parents[1]
REPOSITORY_ROOT = ADDON_ROOT.parent
sys.path.insert(0, str(ADDON_ROOT))

from cclay.hand_shapes import (
    CANONICAL_ROLES,
    LIBRARY_VERSION,
    MAX_HAND_TRACK_KEYS,
    PRESET_LIBRARY,
    PRESET_NAMES,
    HandShapeError,
    compose_quaternions,
    normalize_quaternion,
    preset_deltas,
    resolve_hand_shapes,
    resolve_hand_track,
    schedule_endpoint_frames,
    schedule_role_endpoints,
    track_role_keys,
    validate_rig_bones,
)

CALIBRATION = ADDON_ROOT / "calibration" / "hand-shapes-v1.json"
GENERATOR = REPOSITORY_ROOT / "scripts" / "generate_hand_shape_library.py"
GENERATED = ADDON_ROOT / "cclay" / "hand_shapes.py"


def _mixamo_bones(prefix="mixamorig:"):
    return [f"{prefix}{side}Hand{role}" for side in ("Left", "Right") for role in CANONICAL_ROLES]


def _norm(values):
    return math.sqrt(sum(value * value for value in values))


class LibraryTests(unittest.TestCase):
    def test_frozen_public_inventory_is_complete_and_distinct(self):
        expected_names = (
            "relaxed",
            "open",
            "fist",
            "soft_fist",
            "point",
            "two_finger",
            "cup",
            "grasp",
            "thumb_extended",
            "three_finger",
            "hook",
        )
        self.assertEqual(PRESET_NAMES, expected_names)
        self.assertEqual(tuple(PRESET_LIBRARY), expected_names)
        signatures = {
            tuple(value for side in ("left", "right") for finger in preset[side].values() for value in finger)
            for preset in PRESET_LIBRARY.values()
        }
        self.assertEqual(len(signatures), len(expected_names))

    def test_calibration_schema_and_role_adapters_are_complete(self):
        source = json.loads(CALIBRATION.read_text(encoding="utf-8"))
        self.assertEqual(source["schema_version"], 1)
        self.assertEqual(source["library_version"], "1.1.0")
        self.assertEqual(source["library_version"], LIBRARY_VERSION)
        self.assertEqual(tuple(source["canonical_roles"]), CANONICAL_ROLES)
        self.assertEqual(tuple(source["presets"]), PRESET_NAMES)
        self.assertEqual(
            source["rotation_model"],
            {
                "channel": "local_flexion_degrees",
                "adapter": "per-character/side/role unit axis",
                "quaternion_order": "wxyz",
                "composition": "authored_base @ delta",
            },
        )
        self.assertEqual(set(source["characters"]), {"Y_BOT", "X_BOT"})
        reference_adapters = source["characters"]["Y_BOT"]["role_adapters"]
        for character in ("Y_BOT", "X_BOT"):
            character_data = source["characters"][character]
            self.assertEqual(character_data["bone_prefix"], "mixamorig:")
            self.assertEqual(character_data["role_adapters"], reference_adapters)
            for side, expected_finger_axis in (("left", [1, 0, 0]), ("right", [-1, 0, 0])):
                adapters = character_data["role_adapters"][side]
                self.assertEqual(tuple(adapters), CANONICAL_ROLES)
                for role, axis in adapters.items():
                    self.assertEqual(len(axis), 3)
                    self.assertTrue(all(math.isfinite(component) for component in axis))
                    self.assertTrue(all(component in (-1, 0, 1) for component in axis))
                    self.assertEqual(sum(abs(component) for component in axis), 1)
                    if not role.startswith("Thumb"):
                        self.assertEqual(axis, expected_finger_axis)
                for role in ("Thumb1", "Thumb2", "Thumb3", "Thumb4"):
                    self.assertIn(role, adapters)
        for preset in source["presets"].values():
            self.assertEqual(set(preset), {"left", "right"})
            for side in ("left", "right"):
                self.assertEqual(set(preset[side]), {"Thumb", "Index", "Middle", "Ring", "Pinky"})
                self.assertTrue(all(len(values) == 4 for values in preset[side].values()))

    def test_open_is_identity_and_relaxed_uses_mirrored_local_x_flexion(self):
        expected = ((4, 10, 16, 17), (3, 18, 15, 22), (2, 18, 26, 16), (4, 20, 8, 19))
        open_deltas = preset_deltas("open", "open")
        deltas = preset_deltas("relaxed", "relaxed")
        for side, sign in (("left", 1), ("right", -1)):
            self.assertTrue(all(delta == (1.0, 0.0, 0.0, 0.0) for delta in open_deltas[side].values()))
            observed = tuple(PRESET_LIBRARY["relaxed"][side][finger] for finger in ("Index", "Middle", "Ring", "Pinky"))
            self.assertEqual(observed, expected)
            self.assertEqual(PRESET_LIBRARY["relaxed"][side]["Thumb"][3], 0)
            for finger, values in zip(("Index", "Middle", "Ring", "Pinky"), expected):
                for segment, degrees in enumerate(values, start=1):
                    half_angle = math.radians(degrees) / 2.0
                    expected_delta = (math.cos(half_angle), sign * math.sin(half_angle), 0.0, 0.0)
                    for observed_component, expected_component in zip(
                        deltas[side][f"{finger}{segment}"], expected_delta
                    ):
                        self.assertAlmostEqual(observed_component, expected_component)

    def test_flexion_matches_calibrated_adapters_and_presets_deform_distinctly(self):
        source = json.loads(CALIBRATION.read_text(encoding="utf-8"))
        adapters = source["characters"]["Y_BOT"]["role_adapters"]
        signatures = set()
        for name in PRESET_NAMES:
            deltas = preset_deltas(name, name)
            signatures.add(tuple(component for side in ("left", "right") for delta in deltas[side].values() for component in delta))
            for side in ("left", "right"):
                for role, delta in deltas[side].items():
                    finger = role[:-1]
                    segment = int(role[-1]) - 1
                    degrees = source["presets"][name][side][finger][segment]
                    half_angle = math.radians(degrees) / 2.0
                    axis = adapters[side][role]
                    expected = (
                        math.cos(half_angle),
                        math.sin(half_angle) * axis[0],
                        math.sin(half_angle) * axis[1],
                        math.sin(half_angle) * axis[2],
                    )
                    for observed_component, expected_component in zip(delta, expected):
                        self.assertAlmostEqual(observed_component, expected_component)
                for role in CANONICAL_ROLES:
                    if role.startswith("Thumb"):
                        continue
                    self.assertEqual(deltas[side][role][2:], (0.0, 0.0))
            for role in CANONICAL_ROLES:
                if role.startswith("Thumb"):
                    continue
                self.assertAlmostEqual(deltas["left"][role][0], deltas["right"][role][0])
                self.assertAlmostEqual(deltas["left"][role][1], -deltas["right"][role][1])
        self.assertEqual(len(signatures), len(PRESET_NAMES))
        open_deltas = preset_deltas("open", "open")
        fist_deltas = preset_deltas("fist", "fist")
        point_deltas = preset_deltas("point", "point")
        for side in ("left", "right"):
            self.assertNotEqual(fist_deltas[side]["Index1"], open_deltas[side]["Index1"])
            self.assertNotEqual(point_deltas[side]["Middle1"], open_deltas[side]["Middle1"])

    def test_all_deltas_are_complete_finite_normalized_and_canonical(self):
        for name in PRESET_NAMES:
            bilateral = preset_deltas(name, name)
            self.assertEqual(set(bilateral), {"left", "right"})
            for side in bilateral.values():
                self.assertEqual(tuple(side), CANONICAL_ROLES)
                for quaternion in side.values():
                    self.assertTrue(all(math.isfinite(value) for value in quaternion))
                    self.assertAlmostEqual(_norm(quaternion), 1.0)
                    self.assertGreaterEqual(quaternion[0], 0.0)


class ResolutionAndRigTests(unittest.TestCase):
    def test_independent_defaults_and_asymmetric_resolution(self):
        self.assertEqual(resolve_hand_shapes(), {"left": "relaxed", "right": "relaxed"})
        self.assertEqual(resolve_hand_shapes("point", None), {"left": "point", "right": "relaxed"})
        self.assertEqual(resolve_hand_shapes(None, "fist"), {"left": "relaxed", "right": "fist"})
        deltas = preset_deltas("open", "fist")
        self.assertEqual(deltas["left"]["Index1"], (1.0, 0.0, 0.0, 0.0))
        self.assertNotEqual(deltas["right"]["Index1"], (1.0, 0.0, 0.0, 0.0))

    def test_unknown_values_fail_closed_with_one_error_type(self):
        for call in (
            lambda: resolve_hand_shapes("missing", "open"),
            lambda: preset_deltas("open", 7),
            lambda: validate_rig_bones("OTHER", _mixamo_bones()),
            lambda: validate_rig_bones("Y_BOT", _mixamo_bones()[:-1]),
        ):
            with self.subTest(call=call), self.assertRaises(HandShapeError):
                call()

    def test_rig_validation_returns_complete_exact_bilateral_mapping(self):
        for character in ("Y_BOT", "X_BOT"):
            for prefix in ("mixamorig:", ""):
                mapping = validate_rig_bones(character, _mixamo_bones(prefix))
                self.assertEqual(set(mapping), {"left", "right"})
                self.assertEqual(sum(len(side) for side in mapping.values()), 40)
                for side_name, side_title in (("left", "Left"), ("right", "Right")):
                    self.assertEqual(tuple(mapping[side_name]), CANONICAL_ROLES)
                    self.assertEqual(mapping[side_name]["Thumb1"], f"{prefix}{side_title}HandThumb1")


class QuaternionAndScheduleTests(unittest.TestCase):
    def test_normalization_and_hemisphere_are_deterministic(self):
        self.assertEqual(normalize_quaternion((-2, 0, 0, 0)), (1.0, -0.0, -0.0, -0.0))
        self.assertEqual(normalize_quaternion((0, -2, 0, 0)), (-0.0, 1.0, -0.0, -0.0))
        with self.assertRaises(HandShapeError):
            normalize_quaternion((0, 0, 0, 0))
        with self.assertRaises(HandShapeError):
            normalize_quaternion((math.nan, 0, 0, 1))

    def test_composition_is_authored_base_at_delta_and_noncommuting(self):
        root = math.sqrt(0.5)
        qx = (root, root, 0.0, 0.0)
        qy = (root, 0.0, root, 0.0)
        xy = compose_quaternions(qx, qy)
        yx = compose_quaternions(qy, qx)
        self.assertNotEqual(xy, yx)
        self.assertAlmostEqual(xy[3], 0.5)
        self.assertAlmostEqual(yx[3], -0.5)
        self.assertAlmostEqual(_norm(xy), 1.0)
        self.assertEqual(compose_quaternions((-root, -root, 0, 0), qy), xy)

    def test_schedule_respects_endpoint_budget_and_skips_identity(self):
        identity = (1, 0, 0, 0)
        target = preset_deltas("fist", "open")["left"]["Index1"]
        self.assertEqual(schedule_role_endpoints(10, 20, identity, 1), ())
        self.assertEqual(schedule_endpoint_frames(10, 20, 2), (10, 20))
        scheduled = schedule_role_endpoints(10, 20, target, 2)
        self.assertEqual(tuple(frame for frame, _ in scheduled), (10, 20))
        self.assertEqual(scheduled[0][1], (1.0, 0.0, 0.0, 0.0))
        self.assertEqual(scheduled[1][1], target)
        self.assertEqual(schedule_role_endpoints(12, 12, target, 1), ((12, target),))
        with self.assertRaises(HandShapeError):
            schedule_role_endpoints(10, 20, target, 1)
        with self.assertRaises(HandShapeError):
            schedule_endpoint_frames(20, 10, 2)


class GeneratorTests(unittest.TestCase):
    def test_checked_in_module_matches_calibration(self):
        result = subprocess.run(
            [sys.executable, str(GENERATOR), "--check"],
            cwd=REPOSITORY_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_check_detects_numeric_and_adapter_drift(self):
        replacements = (
            ('"relaxed": {"left": ((8, 12, 8, 0)', '"relaxed": {"left": ((9, 12, 8, 0)'),
            ('"left": {"Thumb1": (1, 0, 0)', '"left": {"Thumb1": (-1, 0, 0)'),
        )
        for old, new in replacements:
            with self.subTest(old=old), tempfile.TemporaryDirectory() as temporary:
                output = pathlib.Path(temporary) / "hand_shapes.py"
                text = GENERATED.read_text(encoding="utf-8")
                self.assertIn(old, text)
                output.write_text(text.replace(old, new, 1), encoding="utf-8")
                result = subprocess.run(
                    [sys.executable, str(GENERATOR), "--source", str(CALIBRATION), "--output", str(output), "--check"],
                    cwd=REPOSITORY_ROOT,
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 1)
                self.assertIn("stale", result.stderr)


class HandTrackTests(unittest.TestCase):
    """A hand track is a sparse per-side preset keyframe list in CLIP frames."""

    def test_resolves_a_single_side_and_leaves_the_other_empty(self):
        resolved = resolve_hand_track(
            right=[{"frame": 0, "preset": "open"}, {"frame": 38, "preset": "grasp"}],
            frame_count=120,
        )
        self.assertEqual(resolved["left"], ())
        self.assertEqual(resolved["right"], ((0, "open"), (38, "grasp")))

    def test_rejects_a_frame_at_or_past_the_clip_length(self):
        for frame in (120, 500):
            with self.subTest(frame=frame), self.assertRaises(HandShapeError) as caught:
                resolve_hand_track(
                    left=[{"frame": frame, "preset": "fist"}], frame_count=120
                )
            self.assertIn("outside the clip", str(caught.exception))

    def test_rejects_non_increasing_frames(self):
        for frames in ((10, 10), (10, 4)):
            with self.subTest(frames=frames), self.assertRaises(HandShapeError) as caught:
                resolve_hand_track(
                    left=[{"frame": frames[0], "preset": "open"}, {"frame": frames[1], "preset": "fist"}],
                    frame_count=60,
                )
            self.assertIn("strictly increase", str(caught.exception))

    def test_rejects_unknown_preset_extra_keys_and_bool_frames(self):
        cases = (
            [{"frame": 0, "preset": "crush"}],
            [{"frame": 0, "preset": "open", "ease": 3}],
            [{"frame": 0}],
            [{"frame": True, "preset": "open"}],
        )
        for keys in cases:
            with self.subTest(keys=keys), self.assertRaises(HandShapeError):
                resolve_hand_track(left=keys, frame_count=60)

    def test_rejects_an_empty_side_and_a_wholly_empty_track(self):
        with self.assertRaises(HandShapeError) as caught:
            resolve_hand_track(left=[], frame_count=60)
        self.assertIn("must not be empty", str(caught.exception))
        with self.assertRaises(HandShapeError) as caught:
            resolve_hand_track(frame_count=60)
        self.assertIn("at least one side", str(caught.exception))

    def test_rejects_more_keys_than_the_declared_cap(self):
        keys = [
            {"frame": frame, "preset": "open"}
            for frame in range(MAX_HAND_TRACK_KEYS + 1)
        ]
        with self.assertRaises(HandShapeError) as caught:
            resolve_hand_track(left=keys, frame_count=200)
        self.assertIn("at most", str(caught.exception))

    def test_rejects_a_non_positive_frame_count(self):
        for frame_count in (0, -1, None, True, 1.5):
            with self.subTest(frame_count=frame_count), self.assertRaises(HandShapeError):
                resolve_hand_track(
                    left=[{"frame": 0, "preset": "open"}], frame_count=frame_count
                )

    def test_role_keys_drop_roles_that_never_leave_identity(self):
        # open is all-zero flexion, so a role whose grasp angle is also zero has
        # nothing to animate and must not get a curve.
        keys = track_role_keys(((0, "open"), (40, "grasp")), "right")
        grasp = preset_deltas(right="grasp")["right"]
        identity_roles = {
            role
            for role, delta in grasp.items()
            if all(abs(v - e) <= 1e-12 for v, e in zip(delta, (1.0, 0.0, 0.0, 0.0)))
        }
        self.assertTrue(identity_roles, "expected some zero-angle roles in grasp")
        self.assertEqual(set(keys) & identity_roles, set())
        self.assertEqual(set(keys), set(grasp) - identity_roles)

    def test_role_keys_keep_identity_keys_when_the_role_moves_later(self):
        # Dropping the frame-0 identity key would make Blender hold the grasp
        # value across the whole clip and silently defeat the track.
        keys = track_role_keys(((0, "open"), (40, "grasp")), "right")
        moving = keys["Index2"]
        self.assertEqual([frame for frame, _ in moving], [0, 40])
        self.assertEqual(moving[0][1], (1.0, 0.0, 0.0, 0.0))
        self.assertNotEqual(moving[1][1], (1.0, 0.0, 0.0, 0.0))

    def test_presets_share_one_flexion_axis_so_interpolation_is_unambiguous(self):
        # The whole design rests on this: two presets differ only in angle about
        # the same axis, so Blender interpolating between keys is exact rather
        # than an approximation. If a preset ever gains an off-axis component,
        # sparse keying stops being safe and this must fail.
        for side in ("left", "right"):
            for preset in PRESET_NAMES:
                for role, (w, x, y, z) in preset_deltas(**{side: preset})[side].items():
                    with self.subTest(side=side, preset=preset, role=role):
                        self.assertAlmostEqual(y, 0.0, places=12)
                        self.assertAlmostEqual(z, 0.0, places=12)
                        self.assertGreaterEqual(w, 0.0)


if __name__ == "__main__":
    unittest.main()
