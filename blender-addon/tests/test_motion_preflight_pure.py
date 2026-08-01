"""Pure-python tests for the preflight_motion analysis math (no bpy required)."""

import json
import math
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))

from cclay import motion_preflight, motion_retarget, scene_relations
from cclay.character_rig import CharacterRigAdapter
from cclay.motion_preflight import (
    FOOT_CONTACT_CHANNELS,
    FOOT_CONTACT_JOINT_INDICES,
    MAX_CONTACT_WINDOWS,
    MAX_LOWEST_TRACK_SAMPLES,
    PreflightMotionError,
    _contact_windows,
    _derive_entity_scale,
    _end_pose,
    _foot_contact_windows,
    _lowest_track,
    _round3,
    _round6,
    _validate_motion_payload,
    _validated_params,
    analyze_motion,
    collect_preflight,
)

try:
    import numpy
except ImportError:  # pragma: no cover - numpy is optional host-side
    numpy = None

FIXTURE_PATH = pathlib.Path(__file__).parent / "fixtures" / "motion_preflight_golden.json"
JOINTS = 27
EXTREMITY_JOINT = 26  # any non-root joint; the track is a min over ALL joints
VALID_UUID = "00000000-0000-4000-8000-000000000001"

TOP_LEVEL_KEYS = {
    "revision", "schema_version", "motion_id", "frames", "fps",
    "duration_seconds", "scale", "units", "travel", "lowest_track",
    "contact_windows", "foot_contacts", "end_pose",
}
TRAVEL_KEYS = {
    "vector_horizontal", "distance_horizontal", "height_start", "height_end",
    "height_min", "height_max", "height_change",
}
LOWEST_TRACK_KEYS = {"min", "max", "sample_stride", "samples"}
CONTACT_WINDOW_KEYS = {"start_frame", "end_frame", "height"}
FOOT_CONTACT_WINDOW_KEYS = {
    "channel", "start_frame", "end_frame", "height", "height_max",
}
END_POSE_KEYS = {"root_height", "lowest_gap", "speed", "resting"}


def _frame(root, lowest):
    """One posed_joints frame: every joint at the root, one extremity lower."""
    joints = [[root[0], root[1], root[2]] for _ in range(JOINTS)]
    joints[EXTREMITY_JOINT] = [root[0], lowest, root[2]]
    return joints


def _flat_walk():
    """Horizontal walk at constant root height with 3 stepping plateaus."""
    frames = []
    for f in range(60):
        x = 0.02 * min(f, 40)
        if f < 10:
            lowest = 0.0
        elif f < 15:
            lowest = [0.05, 0.10, 0.15, 0.10, 0.05][f - 10]
        elif f < 25:
            lowest = 0.0
        elif f < 30:
            lowest = [0.05, 0.10, 0.15, 0.10, 0.05][f - 25]
        else:
            lowest = 0.0
        frames.append(_frame([x, 0.9, 0.0], lowest))
    return frames


def _rising_path():
    """Root rises by exactly 0.4 with 3 distinct plateaus at rising heights."""
    frames = []
    for f in range(30):
        height = 0.9 + 0.4 * f / 29
        if f < 8:
            lowest = 0.0
        elif f < 11:
            lowest = [0.05, 0.10, 0.15][f - 8]
        elif f < 19:
            lowest = 0.2
        elif f < 22:
            lowest = [0.25, 0.30, 0.35][f - 19]
        else:
            lowest = 0.4
        frames.append(_frame([0.01 * f, height, 0.0], lowest))
    return frames


def _ending_prone(moving_tail=False):
    """Root descends to just above the lowest track; tail static or moving."""
    frames = []
    for f in range(40):
        height = 0.9 - 0.85 * min(f, 34) / 34
        x = 0.05 * (f - 34) if (moving_tail and f >= 35) else 0.0
        frames.append(_frame([x, height, 0.0], 0.0))
    return frames


def build_golden_motion():
    """Deterministic generator for the committed TS drift-net fixture."""
    fps = 20
    frames = []
    for f in range(48):
        x = 0.03 * min(f, 40)
        z = -0.005 * min(f, 40)
        height = 0.92 + 0.002 * (f % 5)
        phase = f % 12
        if phase < 8 or f >= 44:
            lowest = 0.0
        else:
            lowest = [0.06, 0.12, 0.12, 0.06][phase - 8]
        frames.append(_frame([x, height, z], lowest))
    return frames, fps


def build_golden_payload():
    posed_joints, fps = build_golden_motion()
    analysis = analyze_motion(posed_joints, fps)
    return {
        "revision": "0" * 64,
        "schema_version": analysis["schema_version"],
        "motion_id": "golden-motion",
        **{key: value for key, value in analysis.items() if key != "schema_version"},
    }


