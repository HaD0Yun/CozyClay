"""Host-side validation coverage for assembly stage_scene operations."""

from __future__ import annotations

import unittest

from cclay.stage_scene import StageSceneValidationError, parse_stage_scene_plan


class StageSceneAssemblyValidationTests(unittest.TestCase):
    def plan(self, operation: dict) -> dict:
        return parse_stage_scene_plan({
            "schema_version": 1,
            "expected_revision_id": "0" * 64,
            "operations": [operation],
        })

    def test_create_assembly(self):
        parsed = self.plan({"op": "create_assembly", "name": "Chair"})
        self.assertEqual(parsed["operations"][0]["name"], "Chair")

    def test_set_parent_and_unparent(self):
        entity_id = "11111111-1111-4111-8111-111111111111"
        parent_id = "22222222-2222-4222-8222-222222222222"
        self.assertEqual(
            self.plan({"op": "set_parent", "entity_id": entity_id, "parent_id": parent_id})["operations"][0]["parent_id"],
            parent_id,
        )
        self.assertIsNone(
            self.plan({"op": "set_parent", "entity_id": entity_id, "parent_id": None})["operations"][0]["parent_id"]
        )

    def test_set_parent_rejects_self_parent(self):
        entity_id = "11111111-1111-4111-8111-111111111111"
        with self.assertRaisesRegex(
            StageSceneValidationError, "cannot parent an entity to itself"
        ):
            self.plan({
                "op": "set_parent",
                "entity_id": entity_id,
                "parent_id": entity_id,
            })

    def test_transform_assembly_optional_components(self):
        operation = self.plan({
            "op": "transform_assembly",
            "assembly_id": "33333333-3333-4333-8333-333333333333",
            "translation": [1, 2, 3],
        })["operations"][0]
        self.assertEqual(operation["translation"], [1, 2, 3])
        self.assertNotIn("rotation_euler", operation)
        self.assertNotIn("scale", operation)

    def test_transform_assembly_requires_a_component(self):
        with self.assertRaisesRegex(
            StageSceneValidationError, "must include at least one transform field"
        ):
            self.plan({
                "op": "transform_assembly",
                "assembly_id": "33333333-3333-4333-8333-333333333333",
            })

    def test_transform_assembly_rejects_null_component(self):
        with self.assertRaisesRegex(
            StageSceneValidationError, "must be a vector, not null"
        ):
            self.plan({
                "op": "transform_assembly",
                "assembly_id": "33333333-3333-4333-8333-333333333333",
                "translation": None,
            })

    def test_transform_assembly_rejects_all_null_components(self):
        with self.assertRaisesRegex(
            StageSceneValidationError, "must be a vector, not null"
        ):
            self.plan({
                "op": "transform_assembly",
                "assembly_id": "33333333-3333-4333-8333-333333333333",
                "translation": None,
                "rotation_euler": None,
                "scale": None,
            })

    def test_add_primitive_rejects_self_parent(self):
        entity_id = "44444444-4444-4444-8444-444444444444"
        with self.assertRaisesRegex(
            StageSceneValidationError, "cannot parent an entity to itself"
        ):
            self.plan({
                "op": "add_primitive",
                "entity_id": entity_id,
                "parent_id": entity_id,
                "primitive_type": "CUBE",
                "name": "Part",
                "location": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
            })

    def test_add_primitive_parent_is_optional(self):
        operation = self.plan({
            "op": "add_primitive",
            "entity_id": "44444444-4444-4444-8444-444444444444",
            "primitive_type": "CUBE",
            "name": "Part",
            "location": [0, 0, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
        })["operations"][0]
        self.assertNotIn("parent_id", operation)


if __name__ == "__main__":
    unittest.main()
