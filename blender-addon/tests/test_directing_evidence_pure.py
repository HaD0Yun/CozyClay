"""Host-side runtime-evidence analysis, trust-registry, and dispatch tests."""

from __future__ import annotations

import hashlib
import json
import math
import os
import pathlib
import sys
import tempfile
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import cclay.fixture_registry as registry
from cclay import bl_info
from cclay import connection as connection_module
from cclay.canonical import canonical_json
from cclay.connection import Connection
from cclay.directing_evidence import (
    RUNTIME_PRODUCER_VERSION,
    EVIDENCE_PRODUCTION_FAILED,
    RUNTIME_PRODUCER_ID,
    analyze_subject_motion,
    blender_to_ardy,
    durable_project_base,
    runtime_producer,
)
from cclay.fixture_registry import (
    EVIDENCE_DIGEST_MISMATCH,
    EVIDENCE_DOCUMENT_SCHEMA_INVALID,
    EVIDENCE_REVISION_MISMATCH,
    EVIDENCE_SCENE_HASH_MISMATCH,
    TRUSTED_FIXTURE_PATH_UNSAFE,
    UNTRUSTED_EVIDENCE_DIGEST,
    load_authorized_fixture,
    parse_directing_analysis_evidence,
    register_runtime_evidence,
)

REVISION = "a" * 64
SCENE_HASH = "b" * 64
FOV = 2 * math.atan(12 / 48)


def static_samples(start: int = 0, end: int = 4) -> list[dict]:
    return [
        {"frame": frame, "center": [3.0, 5.0, -4.0], "height_m": 2.0}
        for frame in range(start, end + 1)
    ]


def plan(digest: str) -> dict:
    return {
        "schema_version": 1,
        "expected_revision_id": REVISION,
        "evidence_sha256": digest,
        "output_format": {"width": 640, "height": 360},
        "keyframes": [
            {
                "frame": 0,
                "pose": {
                    "position": [0.0, 2.0, 10.0],
                    "look_at": [3.0, 5.0, -4.0],
                    "up": [0.0, 1.0, 0.0],
                    "vertical_fov_radians": FOV,
                },
                "transition": "smooth",
            },
        ],
    }


def evidence_document() -> dict:
    return {
        "schema_version": 1,
        "revision_id": REVISION,
        "scene_hash": SCENE_HASH,
        "frame_range": {"start": 0, "end": 4},
        "producer": runtime_producer(),
        "analysis": analyze_subject_motion(static_samples(), 0, 4),
    }


def producer_tuple() -> tuple[str, str, str]:
    producer = runtime_producer()
    return (producer["id"], producer["version"], producer["digest"])


def write_registered(directory: pathlib.Path, document: dict) -> tuple[str, pathlib.Path]:
    payload = canonical_json(document).encode("utf-8")
    digest = hashlib.sha256(payload).hexdigest()
    path = directory / f"{digest}.json"
    path.write_bytes(payload)
    os.chmod(path, 0o600)
    register_runtime_evidence(
        digest,
        path,
        directory,
        producer_tuple(),
        document["revision_id"],
        document["scene_hash"],
    )
    return digest, path