class RoundingTests(unittest.TestCase):
    def test_round3_normalizes_negative_zero(self):
        for value in (-0.0, -0.0001, 0.0004):
            self.assertEqual(_round3(value), 0.0)
            self.assertEqual(math.copysign(1.0, _round3(value)), 1.0)
        self.assertEqual(_round3(1.23456), 1.235)
        self.assertEqual(_round3(-2.0004), -2.0)

    def test_round6_reports_scale_precision(self):
        for value in (-0.0, -0.0000001, 0.0000004):
            self.assertEqual(_round6(value), 0.0)
            self.assertEqual(math.copysign(1.0, _round6(value)), 1.0)
        self.assertEqual(_round6(0.0123456789), 0.012346)
        self.assertEqual(_round6(-2.0000004), -2.0)

    def test_negative_zero_height_change_is_normalized_in_payload(self):
        frames = [_frame([0.0, 1.0, 0.0], 0.0), _frame([0.0, 0.99999, 0.0], 0.0)]
        result = analyze_motion(frames, 20)
        self.assertEqual(result["travel"]["height_change"], 0.0)
        self.assertEqual(
            math.copysign(1.0, result["travel"]["height_change"]), 1.0
        )


class SingleFrameTests(unittest.TestCase):
    def test_single_frame_motion_is_a_static_resting_pose(self):
        result = analyze_motion([_frame([0.0, 0.9, 0.0], 0.0)], 20)
        self.assertEqual(result["frames"], 1)
        self.assertEqual(result["duration_seconds"], 0.05)
        self.assertEqual(result["travel"]["vector_horizontal"], [0.0, 0.0])
        self.assertEqual(result["travel"]["distance_horizontal"], 0.0)
        self.assertEqual(result["travel"]["height_change"], 0.0)
        self.assertEqual(result["lowest_track"]["sample_stride"], 1)
        self.assertEqual(result["lowest_track"]["samples"], [0.0])
        self.assertEqual(result["contact_windows"], [])
        self.assertEqual(result["end_pose"]["speed"], 0.0)
        self.assertTrue(result["end_pose"]["resting"])



class FlatWalkTests(unittest.TestCase):
    def test_travel_contacts_and_resting_end(self):
        result = analyze_motion(_flat_walk(), 20)
        self.assertEqual(result["frames"], 60)
        self.assertEqual(result["fps"], 20)
        self.assertEqual(result["duration_seconds"], 3.0)
        self.assertIsNone(result["scale"])
        self.assertEqual(result["units"], "npz")
        self.assertEqual(result["travel"]["vector_horizontal"], [0.8, 0.0])
        self.assertGreater(result["travel"]["distance_horizontal"], 0.0)
        self.assertEqual(result["travel"]["distance_horizontal"], 0.8)
        self.assertEqual(result["travel"]["height_change"], 0.0)
        self.assertEqual(result["travel"]["height_start"], 0.9)
        self.assertEqual(result["travel"]["height_end"], 0.9)
        windows = result["contact_windows"]
        self.assertGreaterEqual(len(windows), 2)
        self.assertEqual(
            [(w["start_frame"], w["end_frame"]) for w in windows],
            [(0, 9), (15, 24), (30, 59)],
        )
        self.assertTrue(all(w["height"] == 0.0 for w in windows))
        self.assertTrue(result["end_pose"]["resting"])
        self.assertEqual(result["end_pose"]["speed"], 0.0)

    @unittest.skipUnless(numpy is not None, "numpy unavailable host-side")
    def test_numpy_arrays_match_nested_lists(self):
        frames = _flat_walk()
        self.assertEqual(
            analyze_motion(numpy.asarray(frames, dtype=numpy.float64), 20),
            analyze_motion(frames, 20),
        )


class RisingPathTests(unittest.TestCase):
    def test_known_rise_and_strictly_increasing_plateaus(self):
        result = analyze_motion(_rising_path(), 20)
        self.assertLessEqual(abs(result["travel"]["height_change"] - 0.4), 0.001)
        windows = result["contact_windows"]
        self.assertEqual(len(windows), 3)
        heights = [w["height"] for w in windows]
        self.assertEqual(heights, sorted(heights))
        self.assertEqual(len(set(heights)), 3)
        self.assertEqual(heights, [0.0, 0.2, 0.4])


