"""G010 rows 1-10 exact camera-plan/evidence trust precedence regressions."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import stat
import sys
import unittest
from pathlib import Path
from types import MappingProxyType
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import cclay.fixture_registry as registry
from cclay.canonical import canonical_json
from cclay.fixture_registry import (
    EVIDENCE_DIGEST_MISMATCH,
    EVIDENCE_DOCUMENT_MALFORMED,
    EVIDENCE_DOCUMENT_SCHEMA_INVALID,
    EVIDENCE_RANGE_INVALID,
    EVIDENCE_REVISION_MISMATCH,
    EVIDENCE_SCENE_HASH_MISMATCH,
    INVALID_CAMERA_PLAN_SCHEMA,
    TRUSTED_FIXTURE_NOT_FOUND,
    TRUSTED_FIXTURE_PATH_UNSAFE,
    UNTRUSTED_EVIDENCE_DIGEST,
    load_authorized_fixture,
    parse_camera_plan,
)

REVISION = "590ffc757e027eb7ffcfab9e53951314b75dfa1d3cfffa0e340f6f0b24b7d250"
SCENE_HASH = "9a8c73b83e27e23b6a45be26a2768eb679ba4ca5b2731b6067b072878a98a0d7"
PRODUCER = ("cclay.approved_fixture", "test", "f31de2b9d7232e5fdf56c8de4a1ecc80f7cbc4fb6c5743d6eef644d4caeacb59")


def plan(digest: str) -> dict:
    return {
        "schema_version": 1,
        "expected_revision_id": REVISION,
        "evidence_sha256": digest,
        "output_format": {"width": 1920, "height": 1080},
        "keyframes": [{
            "frame": 0.0,
            "pose": {
                "position": [0.0, 2.15, 5.2],
                "look_at": [0.0, 0.9, 0.0],
                "up": [0.0, 1.0, 0.0],
                "vertical_fov_radians": 0.47108996144172666,
            },
            "transition": "cut",
        }],
    }


def evidence() -> dict:
    return {
        "schema_version": 1,
        "revision_id": REVISION,
        "scene_hash": SCENE_HASH,
        "frame_range": {"start": 0, "end": 319},
        "producer": {"id": PRODUCER[0], "version": PRODUCER[1], "digest": PRODUCER[2]},
        "analysis": {
            "motion_valley_frames": [],
            "action_peak_ranges": [],
            "action_axis": {"a": [-1, 0, 0], "b": [1, 0, 0], "up": [0, 0, 1]},
            "subject_samples": [],
        },
    }


def fixture_table(payload: bytes) -> MappingProxyType:
    digest = hashlib.sha256(payload).hexdigest()
    return MappingProxyType({
        digest: ("test", "boxing-v4-directing-evidence.json", PRODUCER)
    })


class CameraPlanEvidencePrecedenceTests(unittest.TestCase):
    def load_payload(self, payload: bytes, *, scene_hash: str = SCENE_HASH) -> dict:
        table = fixture_table(payload)
        digest = next(iter(table))
        with (
            patch.object(registry, "_FIXTURE_REGISTRY", table),
            patch("pathlib.Path.read_bytes", return_value=payload),
        ):
            return load_authorized_fixture(plan(digest), scene_hash)

    def test_row_1_closed_plan_schema_parse_invalid_camera_plan_schema(self):
        invalid = plan("0" * 64)
        invalid["caller_evidence"] = True
        with self.assertRaises(INVALID_CAMERA_PLAN_SCHEMA):
            parse_camera_plan(invalid)

    def test_row_2_digest_absent_core_table_untrusted_evidence_digest(self):
        with self.assertRaises(UNTRUSTED_EVIDENCE_DIGEST):
            load_authorized_fixture(plan("0" * 64), SCENE_HASH)

    def test_row_3_configured_fixture_resource_does_not_exist_trusted_fixture_not_found(self):
        valid_plan = plan(registry.BOXING_V4_EVIDENCE_SHA256)
        with patch("pathlib.Path.exists", return_value=False):
            with self.assertRaises(TRUSTED_FIXTURE_NOT_FOUND):
                load_authorized_fixture(valid_plan, SCENE_HASH)

    def test_row_4_existing_resource_resolves_unsafe_trusted_fixture_path_unsafe(self):
        valid_plan = plan(registry.BOXING_V4_EVIDENCE_SHA256)
        real_stat = (
            Path(registry.__file__).resolve().parent
            / "fixtures"
            / "boxing-v4-directing-evidence.json"
        ).lstat()
        unsafe_stat = os.stat_result((
            stat.S_IFLNK | 0o777,
            *tuple(real_stat)[1:],
        ))
        with patch("pathlib.Path.lstat", return_value=unsafe_stat):
            with self.assertRaises(TRUSTED_FIXTURE_PATH_UNSAFE):
                load_authorized_fixture(valid_plan, SCENE_HASH)

    def test_row_5_recomputed_sha_differs_from_plan_or_table_evidence_digest_mismatch(self):
        valid_plan = plan(registry.BOXING_V4_EVIDENCE_SHA256)
        with patch("pathlib.Path.read_bytes", return_value=b"{}"):
            with self.assertRaises(EVIDENCE_DIGEST_MISMATCH):
                load_authorized_fixture(valid_plan, SCENE_HASH)

    def test_row_6_bytes_malformed_json_utf8_or_noncanonical_evidence_document_malformed(self):
        payload = b"{not json"
        with self.assertRaises(EVIDENCE_DOCUMENT_MALFORMED):
            self.load_payload(payload)

    def test_row_7_parsed_value_violates_closed_schema_evidence_document_schema_invalid(self):
        payload = canonical_json({"schema_version": 1}).encode("utf-8")
        with self.assertRaises(EVIDENCE_DOCUMENT_SCHEMA_INVALID):
            self.load_payload(payload)

    def test_row_8_evidence_range_noninteger_or_start_after_end_evidence_range_invalid(self):
        value = evidence()
        value["frame_range"] = {"start": 10.5, "end": 1}
        payload = canonical_json(value).encode("utf-8")
        with self.assertRaises(EVIDENCE_RANGE_INVALID):
            self.load_payload(payload)

    def test_row_9_fixture_revision_differs_expected_evidence_revision_mismatch(self):
        value = evidence()
        value["revision_id"] = "1" * 64
        payload = canonical_json(value).encode("utf-8")
        with self.assertRaises(EVIDENCE_REVISION_MISMATCH):
            self.load_payload(payload)

    def test_row_10_fixture_scene_hash_differs_current_record_evidence_scene_hash_mismatch(self):
        payload = canonical_json(evidence()).encode("utf-8")
        with self.assertRaises(EVIDENCE_SCENE_HASH_MISMATCH):
            self.load_payload(payload, scene_hash="2" * 64)

    def test_multi_fault_returns_first_atomic_precedence_error_only(self):
        invalid = {"schema_version": 2, "evidence_sha256": "0" * 64}
        with self.assertRaises(INVALID_CAMERA_PLAN_SCHEMA):
            load_authorized_fixture(invalid, "2" * 64)


if __name__ == "__main__":
    unittest.main()
