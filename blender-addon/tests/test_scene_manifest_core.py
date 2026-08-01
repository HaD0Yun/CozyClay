import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))

from cclay.scene_manifest import (
    INVALID_MANIFEST_REFERENCE,
    build_scene_manifest_v4,
    finalize_scene_manifest_child,
)
from cclay.canonical import canonical_json
from cclay.revision import child_revision_id
from tests.test_scene_manifest import LIGHT_OBJECT, OBJECT, parts

PARENT = "a" * 64
PLAN = {
    "schema_version": 1,
    "expected_revision_id": PARENT,
    "operations": [
        {
            "op": "set_material_color",
            "entity_id": OBJECT,
            "color": [0.1, 0.2, 0.3, 1],
        }
    ],
}


class SceneManifestCoreTests(unittest.TestCase):
    def v3_parts(self):
        value = parts()
        value["lights"][0]["areaSize"] = None
        value.update(
            stage_primitives=[{"objectId": OBJECT, "primitiveType": "CUBE"}],
            stage_materials=[{
                "objectId": OBJECT,
                "materialName": "CCLAY Material",
                "baseColor": [0.1, 0.2, 0.3, 1],
                "useNodes": True,
                "principledBaseColor": [0.1, 0.2, 0.3, 1],
            }],
        )
        return value

    def test_v4_hashes_exact_stage_state_and_real_child_revision(self):
        manifest = build_scene_manifest_v4(**self.v3_parts())
        finalized = finalize_scene_manifest_child(manifest, PARENT, PLAN)
        self.assertEqual(finalized["schemaVersion"], 4)
        self.assertEqual(
            finalized["revisionId"],
            child_revision_id(
                finalized["projectId"],
                PARENT,
                canonical_json(PLAN),
                finalized["sceneHash"],
                canonical_json([]),
            ),
        )
        changed = self.v3_parts()
        changed["stage_materials"][0]["baseColor"][0] = 0.8
        self.assertNotEqual(
            finalize_scene_manifest_child(build_scene_manifest_v4(**changed), PARENT, PLAN)["sceneHash"],
            finalized["sceneHash"],
        )

    def test_node_base_color_and_use_nodes_each_advance_hash(self):
        baseline = finalize_scene_manifest_child(
            build_scene_manifest_v4(**self.v3_parts()), PARENT, PLAN
        )
        for field, value in (
            ("principledBaseColor", [0.8, 0.2, 0.3, 1]),
            ("useNodes", False),
        ):
            with self.subTest(field=field):
                changed = self.v3_parts()
                changed["stage_materials"][0][field] = value
                finalized = finalize_scene_manifest_child(
                    build_scene_manifest_v4(**changed), PARENT, PLAN
                )
                self.assertNotEqual(finalized["sceneHash"], baseline["sceneHash"])
                self.assertNotEqual(finalized["revisionId"], baseline["revisionId"])

    def test_v4_stage_references_and_area_size_are_closed(self):
        missing = self.v3_parts()
        missing["stage_primitives"][0]["objectId"] = "99999999-9999-4999-8999-999999999999"
        with self.assertRaises(INVALID_MANIFEST_REFERENCE):
            build_scene_manifest_v4(**missing)

        bad_area = self.v3_parts()
        bad_area["lights"][0]["lightType"] = "AREA"
        with self.assertRaises(Exception):
            build_scene_manifest_v4(**bad_area)

        valid_area = self.v3_parts()
        valid_area["lights"][0].update(lightType="AREA", areaSize=3.0)
        self.assertEqual(build_scene_manifest_v4(**valid_area)["lights"][0]["objectId"], LIGHT_OBJECT)


if __name__ == "__main__":
    unittest.main()
