"""Pure-python tests for the inspect_relations geometry math (no bpy)."""

import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))

from cclay.scene_relations import (
    SceneRelationsError,
    _round3,
    build_relations_payload,
    character_metrics,
    cluster_support_planes,
    collect_relations,
    detect_patterns,
    world_aabb,
)

FIXTURE_PATH = pathlib.Path(__file__).parent / "fixtures" / "scene_relations_golden.json"


def _box_corners(minimum, maximum):
    """The 8 corners of an axis-aligned box, bound_box style ordering-free."""
    (x0, y0, z0), (x1, y1, z1) = minimum, maximum
    return [
        [x, y, z]
        for x in (x0, x1)
        for y in (y0, y1)
        for z in (z0, z1)
    ]


def _box_entity(entity_id, minimum, maximum):
    size = [maximum[i] - minimum[i] for i in range(3)]
    return {
        "entity_id": entity_id,
        "aabb_min": list(minimum),
        "aabb_max": list(maximum),
        "top_height": maximum[2],
        "footprint": [size[0], size[1]],
    }


def _uuid(suffix):
    return f"00000000-0000-4000-8000-{suffix:012x}"


class WorldAabbTests(unittest.TestCase):
    def test_min_max_over_rotated_corner_cloud(self):
        corners = _box_corners((-1.5, 0.25, 0.0), (2.5, 1.75, 3.0))
        corners.reverse()  # order must not matter
        minimum, maximum = world_aabb(corners)
        self.assertEqual(minimum, [-1.5, 0.25, 0.0])
        self.assertEqual(maximum, [2.5, 1.75, 3.0])

    def test_empty_input_rejected(self):
        with self.assertRaises(ValueError):
            world_aabb([])


class ClusterSupportPlanesTests(unittest.TestCase):
    def test_tolerance_merge_and_normal_filter(self):
        faces = [
            (0.0, 1.0),
            (0.003, 1.0),   # merges with 0.0 (within 0.005 of running mean)
            (0.1, 1.0),     # new cluster
            (5.0, 0.2),     # rejected: normal z below 0.85
        ]
        planes = cluster_support_planes(faces)
        self.assertEqual(len(planes), 2)
        self.assertAlmostEqual(planes[0], 0.0015)
        self.assertAlmostEqual(planes[1], 0.1)

    def test_ascending_and_capped_at_lowest_clusters(self):
        faces = [(float(i), 1.0) for i in range(12, 0, -1)]  # 12 distinct z
        planes = cluster_support_planes(faces)
        self.assertEqual(planes, [float(i) for i in range(1, 9)])

    def test_no_upward_faces_yields_empty(self):
        self.assertEqual(cluster_support_planes([(1.0, 0.0), (2.0, -1.0)]), [])

    def test_non_finite_samples_skipped(self):
        faces = [
            (float("nan"), 1.0),      # non-finite z
            (float("inf"), 1.0),      # non-finite z
            (0.5, float("nan")),      # non-finite normal z
            (-float("inf"), 1.0),     # non-finite z
            (0.2, 1.0),
        ]
        self.assertEqual(cluster_support_planes(faces), [0.2])