class EndPoseTests(unittest.TestCase):
    def test_prone_end_rests_near_track_minimum(self):
        result = analyze_motion(_ending_prone(), 20)
        end_pose = result["end_pose"]
        self.assertEqual(end_pose["root_height"], 0.05)
        self.assertLessEqual(
            end_pose["root_height"] - result["lowest_track"]["min"], 0.05
        )
        self.assertEqual(end_pose["lowest_gap"], 0.0)
        self.assertTrue(end_pose["resting"])

    def test_moving_tail_is_not_resting(self):
        result = analyze_motion(_ending_prone(moving_tail=True), 20)
        self.assertFalse(result["end_pose"]["resting"])
        self.assertGreater(result["end_pose"]["speed"], 0.1)

    def test_end_pose_helper_speed_is_mean_per_second_displacement(self):
        root_track = [[0.0, 1.0, 0.0]] * 15 + [
            [0.02 * i, 1.0, 0.0] for i in range(1, 6)
        ]
        end_pose = _end_pose(root_track, [0.0] * 20, 20)
        # Final 5 frames: 4 steps of 0.02 -> mean 0.02/frame * 20 fps = 0.4/s.
        self.assertEqual(end_pose["speed"], 0.4)
        self.assertFalse(end_pose["resting"])


class LowestTrackTests(unittest.TestCase):
    def test_track_is_min_over_all_joints(self):
        frames = _flat_walk()
        track = _lowest_track(frames, 1.0)
        self.assertEqual(track[0], 0.0)
        self.assertEqual(track[12], 0.15)
        self.assertEqual(len(track), 60)

    def test_downsampling_keeps_full_resolution_extremes(self):
        frames = []
        for f in range(500):
            if f == 11:
                frames.append(_frame([0.0, 3.0, 0.0], 3.0))
            else:
                frames.append(_frame([0.0, 1.0, 0.0], -0.5 if f == 7 else 0.1))
        result = analyze_motion(frames, 20)
        lowest = result["lowest_track"]
        self.assertGreater(lowest["sample_stride"], 1)
        self.assertEqual(lowest["sample_stride"], 3)
        self.assertLessEqual(len(lowest["samples"]), MAX_LOWEST_TRACK_SAMPLES)
        self.assertEqual(len(lowest["samples"]), 167)
        # Frames 7 and 11 fall off the stride grid but still set min/max.
        self.assertEqual(lowest["min"], -0.5)
        self.assertEqual(lowest["max"], 3.0)
        self.assertNotIn(-0.5, lowest["samples"])
        self.assertNotIn(3.0, lowest["samples"])


class ContactWindowTests(unittest.TestCase):
    def test_minimum_length_scales_with_fps(self):
        track = [0.0, 0.0, 0.0, 1.0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]
        # fps 20 -> min length 2: both plateaus qualify.
        self.assertEqual(len(_contact_windows(track, 20)), 2)
        # fps 60 -> min length 6: only the 7-frame plateau qualifies.
        windows = _contact_windows(track, 60)
        self.assertEqual(len(windows), 1)
        self.assertEqual((windows[0]["start_frame"], windows[0]["end_frame"]), (4, 10))
        self.assertEqual(windows[0]["height"], 0.5)

    def test_output_is_capped_at_64_earliest_windows(self):
        track = []
        for f in range(500):
            phase = f % 4
            track.append(0.0 if phase < 2 else (0.5 if phase == 2 else 1.0))
        windows = _contact_windows(track, 20)
        self.assertEqual(len(windows), MAX_CONTACT_WINDOWS)
        self.assertEqual(windows[0]["start_frame"], 0)
        self.assertEqual(windows[-1]["start_frame"], 63 * 4)


class ScaleApplicationTests(unittest.TestCase):
    def _npz_scaled_motion(self):
        frames = []
        for f in range(30):
            x = 10.0 * f
            if f < 10:
                lowest = 100.0 if f % 2 == 0 else 100.5
            elif f < 20:
                lowest = 106.0 + 5.0 * (f - 10)
            else:
                lowest = 150.0 if f % 2 == 0 else 150.5
            frames.append(_frame([x, 200.0, 0.0], lowest))
        return frames

    def test_tolerances_apply_after_scaling(self):
        frames = self._npz_scaled_motion()
        unscaled = analyze_motion(frames, 20)
        scaled = analyze_motion(frames, 20, scale=0.01)
        # The 0.5-npz-unit wobble breaks the raw tolerances but is a genuine
        # 0.005 m plateau once metric scale is applied.
        self.assertEqual(unscaled["contact_windows"], [])
        self.assertEqual(len(scaled["contact_windows"]), 2)
        self.assertEqual(
            [w["height"] for w in scaled["contact_windows"]], [1.002, 1.502]
        )
        self.assertEqual(unscaled["units"], "npz")
        self.assertIsNone(unscaled["scale"])
        self.assertEqual(scaled["units"], "meters")
        self.assertEqual(scaled["scale"], 0.01)
        self.assertEqual(unscaled["travel"]["distance_horizontal"], 290.0)
        self.assertEqual(scaled["travel"]["distance_horizontal"], 2.9)
        self.assertEqual(scaled["travel"]["height_start"], 2.0)
        self.assertEqual(scaled["lowest_track"]["min"], 1.0)

    def test_scale_is_reported_at_six_decimals(self):
        frames = self._npz_scaled_motion()
        scaled = analyze_motion(frames, 20, scale=0.0123456789)
        self.assertEqual(scaled["scale"], 0.012346)
        negative_zero = analyze_motion(frames, 20, scale=-1e-9)
        self.assertEqual(negative_zero["scale"], 0.0)
        self.assertEqual(math.copysign(1.0, negative_zero["scale"]), 1.0)


