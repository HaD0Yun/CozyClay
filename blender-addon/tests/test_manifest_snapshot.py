"""Host-side snapshot identity extraction tests."""

from __future__ import annotations

import importlib
import sys
import types
import unittest

import oh_my_blender

sys.modules.setdefault("bpy", types.ModuleType("bpy"))
mathutils = types.ModuleType("mathutils")
mathutils.Quaternion = object
sys.modules.setdefault("mathutils", mathutils)

manifest = importlib.import_module("oh_my_blender.manifest")


class FakeObject(dict):
    def __init__(self, name: str, entity_id: str | None = None) -> None:
        super().__init__()
        if entity_id is not None:
            self["omb.entity_id"] = entity_id
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


class ManifestSnapshotTest(unittest.TestCase):
    def test_object_entity_id_and_assembly_are_extracted(self) -> None:
        root_id = "00000000-0000-4000-8000-000000000001"
        member_id = "00000000-0000-4000-8000-000000000002"
        root = FakeObject("Assembly", root_id)
        member = FakeObject("Part", member_id)
        root.children_recursive = [member]
        root["omb.assembly_id"] = "00000000-0000-4000-8000-000000000003"
        root["omb.assembly_name"] = "Product"

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


if __name__ == "__main__":
    unittest.main()
