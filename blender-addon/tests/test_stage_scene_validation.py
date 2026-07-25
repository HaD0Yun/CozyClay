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
    _require_plan_fps_agrees,
    _requested_scene_fps,
    _pose_contact_frames,
    PoseContactError,
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

    def write_motion_archive(
        self, path, *, rotations=None, joints=None, fps=None, carried=None
    ):
        rotations = rotations or self.npy_v1((1, 27, 3, 3), "<f8")
        joints = joints or self.npy_v1((1, 27, 3), "<f8")
        fps = fps or self.npy_v1((), "<i8", payload=(24).to_bytes(8, "little"))
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("local_rot_mats.npy", rotations)
            archive.writestr("posed_joints.npy", joints)
            archive.writestr("fps.npy", fps)
            for name, member in (carried or {}).items():
                archive.writestr(name, member)

    def carried_members(self, frames=1, *, overrides=None):
        """The six members ARDY writes next to the three the addon consumes."""
        text = "a person walks forward."
        members = {
            "foot_contacts.npy": self.npy_v1((frames, 4), "|b1"),
            "global_rot_mats.npy": self.npy_v1((frames, 27, 3, 3), "<f4"),
            "global_root_heading.npy": self.npy_v1((frames, 2), "<f4"),
            "root_positions.npy": self.npy_v1((frames, 3), "<f4"),
            "smooth_root_pos.npy": self.npy_v1((frames, 3), "<f4"),
            "text.npy": self.npy_v1(
                (), f"<U{len(text)}", payload=text.encode("utf-32-le")
            ),
        }
        members.update(overrides or {})
        return members

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

    def test_motion_npz_accepts_the_members_ardy_actually_writes(self):
        """ARDY emits nine members, not three.

        ``scripts/generate.py`` and both cclay_* generators end in
        ``np.savez(path, **motion_dict)``, so demanding an exact three-member
        set rejected every unmodified generated motion (measured: 16 of 42
        staged motions failed APPLY_MOTION_MALFORMED). The generators live in
        another repo, so this direction is pinned here.
        """
        with tempfile.TemporaryDirectory() as project_directory:
            path = self.motion_path(project_directory)
            self.write_motion_archive(path, carried=self.carried_members())
            self.assertEqual(_inspect_motion_archive(path), 24)

    def test_motion_npz_frame_locks_and_type_checks_the_carried_members(self):
        text = "a person walks forward."
        cases = {
            # A carried member describing a different clip must not ride along.
            "contacts-frame-mismatch": {
                "foot_contacts.npy": self.npy_v1((2, 4), "|b1")
            },
            "root-frame-mismatch": {"root_positions.npy": self.npy_v1((2, 3), "<f4")},
            "contacts-width": {"foot_contacts.npy": self.npy_v1((1, 3), "|b1")},
            # Contacts must stay boolean: a float array here would read as
            # "always in contact" once preflight consumes the model's own labels.
            "contacts-not-bool": {"foot_contacts.npy": self.npy_v1((1, 4), "<f4")},
            "text-not-scalar": {
                "text.npy": self.npy_v1((1,), "<U1", payload=b"\0" * 4)
            },
            # numpy spells unicode width in characters and stores UCS-4, so a
            # utf-8 payload is a quarter of the declared size.
            "text-width-lies": {
                "text.npy": self.npy_v1((), f"<U{len(text)}", payload=text.encode())
            },
            "object-dtype": {"text.npy": self.npy_v1((), "|O8", payload=b"\0" * 8)},
        }
        for name, overrides in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as project_directory:
                path = self.motion_path(project_directory)
                self.write_motion_archive(
                    path, carried=self.carried_members(overrides=overrides)
                )
                self.assert_motion_archive_rejected(path)


