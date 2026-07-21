"""Bundled Y-Bot/X-Bot character import through the stage_scene transaction."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))

from oh_my_blender.stage_scene import (
    StageSceneValidationError,
    parse_stage_scene_plan,
)

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/stage_scene_character_fixture.py"


def _plan(operations):
    return {
        "schema_version": 1,
        "expected_revision_id": "a" * 64,
        "operations": operations,
    }


def _character(**overrides):
    operation = {
        "op": "add_character",
        "entity_id": "11111111-1111-4111-8111-111111111111",
        "character_type": "Y_BOT",
        "name": "Fighter One",
        "location": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
    }
    operation.update(overrides)
    return operation


class AddCharacterValidationTests(unittest.TestCase):
    def test_accepts_both_bundled_character_types(self):
        for character_type in ("Y_BOT", "X_BOT"):
            with self.subTest(character_type=character_type):
                parse_stage_scene_plan(
                    _plan([_character(character_type=character_type)])
                )

    def test_rejects_unknown_character_type(self):
        with self.assertRaises(StageSceneValidationError) as caught:
            parse_stage_scene_plan(_plan([_character(character_type="Z_BOT")]))
        self.assertIn("character_type", str(caught.exception))

    def test_rejects_extra_keys_and_duplicate_identity(self):
        with self.assertRaises(StageSceneValidationError):
            parse_stage_scene_plan(_plan([_character(parent_id=None)]))
        duplicated = _plan([_character(), _character()])
        with self.assertRaises(StageSceneValidationError) as caught:
            parse_stage_scene_plan(duplicated)
        self.assertEqual(caught.exception.code, "STAGE_SCENE_ENTITY_ID_DUPLICATE")


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class AddCharacterRealBlenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        completed = subprocess.run(
            [str(BLENDER), "--background", "--factory-startup", "--python", str(SCRIPT)],
            cwd=REPOSITORY_ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=180,
        )
        if completed.returncode != 0:
            raise AssertionError(
                f"headless Blender failed\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
        lines = [
            line
            for line in completed.stdout.splitlines()
            if line.startswith("OMB_STAGE_CHARACTER_RESULTS=")
        ]
        if len(lines) != 1:
            raise AssertionError(f"missing character results\n{completed.stdout}")
        cls.results = json.loads(lines[0].split("=", 1)[1])

    def test_imports_owned_armature_roots_with_composed_transform(self):
        self.assertTrue(self.results["rootsAreArmatures"])
        self.assertTrue(self.results["rootNames"])
        self.assertTrue(self.results["rootLocation"])
        self.assertTrue(self.results["importScalePreserved"])
        self.assertTrue(self.results["characterTypeTagged"])

    def test_children_are_owned_with_deterministic_uuid4_ids(self):
        self.assertTrue(self.results["childrenExist"])
        self.assertTrue(self.results["childrenOwned"])
        self.assertTrue(self.results["childIdsDeterministic"])

    def test_manifest_tracks_armatures_and_bones(self):
        self.assertTrue(self.results["manifestHasArmatures"])
        self.assertTrue(self.results["manifestBonesPopulated"])
        self.assertTrue(self.results["committed"])
        self.assertTrue(self.results["identityCoversCharacters"])
        self.assertTrue(self.results["checkpointReleased"])

    def test_duplicate_stable_name_rolls_back_cleanly(self):
        self.assertEqual(self.results["dupeNameCode"], "STAGE_SCENE_STABLE_NAME_EXISTS")
        self.assertTrue(self.results["dupeRollback"])
        self.assertTrue(self.results["dupeCheckpointReleased"])