class CharacterMetricsTests(unittest.TestCase):
    def test_name_heuristics_match(self):
        bones = [
            {"name": "mixamorig:Hips", "head_z": 0.95, "tail_z": 1.05},
            {"name": "mixamorig:LeftHand", "head_z": 1.4, "tail_z": 1.45},
            {"name": "mixamorig:Head", "head_z": 1.6, "tail_z": 1.75},
            {"name": "mixamorig:LeftFoot", "head_z": 0.1, "tail_z": 0.02},
        ]
        metrics = character_metrics(bones, [1.0, 1.0, 1.0], [0, 0, 0.0], [0, 0, 1.8])
        self.assertEqual(metrics["bone_count"], 4)
        self.assertAlmostEqual(metrics["standing_height"], 1.8)
        self.assertEqual(metrics["world_scale"], [1.0, 1.0, 1.0])
        self.assertAlmostEqual(metrics["rest_heights"]["lowest"], 0.02)
        self.assertAlmostEqual(metrics["rest_heights"]["pelvis"], 0.95)
        self.assertAlmostEqual(metrics["rest_heights"]["hand"], 1.4)
        self.assertAlmostEqual(metrics["rest_heights"]["head"], 1.6)

    def test_no_match_yields_null_heights(self):
        bones = [{"name": "Bone", "head_z": 0.5, "tail_z": 0.8}]
        metrics = character_metrics(bones, [1, 1, 1], [0, 0, 0], [0, 0, 1])
        self.assertAlmostEqual(metrics["rest_heights"]["lowest"], 0.5)
        self.assertIsNone(metrics["rest_heights"]["pelvis"])
        self.assertIsNone(metrics["rest_heights"]["hand"])
        self.assertIsNone(metrics["rest_heights"]["head"])

    def test_empty_bones_returns_none(self):
        self.assertIsNone(character_metrics([], [1, 1, 1], [0, 0, 0], [0, 0, 1]))

    def test_pelvis_prefers_hips_over_earlier_root(self):
        # Needle-major: 'hips' is tried across ALL bones before 'pelvis' or
        # 'root', so a Root bone listed first must not win.
        bones = [
            {"name": "Root", "head_z": 0.0, "tail_z": 0.1},
            {"name": "Hips", "head_z": 0.95, "tail_z": 1.05},
        ]
        metrics = character_metrics(bones, [1, 1, 1], [0, 0, 0], [0, 0, 1.8])
        self.assertAlmostEqual(metrics["rest_heights"]["pelvis"], 0.95)

    def test_pelvis_falls_back_to_root_without_hips_or_pelvis(self):
        bones = [{"name": "Root", "head_z": 0.02, "tail_z": 0.1}]
        metrics = character_metrics(bones, [1, 1, 1], [0, 0, 0], [0, 0, 1.8])
        self.assertAlmostEqual(metrics["rest_heights"]["pelvis"], 0.02)