class ParamValidationTests(unittest.TestCase):
    def assert_invalid(self, params):
        with self.assertRaises(PreflightMotionError) as caught:
            _validated_params(params)
        self.assertEqual(caught.exception.code, "INVALID_PREFLIGHT_MOTION_PARAMS")
        self.assertTrue(
            str(caught.exception).startswith("INVALID_PREFLIGHT_MOTION_PARAMS: ")
        )

    def test_valid_params(self):
        self.assertEqual(_validated_params({"motion_id": "walk-01"}), ("walk-01", None))
        self.assertEqual(
            _validated_params({"motion_id": "a", "entity_id": VALID_UUID}),
            ("a", VALID_UUID),
        )

    def test_rejection_matrix(self):
        invalid = [
            None,
            [],
            {},
            {"motion_id": None},                                # explicit null
            {"motion_id": "walk", "entity_id": None},           # explicit null
            {"motion_id": "Walk"},                              # uppercase
            {"motion_id": "-walk"},                             # bad leading char
            {"motion_id": "a" * 65},                            # too long
            {"motion_id": ""},
            {"motion_id": 7},
            {"motion_id": "walk", "extra": 1},                  # unknown key
            {"motion_id": "walk", "entity_id": "AAAAAAAA-BBBB-4CCC-9DDD-EEEEFFFF0000"},
            {"motion_id": "walk", "entity_id": "not-a-uuid"},
            {"motion_id": "walk", "entity_id": 7},
        ]
        for params in invalid:
            with self.subTest(params=params):
                self.assert_invalid(params)


class _FakeVector:
    def __init__(self, x, y, z):
        self.components = (x, y, z)

    def __sub__(self, other):
        return _FakeVector(*[
            a - b for a, b in zip(self.components, other.components)
        ])

    @property
    def length(self):
        return math.sqrt(sum(value * value for value in self.components))


class _FakeBone:
    def __init__(self, name, head):
        self.name = name
        self.head_local = _FakeVector(*head)


class _FakeBones:
    def __init__(self, bones):
        self._bones = {bone.name: bone for bone in bones}

    def __iter__(self):
        return iter(self._bones.values())

    def get(self, name):
        return self._bones.get(name)


class _FakeObject:
    def __init__(self, entity_id, type_, bones=(), scale=(1.0, 1.0, 1.0)):
        self._entity_id = entity_id
        self.type = type_
        self.data = mock.Mock()
        self.data.bones = _FakeBones(bones)
        self.scale = scale

    def get(self, key):
        return self._entity_id if key == "cclay.entity_id" else None


def _scene_with(objects):
    fake_bpy = mock.Mock()
    fake_bpy.data.objects = list(objects)
    return mock.patch.object(scene_relations, "bpy", fake_bpy)


class CharacterRigAdapterTests(unittest.TestCase):
    def test_mixamo_prefix_and_thigh_measurement_match_preflight_scale_inputs(self):
        rig = CharacterRigAdapter(_FakeBones([
            _FakeBone("mixamorig:Hips", (0.0, 1.0, 0.0)),
            _FakeBone("mixamorig:RightUpLeg", (0.0, 1.0, 0.0)),
            _FakeBone("mixamorig:RightLeg", (0.0, 0.5, 0.0)),
        ]))
        self.assertEqual(rig.prefix, "mixamorig:")
        self.assertAlmostEqual(rig.rig_thigh, 0.5)

    def test_unprefixed_rig_and_missing_thigh_are_explicit(self):
        rig = CharacterRigAdapter(_FakeBones([
            _FakeBone("Hips", (0.0, 1.0, 0.0)),
            _FakeBone("RightUpLeg", (0.0, 1.0, 0.0)),
        ]))
        self.assertEqual(rig.prefix, "")
        self.assertIsNone(rig.rig_thigh)