class MotionFpsContractTests(unittest.TestCase):
    """One frame rate per plan; a disagreement fails loudly and order-free."""

    RENDER_24 = {"op": "set_render_settings", "fps": 24}

    @staticmethod
    def _apply(motion_id="walk-20"):
        return {"op": "apply_motion", "entity_id": "e", "motion_id": motion_id}

    @staticmethod
    def _plan(*operations):
        return {"operations": list(operations)}

    @staticmethod
    def _fps_of(motion_id):
        """Motion ids in these plans encode their own native fps as a suffix."""
        return int(motion_id.rsplit("-", 1)[1])

    def _assert_conflict(self, plan, *expected_fragments):
        with self.assertRaises(StageSceneError) as caught:
            _require_plan_fps_agrees(plan, self._fps_of)
        message = str(caught.exception)
        self.assertIn("APPLY_MOTION_FPS_CONFLICT", message)
        for fragment in expected_fragments:
            self.assertIn(fragment, message)
        return message

    def test_requested_fps_is_none_when_the_plan_never_names_one(self):
        """Omitting fps is the normal case and must stay unguarded: a plan that
        only applies motion is free to adopt the motion's native rate.
        """
        self.assertIsNone(_requested_scene_fps(self._plan(self._apply())))
        self.assertIsNone(
            _requested_scene_fps(
                self._plan({"op": "set_render_settings", "resolution_x": 1920})
            )
        )

    def test_last_write_wins_across_several_render_operations(self):
        """Blender keeps only the final assignment, so the guard must compare
        against the value the scene would actually end up with. An earlier
        matching fps must not excuse a later conflicting one.
        """
        plan = self._plan(
            {"op": "set_render_settings", "fps": 20},
            self._apply(),
            self.RENDER_24,
        )
        self.assertEqual(_requested_scene_fps(plan), 24)
        self._assert_conflict(plan, "set_render_settings is 24 fps")

    def test_render_conflict_is_rejected_in_both_operation_orders(self):
        """The defect was order-dependent and silent both ways:
        set_render_settings last played 20 fps keys at 24 so the clip ran 20%
        fast, apply_motion last discarded the requested fps. Neither errored.
        """
        for label, plan in (
            ("render-then-motion", self._plan(self.RENDER_24, self._apply())),
            ("motion-then-render", self._plan(self._apply(), self.RENDER_24)),
        ):
            with self.subTest(order=label):
                # Both rates must appear: the director cannot fix this without
                # knowing which of the two values to drop.
                self._assert_conflict(
                    plan, "set_render_settings is 24 fps", "motion walk-20 is 20 fps"
                )

    def test_two_motions_with_different_native_rates_are_rejected(self):
        """The hole a per-operation check could never see. With no fps named in
        the plan at all, each motion individually agrees with "nothing
        requested", so both used to pass and the scene ended at whichever ran
        last -- the other clip then played at the wrong rate.
        """
        self._assert_conflict(
            self._plan(self._apply("walk-20"), self._apply("run-25")),
            "motion walk-20 is 20 fps",
            "motion run-25 is 25 fps",
        )

    def test_remediation_names_only_the_sources_actually_in_conflict(self):
        """Telling a two-motion conflict to "omit fps from set_render_settings"
        points the caller at an operation its plan does not contain, and the
        reverse hides the option that actually applies.
        """
        two_motions = self._assert_conflict(
            self._plan(self._apply("walk-20"), self._apply("run-25"))
        )
        self.assertNotIn("omit fps from set_render_settings", two_motions)
        self.assertIn("apply only motions that share a frame rate", two_motions)

        render_only = self._assert_conflict(
            self._plan(self.RENDER_24, self._apply("walk-20"))
        )
        self.assertIn("omit fps from set_render_settings", render_only)
        self.assertNotIn("apply only motions that share a frame rate", render_only)

        # Two motions that already agree need no advice about sharing a rate; the
        # real conflict there is the requested fps, so pointing at the motions
        # would misdirect. Gated on distinct RATES, not on motion count.
        agreeing_pair = self._assert_conflict(
            self._plan(self.RENDER_24, self._apply("walk-20"), self._apply("jog-20"))
        )
        self.assertIn("omit fps from set_render_settings", agreeing_pair)
        self.assertNotIn("apply only motions that share a frame rate", agreeing_pair)

        # Regenerating at the target rate is always available, so it is always
        # offered; it is the only route when the plan wants a rate no motion has.
        for message in (two_motions, render_only):
            self.assertIn("regenerate the motion", message)

    def test_agreeing_plans_pass(self):
        cases = (
            ("motion only", self._plan(self._apply())),
            (
                "fps matches motion",
                self._plan({"op": "set_render_settings", "fps": 20}, self._apply()),
            ),
            (
                "two motions share a rate",
                self._plan(self._apply("walk-20"), self._apply("jog-20")),
            ),
            ("no motion at all", self._plan(self.RENDER_24)),
            (
                "render fields but no fps",
                self._plan(
                    {"op": "set_render_settings", "resolution_x": 1920}, self._apply()
                ),
            ),
        )
        for label, plan in cases:
            with self.subTest(case=label):
                _require_plan_fps_agrees(plan, self._fps_of)

    def test_motion_fps_is_never_resolved_for_a_plan_without_motion(self):
        """No apply_motion means no npz to read, so the resolver must not run:
        a camera-only plan is free to pick any fps it likes.
        """

        def explode(motion_id):
            raise AssertionError(f"resolver must not run, got {motion_id}")

        _require_plan_fps_agrees(self._plan(self.RENDER_24), explode)


class PoseContactFramesValidationTests(unittest.TestCase):
    """``_pose_contact_frames`` runs before any bpy access, so it is exercised
    directly here without a real Blender process (see
    ``AddCharacterRealBlenderTests`` for the bpy-dependent geometry paths).
    """

    def test_accepts_a_short_list_of_non_negative_integers(self):
        self.assertEqual(_pose_contact_frames([0, 1, 5]), [0, 1, 5])

    def test_rejects_non_list_frames(self):
        for frames in (None, "5", 5, {0: 1}, (0, 1)):
            with self.subTest(frames=frames):
                with self.assertRaises(PoseContactError):
                    _pose_contact_frames(frames)

    def test_rejects_empty_frame_list(self):
        with self.assertRaises(PoseContactError):
            _pose_contact_frames([])

    def test_rejects_too_many_frames(self):
        with self.assertRaises(PoseContactError):
            _pose_contact_frames(list(range(65)))

    def test_accepts_the_frame_count_ceiling(self):
        self.assertEqual(len(_pose_contact_frames(list(range(64)))), 64)

    def test_rejects_negative_bool_and_non_integer_frames(self):
        for frames in ([-1], [True], [False], [1.5], ["1"], [None]):
            with self.subTest(frames=frames):
                with self.assertRaises(PoseContactError):
                    _pose_contact_frames(frames)

    def test_error_is_a_stage_scene_error(self):
        with self.assertRaises(StageSceneError):
            _pose_contact_frames([])


if __name__ == "__main__":
    unittest.main()