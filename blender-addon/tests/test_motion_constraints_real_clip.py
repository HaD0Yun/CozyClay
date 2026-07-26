"""Check the cskel27 parent table against real ARDY clips when any are present.

The pure tests in ``test_motion_constraints`` lock the FK mechanism against a
hand-composed chain, but the parent table itself is a claim about ARDY's
skeleton, and only ARDY's own output can settle it: deriving the constant bone
offsets from one frame and running FK over every other frame has to reproduce
the clip's own ``posed_joints``. A wrong parent moves that error from float32
noise to whole npz units immediately.

No npz is committed (they are megabytes of generated motion), so this scans the
project motion directories that a working CozyClay checkout accumulates. When
none exist the check reports that it found nothing rather than pretending to
have verified anything -- see ``test_reports_when_no_clip_was_available``.

Some npz files under those directories are hand-authored pose sources rather
than generated clips, and their ``posed_joints`` do NOT agree with their own
``local_rot_mats`` (measured: offsets vary by 1.4 npz units across frames on
one such file). Those are skipped by the offset-constancy pre-check, which is a
property of the file, not of the parent table.
"""

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))

from cclay import motion_constraints  # noqa: E402
from cclay.motion_retarget import CSKEL27_JOINTS  # noqa: E402

try:
    import numpy
except ImportError:  # pragma: no cover - host interpreters without numpy
    numpy = None

# Generated clips agree with their own rotations to float32 serialization
# noise; the worst measured across three unrelated ARDY clips was 4.5e-07.
FK_TOLERANCE = 1e-05
# A hand-authored pose source drifts by ~1.4 npz units here, three orders of
# magnitude above the 5.8e-07 seen on generated clips, so this separates the
# two without being sensitive to the exact clip.
OFFSET_CONSTANCY_TOLERANCE = 1e-03

_SEARCH_ROOTS = (
    pathlib.Path(__file__).parents[2] / ".cclay" / "motions",
    pathlib.Path.home() / "blenderPi" / "blender-mcp-lab" / ".cclay" / "motions",
)


def _candidate_clips(limit: int = 3):
    found = []
    for root in _SEARCH_ROOTS:
        if not root.is_dir():
            continue
        found.extend(sorted(root.glob("*.npz")))
    return found[:limit] if limit is None else found


def _offset_constancy(local_rot_mats, posed_joints, offsets, samples: int = 8):
    """Largest drift of a derived offset away from the reference frame's."""
    frames = len(local_rot_mats)
    worst = 0.0
    step = max(1, frames // samples)
    for frame in range(0, frames, step):
        derived = motion_constraints.derive_bone_offsets(
            [[list(row) for row in joint] for joint in local_rot_mats[frame]],
            [list(position) for position in posed_joints[frame]],
        )
        for index, parent in enumerate(motion_constraints.CSKEL27_PARENTS):
            if parent is None:
                continue
            for axis in range(3):
                worst = max(worst, abs(derived[index][axis] - offsets[index][axis]))
    return worst


@unittest.skipIf(numpy is None, "numpy is unavailable in this interpreter")
class RealClipForwardKinematicsTests(unittest.TestCase):
    def _load(self, path):
        data = numpy.load(path)
        return data["local_rot_mats"], data["posed_joints"]

    def test_reproduces_posed_joints_on_every_generated_clip_found(self):
        clips = _candidate_clips()
        if not clips:
            self.skipTest("no .npz motion archives in this checkout")
        checked = 0
        for path in clips:
            local_rot_mats, posed_joints = self._load(path)
            if posed_joints.shape[1] != len(CSKEL27_JOINTS):
                continue
            reference = [
                [list(row) for row in joint] for joint in local_rot_mats[0]
            ]
            offsets = motion_constraints.derive_bone_offsets(
                reference, [list(position) for position in posed_joints[0]]
            )
            if _offset_constancy(local_rot_mats, posed_joints, offsets) > (
                OFFSET_CONSTANCY_TOLERANCE
            ):
                # A hand-authored pose source, not a generated clip.
                continue
            checked += 1
            for frame in range(0, len(local_rot_mats), max(1, len(local_rot_mats) // 8)):
                predicted = motion_constraints.forward_kinematics(
                    [[list(row) for row in joint] for joint in local_rot_mats[frame]],
                    offsets,
                    list(posed_joints[frame][0]),
                )
                for index, name in enumerate(CSKEL27_JOINTS):
                    distance = sum(
                        (predicted[index][axis] - float(posed_joints[frame][index][axis])) ** 2
                        for axis in range(3)
                    ) ** 0.5
                    self.assertLess(
                        distance,
                        FK_TOLERANCE,
                        f"{path.name} frame {frame} joint {name}: {distance}",
                    )
        if checked == 0:
            self.skipTest("no generated clips among the archives found")

    def test_reports_when_no_clip_was_available(self):
        """Make the absence of evidence visible instead of silently green."""
        clips = _candidate_clips()
        if clips:
            self.assertTrue(all(path.suffix == ".npz" for path in clips))
        else:
            self.skipTest("no .npz motion archives in this checkout")


if __name__ == "__main__":
    unittest.main()