class EntityScaleTests(unittest.TestCase):
    def _posed(self):
        frame = [[0.0, 100.0, 0.0] for _ in range(JOINTS)]
        frame[19] = [0.0, 100.0, 0.0]  # RightUpLeg
        frame[20] = [0.0, 50.0, 0.0]   # RightLeg -> npz thigh length 50
        return [frame]

    def test_entity_not_found_carries_contract_code(self):
        with _scene_with([]):
            with self.assertRaises(PreflightMotionError) as caught:
                _derive_entity_scale(VALID_UUID, self._posed())
        self.assertEqual(caught.exception.code, "ENTITY_NOT_FOUND")

    def test_non_armature_entity_is_invalid(self):
        with _scene_with([_FakeObject(VALID_UUID, "MESH")]):
            with self.assertRaises(PreflightMotionError) as caught:
                _derive_entity_scale(VALID_UUID, self._posed())
        self.assertEqual(caught.exception.code, "INVALID_PREFLIGHT_MOTION_PARAMS")

    def test_missing_thigh_bones_are_invalid(self):
        armature = _FakeObject(VALID_UUID, "ARMATURE", [_FakeBone("Hips", (0, 1, 0))])
        with _scene_with([armature]):
            with self.assertRaises(PreflightMotionError) as caught:
                _derive_entity_scale(VALID_UUID, self._posed())
        self.assertEqual(caught.exception.code, "INVALID_PREFLIGHT_MOTION_PARAMS")

    def test_scale_matches_apply_motion_thigh_measurement(self):
        bones = [
            _FakeBone("mixamorig:Hips", (0.0, 1.0, 0.0)),
            _FakeBone("mixamorig:RightUpLeg", (0.0, 1.0, 0.0)),
            _FakeBone("mixamorig:RightLeg", (0.0, 0.5, 0.0)),
        ]
        with _scene_with([_FakeObject(VALID_UUID, "ARMATURE", bones)]):
            scale = _derive_entity_scale(VALID_UUID, self._posed())
        self.assertAlmostEqual(scale, 0.01)  # 0.5 m rig thigh / 50 npz units

    def test_scale_incorporates_object_world_scale(self):
        """CozyClay issue #2: a YBot at object scale 0.01 must report a
        meter-correct preflight scale, not the ~98.5x-inflated raw-local-unit
        value the bug produced (rig bones are unscaled local edit-bone
        lengths; a 100-unit local thigh under a 0.01 object scale is a
        0.01 m). local -> 1.0 m world, over the same 50-unit npz thigh, must
        report 0.02 (100 * 0.01 / 50), not 2.0 (100 / 50)."""
        bones = [
            _FakeBone("mixamorig:Hips", (0.0, 100.0, 0.0)),
            _FakeBone("mixamorig:RightUpLeg", (0.0, 100.0, 0.0)),
            _FakeBone("mixamorig:RightLeg", (0.0, 0.0, 0.0)),
        ]
        armature = _FakeObject(
            VALID_UUID, "ARMATURE", bones, scale=(0.01, 0.01, 0.01)
        )
        with _scene_with([armature]):
            scale = _derive_entity_scale(VALID_UUID, self._posed())
        self.assertAlmostEqual(scale, 0.02)

    def test_non_uniform_object_scale_fails_closed(self):
        bones = [
            _FakeBone("mixamorig:Hips", (0.0, 1.0, 0.0)),
            _FakeBone("mixamorig:RightUpLeg", (0.0, 1.0, 0.0)),
            _FakeBone("mixamorig:RightLeg", (0.0, 0.5, 0.0)),
        ]
        armature = _FakeObject(
            VALID_UUID, "ARMATURE", bones, scale=(0.01, 0.01, 0.02)
        )
        with _scene_with([armature]):
            with self.assertRaises(PreflightMotionError) as caught:
                _derive_entity_scale(VALID_UUID, self._posed())
        self.assertEqual(caught.exception.code, "INVALID_PREFLIGHT_MOTION_PARAMS")

    def test_zero_object_scale_fails_closed(self):
        bones = [
            _FakeBone("mixamorig:Hips", (0.0, 1.0, 0.0)),
            _FakeBone("mixamorig:RightUpLeg", (0.0, 1.0, 0.0)),
            _FakeBone("mixamorig:RightLeg", (0.0, 0.5, 0.0)),
        ]
        armature = _FakeObject(
            VALID_UUID, "ARMATURE", bones, scale=(0.0, 0.0, 0.0)
        )
        with _scene_with([armature]):
            with self.assertRaises(PreflightMotionError) as caught:
                _derive_entity_scale(VALID_UUID, self._posed())
        self.assertEqual(caught.exception.code, "INVALID_PREFLIGHT_MOTION_PARAMS")

    def test_negative_object_scale_fails_closed(self):
        bones = [
            _FakeBone("mixamorig:Hips", (0.0, 1.0, 0.0)),
            _FakeBone("mixamorig:RightUpLeg", (0.0, 1.0, 0.0)),
            _FakeBone("mixamorig:RightLeg", (0.0, 0.5, 0.0)),
        ]
        armature = _FakeObject(
            VALID_UUID, "ARMATURE", bones, scale=(-0.01, -0.01, -0.01)
        )
        with _scene_with([armature]):
            with self.assertRaises(PreflightMotionError) as caught:
                _derive_entity_scale(VALID_UUID, self._posed())
        self.assertEqual(caught.exception.code, "INVALID_PREFLIGHT_MOTION_PARAMS")

    def test_uniform_scale_within_tolerance_is_accepted(self):
        """Floating-point round-trips (e.g. UI edits) must not spuriously trip
        the non-uniform-scale fail-closed check."""
        bones = [
            _FakeBone("mixamorig:Hips", (0.0, 1.0, 0.0)),
            _FakeBone("mixamorig:RightUpLeg", (0.0, 1.0, 0.0)),
            _FakeBone("mixamorig:RightLeg", (0.0, 0.5, 0.0)),
        ]
        armature = _FakeObject(
            VALID_UUID, "ARMATURE", bones,
            scale=(0.01, 0.01 + 1e-9, 0.01 - 1e-9),
        )
        with _scene_with([armature]):
            scale = _derive_entity_scale(VALID_UUID, self._posed())
        self.assertAlmostEqual(scale, 0.0001)


