"""Host-side snapshot identity extraction tests."""

from __future__ import annotations

import importlib
import sys
import types
import unittest
from unittest import mock

import cclay

# cclay.manifest hard-imports bpy/mathutils. Install stubs only for
# the duration of that import and remove any we inserted afterwards: leaving a
# bare importable "bpy" module behind flips other modules' try-import-else-None
# guards (e.g. qa_render) from None to a broken stub for the whole test run.
_inserted = []
for _name, _module in (
    ("bpy", types.ModuleType("bpy")),
    ("mathutils", None),
):
    if _name not in sys.modules:
        if _module is None:
            _module = types.ModuleType("mathutils")
            _module.Quaternion = object
        sys.modules[_name] = _module
        _inserted.append(_name)
try:
    manifest = importlib.import_module("cclay.manifest")
finally:
    for _name in _inserted:
        sys.modules.pop(_name, None)


class FakeObject(dict):
    def __init__(self, name: str, entity_id: str | None = None) -> None:
        super().__init__()
        if entity_id is not None:
            self["cclay.entity_id"] = entity_id
        self.name = name
        self.type = "EMPTY"
        self.parent = None
        self.children_recursive: list[FakeObject] = []
        self.data = None
        self.library = None
        self.animation_data = None
        self.location = [0.0, 0.0, 0.0]
        self.rotation_mode = "QUATERNION"
        self.rotation_quaternion = [1.0, 0.0, 0.0, 0.0]
        self.scale = [1.0, 1.0, 1.0]

    __hash__ = object.__hash__

    def visible_get(self) -> bool:
        return True


class FakeMatrix:
    def decompose(self):
        return ((0.0, 0.0, 0.0), (1.0, 0.0, 0.0, 0.0), (1.0, 1.0, 1.0))


class FakeBone(dict):
    def __init__(self, name: str, entity_id: str | None = None, parent=None) -> None:
        super().__init__()
        if entity_id is not None:
            self["cclay.entity_id"] = entity_id
        self.name = name
        self.parent = parent
        self.matrix_local = FakeMatrix()

    __hash__ = object.__hash__


class FakeArmatureData:
    def __init__(self, bones: list[FakeBone]) -> None:
        self.bones = bones


class FakeArmatureObject(FakeObject):
    def __init__(self, name: str, entity_id: str | None, bones: list[FakeBone]) -> None:
        super().__init__(name, entity_id)
        self.type = "ARMATURE"
        self.data = FakeArmatureData(bones)


class ManifestSnapshotTest(unittest.TestCase):
    def test_object_entity_id_and_assembly_are_extracted(self) -> None:
        root_id = "00000000-0000-4000-8000-000000000001"
        member_id = "00000000-0000-4000-8000-000000000002"
        root = FakeObject("Assembly", root_id)
        member = FakeObject("Part", member_id)
        root.children_recursive = [member]
        root["cclay.assembly_id"] = "00000000-0000-4000-8000-000000000003"
        root["cclay.assembly_name"] = "Product"

        self.assertEqual(manifest._object_snapshot(root)["entityId"], root_id)
        self.assertIsNone(manifest._object_snapshot(FakeObject("Legacy"))["entityId"])
        self.assertEqual(
            manifest._assembly_entries([root, member], {root: root_id, member: member_id}),
            [{
                "assemblyId": "00000000-0000-4000-8000-000000000003",
                "name": "Product",
                "rootEntityId": root_id,
                "memberIds": [root_id, member_id],
            }],
        )

    def test_tracked_entity_id_omits_untracked_entities_instead_of_raising(self) -> None:
        tracked_id = "00000000-0000-4000-8000-000000000004"
        self.assertEqual(manifest._tracked_entity_id(FakeObject("Tracked", tracked_id)), tracked_id)
        self.assertIsNone(manifest._tracked_entity_id(FakeObject("Stray")))

    def test_manifest_object_parent_id_is_none_for_untracked_parent(self) -> None:
        # A stray Empty (e.g. hand-authored via a raw script outside
        # stage_scene, never stamped with cclay.entity_id) parented under a
        # tracked object must not brick manifest extraction for the object -
        # it simply reports no discoverable parent.
        tracked_id = "00000000-0000-4000-8000-000000000005"
        stray_parent = FakeObject("Motion_Fit_Correction")
        child = FakeObject("Child", tracked_id)
        child.parent = stray_parent
        entry = manifest._manifest_object(child)
        self.assertEqual(entry["entityId"], tracked_id)
        self.assertIsNone(entry["parentId"])

    def test_manifest_bones_skips_untracked_armature_and_bones(self) -> None:
        # An armature or bone never stamped by add_character/stage_scene must
        # be omitted, not raise and brick the whole bones list.
        untracked_armature = FakeArmatureObject("RawRig", None, [FakeBone("root")])
        tracked_bone_id = "00000000-0000-4000-8000-000000000006"
        tracked_armature_id = "00000000-0000-4000-8000-000000000007"
        tracked_bone = FakeBone("Hips", tracked_bone_id)
        stray_bone = FakeBone("Extra")
        tracked_armature = FakeArmatureObject(
            "Person", tracked_armature_id, [tracked_bone, stray_bone]
        )
        bones = manifest._manifest_bones([untracked_armature, tracked_armature])
        self.assertEqual(len(bones), 1)
        self.assertEqual(bones[0]["entityId"], tracked_bone_id)
        self.assertEqual(bones[0]["armatureObjectId"], tracked_armature_id)
