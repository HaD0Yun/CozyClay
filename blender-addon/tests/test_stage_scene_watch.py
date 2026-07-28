"""Watch-mode pacing: visual-only, never active headless or in tests by default."""

import os
import types
import unittest
from unittest import mock

from cclay import stage_scene


def _gui_bpy() -> types.SimpleNamespace:
    return types.SimpleNamespace(app=types.SimpleNamespace(background=False))


class WatchPaceTests(unittest.TestCase):
    def test_no_bpy_means_disabled(self) -> None:
        with mock.patch.object(stage_scene, "bpy", None):
            self.assertEqual(stage_scene._watch_pace_ms(), 0)

    def test_background_blender_is_disabled_even_with_env(self) -> None:
        headless = types.SimpleNamespace(app=types.SimpleNamespace(background=True))
        with mock.patch.object(stage_scene, "bpy", headless):
            with mock.patch.dict(os.environ, {"CCLAY_WATCH_MS": "120"}):
                self.assertEqual(stage_scene._watch_pace_ms(), 0)

    def test_unset_env_defaults_to_disabled(self) -> None:
        with mock.patch.object(stage_scene, "bpy", _gui_bpy()):
            with mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop("CCLAY_WATCH_MS", None)
                self.assertEqual(stage_scene._watch_pace_ms(), 0)

    def test_env_value_is_used_and_clamped(self) -> None:
        with mock.patch.object(stage_scene, "bpy", _gui_bpy()):
            with mock.patch.dict(os.environ, {"CCLAY_WATCH_MS": "120"}):
                self.assertEqual(stage_scene._watch_pace_ms(), 120)
            with mock.patch.dict(os.environ, {"CCLAY_WATCH_MS": "99999"}):
                self.assertEqual(stage_scene._watch_pace_ms(), 1000)
            with mock.patch.dict(os.environ, {"CCLAY_WATCH_MS": "-5"}):
                self.assertEqual(stage_scene._watch_pace_ms(), 0)
            with mock.patch.dict(os.environ, {"CCLAY_WATCH_MS": "garbage"}):
                self.assertEqual(stage_scene._watch_pace_ms(), 0)

    def test_watch_step_is_noop_when_disabled(self) -> None:
        with mock.patch.object(stage_scene, "bpy", None):
            stage_scene._watch_step()  # must not raise or sleep


if __name__ == "__main__":
    unittest.main()