class LoaderPassThroughTests(unittest.TestCase):
    def test_missing_project_directory_maps_to_contract_code(self):
        with self.assertRaises(PreflightMotionError) as caught:
            collect_preflight("0" * 64, {"motion_id": "walk-01"}, None)
        self.assertEqual(caught.exception.code, "APPLY_MOTION_PROJECT_DIR_UNKNOWN")
        self.assertTrue(
            str(caught.exception).startswith("APPLY_MOTION_PROJECT_DIR_UNKNOWN: ")
        )

    def test_missing_motion_maps_to_contract_code(self):
        with tempfile.TemporaryDirectory() as project_directory:
            with self.assertRaises(PreflightMotionError) as caught:
                collect_preflight(
                    "0" * 64, {"motion_id": "missing-motion"}, project_directory
                )
        self.assertEqual(caught.exception.code, "APPLY_MOTION_NOT_FOUND")
        self.assertIn("APPLY_MOTION_NOT_FOUND", str(caught.exception))

    @unittest.skipUnless(numpy is not None, "numpy unavailable host-side")
    def test_collect_preflight_reads_a_real_npz_without_bpy(self):
        posed = numpy.asarray(_flat_walk(), dtype=numpy.float64)
        rotations = numpy.broadcast_to(
            numpy.eye(3), (len(posed), JOINTS, 3, 3)
        ).copy()
        with tempfile.TemporaryDirectory() as project_directory:
            motions = pathlib.Path(project_directory) / ".cclay" / "motions"
            motions.mkdir(parents=True)
            numpy.savez(
                motions / "walk-01.npz",
                local_rot_mats=rotations,
                posed_joints=posed,
                fps=numpy.int64(20),
            )
            result = collect_preflight(
                "a" * 64, {"motion_id": "walk-01"}, project_directory
            )
        self.assertEqual(result["revision"], "a" * 64)
        self.assertEqual(result["motion_id"], "walk-01")
        self.assertEqual(result["frames"], 60)
        self.assertEqual(result["fps"], 20)
        self.assertEqual(set(result), TOP_LEVEL_KEYS)