class _EnumItem:
    def __init__(self, identifier: str, value: int) -> None:
        self.identifier = identifier
        self.value = value


class _EnumProp:
    def __init__(self, items: list[_EnumItem], default: float | None = None) -> None:
        self.enum_items = items
        self.default = default


def _keyframe_rna_properties() -> dict[str, _EnumProp]:
    """Minimal stand-in for ``bpy.types.Keyframe.bl_rna.properties``."""
    interpolation = [
        _EnumItem("CONSTANT", 0),
        _EnumItem("LINEAR", 1),
        _EnumItem("BEZIER", 2),
        _EnumItem("BACK", 11),
        _EnumItem("ELASTIC", 15),
    ]
    easing = [
        _EnumItem("AUTO", 0),
        _EnumItem("EASE_IN", 1),
        _EnumItem("EASE_OUT", 2),
        _EnumItem("EASE_IN_OUT", 3),
    ]
    return {
        "interpolation": _EnumProp(interpolation),
        "easing": _EnumProp(easing),
        "back": _EnumProp([], default=1.0),
        "amplitude": _EnumProp([], default=1.0),
        "period": _EnumProp([], default=1.0),
    }


class _KeyframePoint:
    def __init__(self, frame: float, value: float) -> None:
        self.co = (frame, value)
        self.handle_left = (frame - 1.0, value - 1.0)
        self.handle_right = (frame + 1.0, value + 1.0)
        self.interpolation = 2   # BEZIER
        self.easing = 0          # AUTO
        self.handle_left_type = 0
        self.handle_right_type = 0
        self.back = 1.0
        self.amplitude = 1.0
        self.period = 1.0


class _KeyframePoints:
    def __init__(self, points: list[_KeyframePoint]) -> None:
        self._points = points

    def __len__(self) -> int:
        return len(self._points)

    def foreach_get(self, name: str, values: list) -> None:
        for index, point in enumerate(self._points):
            if name in ("co", "handle_left", "handle_right"):
                pair = getattr(point, name)
                values[2 * index] = pair[0]
                values[2 * index + 1] = pair[1]
            else:
                values[index] = getattr(point, name)


class _Fcurve:
    def __init__(self, data_path: str, array_index: int, points: list[_KeyframePoint]) -> None:
        self.modifiers: list = []
        self.data_path = data_path
        self.array_index = array_index
        self.keyframe_points = _KeyframePoints(points)


class _Action:
    def __init__(self, fcurves: list[_Fcurve]) -> None:
        self.fcurves = fcurves


class _AnimationData:
    def __init__(self, fcurves: list[_Fcurve]) -> None:
        self.drivers: list = []
        self.action = _Action(fcurves)


