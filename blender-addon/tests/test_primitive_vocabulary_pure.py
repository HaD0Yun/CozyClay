"""The builder's shape vocabulary must equal PRIMITIVE_TYPES exactly, both ways.

Pure: no Blender. `_PRIMITIVE_BUILDERS` and the shading sets are plain dicts and
frozensets, so equality with the canonical list is decidable here rather than by
probing guessed names in a headless render. Probing could only ever prove that
the names someone thought to guess are refused; it says nothing about a branch
nobody guessed, which is exactly the drift that matters.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

from cclay.scene_manifest import PRIMITIVE_TYPES  # noqa: E402
from cclay.stage_scene import (  # noqa: E402
    _PRIMITIVE_BUILDERS,
    _PRIMITIVES,
    _SHADING_ALL_SMOOTH,
    _SHADING_FLAT,
    _SHADING_SMOOTH_SIDES,
)


class PrimitiveVocabularyTests(unittest.TestCase):
    def test_every_declared_shape_has_a_builder(self):
        missing = set(PRIMITIVE_TYPES) - set(_PRIMITIVE_BUILDERS)
        self.assertEqual(missing, set(), f"declared but unbuildable: {sorted(missing)}")

    def test_no_builder_exists_for_an_undeclared_shape(self):
        # The direction a sampled denylist can never establish: a builder added
        # without a PRIMITIVE_TYPES entry is dead code that validation rejects, so
        # nothing would ever execute it and nothing would ever notice.
        extra = set(_PRIMITIVE_BUILDERS) - set(PRIMITIVE_TYPES)
        self.assertEqual(extra, set(), f"buildable but undeclared: {sorted(extra)}")

    def test_the_validation_set_matches_the_canonical_list(self):
        self.assertEqual(_PRIMITIVES, frozenset(PRIMITIVE_TYPES))

    def test_the_canonical_list_has_no_duplicates(self):
        self.assertEqual(len(PRIMITIVE_TYPES), len(set(PRIMITIVE_TYPES)))

    def test_every_shape_has_exactly_one_shading_policy(self):
        # A shape missing from all three sets silently renders flat; a shape in two
        # of them takes whichever branch is checked first. Both are invisible
        # without this.
        policies = (_SHADING_ALL_SMOOTH, _SHADING_SMOOTH_SIDES, _SHADING_FLAT)
        for shape in PRIMITIVE_TYPES:
            with self.subTest(shape=shape):
                owning = [policy for policy in policies if shape in policy]
                self.assertEqual(len(owning), 1)
        union = _SHADING_ALL_SMOOTH | _SHADING_SMOOTH_SIDES | _SHADING_FLAT
        self.assertEqual(union, set(PRIMITIVE_TYPES))


if __name__ == "__main__":
    unittest.main()
