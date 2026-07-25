"""Pure-python tests for the inspect_pose_contacts geometry math (no bpy).

Issue #2: an ARDY foot-joint constraint can be numerically exact while the
deformed sole mesh floats above or penetrates the declared support geometry.
These tests pin down that ``surface_contact_verified`` is derived only from
the deformed ``sole_co`` against declared support AABBs -- never from
``foot_joint_co`` -- across floating, penetration, outside-footprint,
boundary-gap, and malformed-request cases, and that the emitted payload
matches the closed public schema in
``packages/blender-protocol/src/pose-contacts.ts`` exactly: fixed gate
(no override), singular ``gate``, and the exact side/support field names
and nullability the TS schema requires.
"""

import json
import math
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))

from cclay.pose_contacts import (
    DEFAULT_MAX_GAP_M,
    DEFAULT_MIN_EDGE_MARGIN_M,
    MAX_FRAMES,
    MAX_SUPPORT_ENTITIES,
    PoseContactsError,
    _nearest_support,
    _side_contact,
    _validated_params,
    _xy_footprint_margin,
    build_pose_contacts_payload,
)

FIXTURE_PATH = pathlib.Path(__file__).parent / "fixtures" / "pose_contacts_golden.json"


def _uuid(suffix):
    return f"00000000-0000-4000-8000-{suffix:012x}"


FLOOR = {
    "entity_id": _uuid(2),
    "name": "Floor",
    "aabb_min": [-2.0, -2.0, 0.0],
    "aabb_max": [2.0, 2.0, 0.0],
}
STAIR = {
    "entity_id": _uuid(3),
    "name": "Stair1",
    "aabb_min": [0.0, -0.6, 0.18],
    "aabb_max": [1.2, 0.6, 0.18],
}


def _side_sample(
    foot_joint_co,
    heel_co,
    toe_co,
    sole_co,
    sole_source="deformed_mesh",
    toe_joint_co=None,
):
    heel_to_toe = (
        [toe_co[axis] - heel_co[axis] for axis in range(3)]
        if heel_co is not None and toe_co is not None
        else None
    )
    return {
        "foot_joint_co": foot_joint_co,
        "toe_joint_co": toe_joint_co,
        "heel_co": heel_co,
        "toe_co": toe_co,
        "sole_co": sole_co,
        "sole_source": sole_source,
        "heel_to_toe": heel_to_toe,
    }


class XyFootprintMarginTests(unittest.TestCase):
    def test_center_is_half_the_smaller_extent(self):
        margin = _xy_footprint_margin(0.0, 0.0, [-1.0, -0.5, 0.0], [1.0, 0.5, 0.0])
        self.assertAlmostEqual(margin, 0.5)

    def test_exactly_on_edge_is_zero(self):
        margin = _xy_footprint_margin(1.0, 0.0, [-1.0, -1.0, 0.0], [1.0, 1.0, 0.0])
        self.assertAlmostEqual(margin, 0.0)

    def test_outside_on_one_axis_is_negative(self):
        margin = _xy_footprint_margin(1.5, 0.0, [-1.0, -1.0, 0.0], [1.0, 1.0, 0.0])
        self.assertAlmostEqual(margin, -0.5)


class NearestSupportTests(unittest.TestCase):
    def test_picks_the_smaller_absolute_vertical_gap(self):
        nearest = _nearest_support(0.08, [FLOOR, STAIR])
        self.assertEqual(nearest["entity_id"], FLOOR["entity_id"])

    def test_ties_resolve_to_declaration_order(self):
        same_a = {"entity_id": _uuid(10), "name": "A", "aabb_min": [0, 0, 0], "aabb_max": [1, 1, 0.1]}
        same_b = {"entity_id": _uuid(11), "name": "B", "aabb_min": [0, 0, 0], "aabb_max": [1, 1, 0.1]}
        nearest = _nearest_support(0.1, [same_a, same_b])
        self.assertEqual(nearest["entity_id"], same_a["entity_id"])


