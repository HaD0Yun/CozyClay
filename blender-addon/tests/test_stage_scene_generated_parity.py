"""Generated Python manifest projection matches the generated field fixture."""

import hashlib
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))

from cclay.manifest_fields_generated import (
    generated_camera_manifest_fields,
    generated_light_manifest_fields,
)

FIXTURE = Path(__file__).resolve().parents[2] / "packages/blender-protocol/test/fixtures/canonical-fields.generated.json"


class _Camera:
    def __init__(self, focus_distance):
        self.dof = type("Dof", (), {"focus_distance": focus_distance})()


class _Light:
    def __init__(self, cutoff_distance):
        self.cutoff_distance = cutoff_distance


class GeneratedStageSceneFieldParityTests(unittest.TestCase):
    def test_manifest_projection_matches_manifest_only_fixture_bytes_and_hash(self):
        for row in json.loads(FIXTURE.read_text(encoding="utf-8")):
            operation = row["operation"]
            self.assertFalse(row["stageSceneOperation"])
            if operation["op"] == "set_camera_focus_distance":
                fields = generated_camera_manifest_fields(
                    _Camera(operation["focus_distance"])
                )
            else:
                fields = generated_light_manifest_fields(
                    _Light(operation["cutoff_distance"])
                )
            canonical_fields = json.dumps(
                fields, ensure_ascii=False, separators=(",", ":")
            ).encode("utf-8")
            self.assertEqual(canonical_fields.decode("utf-8"), row["canonicalFields"])
            self.assertEqual(
                hashlib.sha256(canonical_fields).hexdigest(), row["sha256"]
            )


if __name__ == "__main__":
    unittest.main()
