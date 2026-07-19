import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))

from oh_my_blender.stage_scene import StageSceneValidationError, parse_stage_scene_plan

FIXTURES = (
    pathlib.Path(__file__).parents[2]
    / "packages/blender-protocol/test/fixtures/stage-scene"
)


class StageSceneValidationTests(unittest.TestCase):
    def fixture(self, name: str) -> object:
        return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))

    def test_shared_valid_fixture_matches_python_mirror(self):
        plan = parse_stage_scene_plan(self.fixture("valid-plan"))
        self.assertEqual(
            [operation["op"] for operation in plan["operations"]],
            ["add_primitive", "set_material_color", "upsert_area_light", "delete_entity"],
        )

    def test_unknown_field_has_schema_only_code(self):
        with self.assertRaises(StageSceneValidationError) as caught:
            parse_stage_scene_plan(self.fixture("invalid-unknown-field"))
        self.assertEqual(caught.exception.code, "INVALID_STAGE_SCENE_PLAN_SCHEMA")

    def test_duplicate_creation_id_has_distinct_code(self):
        with self.assertRaises(StageSceneValidationError) as caught:
            parse_stage_scene_plan(self.fixture("invalid-duplicate-entity-id"))
        self.assertEqual(caught.exception.code, "STAGE_SCENE_ENTITY_ID_DUPLICATE")

    def test_duplicate_stable_name_has_distinct_code(self):
        plan = self.fixture("valid-plan")
        plan["operations"][2]["name"] = "Floor"
        with self.assertRaises(StageSceneValidationError) as caught:
            parse_stage_scene_plan(plan)
        self.assertEqual(caught.exception.code, "STAGE_SCENE_STABLE_NAME_DUPLICATE")

    def test_each_grammar_branch_is_closed(self):
        for index, operation in enumerate(self.fixture("valid-plan")["operations"]):
            plan = self.fixture("valid-plan")
            plan["operations"][index] = {**operation, "unknown": True}
            with self.subTest(operation=operation["op"]):
                with self.assertRaises(StageSceneValidationError) as caught:
                    parse_stage_scene_plan(plan)
                self.assertEqual(caught.exception.code, "INVALID_STAGE_SCENE_PLAN_SCHEMA")


if __name__ == "__main__":
    unittest.main()