class SideContactTests(unittest.TestCase):
    """Issue #2 core regression surface: sole vs support, never joint vs support."""

    def test_side_with_no_joint_evidence_is_entirely_absent(self):
        sample = _side_sample(
            foot_joint_co=None,
            heel_co=None,
            toe_co=None,
            sole_co=None,
            sole_source=None,
            toe_joint_co=None,
        )
        entry = _side_contact(sample, [FLOOR], DEFAULT_MAX_GAP_M, DEFAULT_MIN_EDGE_MARGIN_M)
        self.assertIsNone(entry)

    def test_side_with_foot_joint_but_no_toe_joint_is_entirely_absent(self):
        """foot_joint_position and toe_joint_position are both required,
        non-nullable fields whenever a side is present at all -- a partial
        joint sample is withheld, never padded with a guessed value."""
        sample = _side_sample(
            foot_joint_co=[0.0, 0.0, 0.0],
            heel_co=[0.0, 0.0, 0.0],
            toe_co=[0.1, 0.0, 0.0],
            sole_co=[0.0, 0.0, 0.0],
            toe_joint_co=None,
        )
        entry = _side_contact(sample, [FLOOR], DEFAULT_MAX_GAP_M, DEFAULT_MIN_EDGE_MARGIN_M)
        self.assertIsNone(entry)

    def test_floating_sole_is_not_verified(self):
        sample = _side_sample(
            foot_joint_co=[-0.1, 0.0, 0.15],
            toe_joint_co=[-0.1, 0.1, 0.15],
            heel_co=[-0.15, -0.05, 0.08],
            toe_co=[-0.05, 0.05, 0.09],
            sole_co=[-0.15, -0.05, 0.08],
        )
        entry = _side_contact(sample, [FLOOR], DEFAULT_MAX_GAP_M, DEFAULT_MIN_EDGE_MARGIN_M)
        self.assertAlmostEqual(entry["support"]["support_gap_m"], 0.08)
        self.assertTrue(entry["support"]["inside_support_footprint"])
        self.assertFalse(entry["support"]["surface_contact_verified"])

    def test_penetrating_sole_is_not_verified(self):
        sample = _side_sample(
            foot_joint_co=[0.1, 0.0, 0.02],
            toe_joint_co=[0.1, 0.1, 0.02],
            heel_co=[0.05, -0.05, -0.06],
            toe_co=[0.15, 0.05, -0.055],
            sole_co=[0.05, -0.05, -0.06],
        )
        entry = _side_contact(sample, [FLOOR], DEFAULT_MAX_GAP_M, DEFAULT_MIN_EDGE_MARGIN_M)
        self.assertAlmostEqual(entry["support"]["support_gap_m"], -0.06)
        self.assertFalse(entry["support"]["surface_contact_verified"])

    def test_outside_footprint_is_not_verified_even_with_a_perfect_gap(self):
        sample = _side_sample(
            foot_joint_co=[3.0, 0.0, 0.0],
            toe_joint_co=[3.0, 0.1, 0.0],
            heel_co=[3.0, 0.0, 0.0],
            toe_co=[3.1, 0.0, 0.0],
            sole_co=[3.0, 0.0, 0.0],
        )
        entry = _side_contact(sample, [FLOOR], DEFAULT_MAX_GAP_M, DEFAULT_MIN_EDGE_MARGIN_M)
        self.assertAlmostEqual(entry["support"]["support_gap_m"], 0.0)
        self.assertFalse(entry["support"]["inside_support_footprint"])
        self.assertLess(entry["support"]["edge_margin_m"], 0.0)
        self.assertFalse(entry["support"]["surface_contact_verified"])

    def test_gap_exactly_at_the_default_threshold_is_verified(self):
        sample = _side_sample(
            foot_joint_co=[0.0, 0.0, 0.03],
            toe_joint_co=[0.0, 0.1, 0.03],
            heel_co=[0.0, 0.0, 0.03],
            toe_co=[0.1, 0.0, 0.03],
            sole_co=[0.0, 0.0, 0.03],
        )
        entry = _side_contact(sample, [FLOOR], DEFAULT_MAX_GAP_M, DEFAULT_MIN_EDGE_MARGIN_M)
        self.assertAlmostEqual(entry["support"]["support_gap_m"], 0.03)
        self.assertTrue(entry["support"]["surface_contact_verified"])

    def test_gap_one_millimeter_past_the_threshold_is_not_verified(self):
        sample = _side_sample(
            foot_joint_co=[0.0, 0.0, 0.031],
            toe_joint_co=[0.0, 0.1, 0.031],
            heel_co=[0.0, 0.0, 0.031],
            toe_co=[0.1, 0.0, 0.031],
            sole_co=[0.0, 0.0, 0.031],
        )
        entry = _side_contact(sample, [FLOOR], DEFAULT_MAX_GAP_M, DEFAULT_MIN_EDGE_MARGIN_M)
        self.assertFalse(entry["support"]["surface_contact_verified"])

    def test_joint_exact_but_sole_wrong_fails_closed(self):
        """The failure issue #2 exists to catch: foot_joint_co sits exactly on
        the support plane (what a naive joint-distance check would call a
        perfect contact) while the deformed sole is floating well above it.
        """
        sample = _side_sample(
            foot_joint_co=[0.0, 0.0, 0.0],   # joint exactly at support top
            toe_joint_co=[0.0, 0.1, 0.0],
            heel_co=[0.0, 0.0, 0.17],
            toe_co=[0.1, 0.0, 0.18],
            sole_co=[0.0, 0.0, 0.17],        # deformed sole floats 0.17m up
        )
        entry = _side_contact(sample, [FLOOR], DEFAULT_MAX_GAP_M, DEFAULT_MIN_EDGE_MARGIN_M)
        self.assertEqual(entry["foot_joint_position"], [0.0, 0.0, 0.0])
        self.assertAlmostEqual(entry["support"]["support_gap_m"], 0.17)
        self.assertFalse(entry["support"]["surface_contact_verified"])

    def test_joint_to_sole_offset_is_the_measured_difference_never_a_guess(self):
        sample = _side_sample(
            foot_joint_co=[0.0, 0.0, 0.2],
            toe_joint_co=[0.0, 0.1, 0.2],
            heel_co=[0.0, 0.0, 0.03],
            toe_co=[0.1, 0.0, 0.04],
            sole_co=[0.0, 0.0, 0.03],
        )
        entry = _side_contact(sample, [FLOOR], DEFAULT_MAX_GAP_M, DEFAULT_MIN_EDGE_MARGIN_M)
        self.assertEqual(entry["joint_to_sole_offset_m"], [0.0, 0.0, -0.17])

    def test_unresolved_sole_withholds_verification_rather_than_guessing(self):
        sample = _side_sample(
            foot_joint_co=[0.0, 0.0, 0.0],
            toe_joint_co=[0.0, 0.1, 0.0],
            heel_co=None,
            toe_co=None,
            sole_co=None,
            sole_source=None,
        )
        entry = _side_contact(sample, [FLOOR], DEFAULT_MAX_GAP_M, DEFAULT_MIN_EDGE_MARGIN_M)
        self.assertIsNotNone(entry)
        self.assertIsNone(entry["sole_point"])
        self.assertIsNone(entry["sole_source"])
        self.assertIsNone(entry["joint_to_sole_offset_m"])
        self.assertIsNone(entry["support"])
        self.assertEqual(entry["contact_basis"], "deformed_mesh")

    def test_custom_min_edge_margin_gate_tightens_verification(self):
        narrow_plate = {
            "entity_id": _uuid(20),
            "name": "NarrowPlate",
            "aabb_min": [-0.02, -1.0, 0.0],
            "aabb_max": [1.0, 1.0, 0.0],
        }
        sample = _side_sample(
            foot_joint_co=[0.0, 0.0, 0.0],
            toe_joint_co=[0.0, 0.1, 0.0],
            heel_co=[0.0, 0.0, 0.0],
            toe_co=[0.1, 0.0, 0.0],
            sole_co=[0.0, 0.0, 0.0],  # 0.02m from the near edge at x=-0.02
        )
        # A 0.0 minimum margin verifies; a 0.05m minimum margin rejects the same sample.
        loose = _side_contact(sample, [narrow_plate], DEFAULT_MAX_GAP_M, 0.0)
        strict = _side_contact(sample, [narrow_plate], DEFAULT_MAX_GAP_M, 0.05)
        self.assertAlmostEqual(loose["support"]["edge_margin_m"], 0.02)
        self.assertTrue(loose["support"]["surface_contact_verified"])
        self.assertFalse(strict["support"]["surface_contact_verified"])


