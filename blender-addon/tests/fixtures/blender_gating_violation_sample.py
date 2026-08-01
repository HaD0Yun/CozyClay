"""Seeded negative sample for test_blender_gating.

This module is deliberately NOT named test*.py so unittest discovery ignores it.
It reproduces the exact prohibited pattern the gating meta-test must detect: a
module-level BLENDER constant plus a setUpClass that raises when Blender is
absent instead of skipping. Never copy this shape into a real test module.
"""
from __future__ import annotations

import shutil
import unittest
from pathlib import Path

BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")


class SeededGatingViolationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not BLENDER.is_file():
            raise AssertionError("Blender is required for this seeded sample")

    def test_placeholder(self) -> None:
        self.assertTrue(BLENDER.is_file())
