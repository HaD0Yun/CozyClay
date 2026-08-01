"""The declarative generated-operation registry rejects unsafe rows before rendering."""

import importlib.util
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("generate_stage_scene_ops", ROOT / "scripts/generate_stage_scene_ops.py")
assert SPEC is not None and SPEC.loader is not None
GENERATOR = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = GENERATOR
SPEC.loader.exec_module(GENERATOR)

BASE = {
    "op": "set_camera_focus_distance",
    "targetResolver": "entity",
    "targetType": "CAMERA",
    "rnaPath": "data.dof.focus_distance",
    "wireField": "focus_distance",
    "valueType": "number",
    "bounds": {"min": 0.0, "max": 1e6},
    "manifestFieldPath": "cameras[].focusDistance",
}


class GenerateStageSceneOpsValidationTests(unittest.TestCase):
    def assert_rejected(self, row, message):
        with self.assertRaisesRegex(ValueError, message):
            GENERATOR.validate_rows([row])

    def test_rejects_unsafe_rna_path(self):
        row = dict(BASE, rnaPath="data.__class__.x")
        self.assert_rejected(row, "rnaPath.*dunder")

    def test_rejects_unknown_target_type(self):
        self.assert_rejected(dict(BASE, targetType="MESH"), "targetType.*recognized Blender")

    def test_rejects_inverted_bounds(self):
        self.assert_rejected(dict(BASE, bounds={"min": 2, "max": 1}), "bounds min")

    def test_rejects_nonfinite_bounds(self):
        self.assert_rejected(dict(BASE, bounds={"min": float("nan"), "max": 1}), "bounds min and max must be finite")

    def test_rejects_manifest_shape_mismatch(self):
        self.assert_rejected(dict(BASE, manifestFieldPath="lights[].cutoffDistance"), "manifestFieldPath.*CAMERA manifest")

    def test_rejects_handwritten_operation_collision(self):
        self.assert_rejected(dict(BASE, op="add_character"), "collides with hand-written")

    def test_rejects_duplicate_operation(self):
        with self.assertRaisesRegex(ValueError, "duplicate op"):
            GENERATOR.validate_rows([BASE, dict(BASE)])

    def test_accepts_empty_registry_after_ordinary_operation_cutover(self):
        self.assertEqual(GENERATOR.validate_rows([]), [])

    def test_manifest_only_row_emits_no_stage_scene_operation(self):
        row = dict(BASE, stageSceneOperation=False)
        generated = GENERATOR.outputs(GENERATOR.validate_rows([row]))
        self.assertNotIn("Type.Literal", generated["packages/blender-protocol/src/stage-scene-ops.generated.ts"])
        self.assertNotIn('"set_camera_focus_distance":', generated["blender-addon/cclay/stage_scene_ops_generated.py"])
        self.assertIn("GeneratedCameraManifestFields", generated["packages/blender-protocol/src/manifest-fields.generated.ts"])

    def test_rejects_non_boolean_stage_scene_operation_flag(self):
        self.assert_rejected(dict(BASE, stageSceneOperation="false"), "stageSceneOperation must be a boolean")


if __name__ == "__main__":
    unittest.main()


class GeneratedBoundsAreActuallyEnforcedTests(unittest.TestCase):
    """The generated validator must call the injected validator, not a builtin.

    The generator originally emitted `float(value, path, minimum=..., maximum=...)`
    -- the Python builtin, which accepts no such keywords -- so every generated
    bounds check raised TypeError and no declared bound was enforced at runtime.
    The whole add-on suite passed while that was true, because nothing executed
    the generated validator. These tests execute it.
    """

    @staticmethod
    def _number(value, path, minimum=None, maximum=None):
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise ValueError(f"{path} must be a number")
        if minimum is not None and value < minimum:
            raise ValueError(f"{path} below {minimum}")
        if maximum is not None and value > maximum:
            raise ValueError(f"{path} above {maximum}")

    def _validate(self, op, field, value):
        from cclay import stage_scene_ops_generated

        stage_scene_ops_generated.validate_generated_operation(
            {"op": op, "entity_id": "123e4567-e89b-42d3-a456-426614174000", field: value},
            0,
            self._number,
        )

    def test_every_registry_row_enforces_its_declared_bounds(self):
        import json

        rows = json.loads((ROOT / "packages/blender-protocol/src/op-registry.json").read_text(encoding="utf-8"))
        for row in rows:
            if row.get("stageSceneOperation", True) is False:
                continue
            op, field = row["op"], row["wireField"]
            minimum, maximum = row["bounds"]["min"], row["bounds"]["max"]
            with self.subTest(op=op):
                self._validate(op, field, (minimum + maximum) / 2)
                with self.assertRaises(ValueError):
                    self._validate(op, field, minimum - 1)
                with self.assertRaises(ValueError):
                    self._validate(op, field, maximum + 1)


class GeneratorSharesOneProjectionPerTargetTests(unittest.TestCase):
    """Two rows sharing a target type must not emit duplicate declarations."""

    def test_rows_sharing_a_target_type_produce_one_projection(self):
        # data.lens is already on the shipped allowlist, so an unconditional
        # discard in cleanup would delete pre-existing global state and make
        # later tests order-dependent. Snapshot and restore exactly instead.
        had_lens = "data.lens" in GENERATOR.ALLOWED_RNA_PATHS["CAMERA"]
        had_focal = "cameras[].focalLength" in GENERATOR.MANIFEST_PATHS
        GENERATOR.MANIFEST_PATHS["cameras[].focalLength"] = ("Camera", "Camera", "focalLength")
        GENERATOR.ALLOWED_RNA_PATHS["CAMERA"].add("data.lens")
        try:
            second = dict(BASE)
            second.update(
                op="set_camera_lens",
                rnaPath="data.lens",
                wireField="lens",
                manifestFieldPath="cameras[].focalLength",
            )
            generated = GENERATOR.outputs(GENERATOR.validate_rows([dict(BASE), second]))
            ts = generated["packages/blender-protocol/src/stage-scene-ops.generated.ts"]
            self.assertEqual(ts.count("export const generatedCameraManifestFields"), 1)
            self.assertIn("focusDistance", ts)
            self.assertIn("focalLength", ts)
        finally:
            if not had_focal:
                GENERATOR.MANIFEST_PATHS.pop("cameras[].focalLength", None)
            if not had_lens:
                GENERATOR.ALLOWED_RNA_PATHS["CAMERA"].discard("data.lens")


class RnaPathMustStayInsideTheEntityDatablockTests(unittest.TestCase):
    """Identifier-shaped is not enough; the path must not cross into another datablock."""

    def test_cross_datablock_traversal_is_rejected(self):
        row = dict(BASE, op="set_camera_action_name", rnaPath="data.animation_data.action.name")
        with self.assertRaisesRegex(ValueError, "not an allowed CAMERA write target"):
            GENERATOR.validate_rows([row])

    def test_every_shipped_row_is_on_the_allowlist(self):
        import json

        rows = json.loads((ROOT / "packages/blender-protocol/src/op-registry.json").read_text(encoding="utf-8"))
        for row in rows:
            with self.subTest(op=row["op"]):
                self.assertIn(row["rnaPath"], GENERATOR.ALLOWED_RNA_PATHS[row["targetType"]])
