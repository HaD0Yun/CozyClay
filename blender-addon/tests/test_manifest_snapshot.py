"""Host-side snapshot identity extraction tests."""

from __future__ import annotations

import importlib
import sys
import types
import unittest

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


if __name__ == "__main__":
    unittest.main()