class ValidatedParamsTests(unittest.TestCase):
    def _base_params(self):
        return {
            "character_entity_id": _uuid(1),
            "frames": [1, 2, 3],
            "support_entity_ids": [_uuid(2)],
        }

    def test_valid_request_returns_the_closed_fields(self):
        result = _validated_params(self._base_params())
        self.assertEqual(result, (_uuid(1), [1, 2, 3], [_uuid(2)]))

    def test_unknown_field_rejected(self):
        params = self._base_params()
        params["bogus"] = 1
        with self.assertRaises(PoseContactsError):
            _validated_params(params)

    def test_gate_override_fields_are_rejected_as_unknown(self):
        """The public params schema is closed over exactly
        character_entity_id/frames/support_entity_ids; max_gap_m/
        min_edge_margin_m are addon-only and must never be accepted."""
        for field, value in (("max_gap_m", 0.05), ("min_edge_margin_m", 0.02)):
            params = self._base_params()
            params[field] = value
            with self.assertRaises(PoseContactsError) as ctx:
                _validated_params(params)
            self.assertEqual(ctx.exception.code, "INVALID_INSPECT_POSE_CONTACTS_PARAMS")

    def test_malformed_character_entity_id_rejected(self):
        params = self._base_params()
        params["character_entity_id"] = "not-a-uuid"
        with self.assertRaises(PoseContactsError):
            _validated_params(params)

    def test_empty_frames_rejected(self):
        params = self._base_params()
        params["frames"] = []
        with self.assertRaises(PoseContactsError):
            _validated_params(params)

    def test_too_many_frames_rejected(self):
        params = self._base_params()
        params["frames"] = list(range(MAX_FRAMES + 1))
        with self.assertRaises(PoseContactsError):
            _validated_params(params)

    def test_max_frames_is_thirty_two(self):
        self.assertEqual(MAX_FRAMES, 32)
        params = self._base_params()
        params["frames"] = list(range(MAX_FRAMES))
        result = _validated_params(params)
        self.assertEqual(len(result[1]), 32)

    def test_duplicate_frames_rejected(self):
        params = self._base_params()
        params["frames"] = [1, 1, 2]
        with self.assertRaises(PoseContactsError):
            _validated_params(params)

    def test_negative_frame_rejected(self):
        params = self._base_params()
        params["frames"] = [-1]
        with self.assertRaises(PoseContactsError):
            _validated_params(params)

    def test_non_integer_frame_rejected(self):
        params = self._base_params()
        params["frames"] = [1.5]
        with self.assertRaises(PoseContactsError):
            _validated_params(params)

    def test_boolean_frame_rejected(self):
        params = self._base_params()
        params["frames"] = [True]
        with self.assertRaises(PoseContactsError):
            _validated_params(params)

    def test_empty_support_entity_ids_rejected(self):
        params = self._base_params()
        params["support_entity_ids"] = []
        with self.assertRaises(PoseContactsError):
            _validated_params(params)

    def test_too_many_support_entity_ids_rejected(self):
        params = self._base_params()
        params["support_entity_ids"] = [_uuid(i) for i in range(MAX_SUPPORT_ENTITIES + 1)]
        with self.assertRaises(PoseContactsError):
            _validated_params(params)

    def test_max_support_entity_ids_is_sixteen(self):
        self.assertEqual(MAX_SUPPORT_ENTITIES, 16)
        params = self._base_params()
        params["support_entity_ids"] = [_uuid(i) for i in range(MAX_SUPPORT_ENTITIES)]
        result = _validated_params(params)
        self.assertEqual(len(result[2]), 16)

    def test_duplicate_support_entity_ids_rejected(self):
        params = self._base_params()
        params["support_entity_ids"] = [_uuid(2), _uuid(2)]
        with self.assertRaises(PoseContactsError):
            _validated_params(params)

    def test_malformed_support_entity_id_rejected(self):
        params = self._base_params()
        params["support_entity_ids"] = ["not-a-uuid"]
        with self.assertRaises(PoseContactsError):
            _validated_params(params)

    def test_params_not_a_dict_rejected(self):
        with self.assertRaises(PoseContactsError):
            _validated_params(["not", "a", "dict"])


