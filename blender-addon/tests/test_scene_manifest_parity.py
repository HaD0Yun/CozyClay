"""Cross-language SceneManifestV2 revision parity (Architecture §6).

The committed fixture is shared verbatim with
packages/director-core/test/fixtures/scene-manifest-v2-parity.json; this
test proves the Python producer reproduces its own committed sceneHash and
revisionId, while packages/director-core/test/scene-manifest-parity.test.ts
proves the TypeScript consumer reproduces the same values from Python's
finalized document. Together they close the byte-identical cross-language
hashing loop required by architecture doc section 6.
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from oh_my_blender.scene_manifest import finalize_scene_manifest

FIXTURE_PATH = os.path.join(
    os.path.dirname(__file__),
    "..",
    "..",
    "packages",
    "director-core",
    "test",
    "fixtures",
    "scene-manifest-v2-parity.json",
)


class SceneManifestParityTest(unittest.TestCase):
    def test_architecture_section_6_and_snapshot_v2_section_2_6_reproduce_the_committed_v2_hash(self):
        with open(FIXTURE_PATH, encoding="utf-8") as handle:
            fixture = json.load(handle)
        without_hashes = {k: v for k, v in fixture.items() if k not in ("sceneHash", "revisionId")}
        rebuilt = finalize_scene_manifest(without_hashes)
        self.assertEqual(rebuilt["sceneHash"], fixture["sceneHash"])
        self.assertEqual(rebuilt["revisionId"], fixture["revisionId"])


if __name__ == "__main__":
    unittest.main()
