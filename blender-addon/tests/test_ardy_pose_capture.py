"""Closed evaluated-pose capture (bridge method ``capture_evaluated_pose``).

Two layers, mirroring how the story splits:

- Hermetic: the closed request shape (unknown keys, malformed ids, bounded and
  uniquely-mapped pose frames), the add-on surface wiring (method registered,
  deliberately NOT read-only, capability reported, addon-surface.ts mirror),
  and the affine frame-mapping rule.
- Real Blender (gated like every other Blender suite, but REQUIRED to run
  here): the evaluated pose is captured at each declared scene frame, the
  entered scene frame is restored on both paths, wrong armature / missing
  base archive / bad frame mapping / a pre-existing archive collision fail
  closed with no file written, and a mid-loop failure or a success-path
  restoration failure rolls back every archive the invocation created.
"""
from __future__ import annotations

import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

from cclay import connection, constraint_capture, handshake  # noqa: E402
from cclay.constraint_capture import (  # noqa: E402
    CLIP_FRAME_BOUND,
    POSE_FRAME_LIMIT,
    PoseCaptureValidationError,
    parse_capture_evaluated_pose,
)

BLENDER = pathlib.Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/ardy_pose_capture_fixture.py"

ENTITY_ID = "00000000-0000-4000-8000-000000000fff"
REVISION_ID = "a" * 64
REQUEST_ID = "0123456789abcdef0123456789abcdef"
BASE_MOTION_ID = "base-motion-1"

# float32 storage noise; a pose archive whose joints were filled in without
# running forward kinematics lands seven orders of magnitude above this.
NPZ_TOLERANCE = 1e-05
# Blender's IK solve does not land exactly on the FK pose it replaced; this is
# the observed worst case over the lab's clips with headroom (same bound
# test_regenerate_request uses).
IK_RESIDUAL_BOUND = 1e-03
# A 0.5-npz-unit handle drag moves the chain rotations orders of magnitude
# more than any IK residual, so a captured archive that ignored the edit fails
# this by construction.
EVALUATED_EDIT_BOUND = 5e-03


def _valid_request(**overrides):
    request = {
        "entity_id": ENTITY_ID,
        "expected_revision_id": REVISION_ID,
        "base_motion_id": BASE_MOTION_ID,
        "request_id": REQUEST_ID,
        "pose_frames": [
            {"scene_frame": 10, "clip_frame": 9},
            {"scene_frame": 12, "clip_frame": 11},
        ],
    }
    request.update(overrides)
    return request