class BuildPayloadTests(unittest.TestCase):
    def test_non_finite_sole_is_rejected(self):
        samples = [{
            "frame": 1,
            "sides": {
                "left": _side_sample(
                    [0, 0, 0], [0, 0, float("nan")], [0.1, 0, 0], [0, 0, float("nan")],
                    toe_joint_co=[0, 0.1, 0],
                ),
                "right": _side_sample(None, None, None, None, None),
            },
        }]
        with self.assertRaises(PoseContactsError):
            build_pose_contacts_payload("0" * 64, _uuid(1), [FLOOR], samples)

    def test_gate_is_fixed_and_echoed_singular_in_the_result(self):
        samples = [{
            "frame": 1,
            "sides": {
                "left": _side_sample(None, None, None, None, None),
                "right": _side_sample(None, None, None, None, None),
            },
        }]
        payload = build_pose_contacts_payload("0" * 64, _uuid(1), [FLOOR], samples)
        self.assertEqual(payload["gate"], {"max_gap_m": 0.03, "min_edge_margin_m": 0.0})
        self.assertEqual(payload["schema_version"], 1)
        self.assertNotIn("gates", payload)
        self.assertNotIn("supports", payload)
        self.assertEqual(payload["frames"][0]["sides"], {"left": None, "right": None})

    def test_result_shape_is_exactly_the_closed_public_fields(self):
        samples = [{
            "frame": 1,
            "sides": {
                "left": _side_sample(
                    [0.0, 0.0, 0.0], [0.0, 0.0, 0.0], [0.1, 0.0, 0.0], [0.0, 0.0, 0.0],
                    toe_joint_co=[0.0, 0.1, 0.0],
                ),
                "right": _side_sample(None, None, None, None, None),
            },
        }]
        payload = build_pose_contacts_payload("0" * 64, _uuid(1), [FLOOR], samples)
        self.assertEqual(
            set(payload),
            {"revision", "schema_version", "character_entity_id", "gate", "frames"},
        )
        left = payload["frames"][0]["sides"]["left"]
        self.assertEqual(
            set(left),
            {
                "foot_joint_position",
                "toe_joint_position",
                "heel_point",
                "toe_point",
                "sole_point",
                "sole_source",
                "heel_to_toe_m",
                "joint_to_sole_offset_m",
                "contact_basis",
                "support",
            },
        )
        self.assertEqual(
            set(left["support"]),
            {
                "support_entity_id",
                "support_height_m",
                "support_gap_m",
                "inside_support_footprint",
                "edge_margin_m",
                "footprint_basis",
                "surface_contact_verified",
            },
        )
        self.assertEqual(left["support"]["footprint_basis"], "aabb_xy")