class DetectPatternsTests(unittest.TestCase):
    def test_uniform_pitch_rising_tops_forms_one_pattern(self):
        entities = []
        for i in range(4):
            entities.append(_box_entity(
                _uuid(i + 1),
                [0.3 * i, 0.0, 0.0],
                [0.3 * i + 0.4, 1.2, 0.15 * (i + 1)],
            ))
        entities.reverse()  # sorting by center along the spread axis is required
        patterns = detect_patterns(entities)
        self.assertEqual(len(patterns), 1)
        pattern = patterns[0]
        self.assertEqual(pattern["count"], 4)
        self.assertEqual(pattern["entity_ids"], [_uuid(i + 1) for i in range(4)])
        self.assertAlmostEqual(pattern["pitch"][0], 0.3)
        self.assertAlmostEqual(pattern["pitch"][1], 0.0)
        self.assertAlmostEqual(pattern["pitch"][2], 0.15)
        self.assertAlmostEqual(pattern["max_deviation"], 0.0)
        self.assertAlmostEqual(pattern["footprint"][0], 0.4)
        self.assertAlmostEqual(pattern["footprint"][1], 1.2)

    def test_platform_plus_unrelated_boxes_yields_no_pattern(self):
        entities = [
            _box_entity(_uuid(1), [0.0, 0.0, 0.0], [3.0, 2.0, 0.4]),
            _box_entity(_uuid(2), [4.0, 0.0, 0.0], [4.4, 0.4, 0.5]),
            _box_entity(_uuid(3), [6.0, 0.0, 0.0], [7.0, 0.7, 0.9]),
        ]
        self.assertEqual(detect_patterns(entities), [])

    def test_irregular_pitch_rejected(self):
        entities = [
            _box_entity(_uuid(1), [0.0, 0.0, 0.0], [0.4, 0.4, 0.2]),
            _box_entity(_uuid(2), [0.3, 0.0, 0.0], [0.7, 0.4, 0.2]),
            _box_entity(_uuid(3), [1.5, 0.0, 0.0], [1.9, 0.4, 0.2]),  # 0.9 gap
        ]
        self.assertEqual(detect_patterns(entities), [])

    def test_outlier_member_no_longer_disqualifies_regular_run(self):
        # 3 regular members plus 1 off-lattice outlier with the same
        # footprint: the largest regular consecutive run is reported.
        entities = [
            _box_entity(_uuid(1), [0.0, 0.0, 0.0], [0.4, 0.4, 0.2]),
            _box_entity(_uuid(2), [0.3, 0.0, 0.0], [0.7, 0.4, 0.2]),
            _box_entity(_uuid(3), [0.6, 0.0, 0.0], [1.0, 0.4, 0.2]),
            _box_entity(_uuid(4), [1.5, 0.0, 0.0], [1.9, 0.4, 0.2]),  # outlier
        ]
        patterns = detect_patterns(entities)
        self.assertEqual(len(patterns), 1)
        pattern = patterns[0]
        self.assertEqual(pattern["entity_ids"], [_uuid(1), _uuid(2), _uuid(3)])
        self.assertEqual(pattern["count"], 3)
        self.assertAlmostEqual(pattern["pitch"][0], 0.3)
        self.assertAlmostEqual(pattern["max_deviation"], 0.0)

    def test_off_lattice_middle_keeps_larger_regular_run(self):
        # 6 members; index 2 (sorted) sits off-lattice, splitting the row into
        # a 2-member prefix and a 3-member suffix — only the larger regular
        # consecutive run (>= 3 members) is reported.
        entities = [
            _box_entity(_uuid(1), [0.0, 0.0, 0.0], [0.4, 0.4, 0.2]),
            _box_entity(_uuid(2), [0.3, 0.0, 0.0], [0.7, 0.4, 0.2]),
            _box_entity(_uuid(3), [0.75, 0.0, 0.0], [1.15, 0.4, 0.2]),  # off-lattice
            _box_entity(_uuid(4), [0.9, 0.0, 0.0], [1.3, 0.4, 0.2]),
            _box_entity(_uuid(5), [1.2, 0.0, 0.0], [1.6, 0.4, 0.2]),
            _box_entity(_uuid(6), [1.5, 0.0, 0.0], [1.9, 0.4, 0.2]),
        ]
        patterns = detect_patterns(entities)
        self.assertEqual(len(patterns), 1)
        pattern = patterns[0]
        self.assertEqual(pattern["entity_ids"], [_uuid(4), _uuid(5), _uuid(6)])
        self.assertEqual(pattern["count"], 3)
        self.assertAlmostEqual(pattern["pitch"][0], 0.3)
        self.assertAlmostEqual(pattern["max_deviation"], 0.0)


class RoundingTests(unittest.TestCase):
    def test_negative_zero_normalizes(self):
        self.assertEqual(repr(_round3(-0.0)), "0.0")
        self.assertEqual(repr(_round3(-0.0001)), "0.0")
        self.assertEqual(_round3(-0.001), -0.001)

    def test_three_decimals(self):
        self.assertEqual(_round3(1.23456), 1.235)
        self.assertEqual(_round3(2), 2.0)


