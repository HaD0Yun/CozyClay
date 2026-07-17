"""Cross-language parity tests for the Scene Snapshot v2 canonical serializer."""

from __future__ import annotations

import json
import math
import sys
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

from oh_my_blender.canonical import (  # noqa: E402
    canonical_json,
    canonical_number,
    canonical_revision,
    canonical_string,
)

FIXTURES = REPOSITORY_ROOT / "packages" / "blender-director" / "test" / "fixtures"


class CanonicalNumberTest(unittest.TestCase):
    def test_shared_number_table(self) -> None:
        cases = json.loads((FIXTURES / "canonical-numbers.json").read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(cases), 30)
        for case in cases:
            with self.subTest(value=case["value"]):
                self.assertEqual(canonical_number(case["value"]), case["expected"])

    def test_half_even_ties(self) -> None:
        # 2^-10 * 1e9 = 976562.5 exactly: even quotient stays, odd rounds up.
        self.assertEqual(canonical_number(0.0009765625), "0.000976562")
        self.assertEqual(canonical_number(0.0029296875), "0.002929688")

    def test_zero_normalization(self) -> None:
        self.assertEqual(canonical_number(-0.0), "0")
        self.assertEqual(canonical_number(1e-10), "0")
        self.assertEqual(canonical_number(-1e-10), "0")

    def test_rejections(self) -> None:
        for bad in (math.nan, math.inf, -math.inf, 1e15, -1e15):
            with self.subTest(value=bad), self.assertRaises(ValueError):
                canonical_number(bad)
        with self.assertRaises(TypeError):
            canonical_number(True)


class CanonicalStringTest(unittest.TestCase):
    def test_nfc_and_minimal_escaping(self) -> None:
        self.assertEqual(canonical_string("e\u0301"), '"\u00e9"')
        self.assertEqual(canonical_string('a"b\\c\nd\u0001'), '"a\\"b\\\\c\\nd\\u0001"')

    def test_code_point_key_order(self) -> None:
        self.assertEqual(canonical_json({"a": 1, "B": 2}), '{"B":2,"a":1}')


class CanonicalRevisionTest(unittest.TestCase):
    def test_parity_snapshot_revision(self) -> None:
        parity = json.loads((FIXTURES / "parity-snapshot.json").read_text(encoding="utf-8"))
        self.assertEqual(canonical_revision(parity["snapshot"]), parity["revision"])

    def test_reparse_idempotence(self) -> None:
        parity = json.loads((FIXTURES / "parity-snapshot.json").read_text(encoding="utf-8"))
        first = canonical_json(parity["snapshot"])
        second = canonical_json(json.loads(first))
        self.assertEqual(second, first)


if __name__ == "__main__":
    unittest.main()