def build_golden_payload():
    supports = [FLOOR, STAIR]
    frame1 = {
        "frame": 1,
        "sides": {
            "left": _side_sample(
                foot_joint_co=[-0.1, 0.0, 0.15],
                toe_joint_co=[-0.1, 0.1, 0.15],
                heel_co=[-0.15, -0.05, 0.08],
                toe_co=[-0.05, 0.05, 0.09],
                sole_co=[-0.15, -0.05, 0.08],
            ),
            "right": _side_sample(
                foot_joint_co=[0.1, 0.0, 0.02],
                toe_joint_co=[0.1, 0.1, 0.02],
                heel_co=[0.05, -0.05, 0.0],
                toe_co=[0.15, 0.05, 0.005],
                sole_co=[0.05, -0.05, 0.0],
            ),
        },
    }
    frame2 = {
        "frame": 2,
        "sides": {
            "left": _side_sample(
                foot_joint_co=[0.05, 0.0, 0.23],
                toe_joint_co=[0.05, 0.1, 0.23],
                heel_co=[0.0, -0.05, 0.18],
                toe_co=[0.1, 0.05, 0.185],
                sole_co=[0.0, -0.05, 0.18],
            ),
            "right": _side_sample(
                foot_joint_co=[1.1, 0.0, 0.23],
                toe_joint_co=[1.1, 0.1, 0.23],
                heel_co=[1.05, -0.05, 0.18],
                toe_co=[1.15, 0.05, 0.181],
                sole_co=[1.05, -0.05, 0.18],
            ),
        },
    }
    return build_pose_contacts_payload(
        "0" * 64,
        _uuid(1),
        supports,
        [frame1, frame2],
    )


class GoldenFixtureTests(unittest.TestCase):
    def test_golden_payload_covers_contract_variants(self):
        payload = build_golden_payload()
        self.assertEqual(payload["revision"], "0" * 64)
        self.assertEqual(payload["schema_version"], 1)
        self.assertEqual(payload["gate"], {"max_gap_m": 0.03, "min_edge_margin_m": 0.0})
        self.assertEqual(len(payload["frames"]), 2)
        left_frame1 = payload["frames"][0]["sides"]["left"]
        right_frame1 = payload["frames"][0]["sides"]["right"]
        self.assertFalse(left_frame1["support"]["surface_contact_verified"])  # floating
        self.assertTrue(right_frame1["support"]["surface_contact_verified"])  # settled
        for side in payload["frames"][1]["sides"].values():
            self.assertTrue(side["support"]["surface_contact_verified"])  # both on stair tread
        self.assertEqual(
            payload["frames"][1]["sides"]["left"]["support"]["support_entity_id"],
            STAIR["entity_id"],
        )

    def test_golden_fixture_matches_committed_json(self):
        """Drift net: any other consumer parsing this exact committed file
        must see the same payload the pure builder produces."""
        committed = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        regenerated = json.loads(json.dumps(build_golden_payload()))
        self.assertEqual(committed, regenerated)


if __name__ == "__main__":
    unittest.main()