class BuildRelationsPayloadTests(unittest.TestCase):
    REVISION = "ab" * 32

    def _rows(self):
        rows = []
        for i in range(3):
            rows.append({
                "entity_id": _uuid(i + 1),
                "name": f"Box{i + 1}",
                "type": "MESH",
                "aabb_min": [0.3 * i, -0.0001, 0.0],
                "aabb_max": [0.3 * i + 0.4, 1.2, 0.15 * (i + 1)],
                "support_planes": [0.15 * (i + 1)],
            })
        return rows

    def _reference(self):
        return {
            "entity_id": _uuid(9),
            "name": "Rig",
            "type": "ARMATURE",
            "origin": [-1.0, 0.6, 0.0],
            "aabb_min": [-1.3, 0.3, 0.0],
            "aabb_max": [-0.7, 0.9, 1.8],
            "character": character_metrics(
                [{"name": "Hips", "head_z": 0.95, "tail_z": 1.05}],
                [1.0, 1.0, 1.0],
                [-1.3, 0.3, 0.0],
                [-0.7, 0.9, 1.8],
            ),
        }

    def test_full_payload_shape(self):
        payload = build_relations_payload(
            self.REVISION, self._rows(), self._reference()
        )
        self.assertEqual(
            set(payload),
            {"revision", "schema_version", "reference", "entities", "patterns"},
        )
        self.assertEqual(payload["revision"], self.REVISION)
        self.assertEqual(payload["schema_version"], 1)

        reference = payload["reference"]
        self.assertEqual(
            set(reference),
            {"entity_id", "name", "type", "origin", "aabb_min", "aabb_max", "character"},
        )
        self.assertEqual(reference["character"]["bone_count"], 1)
        self.assertEqual(reference["character"]["standing_height"], 1.8)
        self.assertEqual(reference["character"]["rest_heights"]["pelvis"], 0.95)
        self.assertIsNone(reference["character"]["rest_heights"]["hand"])

        self.assertEqual(len(payload["entities"]), 3)
        entity = payload["entities"][0]
        self.assertEqual(
            set(entity),
            {
                "entity_id", "name", "type", "aabb_min", "aabb_max", "size",
                "top_height", "support_planes", "footprint", "relative",
            },
        )
        # -0.0001 rounds to -0.0 and must normalize to +0.0
        self.assertEqual(repr(entity["aabb_min"][1]), "0.0")
        self.assertEqual(entity["size"], [0.4, 1.2, 0.15])
        self.assertEqual(entity["top_height"], 0.15)
        self.assertEqual(entity["footprint"], [0.4, 1.2])

        relative = entity["relative"]
        self.assertEqual(
            set(relative),
            {"offset", "horizontal_distance", "direction", "top_above_reference_base"},
        )
        # center (0.2, 0.6, 0.075) - origin (-1.0, 0.6, 0.0)
        self.assertEqual(relative["offset"], [1.2, 0.0, 0.075])
        self.assertEqual(relative["horizontal_distance"], 1.2)
        self.assertEqual(relative["direction"], [1.0, 0.0])
        self.assertEqual(relative["top_above_reference_base"], 0.15)

        self.assertEqual(len(payload["patterns"]), 1)
        pattern = payload["patterns"][0]
        self.assertEqual(
            set(pattern),
            {"entity_ids", "count", "pitch", "max_deviation", "footprint"},
        )
        self.assertEqual(pattern["count"], 3)
        self.assertEqual(pattern["pitch"], [0.3, 0.0, 0.15])

    def test_no_reference_yields_nulls(self):
        payload = build_relations_payload(self.REVISION, self._rows(), None)
        self.assertIsNone(payload["reference"])
        for entity in payload["entities"]:
            self.assertIsNone(entity["relative"])

    def test_zero_horizontal_offset_direction_null(self):
        rows = [{
            "entity_id": _uuid(1),
            "name": "Box",
            "type": "MESH",
            "aabb_min": [-0.5, -0.5, 0.0],
            "aabb_max": [0.5, 0.5, 2.0],
            "support_planes": [],
        }]
        reference = dict(self._reference(), origin=[0.0, 0.0, 0.0])
        payload = build_relations_payload(self.REVISION, rows, reference)
        relative = payload["entities"][0]["relative"]
        self.assertEqual(relative["horizontal_distance"], 0.0)
        self.assertIsNone(relative["direction"])

    def test_non_finite_aabb_raises_non_finite_geometry(self):
        rows = [{
            "entity_id": _uuid(1),
            "name": "Box",
            "type": "MESH",
            "aabb_min": [0.0, 0.0, 0.0],
            "aabb_max": [1.0, float("nan"), 1.0],
            "support_planes": [],
        }]
        with self.assertRaises(SceneRelationsError) as ctx:
            build_relations_payload(self.REVISION, rows, None)
        self.assertEqual(ctx.exception.code, "NON_FINITE_GEOMETRY")
        self.assertTrue(
            str(ctx.exception).startswith("NON_FINITE_GEOMETRY:"),
            str(ctx.exception),
        )


