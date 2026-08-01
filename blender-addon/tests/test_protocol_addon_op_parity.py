"""Drift net: the addon's retained stage_scene validator must accept exactly
the operation and per-operation key surface declared by the TypeScript schema.

Generated manifest-only rows deliberately contribute no stage_scene operations.
This test extracts both sources and fails loudly if the retained handwritten
union drifts in either direction.
"""

import pathlib
import re
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))

from cclay.stage_scene import _OPERATION_KEYS

TS_SOURCE = (
    pathlib.Path(__file__).parents[2]
    / "packages" / "blender-protocol" / "src" / "stage-scene.ts"
)
GENERATED_TS_SOURCE = (
    pathlib.Path(__file__).parents[2]
    / "packages" / "blender-protocol" / "src" / "stage-scene-ops.generated.ts"
)

_OP_LITERAL = re.compile(r'op:\s*Type\.Literal\("([a-z_]+)"\)')
_SCHEMA_DECL = re.compile(r"^(?:export )?const (\w+) =", re.MULTILINE)
_KEY_LINE = re.compile(r"^(\t+)([a-z_][a-z0-9_]*):", re.MULTILINE)
_APPLY_MOTION_BRANCH = re.compile(r"^\texact\(", re.MULTILINE)
# bare + hand_pose + hand_shapes{left,right,both} + hand_track{left,right,both}
_APPLY_MOTION_BRANCHES = 8


def _plan_schema_chunks(source: str) -> dict[str, str]:
    """Map plan-side (non-Request) schema declaration name -> declaration text."""
    matches = list(_SCHEMA_DECL.finditer(source))
    chunks: dict[str, str] = {}
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(source)
        chunks[match.group(1)] = source[match.start():end]
    return {
        name: chunk
        for name, chunk in chunks.items()
        if not name.endswith("RequestSchema") and not name.endswith("Result")
    }


def _top_level_keys(chunk: str, schema_name: str) -> set[str]:
    """Field names at the shallowest tab depth of one schema object literal."""
    key_lines = _KEY_LINE.findall(chunk)
    if not key_lines:
        raise AssertionError(
            f"no tab-indented keys extracted from TS schema {schema_name}; "
            "stage-scene.ts may have been reindented with spaces "
            "(_KEY_LINE matches tab indentation only), which would silently "
            "degrade this parity test to a no-op"
        )
    minimum = min(len(indent) for indent, _ in key_lines)
    return {key for indent, key in key_lines if len(indent) == minimum}


def _apply_motion_keys(chunks: dict[str, str], base_chunk: str) -> set[str]:
    """Union the shared fields with every ApplyMotion extension branch.

    Eight branches: bare, hand_pose, three hand_shapes shapes (left / right /
    both), and three hand_track shapes (left / right / both).
    """
    union_name = "ApplyMotionSchema"
    try:
        union_chunk = chunks[union_name]
    except KeyError as exc:
        raise AssertionError(
            f"TS schema {union_name} is missing; apply_motion parity would be incomplete"
        ) from exc
    branch_count = len(_APPLY_MOTION_BRANCH.findall(union_chunk))
    if branch_count != _APPLY_MOTION_BRANCHES:
        raise AssertionError(
            f"TS schema {union_name} has {branch_count} branches, expected "
            f"{_APPLY_MOTION_BRANCHES}; update the apply_motion union extractor "
            "rather than silently skipping branches"
        )
    return _top_level_keys(base_chunk, "applyMotionFields") | _top_level_keys(
        union_chunk, union_name
    )


class ProtocolAddonOpParityTests(unittest.TestCase):
    def setUp(self):
        self.source = TS_SOURCE.read_text(encoding="utf-8")
        self.generated_source = GENERATED_TS_SOURCE.read_text(encoding="utf-8")
        self.schema_source = f"{self.source}\n{self.generated_source}"

    def test_op_name_sets_are_identical_both_directions(self):
        ts_ops = set(_OP_LITERAL.findall(self.schema_source))
        self.assertNotIn(
            "...GeneratedStageSceneOperationSchemas",
            self.source,
            "manifest-only registry rows must not enter StageSceneOperationV1Schema",
        )
        self.assertEqual(
            _OP_LITERAL.findall(self.generated_source),
            [],
            "manifest-only generated source must not declare stage_scene operations",
        )
        addon_ops = set(_OPERATION_KEYS)
        self.assertTrue(ts_ops, f"no op literals extracted from {TS_SOURCE}")
        missing_in_addon = sorted(ts_ops - addon_ops)
        missing_in_ts = sorted(addon_ops - ts_ops)
        self.assertEqual(
            missing_in_addon,
            [],
            "ops declared in the TS StageSceneOperationV1 union but rejected by "
            f"the addon's _OPERATION_KEYS (add them to stage_scene.py): {missing_in_addon}",
        )
        self.assertEqual(
            missing_in_ts,
            [],
            "ops accepted by the addon's _OPERATION_KEYS but absent from the TS "
            f"StageSceneOperationV1 union (remove or port them): {missing_in_ts}",
        )

    def test_per_op_key_surfaces_are_identical(self):
        compared_ops = 0
        chunks = _plan_schema_chunks(self.source)
        chunks.update(_plan_schema_chunks(self.generated_source))
        for name, chunk in chunks.items():
            op_literals = _OP_LITERAL.findall(chunk)
            if not op_literals:
                continue  # plan/result container schemas, not one operation
            self.assertEqual(
                len(op_literals), 1,
                f"TS schema {name} declares {len(op_literals)} op literals "
                f"{op_literals}; each operation schema must declare exactly one "
                "(a merged chunk would silently skip per-op key comparison)",
            )
            op = op_literals[0]
            with self.subTest(op=op, schema=name):
                self.assertIn(
                    op, _OPERATION_KEYS,
                    f"TS schema {name} declares op {op!r} unknown to the addon",
                )
                ts_keys = (
                    _apply_motion_keys(chunks, chunk)
                    if name == "applyMotionFields"
                    else _top_level_keys(chunk, name)
                )
                addon_keys = set(_OPERATION_KEYS[op])
                self.assertEqual(
                    ts_keys,
                    addon_keys,
                    f"key surface drift for op {op!r}: TS-only keys "
                    f"{sorted(ts_keys - addon_keys)}, addon-only keys "
                    f"{sorted(addon_keys - ts_keys)}",
                )
                compared_ops += 1
        self.assertGreaterEqual(
            compared_ops,
            len(_OPERATION_KEYS),
            f"only {compared_ops} per-op key-surface comparisons ran for "
            f"{len(_OPERATION_KEYS)} addon ops; the TS schema extraction has "
            "silently degraded (regex or file-layout drift)",
        )


if __name__ == "__main__":
    unittest.main()