class CapturePoseParserTests(unittest.TestCase):
    """The request shape is closed: unknown keys and malformed ids are skew."""

    def test_parses_the_closed_request(self):
        parsed = parse_capture_evaluated_pose(_valid_request())
        self.assertEqual(
            parsed,
            {
                "entity_id": ENTITY_ID,
                "expected_revision_id": REVISION_ID,
                "base_motion_id": BASE_MOTION_ID,
                "request_id": REQUEST_ID,
                "pose_frames": [
                    {"scene_frame": 10, "clip_frame": 9},
                    {"scene_frame": 12, "clip_frame": 11},
                ],
            },
        )

    def test_an_unknown_param_key_is_refused(self):
        for extra in ("prompt", "duration_seconds", "schema_version", "bones"):
            with self.subTest(extra=extra):
                with self.assertRaisesRegex(
                    PoseCaptureValidationError, "INVALID_CAPTURE_REQUEST"
                ):
                    parse_capture_evaluated_pose(_valid_request(**{extra: 1}))

    def test_a_missing_param_key_is_refused(self):
        for key in (
            "entity_id",
            "expected_revision_id",
            "base_motion_id",
            "request_id",
            "pose_frames",
        ):
            with self.subTest(key=key):
                request = _valid_request()
                del request[key]
                with self.assertRaisesRegex(
                    PoseCaptureValidationError, "INVALID_CAPTURE_REQUEST"
                ):
                    parse_capture_evaluated_pose(request)

    def test_a_non_object_request_is_refused(self):
        for value in (None, [], "capture", 7):
            with self.subTest(value=value):
                with self.assertRaisesRegex(
                    PoseCaptureValidationError, "INVALID_CAPTURE_REQUEST"
                ):
                    parse_capture_evaluated_pose(value)

    def test_a_malformed_request_id_is_refused(self):
        # The 32-hex filename grammar, same fence write_request uses.
        for request_id in (
            "inbetween-1742",
            "0123456789abcdef0123456789abcdeZ",
            "0123456789abcdef0123456789abcde",
            "0123456789abcdef0123456789abcdef0",
            "0123456789ABCDEF0123456789ABCDEF",
        ):
            with self.subTest(request_id=request_id):
                with self.assertRaisesRegex(
                    PoseCaptureValidationError, "malformed request id"
                ):
                    parse_capture_evaluated_pose(_valid_request(request_id=request_id))

    def test_a_malformed_entity_id_is_refused(self):
        for entity_id in (
            "not-a-uuid",
            "00000000-0000-4000-8000-000000000fff"[:-1],
            "00000000-0000-4000-8000-000000000FFF",
            "00000000-0000-5000-8000-000000000fff",
        ):
            with self.subTest(entity_id=entity_id):
                with self.assertRaisesRegex(
                    PoseCaptureValidationError, "malformed entity id"
                ):
                    parse_capture_evaluated_pose(_valid_request(entity_id=entity_id))

    def test_a_malformed_revision_hash_is_refused(self):
        for revision in ("x" * 64, "a" * 63, "a" * 65, "a" * 64 + "Z"):
            with self.subTest(revision=revision):
                with self.assertRaisesRegex(
                    PoseCaptureValidationError, "malformed expected revision id"
                ):
                    parse_capture_evaluated_pose(
                        _valid_request(expected_revision_id=revision)
                    )

    def test_a_malformed_base_motion_id_is_refused(self):
        for motion_id in ("", "Bad Motion", "UPPER-case", "has/slash", "a" * 65):
            with self.subTest(motion_id=motion_id):
                with self.assertRaisesRegex(
                    PoseCaptureValidationError, "malformed base motion id"
                ):
                    parse_capture_evaluated_pose(_valid_request(base_motion_id=motion_id))

    def test_pose_frames_is_a_bounded_list(self):
        for pose_frames in ([], {}, "frames", [{"scene_frame": 1, "clip_frame": 0}] * (POSE_FRAME_LIMIT + 1)):
            with self.subTest(pose_frames=pose_frames):
                with self.assertRaisesRegex(
                    PoseCaptureValidationError, "INVALID_CAPTURE_REQUEST"
                ):
                    parse_capture_evaluated_pose(_valid_request(pose_frames=pose_frames))

    def test_a_pose_frame_pair_is_closed(self):
        for entry in ({"scene_frame": 1}, {"clip_frame": 0}, {"scene_frame": 1, "clip_frame": 0, "extra": 2}, [], "1:0"):
            with self.subTest(entry=entry):
                with self.assertRaisesRegex(
                    PoseCaptureValidationError, "INVALID_CAPTURE_REQUEST"
                ):
                    parse_capture_evaluated_pose(
                        _valid_request(pose_frames=[entry])
                    )

    def test_frame_values_must_be_integer_and_bounded(self):
        bad_frames = [
            {"scene_frame": 1.5, "clip_frame": 0},
            {"scene_frame": True, "clip_frame": 0},
            {"scene_frame": 1, "clip_frame": 0.5},
            {"scene_frame": 1, "clip_frame": True},
            {"scene_frame": -100001, "clip_frame": 0},
            {"scene_frame": 100001, "clip_frame": 0},
            {"scene_frame": 1, "clip_frame": -1},
            {"scene_frame": 1, "clip_frame": CLIP_FRAME_BOUND + 1},
        ]
        for entry in bad_frames:
            with self.subTest(entry=entry):
                with self.assertRaisesRegex(
                    PoseCaptureValidationError, "INVALID_CAPTURE_REQUEST"
                ):
                    parse_capture_evaluated_pose(_valid_request(pose_frames=[entry]))

    def test_a_duplicated_scene_frame_is_refused(self):
        with self.assertRaisesRegex(PoseCaptureValidationError, "scene_frame .* duplicated"):
            parse_capture_evaluated_pose(
                _valid_request(
                    pose_frames=[
                        {"scene_frame": 10, "clip_frame": 9},
                        {"scene_frame": 10, "clip_frame": 8},
                    ]
                )
            )

    def test_a_duplicated_clip_frame_is_refused(self):
        with self.assertRaisesRegex(PoseCaptureValidationError, "clip_frame .* duplicated"):
            parse_capture_evaluated_pose(
                _valid_request(
                    pose_frames=[
                        {"scene_frame": 10, "clip_frame": 9},
                        {"scene_frame": 11, "clip_frame": 9},
                    ]
                )
            )

    def test_a_non_constant_offset_is_refused(self):
        # The protocol rule: every entry shares ONE scene_frame - clip_frame
        # offset, which is the add-on's affine mapping stated without a start.
        with self.assertRaisesRegex(PoseCaptureValidationError, "must share one offset"):
            parse_capture_evaluated_pose(
                _valid_request(
                    pose_frames=[
                        {"scene_frame": 10, "clip_frame": 9},
                        {"scene_frame": 12, "clip_frame": 10},
                    ]
                )
            )

    def test_the_maximum_pose_frames_bound_is_accepted(self):
        pose_frames = [
            {"scene_frame": 10 + index, "clip_frame": 9 + index}
            for index in range(POSE_FRAME_LIMIT)
        ]
        parsed = parse_capture_evaluated_pose(_valid_request(pose_frames=pose_frames))
        self.assertEqual(len(parsed["pose_frames"]), POSE_FRAME_LIMIT)


