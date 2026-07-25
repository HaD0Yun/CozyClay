"""Bundled Y-Bot/X-Bot character import through the stage_scene transaction."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))

from cclay.stage_scene import (
    StageSceneValidationError,
    _ADAPTIVE_QUALIFIED,
    _channelbag_has_unique_owner,
    _StageSceneRun,
    _curve_inventory_matches,
    _keyframe_points_snapshot,
    _import_character_fbx,
    _new_grouped_fcurve,
    _motion_keyframe_mode,
    parse_stage_scene_plan,
)

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/stage_scene_character_fixture.py"


def _plan(operations):
    return {
        "schema_version": 1,
        "expected_revision_id": "a" * 64,
        "operations": operations,
    }


def _character(**overrides):
    operation = {
        "op": "add_character",
        "entity_id": "11111111-1111-4111-8111-111111111111",
        "character_type": "Y_BOT",
        "name": "Fighter One",
        "location": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
    }
    operation.update(overrides)
    return operation


class AddCharacterValidationTests(unittest.TestCase):
    def test_accepts_both_bundled_character_types(self):
        for character_type in ("Y_BOT", "X_BOT"):
            with self.subTest(character_type=character_type):
                parse_stage_scene_plan(
                    _plan([_character(character_type=character_type)])
                )

    def test_rejects_unknown_character_type(self):
        with self.assertRaises(StageSceneValidationError) as caught:
            parse_stage_scene_plan(_plan([_character(character_type="Z_BOT")]))
        self.assertIn("character_type", str(caught.exception))

    def test_rejects_extra_keys_and_duplicate_identity(self):
        with self.assertRaises(StageSceneValidationError):
            parse_stage_scene_plan(_plan([_character(parent_id=None)]))
        duplicated = _plan([_character(), _character()])
        with self.assertRaises(StageSceneValidationError) as caught:
            parse_stage_scene_plan(duplicated)
        self.assertEqual(caught.exception.code, "STAGE_SCENE_ENTITY_ID_DUPLICATE")

    def test_release_one_mode_gate_rejects_adaptive_and_unknown_modes(self):
        self.assertFalse(_ADAPTIVE_QUALIFIED)
        with mock.patch.dict(
            "os.environ", {"CCLAY_MOTION_KEYFRAME_MODE": "bulk_dense"}, clear=False
        ):
            self.assertEqual(_motion_keyframe_mode(), "bulk_dense")
        for mode in ("qualified_adaptive", "per_key", ""):
            with self.subTest(mode=mode), mock.patch.dict(
                "os.environ", {"CCLAY_MOTION_KEYFRAME_MODE": mode}, clear=False
            ):
                with self.assertRaisesRegex(
                    RuntimeError, "^MOTION_KEYFRAME_MODE_DISABLED$"
                ):
                    _motion_keyframe_mode()

    def test_curve_inventory_allows_only_tight_value_serialization_drift(self):
        key = ('pose.bones["Hips"].location', 0)
        expected = {key: ("Hips", [1.0, 2.0], [0.125, -0.375])}
        within_float32_drift = {
            key: ("Hips", [1.0, 2.0], [0.12500003, -0.37500003])
        }
        self.assertTrue(
            _curve_inventory_matches(within_float32_drift, expected)
        )
        outside_tolerance = {
            key: ("Hips", [1.0, 2.0], [0.12501, -0.375])
        }
        self.assertFalse(_curve_inventory_matches(outside_tolerance, expected))

    def test_curve_inventory_rejects_topology_group_count_and_frame_corruption(self):
        key = ('pose.bones["Hips"].location', 0)
        expected = {key: ("Hips", [1.0, 2.0], [0.125, -0.375])}
        corruptions = {
            "inventory": {
                ('pose.bones["Hips"].location', 1):
                    ("Hips", [1.0, 2.0], [0.125, -0.375])
            },
            "group": {key: ("Pelvis", [1.0, 2.0], [0.125, -0.375])},
            "count": {key: ("Hips", [1.0, 2.0], [0.125])},
            "frame": {key: ("Hips", [1.0, 2.25], [0.125, -0.375])},
        }
        for corruption, actual in corruptions.items():
            with self.subTest(corruption=corruption):
                self.assertFalse(_curve_inventory_matches(actual, expected))

    def test_channelbag_ownership_deduplicates_distinct_rna_wrappers(self):
        class Bag:
            def __init__(self, slot_handle, pointer):
                self.slot_handle = slot_handle
                self.pointer = pointer

            def as_pointer(self):
                return self.pointer

        channelbag = Bag(7, 101)
        alternate_wrapper = Bag(7, 101)
        self.assertTrue(
            _channelbag_has_unique_owner(
                channelbag, 7, [[channelbag, alternate_wrapper]]
            )
        )

    def test_channelbag_ownership_rejects_ambiguous_or_missing_topology(self):
        class Bag:
            def __init__(self, slot_handle, pointer):
                self.slot_handle = slot_handle
                self.pointer = pointer

            def as_pointer(self):
                return self.pointer

        channelbag = Bag(7, 101)
        same_pointer_wrapper = Bag(7, 101)
        other_owner = Bag(7, 202)
        cases = {
            "missing": [[]],
            "wrong_slot": [[Bag(8, 101)]],
            "different_duplicate": [[channelbag, other_owner]],
            "multiple_strips": [[channelbag], [same_pointer_wrapper]],
        }
        for case, locations in cases.items():
            with self.subTest(case=case):
                self.assertFalse(
                    _channelbag_has_unique_owner(channelbag, 7, locations)
                )

    def test_recovery_retries_rollback_after_pre_durable_failure(self):
        calls = []

        class Transaction:
            def rollback(self):
                calls.append("rollback")

            def finalize_deletions(self):
                calls.append("finalize")

            def finalize_orphan_actions(self):
                calls.append("actions")

        run = _StageSceneRun.__new__(_StageSceneRun)
        run.transaction = Transaction()
        run.recovery_direction = "ROLLBACK"
        run.before_manifest = {"sceneHash": "before"}
        run.candidate_manifest = {"sceneHash": "after"}
        with mock.patch(
            "cclay.stage_scene._live_base_manifest",
            return_value={"sceneHash": "before"},
        ):
            self.assertTrue(run._recover())
        self.assertEqual(calls, ["rollback"])

    def test_recovery_is_forward_only_after_durable_boundary(self):
        calls = []

        class Transaction:
            def rollback(self):
                calls.append("rollback")

            def finalize_deletions(self):
                calls.append("finalize")

            def finalize_orphan_actions(self):
                calls.append("actions")

        run = _StageSceneRun.__new__(_StageSceneRun)
        run.transaction = Transaction()
        run.recovery_direction = "FORWARD"
        run.before_manifest = {"sceneHash": "before"}
        run.candidate_manifest = {"sceneHash": "after"}
        with mock.patch(
            "cclay.stage_scene._live_base_manifest",
            return_value={"sceneHash": "after"},
        ):
            self.assertTrue(run._recover())
        self.assertEqual(calls, ["finalize", "actions"])

    def test_keyframe_snapshot_uses_bulk_foreach_get(self):
        bulk_values = {
            "interpolation": 1,
            "easing": 2,
            "handle_left_type": 3,
            "handle_right_type": 3,
            "back": 0.0,
            "amplitude": 0.0,
            "period": 0.0,
        }
        fields = {
            "co": [1.0, 0.25, 2.0, -0.5],
            "handle_left": [0.8, 0.25, 1.8, -0.5],
            "handle_right": [1.2, 0.25, 2.2, -0.5],
            "interpolation": [1, 1],
            "easing": [2, 2],
            "handle_left_type": [3, 3],
            "handle_right_type": [3, 3],
            "back": [0.0, 0.0],
            "amplitude": [0.0, 0.0],
            "period": [0.0, 0.0],
        }

        class BulkPoints:
            def __len__(self):
                return 2

            def __iter__(self):
                raise AssertionError("bulk path must not iterate point wrappers")

            def foreach_get(self, name, destination):
                destination[:] = fields[name]

        frames, values, valid, used_bulk = _keyframe_points_snapshot(
            BulkPoints(), bulk_values
        )
        self.assertTrue(used_bulk)
        self.assertTrue(valid)
        self.assertEqual(frames, [1.0, 2.0])
        self.assertEqual(values, [0.25, -0.5])

    def test_keyframe_snapshot_falls_back_for_non_rna_test_doubles(self):
        bulk_values = {
            "back": 0.0, "amplitude": 0.0, "period": 0.0,
        }

        class Vector:
            def __init__(self, x, y):
                self.x = x
                self.y = y

        class Point:
            interpolation = "BEZIER"
            easing = "AUTO"
            handle_left_type = "AUTO_CLAMPED"
            handle_right_type = "AUTO_CLAMPED"
            back = 0.0
            amplitude = 0.0
            period = 0.0

            def __init__(self, frame, value):
                self.co = Vector(frame, value)
                self.handle_left = Vector(frame - 0.1, value)
                self.handle_right = Vector(frame + 0.1, value)

        frames, values, valid, used_bulk = _keyframe_points_snapshot(
            [Point(1.0, 0.25), Point(2.0, -0.5)], bulk_values
        )
        self.assertFalse(used_bulk)
        self.assertTrue(valid)
        self.assertEqual(frames, [1.0, 2.0])
        self.assertEqual(values, [0.25, -0.5])

    def test_fbx_import_prefers_blender_5_operator(self):
        calls = []
        operators = mock.Mock()
        operators.wm.fbx_import = lambda **kwargs: calls.append(("modern", kwargs))
        operators.import_scene.fbx = lambda **kwargs: calls.append(
            ("legacy", kwargs)
        )
        _import_character_fbx(operators, "/asset.fbx")
        self.assertEqual(
            calls, [("modern", {"filepath": "/asset.fbx"})]
        )

    def test_fbx_import_falls_back_when_dynamic_modern_wrapper_is_missing(self):
        calls = []

        class Namespace:
            pass

        def missing_modern(**_kwargs):
            calls.append(("modern_missing", {}))
            raise AttributeError("Calling operator wm.fbx_import error, could not be found")

        operators = Namespace()
        operators.wm = Namespace()
        operators.wm.fbx_import = missing_modern
        operators.import_scene = Namespace()
        operators.import_scene.fbx = lambda **kwargs: calls.append(
            ("legacy", kwargs)
        )
        _import_character_fbx(operators, "/asset.fbx")
        self.assertEqual(
            calls,
            [
                ("modern_missing", {}),
                ("legacy", {"filepath": "/asset.fbx"}),
            ],
        )

    def test_fbx_import_rejects_two_missing_dynamic_wrappers_stably(self):
        class Namespace:
            pass

        def missing(**_kwargs):
            raise AttributeError("operator could not be found")

        operators = Namespace()
        operators.wm = Namespace()
        operators.wm.fbx_import = missing
        operators.import_scene = Namespace()
        operators.import_scene.fbx = missing
        with self.assertRaisesRegex(
            RuntimeError,
            "^CHARACTER_IMPORT_UNSUPPORTED: Blender FBX import operator is unavailable$",
        ) as caught:
            _import_character_fbx(operators, "/asset.fbx")
        self.assertIsInstance(caught.exception.__cause__, AttributeError)

    def test_fbx_import_does_not_mask_real_runtime_failure(self):
        class Namespace:
            pass

        def failed(**_kwargs):
            raise RuntimeError("FBX parse failed")

        operators = Namespace()
        operators.wm = Namespace()
        operators.wm.fbx_import = failed
        with self.assertRaisesRegex(RuntimeError, "^FBX parse failed$"):
            _import_character_fbx(operators, "/asset.fbx")

    def test_grouped_fcurve_prefers_blender_5_signature(self):
        group = object()
        fcurve = mock.Mock()
        fcurves = mock.Mock()
        fcurves.new.return_value = fcurve
        channelbag = mock.Mock(fcurves=fcurves)
        result = _new_grouped_fcurve(
            channelbag, "pose.path", 2, "Spine"
        )
        self.assertIs(result, fcurve)
        fcurves.new.assert_called_once_with(
            "pose.path", index=2, group_name="Spine"
        )
        self.assertIsNot(fcurve.group, group)

    def test_grouped_fcurve_uses_and_reuses_blender_44_group(self):
        group = object()
        fcurve = mock.Mock()
        calls = []

        class FCurves:
            def new(self, data_path, **kwargs):
                calls.append((data_path, kwargs))
                if "group_name" in kwargs:
                    raise TypeError(
                        "new(): keyword argument 'group_name' unrecognized"
                    )
                return fcurve

            def remove(self, value):
                calls.append(("remove", value))

        groups = mock.Mock()
        groups.get.return_value = group
        channelbag = mock.Mock(fcurves=FCurves(), groups=groups)
        result = _new_grouped_fcurve(
            channelbag, "pose.path", 2, "Spine"
        )
        self.assertIs(result, fcurve)
        self.assertIs(fcurve.group, group)
        groups.get.assert_called_once_with("Spine")
        groups.new.assert_not_called()

    def test_grouped_fcurve_creates_group_and_cleans_up_on_assignment_failure(self):
        removed = []

        class BrokenCurve:
            @property
            def group(self):
                return None

            @group.setter
            def group(self, _value):
                raise RuntimeError("group assignment failed")

        fcurve = BrokenCurve()

        class FCurves:
            def new(self, _data_path, **kwargs):
                if "group_name" in kwargs:
                    raise TypeError(
                        "new(): keyword argument 'group_name' unrecognized"
                    )
                return fcurve

            def remove(self, value):
                removed.append(value)

        groups = mock.Mock()
        groups.get.return_value = None
        created_group = object()
        groups.new.return_value = created_group
        channelbag = mock.Mock(fcurves=FCurves(), groups=groups)
        with self.assertRaisesRegex(RuntimeError, "group assignment failed"):
            _new_grouped_fcurve(channelbag, "pose.path", 2, "Spine")
        groups.new.assert_called_once_with("Spine")
        self.assertEqual(removed, [fcurve])

    def test_grouped_fcurve_does_not_mask_unrelated_type_error(self):
        fcurves = mock.Mock()
        fcurves.new.side_effect = TypeError("invalid data_path type")
        channelbag = mock.Mock(fcurves=fcurves)
        with self.assertRaisesRegex(TypeError, "invalid data_path type"):
            _new_grouped_fcurve(channelbag, "pose.path", 2, "Spine")
        self.assertEqual(fcurves.new.call_count, 1)


    def test_terminal_error_code_is_null_only_without_error(self):
        run = _StageSceneRun.__new__(_StageSceneRun)
        run.error = None
        self.assertIsNone(run._error_code())
        run.error = RuntimeError("fault")
        self.assertEqual(run._error_code(), "STAGE_SCENE_FAILED")

    def test_fixture_honors_seeded_benchmark_starting_order(self):
        source = SCRIPT.read_text(encoding="utf-8")
        self.assertIn(
            'os.environ.get("CCLAY_BENCHMARK_WRITER_ORDER", "bulk_first")',
            source,
        )
        self.assertIn('if value == "legacy_first":', source)
        self.assertIn("for writer in starting_writer_order:", source)


    def test_terminal_rss_failure_cannot_suppress_log_callback_or_timing(self):
        run = _StageSceneRun.__new__(_StageSceneRun)
        run.phase = "CHECKPOINT_RELEASE"
        run.done = False
        run.rss_baseline = 1
        run.rss_high_water = 1
        run.max_scheduled_step_ms = 1.0
        run._active_step_started = 10.0
        calls = []
        run._emit_log = lambda outcome: calls.append(("log", outcome))
        run._callback = lambda: calls.append("callback")
        with (
            mock.patch(
                "cclay.stage_scene._current_rss_bytes",
                side_effect=RuntimeError("rss unavailable"),
            ),
            mock.patch(
                "cclay.stage_scene.time.monotonic",
                return_value=10.125,
            ),
        ):
            run._finish_success()
        self.assertEqual(calls, [("log", "SUCCESS"), "callback"])
        self.assertEqual(run.max_scheduled_step_ms, 125.0)

    def test_terminal_rss_sampling_is_non_enforcing(self):
        run = _StageSceneRun.__new__(_StageSceneRun)
        run.rss_baseline = 1
        run.rss_high_water = 1
        with mock.patch(
            "cclay.stage_scene._current_rss_bytes",
            side_effect=RuntimeError("rss unavailable"),
        ):
            run._sample_terminal_rss()
        self.assertEqual(run.rss_high_water, 1)

    def test_recovery_measurement_updates_over_limit_rss_without_rethrowing(self):
        run = _StageSceneRun.__new__(_StageSceneRun)
        run.rss_baseline = 100
        run.rss_high_water = 600 * 1024 * 1024
        run.longest_rna_call_ms = 0.0
        calls = []
        with (
            mock.patch(
                "cclay.stage_scene._current_rss_bytes",
                return_value=700 * 1024 * 1024,
            ),
            mock.patch(
                "cclay.stage_scene.time.monotonic",
                side_effect=[10.0, 10.01],
            ),
        ):
            result = run._measure_recovery(
                lambda: calls.append("rollback") or "recovered"
            )
        self.assertEqual(result, "recovered")
        self.assertEqual(calls, ["rollback"])
        self.assertEqual(run.rss_high_water, 700 * 1024 * 1024)
        self.assertAlmostEqual(run.longest_rna_call_ms, 10.0, delta=1e-9)

    def test_state_machine_verifies_commit_before_checkpoint_release(self):
        source = (
            Path(__file__).parents[1]
            / "cclay" / "stage_scene.py"
        ).read_text(encoding="utf-8")
        verify = source.index('elif self.phase == "POST_COMMIT_VERIFY":')
        release = source.index('elif self.phase == "CHECKPOINT_RELEASE":')
        self.assertLess(verify, release)
        self.assertIn("STAGE_SCENE_COMMITTED_HASH_MISMATCH", source[verify:release])


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class AddCharacterRealBlenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        completed = subprocess.run(
            [str(BLENDER), "--background", "--factory-startup", "--python", str(SCRIPT)],
            cwd=REPOSITORY_ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=180,
        )
        if completed.returncode != 0:
            raise AssertionError(
                f"headless Blender failed\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
        lines = [
            line
            for line in completed.stdout.splitlines()
            if line.startswith("CCLAY_STAGE_CHARACTER_RESULTS=")
        ]
        if len(lines) != 1:
            raise AssertionError(f"missing character results\n{completed.stdout}")
        cls.results = json.loads(lines[0].split("=", 1)[1])
        cls.motion_receipts = []
        for line in completed.stdout.splitlines():
            if not line.startswith("{"):
                continue
            try:
                receipt = json.loads(line)
            except json.JSONDecodeError:
                continue
            if receipt.get("schema") == "cclay.stage_scene_motion.v2":
                cls.motion_receipts.append((line, receipt))

    def test_captures_bounded_successful_v2_motion_receipt(self):
        successful = [
            (line, receipt)
            for line, receipt in self.motion_receipts
            if receipt.get("outcome") == "SUCCESS"
        ]
        self.assertTrue(successful)
        line, receipt = successful[0]
        self.assertLessEqual(len(line.encode("utf-8")), 4096)
        self.assertEqual(receipt["report_version"], 2)
        self.assertEqual(
            receipt["qualification_version"], "ardy-adaptive-v1"
        )
        self.assertIsNone(receipt["error_code"])
        for field in (
            "terminal_phase", "error_code", "mode", "effective_mode",
            "action_api", "motion_count", "completed_motion_count",
            "dense_motion_count", "optimized_motion_count",
            "fallback_motion_count", "source_frames", "source_points",
            "kept_points", "curve_count", "protected_reason_counts",
            "timings_ms", "rss_delta_bytes",
            "longest_uninterruptible_call_ms", "max_scheduled_step_ms",
            "max_heartbeat_gap_ms", "cancellation_latency_ms",
        ):
            with self.subTest(field=field):
                self.assertIn(field, receipt)
        self.assertLessEqual(receipt["source_frames"], 6_144_000)
        self.assertLessEqual(receipt["source_points"], 608_256_000)
        self.assertLessEqual(receipt["curve_count"], 66_304)

    def test_imports_owned_armature_roots_with_composed_transform(self):
        self.assertTrue(self.results["rootsAreArmatures"])
        self.assertTrue(self.results["rootNames"])
        self.assertTrue(self.results["rootLocation"])
        self.assertTrue(self.results["importScalePreserved"])
        self.assertTrue(self.results["characterTypeTagged"])

    def test_children_are_owned_with_deterministic_uuid4_ids(self):
        self.assertTrue(self.results["childrenExist"])
        self.assertTrue(self.results["childrenOwned"])
        self.assertTrue(self.results["childIdsDeterministic"])

    def test_manifest_tracks_armatures_and_bones(self):
        self.assertTrue(self.results["manifestHasArmatures"])
        self.assertTrue(self.results["manifestBonesPopulated"])
        self.assertTrue(self.results["committed"])
        self.assertTrue(self.results["identityCoversCharacters"])
        self.assertTrue(self.results["checkpointReleased"])

    def test_duplicate_stable_name_rolls_back_cleanly(self):
        self.assertEqual(self.results["dupeNameCode"], "STAGE_SCENE_STABLE_NAME_EXISTS")
        self.assertTrue(self.results["dupeRollback"])
        self.assertTrue(self.results["dupeCheckpointReleased"])

    def test_creates_and_activates_a_typed_camera(self):
        self.assertTrue(self.results["cameraCreatedAndActive"])
        self.assertTrue(self.results["cameraIdentityReturned"])
        self.assertTrue(self.results["cameraRollback"])

    def test_apply_motion_result_is_immediately_inspectable(self):
        self.assertTrue(self.results["motionKeysNormalized"])
        self.assertTrue(self.results["motionSnapshotInspectable"])

    def test_apply_motion_completes_missing_fingers(self):
        self.assertTrue(self.results["relaxedFingerCompletion"])
        self.assertTrue(self.results["openFingerOverride"])
        self.assertTrue(self.results["completeHandInventory"])
        self.assertTrue(self.results["defaultAppliedHandShapes"])
        self.assertTrue(self.results["asymmetricHandShapes"])
        self.assertTrue(self.results["handShapeLibraryVersion"])
        self.assertTrue(self.results["handKeyBudgetAndInterpolation"])
        self.assertTrue(self.results["postApplyRollbackRaised"])
        self.assertTrue(self.results["postApplyRollbackComplete"])

    def test_pose_contact_samples_distinguish_joint_from_deformed_sole(self):
        """Issue #2 item D: a frame-specific pose-contact sample must carry the
        skeleton joint and the deformed-mesh sole surface as distinct values,
        never conflate them, and fail closed when it cannot resolve one.
        """
        self.assertTrue(self.results["poseContactFrameOrder"])
        self.assertTrue(self.results["poseContactRestoresCurrentFrame"])
        self.assertTrue(self.results["poseContactHasBothSides"])
        self.assertTrue(self.results["poseContactJointAndSoleDiffer"])
        self.assertTrue(self.results["poseContactHeelToeVectorResolved"])
        self.assertTrue(self.results["poseContactDeformedFalseWithholdsSurfaceEvidence"])
        self.assertTrue(self.results["poseContactRejectsNonArmatureEntity"])
        self.assertTrue(self.results["poseContactRejectsUnknownEntity"])
        self.assertTrue(self.results["poseContactRejectsEmptyFrames"])

    def test_pose_contacts_bridge_runs_end_to_end_under_real_blender(self):
        """Issue #2 item D: the callable bridge -- ``collect_pose_contacts``,
        not only the pure geometry helpers -- must run under real Blender
        against a real declared support mesh and return a payload matching
        the exact closed public schema shape, with scene frames validated
        (never silently clamped) and missing/non-armature entities mapped to
        the public error contract.
        """
        self.assertTrue(self.results["poseContactsBridgeRestoresCurrentFrame"])
        self.assertTrue(self.results["poseContactsBridgeResultShape"])
        self.assertTrue(self.results["poseContactsBridgeFrameOrder"])
        self.assertTrue(self.results["poseContactsBridgeSideShape"])
        self.assertTrue(self.results["poseContactsBridgeBothJointsPresent"])
        self.assertTrue(self.results["poseContactsBridgeDeformedSoleEvidence"])
        self.assertTrue(self.results["poseContactsBridgeSupportFitPresent"])
        # The gate verdict must agree with the measured formula -- never a
        # fixed/guessed pass, since the fixture pose is not planted on the
        # support.
        self.assertTrue(self.results["poseContactsBridgeVerdictMatchesGateFormula"])
        self.assertTrue(self.results["poseContactsBridgeSignedGapAndFootprintEmitted"])
        self.assertTrue(self.results["poseContactsBridgeOutOfRangeFrameRejected"])
        self.assertTrue(
            self.results["poseContactsBridgeFrameRestoredAfterOutOfRangeFailure"]
        )
        self.assertTrue(self.results["poseContactsBridgeNonArmatureRejected"])
        self.assertTrue(self.results["poseContactsBridgeUnknownEntityRejected"])

    def test_apply_motion_bakes_a_mid_clip_hand_track(self):
        self.assertTrue(self.results["handTrackKeysAtClipFrames"])
        self.assertTrue(self.results["handTrackUntrackedSideStaysConstant"])
        self.assertTrue(self.results["handTrackResolvedState"])
        self.assertTrue(self.results["handTrackActuallyAnimates"])
        self.assertTrue(self.results["handTrackOutOfRangeRejected"])

    def test_motion_fps_conflict_is_rejected_for_every_disagreement(self):
        """One frame rate per plan, independent of operation order.

        The two-motion row is the case a per-operation check could never see:
        with no fps named anywhere, each motion agrees with "nothing
        requested", so the scene used to end at whichever ran last while the
        other clip played at the wrong rate.
        """
        self.assertTrue(self.results["fpsConflictRejectedRenderFirst"])
        self.assertTrue(self.results["fpsConflictRejectedMotionFirst"])
        self.assertTrue(self.results["fpsConflictRejectedTwoMotions"])

    def test_manifest_ignores_only_inert_easing_parameters(self):
        self.assertTrue(self.results["inertEasingFieldsRemainInspectable"])
        self.assertTrue(self.results["relevantEasingFieldRejected"])

    def test_bulk_dense_writer_uses_layered_slot_topology(self):
        self.assertTrue(self.results["denseWriterExactInventory"])
        self.assertTrue(self.results["denseWriterLayeredTopology"])

    def test_bulk_dense_writer_matches_legacy_bezier_authoring(self):
        self.assertTrue(self.results["denseWriterBezierKeyParity"])
        self.assertTrue(self.results["denseWriterBezierEvaluationParity"])
        self.assertTrue(self.results["denseWriterCompleteCurveParity"])

    def test_bulk_dense_writer_emits_a_measurable_benchmark_receipt(self):
        receipt = self.results["denseWriterBenchmarkReceipt"]
        self.assertEqual(receipt["curves"], 99)
        self.assertEqual(receipt["points"], 23760)
        self.assertEqual(receipt["legacyCurves"], 99)
        self.assertEqual(receipt["legacyPoints"], 23760)
        self.assertEqual(receipt["writerOrder"], "bulk_first")
        self.assertGreater(receipt["elapsedMs"], 0)
        self.assertEqual(len(receipt["legacyRunsMs"]), 1)
        self.assertEqual(len(receipt["bulkRunsMs"]), 1)
        self.assertTrue(all(value > 0 for value in receipt["legacyRunsMs"]))
        self.assertTrue(all(value > 0 for value in receipt["bulkRunsMs"]))
        self.assertGreater(receipt["legacyMedianMs"], 0)
        self.assertGreater(receipt["bulkMedianMs"], 0)
        self.assertEqual(
            receipt["legacyMedianMs"], receipt["legacyRunsMs"][0]
        )
        self.assertEqual(
            receipt["bulkMedianMs"], receipt["bulkRunsMs"][0]
        )
        self.assertGreaterEqual(receipt["speedup"], 5.0)
        self.assertTrue(self.results["denseWriterPerformanceImproved"])
        self.assertTrue(self.results["denseWriterTemporaryActionsRemoved"])
        self.assertTrue(self.results["denseWriterTerminalReceiptExact"])
        self.assertTrue(self.results["repeatedMotionNoIntermediateActionLeak"])

    def test_motion_rollback_restores_every_captured_pose_channel(self):
        self.assertTrue(self.results["postApplyRollbackFullPoseRestored"])

    def test_post_commit_failure_requires_forward_reconciliation(self):
        self.assertTrue(self.results["postCommitFailureRaisedReconciliation"])
        self.assertTrue(self.results["postCommitFailureDidNotRollback"])
        self.assertTrue(self.results["postCommitCheckpointRetainedUntilReconciled"])

    def test_pre_durable_faults_retain_recovery_evidence(self):
        self.assertTrue(self.results["preDurableFaultBoundaries"])
        for receipt in (
            "rollbackFailureRaisedReconciliation",
            "rollbackFailureRetainedCheckpoint",
            "baseHashMismatchRaisedReconciliation",
            "baseHashMismatchRetainedCheckpoint",
            "preCommitReleaseFailureRaisedReconciliation",
            "preCommitReleaseFailureRetainedCheckpoint",
        ):
            with self.subTest(receipt=receipt):
                self.assertTrue(self.results[receipt])