class AnalyzeSubjectMotionTests(unittest.TestCase):
    def test_static_scene_every_frame_is_a_valley_and_no_peaks_exist(self):
        analysis = analyze_subject_motion(static_samples(), 0, 4)
        self.assertEqual(analysis["motion_valley_frames"], [0, 1, 2, 3, 4])
        self.assertEqual(analysis["action_peak_ranges"], [])
        self.assertEqual(analysis["subject_samples"], static_samples())

    def test_static_scene_axis_is_horizontal_non_zero_and_non_parallel_to_up(self):
        axis = analyze_subject_motion(static_samples(), 0, 4)["action_axis"]
        self.assertEqual(axis["up"], [0.0, 1.0, 0.0])
        self.assertEqual(axis["a"], [3.0, 5.0, -4.0])
        self.assertEqual(axis["b"], [4.0, 5.0, -4.0])
        vector = [axis["b"][index] - axis["a"][index] for index in range(3)]
        self.assertGreaterEqual(math.hypot(*vector), 1e-9)
        # cross(vector, [0, 1, 0]) magnitude equals the horizontal magnitude.
        self.assertGreaterEqual(math.hypot(vector[0], vector[2]), 1e-9)
        parse_directing_analysis_evidence(evidence_document())

    def test_moving_subject_axis_spans_the_displacement_and_peaks_are_grouped(self):
        samples = [
            {"frame": frame, "center": [float(x), 1.0, 0.0], "height_m": 1.8}
            for frame, x in ((0, 0.0), (1, 1.0), (2, 2.0), (3, 3.0), (4, 3.0), (5, 3.0))
        ]
        analysis = analyze_subject_motion(samples, 0, 5)
        self.assertEqual(analysis["action_axis"]["a"], [0.0, 1.0, 0.0])
        self.assertEqual(analysis["action_axis"]["b"], [3.0, 1.0, 0.0])
        self.assertEqual(analysis["action_peak_ranges"], [{"start": 0, "end": 3}])
        self.assertEqual(analysis["motion_valley_frames"], [4, 5])

    def test_vertical_only_motion_falls_back_to_a_horizontal_axis(self):
        samples = [
            {"frame": frame, "center": [0.0, float(frame), 0.0], "height_m": 1.0}
            for frame in range(3)
        ]
        axis = analyze_subject_motion(samples, 0, 2)["action_axis"]
        vector = [axis["b"][index] - axis["a"][index] for index in range(3)]
        self.assertGreaterEqual(math.hypot(vector[0], vector[2]), 1e-9)

    def test_samples_must_cover_every_frame_of_the_range(self):
        with self.assertRaises(EVIDENCE_PRODUCTION_FAILED):
            analyze_subject_motion(static_samples(0, 3), 0, 4)

    def test_blender_to_ardy_is_the_inverse_of_the_plan_conversion(self):
        self.assertEqual(blender_to_ardy([3.0, 4.0, 5.0]), [3.0, 5.0, -4.0])

    def test_runtime_producer_identity_is_fixed_and_digest_bound(self):
        # The producer version is a pinned evidence identity, not the add-on
        # version: bumping it invalidates every committed evidence digest and
        # every camera plan authorized by one.
        producer = runtime_producer()
        version = RUNTIME_PRODUCER_VERSION
        self.assertEqual(version, "0.4.0")
        self.assertEqual(producer["id"], RUNTIME_PRODUCER_ID)
        self.assertEqual(producer["id"], "cclay-addon-runtime")
        self.assertEqual(producer["version"], version)
        self.assertEqual(
            producer["digest"],
            hashlib.sha256(
                f"cclay-addon-runtime\x00{version}".encode("utf-8")
            ).hexdigest(),
        )