class CapturePoseMappingTests(unittest.TestCase):
    """The affine clip mapping, validated before any frame is evaluated."""

    def test_consistent_pairs_pass(self):
        constraint_capture._require_pose_frame_mapping(
            [
                {"scene_frame": 10, "clip_frame": 9},
                {"scene_frame": 12, "clip_frame": 11},
            ],
            start_frame=1,
            frame_count=20,
        )

    def test_a_pair_off_the_affine_rule_is_refused(self):
        with self.assertRaisesRegex(PoseCaptureValidationError, "maps to clip frame"):
            constraint_capture._require_pose_frame_mapping(
                [{"scene_frame": 10, "clip_frame": 8}],
                start_frame=1,
                frame_count=20,
            )

    def test_an_out_of_range_scene_frame_is_refused(self):
        with self.assertRaisesRegex(
            PoseCaptureValidationError, "outside clip range"
        ):
            constraint_capture._require_pose_frame_mapping(
                [{"scene_frame": 30, "clip_frame": 29}],
                start_frame=1,
                frame_count=20,
            )

    def test_a_negative_clip_frame_is_refused(self):
        with self.assertRaisesRegex(
            PoseCaptureValidationError, "outside clip range"
        ):
            constraint_capture._require_pose_frame_mapping(
                [{"scene_frame": 0, "clip_frame": -1}],
                start_frame=1,
                frame_count=20,
            )


