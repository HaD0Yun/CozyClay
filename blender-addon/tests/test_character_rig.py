"""Pure-python tests for CharacterRigAdapter's Mixamo bone lookups."""

import math
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))

from cclay.character_rig import CharacterRigAdapter


class _Vector:
    def __init__(self, values):
        self._values = tuple(values)

    def __sub__(self, other):
        return _Vector(a - b for a, b in zip(self._values, other._values))

    @property
    def length(self):
        return math.sqrt(sum(value * value for value in self._values))

    def __iter__(self):
        return iter(self._values)


class _Matrix:
    def __init__(self, rows):
        self._rows = tuple(tuple(row) for row in rows)

    def to_3x3(self):
        return self._rows


class _Bone:
    def __init__(self, name, head=(0.0, 0.0, 0.0), matrix=None):
        self.name = name
        self.head_local = _Vector(head)
        self.matrix_local = _Matrix(
            matrix
            if matrix is not None
            else ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))
        )


class _Bones(dict):
    """Minimal Blender bone collection double: iteration yields bones, not names."""

    def __iter__(self):
        return iter(self.values())


def _name(prefix, bone):
    return f"{prefix}{bone}"


def _bones(*bones):
    return _Bones({bone.name: bone for bone in bones})


class CharacterRigAdapterTests(unittest.TestCase):
    def test_detects_prefix_and_measures_right_thigh(self):
        for prefix in ("", "mixamorig:"):
            with self.subTest(prefix=prefix or "unprefixed"):
                upper = _Bone(_name(prefix, "RightUpLeg"), head=(1.0, 5.0, 2.0))
                lower = _Bone(_name(prefix, "RightLeg"), head=(4.0, 1.0, 2.0))
                adapter = CharacterRigAdapter(_bones(upper, lower))

                self.assertEqual(adapter.prefix, prefix)
                self.assertAlmostEqual(adapter.rig_thigh, 5.0)

    def test_returns_no_thigh_when_either_required_bone_is_missing(self):
        for prefix in ("", "mixamorig:"):
            for missing in ("RightUpLeg", "RightLeg"):
                with self.subTest(prefix=prefix or "unprefixed", missing=missing):
                    names = {"RightUpLeg", "RightLeg"} - {missing}
                    bones = _bones(
                        _Bone(_name(prefix, "Hips")),
                        *(_Bone(_name(prefix, name)) for name in names),
                    )

                    self.assertIsNone(CharacterRigAdapter(bones).rig_thigh)

    def test_collects_available_rest_rotations_and_converts_matrix_rows_to_lists(self):
        rotation = ((0.0, -1.0, 0.0), (1.0, 0.0, 0.0), (0.0, 0.0, 1.0))
        for prefix in ("", "mixamorig:"):
            with self.subTest(prefix=prefix or "unprefixed"):
                head = _Bone(_name(prefix, "Head"), matrix=rotation)
                spine3 = _Bone(_name(prefix, "Spine3"), matrix=rotation)
                adapter = CharacterRigAdapter(_bones(head, spine3))

                self.assertEqual(adapter.rest_rotations(), {"Head": [list(row) for row in rotation]})

    def test_returns_hips_head_only_when_the_matching_hips_bone_exists(self):
        for prefix in ("", "mixamorig:"):
            with self.subTest(prefix=prefix or "unprefixed"):
                hips = _Bone(_name(prefix, "Hips"), head=(0.25, 1.5, -0.75))
                self.assertEqual(
                    CharacterRigAdapter(_bones(hips)).hips_head(),
                    [0.25, 1.5, -0.75],
                )
                self.assertIsNone(
                    CharacterRigAdapter(_bones(_Bone(_name(prefix, "Head")))).hips_head()
                )

    def test_authored_bone_names_keep_only_mapped_pose_bones_in_rotation_order(self):
        rotations = {"Head": object(), "Spine3": object(), "RightArm": object()}
        for prefix in ("", "mixamorig:"):
            with self.subTest(prefix=prefix or "unprefixed"):
                rest_bones = _bones(
                    _Bone(_name(prefix, "Head")),
                    _Bone(_name(prefix, "RightArm")),
                )
                pose_bones = _Bones(
                    {
                        _name(prefix, "Head"): object(),
                        _name(prefix, "Unrelated"): object(),
                    }
                )

                self.assertEqual(
                    CharacterRigAdapter(rest_bones).authored_bone_names(rotations, pose_bones),
                    (_name(prefix, "Head"),),
                )


if __name__ == "__main__":
    unittest.main()