@unittest.skipUnless(numpy is not None, "numpy unavailable host-side")
class ValidationParityTests(unittest.TestCase):
    """The vectorized numpy path must reject exactly what the cursor rejects."""

    def _valid_payload(self, frames=4):
        rotations = numpy.broadcast_to(
            numpy.eye(3), (frames, JOINTS, 3, 3)
        ).copy()
        posed = numpy.zeros((frames, JOINTS, 3))
        posed[:, :, 1] = 1.0  # frame-0 hips +Y dominant (Y-up)
        return rotations, posed

    def assert_both_paths_reject(self, rotations, posed):
        for path, (rots, joints) in {
            "vectorized": (rotations, posed),
            "cursor": (rotations.tolist(), posed.tolist()),
        }.items():
            with self.subTest(path=path):
                with self.assertRaises(PreflightMotionError) as caught:
                    _validate_motion_payload(rots, joints, 20)
                self.assertEqual(caught.exception.code, "APPLY_MOTION_MALFORMED")

    def test_valid_payload_passes_both_paths(self):
        rotations, posed = self._valid_payload()
        # numpy arrays must take the vectorized path, never the frame loop.
        with mock.patch.object(
            motion_retarget.MotionValidationCursor,
            "step",
            side_effect=AssertionError("numpy inputs must not use the cursor loop"),
        ):
            _validate_motion_payload(rotations, posed, 20)
        _validate_motion_payload(rotations.tolist(), posed.tolist(), 20)

    def test_non_finite_joint_rejected_by_both_paths(self):
        rotations, posed = self._valid_payload()
        posed[2][5][1] = float("nan")
        self.assert_both_paths_reject(rotations, posed)

    def test_non_finite_rotation_rejected_by_both_paths(self):
        rotations, posed = self._valid_payload()
        rotations[1][3][0][0] = float("inf")
        self.assert_both_paths_reject(rotations, posed)

    def test_non_y_up_rejected_by_both_paths(self):
        rotations, posed = self._valid_payload()
        posed[0][0] = [1.0, 0.1, 0.0]  # frame-0 hips X dominant
        self.assert_both_paths_reject(rotations, posed)

    def test_reflection_matrix_rejected_by_both_paths(self):
        rotations, posed = self._valid_payload()
        rotations[1][3] = numpy.diag([1.0, 1.0, -1.0])  # orthonormal, det -1
        self.assert_both_paths_reject(rotations, posed)

    def test_column_gram_perturbation_rejected_by_both_paths(self):
        # QA finding G005/high: A = sqrt(I + E) @ eigenbasis(E) with
        # E = c * (ones - I), c = 0.99 * tol. Then A @ A.T == I + E, so the
        # row-gram max error is c (under tol), while A.T @ A == I + diag(w)
        # with eigenvalues {2c, -c, -c}, so the column-gram max error is 2c
        # (over tol; cursor rejects via column checks) and det ~ 1 - O(c^2).
        tol = motion_retarget.ROTATION_MATRIX_TOLERANCE
        c = 0.99 * tol
        perturbation = c * (numpy.ones((3, 3)) - numpy.eye(3))
        w, eigenbasis = numpy.linalg.eigh(perturbation)  # eigenvalues {2c, -c, -c}
        sqrtm = eigenbasis @ numpy.diag(numpy.sqrt(1.0 + w)) @ eigenbasis.T
        rotations, posed = self._valid_payload()
        rotations[1][5] = sqrtm @ eigenbasis  # sqrt(I+E) @ eigenbasis
        self.assert_both_paths_reject(rotations, posed)

    def test_nan_gram_from_huge_finite_entries_rejected_by_both_paths(self):
        # 1e200 entries pass the elementwise isfinite pre-check, but the gram
        # products overflow to inf and inf - inf == NaN; NaN comparisons must
        # fail closed (reject), never mask the residual.
        rotations, posed = self._valid_payload()
        rotations[1][3] = [
            [1e200, -1e200, 0.0],
            [1e200, 1e200, 0.0],
            [0.0, 0.0, 1.0],
        ]
        self.assert_both_paths_reject(rotations, posed)


class SchemaTests(unittest.TestCase):
    def test_closed_payload_key_sets(self):
        payload = build_golden_payload()
        self.assertEqual(set(payload), TOP_LEVEL_KEYS)
        self.assertEqual(set(payload["travel"]), TRAVEL_KEYS)
        self.assertEqual(set(payload["lowest_track"]), LOWEST_TRACK_KEYS)
        self.assertEqual(set(payload["end_pose"]), END_POSE_KEYS)
        self.assertTrue(payload["contact_windows"])
        for window in payload["contact_windows"]:
            self.assertEqual(set(window), CONTACT_WINDOW_KEYS)
        self.assertEqual(payload["schema_version"], 1)
        self.assertIsInstance(payload["end_pose"]["resting"], bool)

    def test_golden_fixture_matches_committed_json(self):
        """Drift net: the TS protocol test parses this exact committed file."""
        committed = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        regenerated = json.loads(json.dumps(build_golden_payload()))
        self.assertEqual(committed, regenerated)


