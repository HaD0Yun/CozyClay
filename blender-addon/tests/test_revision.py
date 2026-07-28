import hashlib
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from cclay.revision import initial_revision_id


class RevisionTests(unittest.TestCase):
    def test_architecture_section_6_initial_revision_formula(self):
        project_id = "12345678-1234-4234-8234-123456789abc"
        scene_hash = "ab" * 32
        expected = hashlib.sha256(
            ("omb-revision-v1\0" + project_id + "\0" + scene_hash).encode("utf-8")
        ).hexdigest()
        self.assertEqual(initial_revision_id(project_id, scene_hash), expected)


if __name__ == "__main__":
    unittest.main()