class RuntimeEvidenceTrustTests(unittest.TestCase):
    def setUp(self) -> None:
        patcher = mock.patch.dict(registry._RUNTIME_EVIDENCE_REGISTRY, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = pathlib.Path(directory.name)
        os.chmod(self.directory, 0o700)

    def test_registered_runtime_digest_loads_through_the_shared_trust_rows(self):
        digest, _path = write_registered(self.directory, evidence_document())
        evidence = load_authorized_fixture(plan(digest), SCENE_HASH)
        self.assertEqual(evidence, evidence_document())

    def test_unknown_digest_still_raises_untrusted_evidence_digest(self):
        write_registered(self.directory, evidence_document())
        with self.assertRaises(UNTRUSTED_EVIDENCE_DIGEST):
            load_authorized_fixture(plan("0" * 64), SCENE_HASH)

    def test_tampered_runtime_bytes_raise_evidence_digest_mismatch(self):
        digest, path = write_registered(self.directory, evidence_document())
        path.write_bytes(path.read_bytes() + b" ")
        with self.assertRaises(EVIDENCE_DIGEST_MISMATCH):
            load_authorized_fixture(plan(digest), SCENE_HASH)

    def test_scene_hash_drift_raises_evidence_scene_hash_mismatch(self):
        digest, _path = write_registered(self.directory, evidence_document())
        with self.assertRaises(EVIDENCE_SCENE_HASH_MISMATCH):
            load_authorized_fixture(plan(digest), "c" * 64)

    def test_revision_drift_raises_evidence_revision_mismatch(self):
        digest, _path = write_registered(self.directory, evidence_document())
        stale_plan = plan(digest)
        stale_plan["expected_revision_id"] = "d" * 64
        with self.assertRaises(EVIDENCE_REVISION_MISMATCH):
            load_authorized_fixture(stale_plan, SCENE_HASH)

    def test_producer_mismatch_raises_evidence_document_schema_invalid(self):
        document = evidence_document()
        payload = canonical_json(document).encode("utf-8")
        digest = hashlib.sha256(payload).hexdigest()
        path = self.directory / f"{digest}.json"
        path.write_bytes(payload)
        os.chmod(path, 0o600)
        register_runtime_evidence(
            digest,
            path,
            self.directory,
            ("cclay-addon-runtime", "other-version", "e" * 64),
            REVISION,
            SCENE_HASH,
        )
        with self.assertRaises(EVIDENCE_DOCUMENT_SCHEMA_INVALID):
            load_authorized_fixture(plan(digest), SCENE_HASH)

    def test_symlinked_runtime_evidence_is_path_unsafe(self):
        document = evidence_document()
        payload = canonical_json(document).encode("utf-8")
        digest = hashlib.sha256(payload).hexdigest()
        outside = self.directory / "outside"
        outside.mkdir(mode=0o700)
        target = outside / "real.json"
        target.write_bytes(payload)
        os.chmod(target, 0o600)
        link = self.directory / f"{digest}.json"
        link.symlink_to(target)
        # Registration binds the file to its private directory and rejects a
        # symlink that resolves outside it, so the untrusted resource never
        # reaches the trust registry.
        with self.assertRaises(TRUSTED_FIXTURE_PATH_UNSAFE):
            register_runtime_evidence(
                digest, link, self.directory, producer_tuple(), REVISION, SCENE_HASH
            )
        with self.assertRaises(UNTRUSTED_EVIDENCE_DIGEST):
            load_authorized_fixture(plan(digest), SCENE_HASH)

    def test_registration_rejects_a_file_outside_the_private_evidence_directory(self):
        # A well-formed, correctly-owned evidence file whose digest matches its
        # bytes must still be refused when it lives outside a private 0700
        # directory (e.g. world-writable /tmp). Binding the trusted directory to
        # the resource's own parent would authorize it; binding it to a recorded
        # private directory does not.
        document = evidence_document()
        payload = canonical_json(document).encode("utf-8")
        digest = hashlib.sha256(payload).hexdigest()
        loose = tempfile.NamedTemporaryFile(
            dir="/tmp", suffix=".json", delete=False
        )
        loose.write(payload)
        loose.close()
        os.chmod(loose.name, 0o600)
        self.addCleanup(lambda: os.unlink(loose.name))
        loose_path = pathlib.Path(loose.name)
        # Attacker attempts to bind trust to the world-writable /tmp directory.
        with self.assertRaises(TRUSTED_FIXTURE_PATH_UNSAFE):
            register_runtime_evidence(
                digest, loose_path, loose_path.parent, producer_tuple(), REVISION, SCENE_HASH
            )
        # Attacker attempts to smuggle a /tmp file under a legitimate private
        # directory: the containment row rejects it because the file does not
        # resolve inside that directory.
        with self.assertRaises(TRUSTED_FIXTURE_PATH_UNSAFE):
            register_runtime_evidence(
                digest, loose_path, self.directory, producer_tuple(), REVISION, SCENE_HASH
            )
        with self.assertRaises(UNTRUSTED_EVIDENCE_DIGEST):
            load_authorized_fixture(plan(digest), SCENE_HASH)

    def test_register_rejects_malformed_digests_and_producer_identities(self):
        with self.assertRaises(ValueError):
            register_runtime_evidence(
                "not-a-digest",
                self.directory / "x.json",
                self.directory,
                producer_tuple(),
                REVISION,
                SCENE_HASH,
            )
        with self.assertRaises(ValueError):
            register_runtime_evidence(
                "0" * 64,
                self.directory / "x.json",
                self.directory,
                ("only", "two"),
                REVISION,
                SCENE_HASH,
            )


class DurableProjectBaseTests(unittest.TestCase):
    """Evidence binds the durable project index, not the raw V2 substrate."""

    PROJECT_ID = "00000000-0000-4000-8000-00000000000a"

    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = pathlib.Path(directory.name)
        (self.directory / ".cclay").mkdir()

    def write_index(self, value: dict) -> None:
        (self.directory / ".cclay" / "project.json").write_text(
            json.dumps(value), encoding="utf-8"
        )

    def test_returns_the_durable_current_revision_and_manifest_scene_hash(self):
        self.write_index({
            "project_id": self.PROJECT_ID,
            "schema_version": 1,
            "current_revision_id": REVISION,
            "manifest": {"sceneHash": SCENE_HASH},
        })
        self.assertEqual(
            durable_project_base(self.directory, self.PROJECT_ID),
            (REVISION, SCENE_HASH),
        )

    def test_missing_project_directory_fails_production(self):
        with self.assertRaises(EVIDENCE_PRODUCTION_FAILED):
            durable_project_base(None, self.PROJECT_ID)

    def test_absent_durable_project_index_fails_production(self):
        with self.assertRaises(EVIDENCE_PRODUCTION_FAILED):
            durable_project_base(self.directory, self.PROJECT_ID)

    def test_legacy_index_without_current_revision_fails_production(self):
        self.write_index({"project_id": self.PROJECT_ID})
        with self.assertRaises(EVIDENCE_PRODUCTION_FAILED):
            durable_project_base(self.directory, self.PROJECT_ID)

    def test_foreign_project_index_fails_production(self):
        self.write_index({
            "project_id": "11111111-2222-4333-8444-555555555555",
            "current_revision_id": REVISION,
            "manifest": {"sceneHash": SCENE_HASH},
        })
        with self.assertRaises(EVIDENCE_PRODUCTION_FAILED):
            durable_project_base(self.directory, self.PROJECT_ID)

    def test_invalid_durable_hashes_fail_production(self):
        self.write_index({
            "project_id": self.PROJECT_ID,
            "current_revision_id": "not-a-hash",
            "manifest": {"sceneHash": SCENE_HASH},
        })
        with self.assertRaises(EVIDENCE_PRODUCTION_FAILED):
            durable_project_base(self.directory, self.PROJECT_ID)
        self.write_index({
            "project_id": self.PROJECT_ID,
            "current_revision_id": REVISION,
            "manifest": {"sceneHash": None},
        })
        with self.assertRaises(EVIDENCE_PRODUCTION_FAILED):
            durable_project_base(self.directory, self.PROJECT_ID)

    def test_corrupt_index_document_fails_production(self):
        (self.directory / ".cclay" / "project.json").write_text(
            "{not json", encoding="utf-8"
        )
        with self.assertRaises(EVIDENCE_PRODUCTION_FAILED):
            durable_project_base(self.directory, self.PROJECT_ID)


class ProduceDirectingEvidenceDispatchTests(unittest.TestCase):
    def test_bridge_dispatch_routes_params_without_task_tracking(self):
        class FakeSocket:
            def __init__(self):
                self.closed = False
                self.sent = []

            def send_json(self, message):
                self.sent.append(message)

            def close(self):
                self.closed = True

        socket = FakeSocket()
        with tempfile.TemporaryDirectory() as directory:
            cclay = pathlib.Path(directory, ".cclay")
            cclay.mkdir()
            (cclay / "project.json").write_text(json.dumps({
                "project_id": "project",
                "current_revision_id": REVISION,
                "manifest": {"sceneHash": SCENE_HASH},
            }))
            connection = Connection(None, socket, project_directory=directory)
            produced = {
                "schema_version": 1,
                "evidence_sha256": "f" * 64,
                "revision_id": REVISION,
                "scene_hash": SCENE_HASH,
                "frame_range": {"start": 0, "end": 319},
                "byte_length": 512,
            }
            stub = types.SimpleNamespace(
                produce_directing_evidence=mock.Mock(return_value=produced)
            )
            message = {
                "type": "bridge_request",
                "id": "evidence-bridge",
                "request_id": "evidence-request",
                "method": "produce_directing_evidence",
                "params": {
                    "project_id": "00000000-0000-4000-8000-00000000000a",
                    "frame_start": None,
                    "frame_end": None,
                },
                "expected_revision_id": "0" * 64,
                "deadline_ms": 5000,
            }
            blender = mock.Mock()
            with (
                mock.patch.object(connection_module, "bpy", blender),
                mock.patch.dict(
                    sys.modules,
                    {"cclay.directing_evidence": stub},
                ),
            ):
                connection.dispatch_bridge_message(message)

        stub.produce_directing_evidence.assert_called_once_with(
            "00000000-0000-4000-8000-00000000000a", None, None,
            project_directory=pathlib.Path(directory),
        )
        self.assertEqual(socket.sent, [{
            "type": "bridge_result",
            "id": "evidence-bridge",
            "request_id": "evidence-request",
            "result": produced,
        }])
        self.assertIsNone(connection.task_status.task_kind)
        self.assertFalse(connection._bridge_cancellations)
        blender.ops.cclay.apply_camera_plan.assert_not_called()

    def test_production_failure_maps_to_the_bridge_error_envelope(self):
        class FakeSocket:
            def __init__(self):
                self.closed = False
                self.sent = []

            def send_json(self, message):
                self.sent.append(message)

            def close(self):
                self.closed = True

        socket = FakeSocket()
        with tempfile.TemporaryDirectory() as directory:
            cclay = pathlib.Path(directory, ".cclay")
            cclay.mkdir()
            (cclay / "project.json").write_text(json.dumps({
                "project_id": "project",
                "current_revision_id": REVISION,
                "manifest": {"sceneHash": SCENE_HASH},
            }))
            connection = Connection(None, socket, project_directory=directory)
            stub = types.SimpleNamespace(
                produce_directing_evidence=mock.Mock(
                    side_effect=EVIDENCE_PRODUCTION_FAILED(
                        "scene has no armature or mesh subject to analyze"
                    )
                )
            )
            with (
                mock.patch.object(connection_module, "bpy", mock.Mock()),
                mock.patch.dict(
                    sys.modules,
                    {"cclay.directing_evidence": stub},
                ),
            ):
                connection.dispatch_bridge_message({
                    "type": "bridge_request",
                    "id": "evidence-bridge",
                    "request_id": "evidence-request",
                    "method": "produce_directing_evidence",
                    "params": {"project_id": "bad", "frame_start": None, "frame_end": None},
                    "expected_revision_id": REVISION,
                    "deadline_ms": 5000,
                })

        self.assertEqual(socket.sent[-1]["type"], "bridge_error")
        self.assertEqual(socket.sent[-1]["code"], "EVIDENCE_PRODUCTION_FAILED")
        self.assertFalse(connection._bridge_cancellations)


if __name__ == "__main__":
    unittest.main()
