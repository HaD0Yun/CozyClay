"""End-to-end: cclay.request_constraint_regeneration produces a valid request.

Runs the operator inside real Blender against a real project directory and
then checks what it left on disk, including feeding the request back through
the host's own TypeBox parser. That last step is the point: the add-on writes
the payload in Python and the director reads it in TypeScript, and nothing
else in the repo forces those two definitions to agree.

The synthetic full-body archive is verified against its own rotations. Two
pose archives already in this project have posed_joints that disagree with
their local_rot_mats by 1.4 units, and no consumer notices, so writing one
correctly is not something to take on trust.
"""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]

BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
NODE = shutil.which("node")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/regenerate_request_fixture.py"

# float32 storage noise; a pose archive whose joints were filled in without
# running forward kinematics lands seven orders of magnitude above this.
NPZ_TOLERANCE = 1e-05
# Blender's IK solve does not land exactly on the FK pose it replaced. This is
# the observed worst case over the lab's clips (5.8e-04 npz units at an elbow)
# with headroom, and it applies only to the joints the constraints drive.
IK_RESIDUAL_BOUND = 1e-03

_SEARCH_ROOTS = (
    REPOSITORY_ROOT / ".cclay" / "motions",
    Path.home() / "blenderPi" / "blender-mcp-lab" / ".cclay" / "motions",
)

_PARSE_REQUEST = """
import { parseArdyRegenerateRequest } from './packages/blender-protocol/src/ardy-regenerate.ts';
import { readFileSync } from 'node:fs';
parseArdyRegenerateRequest(JSON.parse(readFileSync(process.argv[1], 'utf8')));
console.log('PARSED_OK');
"""