class _Bone(dict):
    def __init__(self, name: str, entity_id: str | None = None) -> None:
        super().__init__()
        if entity_id is not None:
            self["cclay.entity_id"] = entity_id
        self.name = name


class _Bones:
    def __init__(self, bones: list[_Bone]) -> None:
        self._bones = {bone.name: bone for bone in bones}

    def get(self, name: str):
        return self._bones.get(name)


class _ArmatureData:
    def __init__(self, bones: list[_Bone]) -> None:
        self.bones = _Bones(bones)


class _AnimatedArmature:
    def __init__(self, bones: list[_Bone], fcurves: list[_Fcurve]) -> None:
        self.type = "ARMATURE"
        self.data = _ArmatureData(bones)
        self.animation_data = _AnimationData(fcurves)


def _pose_curve(bone_name: str) -> _Fcurve:
    return _Fcurve(
        f'pose.bones["{bone_name}"].rotation_quaternion', 0,
        [_KeyframePoint(1.0, 0.0), _KeyframePoint(24.0, 0.7071)],
    )


class AnimationDigestTests(unittest.TestCase):
    """The animation digest excludes f-curves on untracked pose bones.

    The IK layer (``ik_rig.attach``) keys control bones created with
    ``edit_bones.new()`` and never stamped with ``cclay.entity_id``; hashing
    those curves would change the canonical scene hash when the layer is
    attached, breaking the stored-revision contract (the
    ``manifest._pose_bone_is_tracked`` docstring).
    """

    def setUp(self) -> None:
        self._types = mock.Mock()
        self._types.Keyframe.bl_rna.properties = _keyframe_rna_properties()
        self._patch = mock.patch.object(
            manifest.bpy, "types", self._types, create=True
        )
        self._patch.start()
        self.addCleanup(self._patch.stop)

    def _armature(self, bones: list[_Bone], fcurves: list[_Fcurve]) -> _AnimatedArmature:
        return _AnimatedArmature(bones, fcurves)

    def test_untracked_pose_bone_curve_is_excluded_and_tracked_ones_kept(self):
        entity_id = "00000000-0000-4000-8000-000000000011"
        tracked_bone = _Bone("Hips", "00000000-0000-4000-8000-000000000010")
        untracked_bone = _Bone("CCLAY-IK-TGT-LeftHand")
        object_curve = _Fcurve(
            "location", 0, [_KeyframePoint(1.0, 0.0), _KeyframePoint(24.0, 3.0)]
        )
        baseline_armature = self._armature(
            [tracked_bone, untracked_bone],
            [_pose_curve("Hips"), _pose_curve("CCLAY-IK-TGT-LeftHand"), object_curve],
        )
        baseline = manifest._animation_digest(entity_id, baseline_armature)
        self.assertIsNotNone(baseline)

        # Removing the curve that targets the untracked control bone must not
        # change the digest: it was never part of the hashed surface.
        without_untracked = self._armature(
            [tracked_bone, untracked_bone],
            [_pose_curve("Hips"), object_curve],
        )
        self.assertEqual(
            manifest._animation_digest(entity_id, without_untracked), baseline
        )

        # A curve on a tracked pose bone IS part of the digest...
        without_tracked = self._armature(
            [tracked_bone, untracked_bone],
            [_pose_curve("CCLAY-IK-TGT-LeftHand"), object_curve],
        )
        self.assertNotEqual(
            manifest._animation_digest(entity_id, without_tracked), baseline
        )

        # ...and so is an object-level path.
        without_object = self._armature(
            [tracked_bone, untracked_bone],
            [_pose_curve("Hips"), _pose_curve("CCLAY-IK-TGT-LeftHand")],
        )
        self.assertNotEqual(
            manifest._animation_digest(entity_id, without_object), baseline
        )

    def test_curves_only_on_untracked_pose_bones_report_no_digest(self):
        untracked_bone = _Bone("CCLAY-IK-TGT-LeftHand")
        armature = self._armature(
            [untracked_bone], [_pose_curve("CCLAY-IK-TGT-LeftHand")]
        )
        self.assertIsNone(
            manifest._animation_digest(
                "00000000-0000-4000-8000-000000000011", armature
            )
        )


if __name__ == "__main__":
    unittest.main()
