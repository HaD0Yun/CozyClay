import copy
import os
import sys
import stat
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from cclay.fixture_registry import (
    BOXING_V4_EVIDENCE_SHA256,
    INVALID_CAMERA_PLAN,
    UNTRUSTED_DIRECTING_EVIDENCE,
    convert_ardy_plan_pose_to_blender,
    load_authorized_fixture,
    parse_camera_plan,
    parse_directing_analysis_evidence,
)

REVISION = "7920614992fba50993b2cc2774dbf9a11fbd6feceaf00dc97ee0c75aa7e6768a"
SCENE_HASH = "81c57a255b9d51a6b66dd8bc7b2c898b30a7c2314ce962345277bcf86d6769ab"


def camera_plan():
    return {
        "schema_version": 1,
        "expected_revision_id": REVISION,
        "evidence_sha256": BOXING_V4_EVIDENCE_SHA256,
        "output_format": {"width": 1920, "height": 1080},
        "keyframes": [
            {
                "frame": 0,
                "pose": {
                    "position": [0.0, 2.15, 5.2],
                    "look_at": [0.0, 0.9, 0.0],
                    "up": [0.0, 1.0, 0.0],
                    "vertical_fov_radians": 0.47108996144172666,
                },
                "transition": "smooth",
            },
            {
                "frame": 80,
                "pose": {
                    "position": [-4.38553, 2.0, 4.388669],
                    "look_at": [-0.38553, 0.9, 0.888669],
                    "up": [0.0, 1.0, 0.0],
                    "vertical_fov_radians": 0.47108996144172666,
                },
                "transition": "cut",
            },
        ],
    }


class FixtureRegistryTests(unittest.TestCase):
    def test_architecture_section_7_typed_operations_camera_plan_is_closed_and_digest_bound(self):
        plan = parse_camera_plan(camera_plan())
        self.assertEqual(plan["evidence_sha256"], BOXING_V4_EVIDENCE_SHA256)
        polluted = {**camera_plan(), "evidence": {"trusted": True}}
        with self.assertRaises(INVALID_CAMERA_PLAN):
            parse_camera_plan(polluted)

    def test_architecture_section_15_1_evidence_is_z_up_and_only_ardy_plan_vectors_convert_once(self):
        evidence = load_authorized_fixture(camera_plan(), SCENE_HASH)
        self.assertEqual(evidence["analysis"]["action_axis"]["up"], [0.0, 0.0, 1.0])
        converted = convert_ardy_plan_pose_to_blender(camera_plan()["keyframes"][0]["pose"])
        self.assertEqual(converted["position"], [0.0, -5.2, 2.15])
        self.assertEqual(converted["look_at"], [0.0, -0.0, 0.9])
        self.assertEqual(converted["up"], [0.0, -0.0, 1.0])

    def test_architecture_section_15_4_fixture_identity_comes_only_from_core_digest_allowlist(self):
        plan = camera_plan()
        plan["fixture_identity"] = "boxing-v4"
        with self.assertRaises(INVALID_CAMERA_PLAN):
            load_authorized_fixture(plan, SCENE_HASH)
        plan = camera_plan()
        plan["evidence_sha256"] = "0" * 64
        with self.assertRaises(UNTRUSTED_DIRECTING_EVIDENCE):
            load_authorized_fixture(plan, SCENE_HASH)

    def test_architecture_section_6_core_recomputes_sha256_over_loaded_canonical_bytes(self):
        with patch("pathlib.Path.read_bytes", return_value=b"{}"):
            with self.assertRaises(UNTRUSTED_DIRECTING_EVIDENCE):
                load_authorized_fixture(camera_plan(), SCENE_HASH)

    def test_architecture_section_6_package_resource_must_be_a_regular_nonsymlink_file(self):
        real_stat = (
            Path(__file__).resolve().parents[1]
            / "cclay"
            / "fixtures"
            / "boxing-v4-directing-evidence.json"
        ).lstat()
        unsafe_stat = os.stat_result((
            stat.S_IFLNK | 0o777,
            *tuple(real_stat)[1:],
        ))
        with patch("pathlib.Path.lstat", return_value=unsafe_stat):
            with self.assertRaises(UNTRUSTED_DIRECTING_EVIDENCE):
                load_authorized_fixture(camera_plan(), SCENE_HASH)

    def test_plan_range_is_validated_after_python_evidence_trust_boundary(self):
        plan = camera_plan()
        plan["keyframes"][-1]["frame"] = 320
        evidence = load_authorized_fixture(plan, SCENE_HASH)
        self.assertEqual(evidence["frame_range"]["end"], 319)

    def test_architecture_section_6_evidence_schema_is_closed_and_caller_metadata_cannot_authorize(self):
        evidence = load_authorized_fixture(camera_plan(), SCENE_HASH)
        polluted = copy.deepcopy(evidence)
        polluted["authorized_fixture"] = True
        with self.assertRaises(UNTRUSTED_DIRECTING_EVIDENCE):
            parse_directing_analysis_evidence(polluted)


if __name__ == "__main__":
    unittest.main()
