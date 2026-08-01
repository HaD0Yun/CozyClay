"""Python half of the cross-language V4 manifest parity pair.

The TypeScript half lives at
`packages/director-core/test/scene-manifest-v4-parity.test.ts` and asserts that
`buildSceneManifestV4Revision` reproduces the values recorded in these fixtures.
This file asserts the add-on's own finalizers produce those same values, so the
two suites together prove the canonicalizers agree rather than each merely
agreeing with itself.

The hierarchical fixture matters specifically: a hierarchy-free scene is hashed
through the V3-shaped preimage, so a flat-only fixture cannot detect a
divergence that appears once assemblies or parented objects exist.
"""

import copy
import json
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from cclay.revision import initial_revision_id
from cclay.scene_manifest import finalize_scene_manifest_child

FIXTURES = Path(__file__).resolve().parents[2] / "packages/director-core/test/fixtures"
FLAT = FIXTURES / "scene-manifest-v4-parity.json"
HIERARCHICAL = FIXTURES / "scene-manifest-v4-hierarchy-parity.json"
PARENT_REVISION = "d" * 64


def _hash_free(path: Path) -> tuple:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    recorded = (manifest["sceneHash"], manifest["revisionId"])
    stripped = copy.deepcopy(manifest)
    stripped.pop("sceneHash", None)
    stripped.pop("revisionId", None)
    return stripped, recorded


class SceneManifestV4ParityTests(unittest.TestCase):
    def test_hierarchical_fixture_reproduces_its_recorded_hash_and_child_revision(self):
        manifest, (scene_hash, revision_id) = _hash_free(HIERARCHICAL)
        parented = [entry for entry in manifest["objects"] if entry.get("parentId")]
        self.assertTrue(
            parented,
            "fixture must carry real hierarchy or it exercises the flat preimage path instead",
        )
        operation = {
            "schema_version": 1,
            "expected_revision_id": PARENT_REVISION,
            "operations": [
                {
                    "op": "set_parent",
                    "entity_id": "00000000-0000-4000-8000-000000000001",
                    "parent_id": "00000000-0000-4000-8000-000000000002",
                }
            ],
        }
        built = finalize_scene_manifest_child(manifest, PARENT_REVISION, operation)
        self.assertEqual(built["sceneHash"], scene_hash)
        self.assertEqual(built["revisionId"], revision_id)

    def test_flat_fixture_was_produced_by_its_generator(self):
        # The flat fixture claims to come from
        # blender-addon/tests/fixtures/generate_scene_manifest_parity.py, which
        # finalizes an initial manifest. A hand-built fixture carrying a
        # revisionId the generator would never mint looks correct to every test
        # that strips and recomputes, so assert the recorded revisionId really is
        # initial_revision_id(projectId, sceneHash). Regenerate through the
        # generator rather than editing the fixture if this fails.
        manifest = json.loads(FLAT.read_text(encoding="utf-8"))
        self.assertEqual(
            manifest["revisionId"],
            initial_revision_id(manifest["projectId"], manifest["sceneHash"]),
        )

    def test_hierarchy_changes_the_scene_hash(self):
        _, (flat_hash, _) = _hash_free(FLAT)
        _, (hierarchical_hash, _) = _hash_free(HIERARCHICAL)
        self.assertNotEqual(
            flat_hash,
            hierarchical_hash,
            "hierarchy must affect the preimage, otherwise the parity assertions pass for the wrong reason",
        )


if __name__ == "__main__":
    unittest.main()