class CollectRelationsValidationTests(unittest.TestCase):
    """Param validation runs before any bpy access, so it is testable here."""

    def _invalid(self, params):
        with self.assertRaises(SceneRelationsError) as ctx:
            collect_relations("ab" * 32, params)
        self.assertEqual(ctx.exception.code, "INVALID_INSPECT_RELATIONS_PARAMS")
        self.assertTrue(
            str(ctx.exception).startswith("INVALID_INSPECT_RELATIONS_PARAMS:"),
            str(ctx.exception),
        )

    def test_rejects_non_object_params(self):
        self._invalid(None)
        self._invalid([])

    def test_rejects_unknown_fields(self):
        self._invalid({"entityIds": [_uuid(1)]})

    def test_rejects_bad_entity_ids(self):
        self._invalid({"entity_ids": []})
        self._invalid({"entity_ids": "not-a-list"})
        self._invalid({"entity_ids": ["not-a-uuid"]})
        self._invalid({"entity_ids": ["ABCDEF00-0000-4000-8000-00000000000A"]})
        self._invalid({"entity_ids": [_uuid(1)] * 2})
        self._invalid({"entity_ids": [_uuid(i + 1) for i in range(65)]})

    def test_rejects_bad_reference_entity_id(self):
        self._invalid({"reference_entity_id": "bogus"})

    def test_rejects_explicit_nulls(self):
        # Key-presence parity with the TS Type.Optional contract: explicit
        # null is not the same as an absent optional field.
        self._invalid({"entity_ids": None})
        self._invalid({"reference_entity_id": None})
        self._invalid({"entity_ids": [_uuid(1)], "reference_entity_id": None})
        self._invalid({"entity_ids": None, "reference_entity_id": _uuid(1)})


def build_golden_payload():
    """Deterministic generator for the committed TS drift-net fixture.

    Covers reference + character (with a null-able rest height), a pattern of
    three crates, a direction:null relative (pillar centered above the rig),
    and an entity with empty support_planes.
    """
    rows = []
    for i in range(3):
        rows.append({
            "entity_id": _uuid(i + 1),
            "name": f"Crate{i + 1}",
            "type": "MESH",
            "aabb_min": [0.3 * i, 0.0, 0.0],
            "aabb_max": [0.3 * i + 0.4, 1.2, 0.15 * (i + 1)],
            "support_planes": [0.15 * (i + 1)],
        })
    rows.append({
        "entity_id": _uuid(8),
        "name": "Pillar",
        "type": "MESH",
        "aabb_min": [-1.5, 0.1, 0.0],
        "aabb_max": [-0.5, 1.1, 2.0],
        "support_planes": [],
    })
    reference = {
        "entity_id": _uuid(9),
        "name": "Rig",
        "type": "ARMATURE",
        "origin": [-1.0, 0.6, 0.0],
        "aabb_min": [-1.3, 0.3, 0.0],
        "aabb_max": [-0.7, 0.9, 1.8],
        "character": character_metrics(
            [
                {"name": "Root", "head_z": 0.0, "tail_z": 0.1},
                {"name": "Hips", "head_z": 0.95, "tail_z": 1.05},
                {"name": "Head", "head_z": 1.6, "tail_z": 1.75},
            ],
            [1.0, 1.0, 1.0],
            [-1.3, 0.3, 0.0],
            [-0.7, 0.9, 1.8],
        ),
    }
    return build_relations_payload("0" * 64, rows, reference)


class GoldenFixtureTests(unittest.TestCase):
    def test_golden_payload_covers_contract_variants(self):
        payload = build_golden_payload()
        self.assertEqual(payload["revision"], "0" * 64)
        self.assertEqual(payload["reference"]["character"]["rest_heights"]["pelvis"], 0.95)
        self.assertIsNone(payload["reference"]["character"]["rest_heights"]["hand"])
        self.assertEqual(len(payload["patterns"]), 1)
        pillar = payload["entities"][3]
        self.assertEqual(pillar["support_planes"], [])
        self.assertIsNone(pillar["relative"]["direction"])

    def test_golden_fixture_matches_committed_json(self):
        """Drift net: the TS protocol test parses this exact committed file."""
        committed = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        regenerated = json.loads(json.dumps(build_golden_payload()))
        self.assertEqual(committed, regenerated)


if __name__ == "__main__":
    unittest.main()
