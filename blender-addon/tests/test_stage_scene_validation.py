import json
import pathlib
import struct
import sys
import tempfile
import unittest
import zipfile
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))

from cclay.stage_scene import (
    StageSceneError,
    StageSceneValidationError,
    _inspect_motion_archive,
    _load_motion_payload,
    parse_stage_scene_plan,
)
from cclay.hand_shapes import PRESET_NAMES

FIXTURES = (
    pathlib.Path(__file__).parents[2]
    / "packages/blender-protocol/test/fixtures/stage-scene"
)


class StageSceneValidationTests(unittest.TestCase):
    def fixture(self, name: str) -> object:
        return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))

    def test_shared_valid_fixture_matches_python_mirror(self):
        plan = parse_stage_scene_plan(self.fixture("valid-plan"))
        self.assertEqual(
            [operation["op"] for operation in plan["operations"]],
            ["add_primitive", "set_material_color", "upsert_area_light", "delete_entity"],
        )

    def test_unknown_field_has_schema_only_code(self):
        with self.assertRaises(StageSceneValidationError) as caught:
            parse_stage_scene_plan(self.fixture("invalid-unknown-field"))
        self.assertEqual(caught.exception.code, "INVALID_STAGE_SCENE_PLAN_SCHEMA")

    def test_duplicate_creation_id_has_distinct_code(self):
        with self.assertRaises(StageSceneValidationError) as caught:
            parse_stage_scene_plan(self.fixture("invalid-duplicate-entity-id"))
        self.assertEqual(caught.exception.code, "STAGE_SCENE_ENTITY_ID_DUPLICATE")

    def test_duplicate_stable_name_has_distinct_code(self):
        plan = self.fixture("valid-plan")
        plan["operations"][2]["name"] = "Floor"
        with self.assertRaises(StageSceneValidationError) as caught:
            parse_stage_scene_plan(plan)
        self.assertEqual(caught.exception.code, "STAGE_SCENE_STABLE_NAME_DUPLICATE")

    def test_each_grammar_branch_is_closed(self):
        for index, operation in enumerate(self.fixture("valid-plan")["operations"]):
            plan = self.fixture("valid-plan")
            plan["operations"][index] = {**operation, "unknown": True}
            with self.subTest(operation=operation["op"]):
                with self.assertRaises(StageSceneValidationError) as caught:
                    parse_stage_scene_plan(plan)
                self.assertEqual(caught.exception.code, "INVALID_STAGE_SCENE_PLAN_SCHEMA")

    @staticmethod
    def plan(operations):
        return {
            "schema_version": 1,
            "expected_revision_id": "a" * 64,
            "operations": operations,
        }

    def test_adopt_entity_parses_closed_shape(self):
        entity_id = "11111111-1111-4111-8111-111111111111"
        plan = parse_stage_scene_plan(
            self.plan([
                {"op": "adopt_entity", "entity_id": entity_id},
                {"op": "delete_entity", "entity_id": entity_id},
            ])
        )
        self.assertEqual(
            [operation["op"] for operation in plan["operations"]],
            ["adopt_entity", "delete_entity"],
        )

    def test_adopt_entity_rejects_unknown_fields_and_bad_uuid(self):
        entity_id = "11111111-1111-4111-8111-111111111111"
        for operation in (
            {"op": "adopt_entity", "entity_id": entity_id, "name": "Cube"},
            {"op": "adopt_entity", "entity_id": "not-a-uuid"},
            {"op": "adopt_entity", "entity_id": entity_id.replace("1", "A", 1)},
            {"op": "adopt_entity"},
        ):
            with self.subTest(operation=operation):
                with self.assertRaises(StageSceneValidationError) as caught:
                    parse_stage_scene_plan(self.plan([operation]))
                self.assertEqual(
                    caught.exception.code, "INVALID_STAGE_SCENE_PLAN_SCHEMA"
                )

    def test_transform_entity_parses_optional_transform_fields(self):
        entity_id = "11111111-1111-4111-8111-111111111111"
        plan = parse_stage_scene_plan(
            self.plan([
                {"op": "transform_entity", "entity_id": entity_id, "location": [1, 2, 3]},
                {
                    "op": "transform_entity",
                    "entity_id": entity_id,
                    "rotation_euler": [0, 0, 1.5],
                    "scale": [2, 2, 2],
                },
            ])
        )
        self.assertEqual(len(plan["operations"]), 2)

    def test_transform_entity_rejects_empty_null_and_unknown_fields(self):
        entity_id = "11111111-1111-4111-8111-111111111111"
        for operation in (
            {"op": "transform_entity", "entity_id": entity_id},
            {"op": "transform_entity", "entity_id": entity_id, "location": None},
            {"op": "transform_entity", "entity_id": entity_id, "translation": [1, 2, 3]},
            {"op": "transform_entity", "entity_id": entity_id, "scale": [0, 1, 1]},
        ):
            with self.subTest(operation=operation):
                with self.assertRaises(StageSceneValidationError) as caught:
                    parse_stage_scene_plan(self.plan([operation]))
                self.assertEqual(
                    caught.exception.code, "INVALID_STAGE_SCENE_PLAN_SCHEMA"
                )

    def test_set_light_property_parses_optional_property_fields(self):
        entity_id = "11111111-1111-4111-8111-111111111111"
        plan = parse_stage_scene_plan(
            self.plan([
                {"op": "set_light_property", "entity_id": entity_id, "energy": 800},
                {
                    "op": "set_light_property",
                    "entity_id": entity_id,
                    "color": [1, 0.5, 0],
                    "size": 2.5,
                },
            ])
        )
        self.assertEqual(len(plan["operations"]), 2)

    def test_set_light_property_rejects_empty_unknown_and_out_of_range(self):
        entity_id = "11111111-1111-4111-8111-111111111111"
        for operation in (
            {"op": "set_light_property", "entity_id": entity_id},
            {"op": "set_light_property", "entity_id": entity_id, "power": 5},
            {"op": "set_light_property", "entity_id": entity_id, "energy": -1},
            {"op": "set_light_property", "entity_id": entity_id, "energy": None},
            {"op": "set_light_property", "entity_id": entity_id, "color": [1, 1, 2]},
            {"op": "set_light_property", "entity_id": entity_id, "size": 0},
            {"op": "set_light_property", "energy": 5},
        ):
            with self.subTest(operation=operation):
                with self.assertRaises(StageSceneValidationError) as caught:
                    parse_stage_scene_plan(self.plan([operation]))
                self.assertEqual(
                    caught.exception.code, "INVALID_STAGE_SCENE_PLAN_SCHEMA"
                )

    def test_set_camera_property_parses_optional_property_fields(self):
        entity_id = "11111111-1111-4111-8111-111111111111"
        plan = parse_stage_scene_plan(
            self.plan([
                {"op": "set_camera_property", "entity_id": entity_id, "lens": 50},
                {
                    "op": "set_camera_property",
                    "entity_id": entity_id,
                    "clip_start": 0.1,
                    "clip_end": 100,
                    "sensor_width": 36,
                    "sensor_height": 24,
                    "sensor_fit": "HORIZONTAL",
                },
            ])
        )
        self.assertEqual(len(plan["operations"]), 2)

    def test_set_camera_property_rejects_empty_unknown_and_out_of_range(self):
        entity_id = "11111111-1111-4111-8111-111111111111"
        for operation in (
            {"op": "set_camera_property", "entity_id": entity_id},
            {"op": "set_camera_property", "entity_id": entity_id, "fov": 90},
            {"op": "set_camera_property", "entity_id": entity_id, "lens": 0},
            {"op": "set_camera_property", "entity_id": entity_id, "clip_end": -1},
            {"op": "set_camera_property", "entity_id": entity_id, "sensor_width": None},
            {"op": "set_camera_property", "entity_id": entity_id, "sensor_fit": "DIAGONAL"},
            {"op": "set_camera_property", "lens": 50},
        ):
            with self.subTest(operation=operation):
                with self.assertRaises(StageSceneValidationError) as caught:
                    parse_stage_scene_plan(self.plan([operation]))
                self.assertEqual(
                    caught.exception.code, "INVALID_STAGE_SCENE_PLAN_SCHEMA"
                )

    def test_set_render_settings_parses_closed_shape(self):
        plan = parse_stage_scene_plan(
            self.plan([
                {
                    "op": "set_render_settings",
                    "resolution_x": 1920,
                    "resolution_y": 1080,
                    "resolution_percentage": 100,
                    "fps": 24,
                    "frame_start": 1,
                    "frame_end": 250,
                },
                {"op": "set_render_settings", "fps": 30},
            ])
        )
        self.assertEqual(len(plan["operations"]), 2)

    def test_set_render_settings_rejects_unknown_and_out_of_range(self):
        for operation in (
            {"op": "set_render_settings", "engine": "CYCLES"},
            {"op": "set_render_settings", "resolution_x": 0},
            {"op": "set_render_settings", "resolution_y": 65536},
            {"op": "set_render_settings", "resolution_percentage": 101},
            {"op": "set_render_settings", "fps": 0},
            {"op": "set_render_settings", "fps": 24.5},
            {"op": "set_render_settings", "fps": True},
            {"op": "set_render_settings", "frame_start": -100001},
            {"op": "set_render_settings", "frame_end": 100001},
        ):
            with self.subTest(operation=operation):
                with self.assertRaises(StageSceneValidationError) as caught:
                    parse_stage_scene_plan(self.plan([operation]))
                self.assertEqual(
                    caught.exception.code, "INVALID_STAGE_SCENE_PLAN_SCHEMA"
                )

    def test_rename_entity_parses_closed_shape(self):
        entity_id = "11111111-1111-4111-8111-111111111111"
        plan = parse_stage_scene_plan(
            self.plan([
                {"op": "rename_entity", "entity_id": entity_id, "name": "Hero Light"},
            ])
        )
        self.assertEqual(plan["operations"][0]["name"], "Hero Light")

    def test_rename_entity_rejects_unknown_missing_and_invalid_fields(self):
        entity_id = "11111111-1111-4111-8111-111111111111"
        for operation in (
            {"op": "rename_entity", "entity_id": entity_id},
            {"op": "rename_entity", "entity_id": entity_id, "name": ""},
            {"op": "rename_entity", "entity_id": entity_id, "name": 5},
            {"op": "rename_entity", "entity_id": entity_id, "name": "x" * 257},
            {"op": "rename_entity", "entity_id": "not-a-uuid", "name": "Cube"},
            {
                "op": "rename_entity",
                "entity_id": entity_id,
                "name": "Cube",
                "collection_name": "Props",
            },
        ):
            with self.subTest(operation=operation):
                with self.assertRaises(StageSceneValidationError) as caught:
                    parse_stage_scene_plan(self.plan([operation]))
                self.assertEqual(
                    caught.exception.code, "INVALID_STAGE_SCENE_PLAN_SCHEMA"
                )

    @staticmethod
    def add_primitive_op(**overrides):
        return {
            "op": "add_primitive",
            "entity_id": "11111111-1111-4111-8111-111111111111",
            "primitive_type": "CUBE",
            "name": "Prop Cube",
            "location": [0, 0, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
            **overrides,
        }

    @staticmethod
    def upsert_area_light_op(**overrides):
        return {
            "op": "upsert_area_light",
            "entity_id": "22222222-2222-4222-8222-222222222222",
            "name": "Key Light",
            "location": [0, 0, 3],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
            "energy": 800,
            "color": [1, 1, 1],
            "size": 2,
            **overrides,
        }

    def test_creation_ops_accept_optional_collection_name(self):
        plan = parse_stage_scene_plan(
            self.plan([
                self.add_primitive_op(collection_name="Props"),
                self.upsert_area_light_op(collection_name="Lights"),
            ])
        )
        self.assertEqual(plan["operations"][0]["collection_name"], "Props")
        self.assertEqual(plan["operations"][1]["collection_name"], "Lights")

    def test_creation_ops_still_parse_without_collection_name(self):
        plan = parse_stage_scene_plan(
            self.plan([self.add_primitive_op(), self.upsert_area_light_op()])
        )
        self.assertEqual(len(plan["operations"]), 2)

    def test_creation_ops_reject_non_string_collection_name(self):
        for operation in (
            self.add_primitive_op(collection_name=5),
            self.add_primitive_op(collection_name=None),
            self.add_primitive_op(collection_name=""),
            self.upsert_area_light_op(collection_name=5),
            self.upsert_area_light_op(collection_name=None),
            self.upsert_area_light_op(collection_name=""),
        ):
            with self.subTest(operation=operation):
                with self.assertRaises(StageSceneValidationError) as caught:
                    parse_stage_scene_plan(self.plan([operation]))
                self.assertEqual(
                    caught.exception.code, "INVALID_STAGE_SCENE_PLAN_SCHEMA"
                )

    def test_add_camera_parses_closed_shape_with_optional_lens(self):
        entity_id = "11111111-1111-4111-8111-111111111111"
        plan = parse_stage_scene_plan(
            self.plan([
                {
                    "op": "add_camera",
                    "entity_id": entity_id,
                    "name": "Shot Camera",
                    "location": [4, -6, 3],
                    "rotation": [1.1, 0, 0.6],
                },
                {
                    "op": "add_camera",
                    "entity_id": "22222222-2222-4222-8222-222222222222",
                    "name": "Close Camera",
                    "location": [1, -2, 2],
                    "rotation": [1.2, 0, 0.2],
                    "lens": 70,
                },
            ])
        )
        self.assertEqual([operation["op"] for operation in plan["operations"]], ["add_camera", "add_camera"])

    def test_add_camera_rejects_bad_shape_and_lens(self):
        entity_id = "11111111-1111-4111-8111-111111111111"
        base = {
            "op": "add_camera",
            "entity_id": entity_id,
            "name": "Shot Camera",
            "location": [4, -6, 3],
            "rotation": [1.1, 0, 0.6],
        }
        for operation in (
            {**base, "lens": 0},
            {**base, "lens": "50"},
            {**base, "scale": [1, 1, 1]},
            {key: value for key, value in base.items() if key != "rotation"},
        ):
            with self.subTest(operation=operation):
                with self.assertRaises(StageSceneValidationError):
                    parse_stage_scene_plan(self.plan([operation]))
    def test_apply_motion_parses_optional_timing_and_hand_completion(self):
        entity_id = "11111111-1111-4111-8111-111111111111"
        plan = parse_stage_scene_plan(
            self.plan([
                {"op": "apply_motion", "entity_id": entity_id, "motion_id": "wave-0722"},
                {
                    "op": "apply_motion",
                    "entity_id": entity_id,
                    "motion_id": "walk",
                    "hand_pose": "open",
                    "start_frame": 40,
                },
            ])
        )
        self.assertEqual(
            [operation["op"] for operation in plan["operations"]],
            ["apply_motion", "apply_motion"],
        )
        self.assertEqual(plan["operations"][1]["hand_pose"], "open")

    def test_apply_motion_accepts_every_frozen_preset_and_independent_sides(self):
        entity_id = "11111111-1111-4111-8111-111111111111"
        operations = [
            {
                "op": "apply_motion",
                "entity_id": entity_id,
                "motion_id": f"shape-{index}",
                "hand_shapes": {"left": preset, "right": PRESET_NAMES[-index - 1]},
            }
            for index, preset in enumerate(PRESET_NAMES)
        ]
        parsed = parse_stage_scene_plan(self.plan(operations))
        self.assertEqual(
            [operation["hand_shapes"]["left"] for operation in parsed["operations"]],
            list(PRESET_NAMES),
        )

    def test_apply_motion_hand_shapes_closed_forms_and_exact_errors(self):
        entity_id = "11111111-1111-4111-8111-111111111111"
        base = {"op": "apply_motion", "entity_id": entity_id, "motion_id": "wave"}
        valid = (
            base,
            {**base, "hand_pose": "open"},
            {**base, "hand_shapes": {"left": "point"}},
            {**base, "hand_shapes": {"right": "fist"}},
            {**base, "hand_shapes": {"left": "point", "right": "fist"}},
        )
        for operation in valid:
            with self.subTest(valid=operation):
                parse_stage_scene_plan(self.plan([operation]))

        invalid = (
            (
                {**base, "hand_pose": "open", "hand_shapes": {"left": "point"}},
                "operations[0].hand_pose and hand_shapes are mutually exclusive",
            ),
            (
                {**base, "hand_shapes": {}},
                "operations[0].hand_shapes must contain exactly left, right, or both",
            ),
            (
                {**base, "hand_shapes": {"middle": "point"}},
                "operations[0].hand_shapes contains unknown fields",
            ),
            (
                {**base, "hand_shapes": {"left": "missing"}},
                "operations[0].hand_shapes.left is unsupported",
            ),
            (
                {**base, "hand_shapes": {"left": "point", "right": None}},
                "operations[0].hand_shapes.right is unsupported",
            ),
            (
                {**base, "hand_shapes": None},
                "operations[0].hand_shapes must contain exactly left, right, or both",
            ),
        )
        for operation, message in invalid:
            with self.subTest(invalid=operation):
                with self.assertRaises(StageSceneValidationError) as caught:
                    parse_stage_scene_plan(self.plan([operation]))
                self.assertEqual(caught.exception.code, "INVALID_STAGE_SCENE_PLAN_SCHEMA")
                self.assertEqual(str(caught.exception), f"INVALID_STAGE_SCENE_PLAN_SCHEMA: {message}")

    def test_apply_motion_rejects_bad_ids_keys_and_frames(self):
        entity_id = "11111111-1111-4111-8111-111111111111"
        for operation in (
            {"op": "apply_motion", "entity_id": entity_id},  # missing motion_id
            {"op": "apply_motion", "motion_id": "wave"},  # missing entity_id
            {"op": "apply_motion", "entity_id": entity_id, "motion_id": "Wave"},
            {"op": "apply_motion", "entity_id": entity_id, "motion_id": "../etc"},
            {"op": "apply_motion", "entity_id": entity_id, "motion_id": "a" * 65},
            {"op": "apply_motion", "entity_id": entity_id, "motion_id": ""},
            {
                "op": "apply_motion",
                "entity_id": entity_id,
                "motion_id": "wave",
                "start_frame": 100001,
            },
            {
                "op": "apply_motion",
                "entity_id": entity_id,
                "motion_id": "wave",
                "start_frame": 1.5,
            },
            {
                "op": "apply_motion",
                "entity_id": entity_id,
                "motion_id": "wave",
                "npz_path": "/tmp/x.npz",
            },
            {
                "op": "apply_motion",
                "entity_id": entity_id,
                "motion_id": "wave",
                "hand_pose": "fist",
            },
        ):
            with self.subTest(operation=operation):
                with self.assertRaises(StageSceneValidationError) as caught:
                    parse_stage_scene_plan(self.plan([operation]))
                self.assertEqual(
                    caught.exception.code, "INVALID_STAGE_SCENE_PLAN_SCHEMA"
                )

    @staticmethod
    def motion_path(project_directory, motion_id="payload"):
        motions = pathlib.Path(project_directory) / ".cclay" / "motions"
        motions.mkdir(parents=True, exist_ok=True)
        return motions / f"{motion_id}.npz"

    @staticmethod
    def npy_v1(shape, descr, *, fortran_order=False, payload=None):
        header = repr({
            "descr": descr,
            "fortran_order": fortran_order,
            "shape": shape,
        }).encode("latin1")
        padding = (64 - ((10 + len(header) + 1) % 64)) % 64
        header += b" " * padding + b"\n"
        if payload is None:
            itemsize = int(descr[2:])
            element_count = 1
            for size in shape:
                element_count *= size
            payload = b"\0" * (element_count * itemsize)
        return b"\x93NUMPY\x01\x00" + struct.pack("<H", len(header)) + header + payload

    def write_motion_archive(self, path, *, rotations=None, joints=None, fps=None):
        rotations = rotations or self.npy_v1((1, 27, 3, 3), "<f8")
        joints = joints or self.npy_v1((1, 27, 3), "<f8")
        fps = fps or self.npy_v1((), "<i8", payload=(24).to_bytes(8, "little"))
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("local_rot_mats.npy", rotations)
            archive.writestr("posed_joints.npy", joints)
            archive.writestr("fps.npy", fps)

    def assert_motion_archive_rejected(self, path):
        with self.assertRaises(StageSceneError) as caught:
            _inspect_motion_archive(path)
        self.assertIn("APPLY_MOTION_MALFORMED", str(caught.exception))

    def assert_loader_preflight_rejected(self, project_directory):
        fake_numpy = mock.Mock()
        fake_numpy.load = mock.Mock(
            side_effect=AssertionError("numpy.load must not run before preflight")
        )
        with mock.patch.dict(sys.modules, {"numpy": fake_numpy}):
            with self.assertRaises(StageSceneError) as caught:
                _load_motion_payload(project_directory, "payload")
        self.assertIn("APPLY_MOTION_MALFORMED", str(caught.exception))
        fake_numpy.load.assert_not_called()

    def test_motion_npz_declared_uncompressed_limit_precedes_materialization(self):
        with tempfile.TemporaryDirectory() as project_directory:
            path = self.motion_path(project_directory)
            with zipfile.ZipFile(
                path, "w", compression=zipfile.ZIP_DEFLATED
            ) as archive:
                with archive.open("local_rot_mats.npy", "w") as member:
                    chunk = b"\0" * (1024 * 1024)
                    for _ in range(97):
                        member.write(chunk)
                archive.writestr("posed_joints.npy", b"")
                archive.writestr("fps.npy", b"")
            self.assertLess(path.stat().st_size, 1024 * 1024)
            self.assert_motion_archive_rejected(path)
            self.assert_loader_preflight_rejected(project_directory)

    def test_motion_npz_rejects_duplicate_missing_unexpected_and_unsafe_members(self):
        member_sets = (
            ("local_rot_mats.npy", "posed_joints.npy"),
            ("local_rot_mats.npy", "posed_joints.npy", "fps.npy", "extra.npy"),
            ("local_rot_mats.npy", "posed_joints.npy", "fps.npy", "fps.npy"),
            ("../local_rot_mats.npy", "posed_joints.npy", "fps.npy"),
        )
        for names in member_sets:
            with self.subTest(names=names), tempfile.TemporaryDirectory() as project_directory:
                path = self.motion_path(project_directory)
                with zipfile.ZipFile(path, "w") as archive:
                    for name in names:
                        archive.writestr(name, b"not-an-npy")
                self.assert_motion_archive_rejected(path)

    def test_motion_npz_rejects_header_shape_dtype_object_order_and_fps_metadata(self):
        valid_rotations = self.npy_v1((1, 27, 3, 3), "<f8")
        valid_joints = self.npy_v1((1, 27, 3), "<f8")
        valid_fps = self.npy_v1((), "<i8", payload=(24).to_bytes(8, "little"))
        cases = {
            "rotation-shape": {
                "rotations": self.npy_v1((1, 26, 3, 3), "<f8"),
            },
            "joint-dtype": {
                "joints": self.npy_v1((1, 27, 3), "<U1"),
            },
            "rotation-object": {
                "rotations": self.npy_v1((1, 27, 3, 3), "|O8"),
            },
            "rotation-fortran": {
                "rotations": self.npy_v1(
                    (1, 27, 3, 3), "<f8", fortran_order=True
                ),
            },
            "fps-shape": {
                "fps": self.npy_v1((1,), "<i8", payload=(24).to_bytes(8, "little")),
            },
            "fps-bool": {
                "fps": self.npy_v1((), "|b1", payload=b"\x01"),
            },
            "huge-itemsize": {
                "rotations": self.npy_v1(
                    (1, 27, 3, 3), "<f" + "9" * 4096, payload=b""
                ),
            },
        }
        for name, overrides in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as project_directory:
                path = self.motion_path(project_directory)
                self.write_motion_archive(
                    path,
                    rotations=overrides.get("rotations", valid_rotations),
                    joints=overrides.get("joints", valid_joints),
                    fps=overrides.get("fps", valid_fps),
                )
                self.assert_motion_archive_rejected(path)

    def test_motion_npz_rejects_frame_limit_from_header_before_materialization(self):
        with tempfile.TemporaryDirectory() as project_directory:
            path = self.motion_path(project_directory)
            self.write_motion_archive(
                path,
                rotations=self.npy_v1(
                    (24_001, 27, 3, 3), "<f8", payload=b""
                ),
            )
            self.assert_motion_archive_rejected(path)

    def test_motion_npz_rejects_invalid_npy_header_before_materialization(self):
        with tempfile.TemporaryDirectory() as project_directory:
            path = self.motion_path(project_directory)
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("local_rot_mats.npy", b"\x93NUMPY\x01\x00\xff\xff")
                archive.writestr("posed_joints.npy", b"not-an-npy")
                archive.writestr("fps.npy", b"not-an-npy")
            self.assert_motion_archive_rejected(path)
            self.assert_loader_preflight_rejected(project_directory)

if __name__ == "__main__":
    unittest.main()