class CapturePoseSurfaceTests(unittest.TestCase):
    """The method is a tracked mutation: registered, never read-only."""

    def test_the_method_is_in_supported_bridge_methods(self):
        self.assertIn("capture_evaluated_pose", handshake.SUPPORTED_BRIDGE_METHODS)

    def test_the_method_is_absent_from_read_only_bridge_methods(self):
        # Deliberate: it verifies expected_revision_id and writes revision-bound
        # archives, so _execution_mutations_frozen refuses it with
        # RECOVERY_REQUIRED during execution recovery and it participates in
        # task tracking.
        self.assertNotIn("capture_evaluated_pose", connection._READ_ONLY_BRIDGE_METHODS)

    def test_the_method_participates_in_task_tracking(self):
        self.assertEqual(connection._TASK_KINDS["capture_evaluated_pose"], "pose_capture")
        descriptor, total = connection._task_descriptor(
            "capture_evaluated_pose",
            {"expected_revision_id": REVISION_ID, "pose_frames": [1, 2]},
        )
        self.assertIn("2 pose frames", descriptor)
        self.assertEqual(total, 2)

    def test_the_handshake_reports_the_capability(self):
        hello = handshake.build_hello(
            "9f8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", "0.35.0", "5.1.2"
        )
        self.assertIn("cclay.method.capture_evaluated_pose", hello["capabilities"])

    def test_the_addon_surface_mirror_matches(self):
        # apps/cclay-extension/test/addon-surface.ts mirrors the add-on method
        # list so the extension's staleness probes cannot drift; this story
        # owns both sides.
        mirror = REPOSITORY_ROOT / "apps/cclay-extension/test/addon-surface.ts"
        source = mirror.read_text(encoding="utf-8")
        block = re.search(
            r"export const BRIDGE_METHODS = \[(.*?)\];", source, re.DOTALL
        )
        self.assertIsNotNone(block, "BRIDGE_METHODS block is missing")
        mirrored = re.findall(r'"([^"]+)"', block.group(1))
        # Order is not part of the contract: the extension folds these into
        # capability strings and consumes them as a set.
        self.assertEqual(set(mirrored), set(handshake.SUPPORTED_BRIDGE_METHODS))


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class EvaluatedPoseCaptureTests(unittest.TestCase):
    """Real Blender: evaluated capture, frame restore, fail-closed modes."""

    @classmethod
    def setUpClass(cls) -> None:
        cls._directory = tempfile.TemporaryDirectory()
        cls.project = pathlib.Path(cls._directory.name)
        completed = subprocess.run(
            [
                str(BLENDER),
                "--background",
                "--factory-startup",
                "--python",
                str(SCRIPT),
                "--",
                str(cls.project),
            ],
            cwd=REPOSITORY_ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=900,
        )
        if completed.returncode != 0:
            raise AssertionError(
                f"headless Blender failed\nstdout:\n{completed.stdout}\n"
                f"stderr:\n{completed.stderr}"
            )
        lines = [
            line
            for line in completed.stdout.splitlines()
            if line.startswith("CCLAY_POSE_CAPTURE=")
        ]
        if len(lines) != 1:
            raise AssertionError(f"missing capture report\n{completed.stdout}")
        cls.results = json.loads(lines[0].split("=", 1)[1])

    @classmethod
    def tearDownClass(cls) -> None:
        directory = getattr(cls, "_directory", None)
        if directory is not None:
            directory.cleanup()

    def test_the_capture_finishes(self):
        self.assertIsNone(self.results.get("successCode"), self.results.get("successMessage"))

    def test_every_declared_scene_frame_is_captured_in_order(self):
        ids = self.results["successIds"]
        self.assertEqual(
            ids,
            [
                "cclay-pose-0123456789abcdef0123456789abcdef-1",
                "cclay-pose-0123456789abcdef0123456789abcdef-2",
                "cclay-pose-0123456789abcdef0123456789abcdef-3",
            ],
        )
        frames = [(entry["scene_frame"], entry["clip_frame"]) for entry in self.results["successResult"]["pose_frames"]]
        self.assertEqual(frames, [(1, 0), (2, 1), (3, 2)])

    def test_the_synthetic_archives_are_private_and_atomic(self):
        self.assertEqual(len(self.results["successFiles"]), 3)
        self.assertEqual(set(self.results["successFileModes"]), {"0o600"})
        self.assertEqual(self.results["successPartials"], [])

    def test_the_archives_pass_the_validator_apply_motion_uses(self):
        # inspect_motion_archive is the exact validator write_pose_source_npz
        # round-trips through, and load_motion_payload is what apply_motion
        # reads with.
        for entry in self.results["archiveChecks"]:
            self.assertEqual(entry["shape"], [[1, 27, 3, 3], [1, 27, 3]])
            self.assertEqual(entry["fps"], 20)
            self.assertEqual(entry["inspect_fps"], 20)

    def test_cskel27_y_up_and_fps_invariants_hold(self):
        # cskel27: 27 joints by construction of the shape checks above. FPS:
        # synthetic fps equals the base clip fps. Y-up: the captured frame
        # lands in the base clip's npz space -- the whole carried skeleton
        # reproduces the base clip frame within float32 noise, so the vertical
        # axis cannot have been re-mapped.
        self.assertEqual(self.results["baseFrames"], 3)
        self.assertEqual(self.results["baseFps"], 20)
        for entry in self.results["fidelity"]:
            self.assertLess(entry["carried"], NPZ_TOLERANCE)
            self.assertLess(entry["solved"], IK_RESIDUAL_BOUND)

    def test_the_evaluated_pose_is_captured_not_the_base_archive(self):
        # A keyed 0.3-unit handle drag must move the captured chain rotations
        # far beyond the IK residual; a capture that replayed the base archive
        # would report ~0 here.
        self.assertGreater(self.results["editedHandleDelta"], EVALUATED_EDIT_BOUND)

    def test_the_entered_scene_frame_is_restored_after_success(self):
        self.assertEqual(self.results["enteredBeforeSuccess"], 37)
        self.assertEqual(self.results["restoredAfterSuccess"], 37)

    def test_a_wrong_armature_fails_closed_with_no_file_written(self):
        self.assertEqual(self.results["wrongEntityCode"], "ENTITY_NOT_FOUND")
        self.assertEqual(self.results["wrongEntityFiles"], [])

    def test_a_revision_mismatch_fails_closed_before_any_frame(self):
        self.assertEqual(self.results["revisionCode"], "REVISION_MISMATCH")
        self.assertEqual(self.results["revisionFiles"], [])

    def test_a_missing_base_archive_fails_closed_with_no_file_written(self):
        # The clip names the requested motion but the npz is gone from
        # .cclay/motions: motion_basis fails closed before any frame.
        self.assertEqual(self.results["missingBaseCode"], "ConstraintCaptureError")
        self.assertEqual(self.results["missingBaseFiles"], [])

    def test_a_base_clip_mismatch_fails_closed_with_no_file_written(self):
        # The armature's applied clip is not the requested base motion: the
        # capture would bind poses to frames of a motion that is not on the
        # rig, so it is refused before any frame is evaluated.
        self.assertEqual(self.results["baseMismatchCode"], "BASE_MOTION_MISMATCH")
        self.assertEqual(self.results["baseMismatchFiles"], [])

    def test_a_bad_frame_mapping_fails_closed_with_no_file_written(self):
        self.assertEqual(self.results["badMappingCode"], "POSE_FRAME_MAPPING_INVALID")
        self.assertEqual(self.results["badMappingFiles"], [])
        self.assertEqual(self.results["restoredAfterBadMapping"], 37)

    def test_a_mid_capture_failure_rolls_back_every_archive_this_invocation_created(self):
        # The second write is forced to fail after the first archive is on
        # disk; the invocation must leave the project exactly as it found it,
        # and the finally must still restore the entered frame.
        self.assertEqual(self.results["midCaptureCode"], "ConstraintCaptureError")
        self.assertIn("simulated write failure", self.results["midCaptureMessage"])
        self.assertEqual(self.results["midCaptureFiles"], [])
        self.assertEqual(self.results["enteredBeforeMidCapture"], 37)
        self.assertEqual(self.results["restoredAfterMidCapture"], 37)

    def test_a_pre_existing_archive_is_refused_before_any_frame_and_never_deleted(self):
        # The preflight refuses the whole request when any synthetic archive
        # already exists, before a single frame is evaluated, and the rollback
        # never touches a file this invocation did not create.
        self.assertEqual(self.results["collisionCode"], "ConstraintCaptureError")
        self.assertIn("already exists", self.results["collisionMessage"])
        self.assertEqual(
            self.results["collisionFiles"],
            ["cclay-pose-55555555555555555555555555555555-1.npz"],
        )
        self.assertTrue(self.results["collisionStaleIntact"])
        self.assertEqual(self.results["enteredBeforeCollision"], 37)
        self.assertEqual(self.results["restoredAfterCollision"], 37)

    def test_a_restoration_failure_on_the_success_path_rolls_back(self):
        # The capture itself succeeds; only restoring the entered frame fails.
        # That failure is what the caller must see, and every archive the
        # capture created must be rolled back because the scene was left in a
        # state nobody asked for.
        self.assertEqual(self.results["restoreFailCode"], "RuntimeError")
        self.assertIn(
            "simulated frame restore failure", self.results["restoreFailMessage"]
        )
        self.assertEqual(self.results["restoreFailFiles"], [])
        self.assertEqual(self.results["enteredBeforeRestoreFail"], 37)
    def test_a_restore_failure_on_the_error_path_never_masks_the_primary_error(self):
        # Both the mid-loop write and the entered-frame restore fail; the
        # caller must see the ORIGINAL write failure with the restore failure
        # attached as context, not the restore error replacing it.
        self.assertEqual(self.results["combinedCode"], "ConstraintCaptureError")
        self.assertIn("simulated write failure", self.results["combinedMessage"])
        self.assertTrue(
            any(
                "scene frame restore failed" in note
                for note in self.results["combinedNotes"]
            )
        )
        self.assertEqual(self.results["combinedFiles"], [])
        self.assertEqual(self.results["enteredBeforeCombined"], 37)

    def test_a_foreign_archive_between_preflight_and_publish_is_never_touched(self):
        # The preflight passed, then a foreign actor dropped an archive at the
        # first destination before its publish. Create-only publication must
        # refuse with the collision error -- never overwrite it -- and the
        # rollback must leave the foreign file byte-identical: a file this
        # invocation did not create is never its to delete.
        self.assertEqual(
            self.results["foreignCollisionCode"], "ConstraintCaptureError"
        )
        self.assertIn("already exists", self.results["foreignCollisionMessage"])
        # The glob matches the foreign file too: it must be the ONLY archive
        # there, proving the invocation created nothing and rolled nothing
        # back.
        self.assertEqual(
            self.results["foreignCollisionFiles"],
            ["cclay-pose-99999999999999999999999999999999-1.npz"],
        )
        self.assertTrue(self.results["foreignCollisionForeignIntact"])
        self.assertEqual(self.results["enteredBeforeForeignCollision"], 37)
        self.assertEqual(self.results["restoredAfterForeignCollision"], 37)

    def test_an_exception_after_a_successful_publish_still_leaves_zero_archives(self):
        # The first archive is fully published, then the seam raises before
        # any post-hoc bookkeeping could run. The rollback set was populated
        # BEFORE the publish, so the archive is tracked and removed; a set
        # filled from the writer's return value afterwards would leave it on
        # disk, untracked and unremovable.
        self.assertEqual(self.results["postPublishCode"], "RuntimeError")
        self.assertIn(
            "simulated failure immediately after publish",
            self.results["postPublishMessage"],
        )
        self.assertEqual(self.results["postPublishFiles"], [])
        self.assertEqual(self.results["enteredBeforePostPublish"], 37)
        self.assertEqual(self.results["restoredAfterPostPublish"], 37)

    def test_a_staged_file_unlink_failure_is_context_not_a_mask(self):
        # Write #2 fails validation after staging, and removing the staged
        # file also fails. The caller must see the validation error with the
        # unlink failure attached as context, rollback must still attempt
        # every path (the surviving staged file earns its own note), and zero
        # archives may survive.
        self.assertEqual(
            self.results["stagedUnlinkCode"], "INVALID_MOTION_ARCHIVE"
        )
        self.assertIn(
            "simulated validation failure", self.results["stagedUnlinkMessage"]
        )
        self.assertTrue(
            any(
                "failed to remove staged file" in note
                for note in self.results["stagedUnlinkNotes"]
            ),
            "the staged-file unlink failure must be attached to the primary error",
        )
        self.assertTrue(
            any(
                "rollback failed to remove" in note
                for note in self.results["stagedUnlinkNotes"]
            ),
            "rollback must attempt the surviving staged file and report its failure",
        )
        self.assertEqual(self.results["stagedUnlinkFiles"], [])
        self.assertEqual(self.results["enteredBeforeStagedUnlinkFail"], 37)
        self.assertEqual(self.results["restoredAfterStagedUnlinkFail"], 37)

    def test_a_non_capture_error_before_the_link_leaves_foreign_files_alone(self):
        # The residual: a NON-ConstraintCaptureError failure (a Blender
        # evaluation error) before the link for a later frame must not let
        # the rollback delete a foreign file that appeared at a preflighted
        # destination after the preflight -- while the archive frame 1 really
        # published is still rolled back.
        self.assertEqual(self.results["evalErrorCode"], "RuntimeError")
        self.assertIn(
            "simulated evaluation failure", self.results["evalErrorMessage"]
        )
        # The glob matches the foreign file too: it must be the ONLY archive
        # there, byte-identical, proving the rollback removed this
        # invocation's archive and never touched the foreign file.
        self.assertEqual(
            self.results["evalErrorFiles"],
            ["cclay-pose-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-3.npz"],
        )
        self.assertTrue(self.results["evalErrorForeignIntact"])
        self.assertTrue(
            self.results["evalErrorLeftNotes"],
            "the ownership skip must be surfaced as context on the primary error",
        )
        self.assertEqual(self.results["enteredBeforeEvalError"], 37)
        self.assertEqual(self.results["restoredAfterEvalError"], 37)

    def test_a_foreign_staged_file_is_neither_reused_nor_deleted(self):
        # A leftover staged file from another invocation sits at the old
        # deterministic .npz.partial name. The capture must stage under its
        # own invocation-unique name (O_EXCL), publish normally, and leave
        # the foreign staged file byte-identical -- never truncate it as its
        # own staging and never delete it as its own cleanup.
        self.assertIsNone(
            self.results.get("stagedExclusiveCode"),
            self.results.get("stagedExclusiveMessage"),
        )
        self.assertEqual(
            self.results["stagedExclusiveFiles"],
            [
                "cclay-pose-cccccccccccccccccccccccccccccccc-1.npz",
                "cclay-pose-cccccccccccccccccccccccccccccccc-2.npz",
                "cclay-pose-cccccccccccccccccccccccccccccccc-3.npz",
            ],
        )
        self.assertTrue(self.results["stagedExclusiveOtherIntact"])
        # The partial set after the capture must be exactly the before-state
        # (path L's surviving staged file) plus the foreign staged file: this
        # invocation's own staged file was cleaned up and nothing else was
        # touched.
        self.assertEqual(
            self.results["stagedExclusivePartials"],
            self.results["stagedExclusiveExpectedPartials"],
        )
        self.assertEqual(self.results["enteredBeforeStagedExclusive"], 37)
        self.assertEqual(self.results["restoredAfterStagedExclusive"], 37)

    def test_an_unowned_armature_fails_closed_with_no_file_written(self):
        self.assertEqual(self.results["unownedCode"], "ENTITY_NOT_OWNED")
        self.assertEqual(self.results["unownedFiles"], [])

    def test_pre_frame_failures_leave_the_entered_frame_untouched(self):
        # The failure paths before any frame evaluation must not touch the
        # entered frame either (they raise before frame_set is ever called).
        self.assertEqual(self.results["enteredBeforeWrongEntity"], 37)
        self.assertEqual(self.results["restoredAfterWrongEntity"], 37)
        self.assertEqual(self.results["enteredBeforeBadMapping"], 37)


if __name__ == "__main__":
    unittest.main()