class FootContactTests(unittest.TestCase):
    @staticmethod
    def _foot_frame(root, heights):
        """One frame with an explicit height per foot-contact joint."""
        joints = [[root[0], root[1], root[2]] for _ in range(JOINTS)]
        for joint_index, height in zip(FOOT_CONTACT_JOINT_INDICES, heights):
            joints[joint_index] = [root[0], height, root[2]]
        return joints

    def _flat(self, frames, heights=(0.0, 0.0, 0.0, 0.0)):
        return [self._foot_frame([0.0, 0.9, 0.0], heights) for _ in range(frames)]

    def test_channel_order_and_joints_match_ardy(self):
        """Pinned against ardy/motion_rep/feet.py's documented channel order.

        Reordering these silently attributes one foot's contact to the other,
        which is unrecoverable downstream because the caller only sees a name.
        """
        self.assertEqual(
            [channel for channel, _joint in FOOT_CONTACT_CHANNELS],
            ["left_heel", "left_toe", "right_heel", "right_toe"],
        )
        self.assertEqual(
            [joint for _channel, joint in FOOT_CONTACT_CHANNELS],
            ["LeftFoot", "LeftToeBase", "RightFoot", "RightToeBase"],
        )
        # CoreSkeleton27.left_foot_joint_idx / right_foot_joint_idx.
        self.assertEqual(FOOT_CONTACT_JOINT_INDICES, (25, 26, 21, 22))

    def test_absent_contacts_report_null_not_empty(self):
        """None means "the npz carries no channel"; [] means "no contact seen"."""
        posed = self._flat(10)
        self.assertIsNone(analyze_motion(posed, 20)["foot_contacts"])
        flags = [[False] * 4 for _ in range(10)]
        self.assertEqual(analyze_motion(posed, 20, None, flags)["foot_contacts"], [])

    def test_windows_are_named_per_channel_with_their_own_joint_height(self):
        posed = self._flat(8, heights=(0.0, 0.0, 0.18, 0.18))
        flags = [[False] * 4 for _ in range(8)]
        for frame in (1, 2, 3):
            flags[frame][0] = True
        for frame in (5, 6):
            flags[frame][3] = True
        windows = _foot_contact_windows(posed, flags, 1.0)
        self.assertEqual(
            [
                (w["channel"], w["start_frame"], w["end_frame"], w["height"])
                for w in windows
            ],
            [("left_heel", 1, 3, 0.0), ("right_toe", 5, 6, 0.18)],
        )
        for window in windows:
            self.assertEqual(set(window), FOOT_CONTACT_WINDOW_KEYS)

    def test_height_reports_the_mean_and_the_worst_frame_in_the_window(self):
        """The pair is what makes "model says planted, geometry says airborne"
        measurable: a 6 cm height_max under a declared contact is a foot float.
        """
        posed = [
            self._foot_frame([0.0, 0.9, 0.0], (height, 0.0, 0.0, 0.0))
            for height in (0.0, 0.0, 0.03, 0.06, 0.0)
        ]
        flags = [[False] * 4 for _ in range(5)]
        flags[2][0] = True
        flags[3][0] = True
        window = _foot_contact_windows(posed, flags, 1.0)[0]
        self.assertEqual((window["height"], window["height_max"]), (0.045, 0.06))

    def test_a_foot_planted_on_a_stair_reads_that_stair_not_an_error(self):
        """Heights stay absolute, so correct stair climbing cannot look faulty.

        A "distance above the floor" field would flag every stair contact,
        which is why none exists.
        """
        posed = []
        flags = []
        for step in range(4):
            for _ in range(3):
                posed.append(
                    self._foot_frame([0.0, 0.9, 0.0], (0.0, 0.0, 0.18 * step, 0.0))
                )
                flags.append([False, False, True, False])
            posed.append(
                self._foot_frame([0.0, 0.9, 0.0], (0.0, 0.0, 0.18 * step + 0.1, 0.0))
            )
            flags.append([False] * 4)
        self.assertEqual(
            [w["height"] for w in _foot_contact_windows(posed, flags, 1.0)],
            [0.0, 0.18, 0.36, 0.54],
        )

    def test_windows_sort_by_frame_across_channels(self):
        posed = self._flat(6)
        flags = [[False] * 4 for _ in range(6)]
        flags[4][0] = flags[5][0] = True
        flags[0][3] = flags[1][3] = True
        windows = _foot_contact_windows(posed, flags, 1.0)
        self.assertEqual(
            [w["channel"] for w in windows], ["right_toe", "left_heel"]
        )

    def test_scale_applies_to_reported_heights(self):
        posed = self._flat(4, heights=(0.5, 0.0, 0.0, 0.0))
        flags = [[True, False, False, False] for _ in range(4)]
        window = _foot_contact_windows(posed, flags, 2.0)[0]
        self.assertEqual((window["height"], window["height_max"]), (1.0, 1.0))

    def test_window_count_is_capped(self):
        frames = MAX_CONTACT_WINDOWS * 4
        posed = self._flat(frames)
        flags = [[frame % 2 == 0, False, False, False] for frame in range(frames)]
        self.assertEqual(
            len(_foot_contact_windows(posed, flags, 1.0)), MAX_CONTACT_WINDOWS
        )


if __name__ == "__main__":
    unittest.main()