def _a_real_clip():
    for root in _SEARCH_ROOTS:
        if root.is_dir():
            for path in sorted(root.glob("*.npz")):
                return path
    return None


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class RegenerateRequestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        clip = _a_real_clip()
        if clip is None:
            raise unittest.SkipTest("no .npz motion archive in this checkout")
        cls._directory = tempfile.TemporaryDirectory()
        cls.project = Path(cls._directory.name)
        completed = subprocess.run(
            [
                str(BLENDER), "--background", "--factory-startup",
                "--python", str(SCRIPT), "--", str(clip), str(cls.project),
            ],
            cwd=REPOSITORY_ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=900,
        )
        if completed.returncode != 0:
            raise AssertionError(
                f"headless Blender failed\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
        lines = [
            line
            for line in completed.stdout.splitlines()
            if line.startswith("CCLAY_REGENERATE_REQUEST=")
        ]
        if len(lines) != 1:
            raise AssertionError(f"missing operator report\n{completed.stdout}")
        cls.report = json.loads(lines[0].split("=", 1)[1])

    @classmethod
    def tearDownClass(cls) -> None:
        directory = getattr(cls, "_directory", None)
        if directory is not None:
            directory.cleanup()

    def test_the_operator_finishes(self):
        self.assertEqual(self.report["status"], ["FINISHED"])

    def test_it_writes_exactly_one_request_named_after_its_id(self):
        self.assertEqual(self.report["requestCount"], 1)
        self.assertTrue(self.report["requestFilenameMatchesId"])

    def test_the_request_is_owner_only_and_leaves_no_partial_files(self):
        self.assertEqual(self.report["requestFileMode"], "0o600")
        self.assertEqual(self.report["partialsLeft"], [])

    def test_every_marked_constraint_reaches_the_request(self):
        payload = self.report["payload"]
        self.assertEqual(
            sorted(entry["joint"] for entry in payload["effectors"]),
            ["LeftFoot", "RightHand"],
        )
        self.assertEqual(len(payload["full_body"]), 1)
        self.assertEqual(len(payload["root_2d"]), 1)

    def test_the_request_carries_the_scenes_identity_and_revision_guard(self):
        payload = self.report["payload"]
        self.assertEqual(payload["base_motion_id"], "regen-fixture-base")
        self.assertEqual(payload["entity_id"], "3f2504e0-4f89-41d3-9a0c-0305e82c3301")
        self.assertEqual(payload["expected_revision_id"], "b" * 64)
        self.assertEqual(payload["schema_version"], 1)

    def test_the_ik_layer_is_gone_once_the_request_is_published(self):
        # Constraints in the payload prove the read happened before this.
        self.assertFalse(self.report["ikLayerRemains"])
        self.assertTrue(self.report["payload"]["effectors"])

    def test_the_synthetic_pose_archive_has_the_shape_the_generator_reads(self):
        self.assertEqual(
            self.report["syntheticShape"], [[1, 27, 3, 3], [1, 27, 3]]
        )
        self.assertEqual(self.report["syntheticFps"], 20)

    def test_the_synthetic_poses_joints_match_its_own_rotations(self):
        self.assertLess(self.report["syntheticSelfConsistency"], NPZ_TOLERANCE)

    def test_the_synthetic_pose_keeps_the_untouched_joints_exactly(self):
        # Joints the IK layer does not drive are carried straight from the base
        # clip, so anything above float32 noise here is a transform bug.
        self.assertLess(self.report["syntheticCarriedJointError"], NPZ_TOLERANCE)

    def test_the_synthetic_poses_solved_joints_stay_within_the_ik_residual(self):
        # The chain joints come back through Blender's IK solve, so they carry
        # its residual instead of reproducing the clip bit for bit. Measured
        # across every clip in the lab the worst case was 5.8e-04 npz units,
        # i.e. 0.58 mm, and it was always an elbow or knee.
        self.assertLess(self.report["syntheticSolvedJointError"], IK_RESIDUAL_BOUND)

    def test_the_request_is_remembered_on_the_object_not_the_action(self):
        # The action is replaced wholesale by regeneration, so a record kept
        # on it would be destroyed by the very event it exists to survive.
        pending = self.report["pending"]
        assert pending is not None
        self.assertEqual(pending["request_id"], self.report["payload"]["request_id"])
        self.assertEqual(
            pending["marks"],
            {"FullBody": [9], "LeftFoot": [7], "RightHand": [4], "Root2D": [5]},
        )

    def test_applying_the_outcome_puts_the_ik_handles_back(self):
        self.assertEqual(self.report["applyStatus"], ["FINISHED"])
        self.assertTrue(self.report["ikLayerRestored"])
        self.assertTrue(self.report["pendingCleared"])

    def test_constraints_are_re_keyed_onto_the_regenerated_clip(self):
        marks = self.report["restoredMarks"]
        self.assertEqual(marks["RightHand"], [4])
        self.assertEqual(marks["LeftFoot"], [7])
        self.assertEqual(marks["Root2D"], [5])

    def test_a_constraint_past_the_end_of_the_new_clip_is_dropped(self):
        # The regenerated clip is 7 frames from frame 1 while the scene runs to
        # 250, and the full-body constraint sat on frame 9. Bounding by the
        # scene would restore it onto a frame the clip does not have; the next
        # collection would then read it as an out-of-range clip frame.
        self.assertEqual(self.report["restoredMarks"]["FullBody"], [])
        self.assertEqual(self.report["clipRange"], [1, 7])
        self.assertEqual(
            self.report["frameRange"],
            [1, 250],
            "scene and clip ranges must disagree or this proves nothing",
        )

    def test_the_consumed_outcome_is_not_left_behind(self):
        # Outcomes are addressed by request id, so a consumed one left on disk
        # accumulates and can be misread by a later request.
        self.assertTrue(self.report["outcomeDiscarded"])

    def test_the_new_clips_continuity_is_carried_forward_for_the_next_pass(self):
        # Stored on the object, not the action, because the action is what
        # regeneration replaces. Without it every pass is the first pass and
        # drift across repeated regenerations is invisible.
        self.assertAlmostEqual(self.report["continuityAfter"], 0.30)
        self.assertIsNotNone(
            self.report["continuityWarning"],
            "0.30m against 0.10m is past the allowance and must be reported",
        )

    @unittest.skipUnless(NODE, "node is unavailable")
    def test_the_host_schema_accepts_the_addons_request(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump(self.report["payload"], handle)
            request_path = handle.name
        try:
            completed = subprocess.run(
                [
                    NODE, "--experimental-strip-types", "--input-type=module",
                    "-e", _PARSE_REQUEST, request_path,
                ],
                cwd=REPOSITORY_ROOT,
                check=False,
                capture_output=True,
                text=True,
                timeout=180,
            )
        finally:
            Path(request_path).unlink(missing_ok=True)
        self.assertIn(
            "PARSED_OK",
            completed.stdout,
            f"host schema rejected the add-on request\n{completed.stdout}\n{completed.stderr}",
        )


if __name__ == "__main__":
    unittest.main()
