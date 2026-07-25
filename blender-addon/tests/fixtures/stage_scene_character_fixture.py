from __future__ import annotations

import json
import logging
import os
import pathlib
import re
import tempfile
import sys
import time

import bpy
import numpy

REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))
import cclay.stage_scene as stage_scene_module
from cclay import hand_shapes, motion_retarget

from cclay.hand_shapes import CANONICAL_ROLE_ORDER, LIBRARY_VERSION
from cclay.manifest import (
    _animation_snapshot,
    animation_fcurves,
    extract_scene_manifest_v2,
    extract_scene_snapshot,
)
from cclay.connection import DurableCommitReconciliationRequired
from cclay.snapshot import UNSUPPORTED_FCURVE_FEATURE
from cclay.stage_scene import (
    StageSceneError,
    _derived_child_entity_id,
    apply_stage_scene_transaction,
)

PROJECT_ID = "00000000-0000-4000-8000-00000000000a"
YBOT_ID = "11111111-1111-4111-8111-111111111111"
XBOT_ID = "22222222-2222-4222-8222-222222222222"
DUPE_ID = "33333333-3333-4333-8333-333333333333"
CAMERA_ID = "44444444-4444-4444-8444-444444444444"
FAILED_CAMERA_ID = "55555555-5555-4555-8555-555555555555"
UUID4 = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)


class FakeConnection:
    def __init__(self):
        self.active_checkpoint = None
        self.recovery = None
        self.fail_release_once = False
        self.recovery_required_calls = 0

    def hold_checkpoint(self, checkpoint, recovery_fn=None):
        if self.active_checkpoint is not None:
            raise RuntimeError("checkpoint already held")
        self.active_checkpoint = checkpoint
        self.recovery = recovery_fn

    def release_checkpoint(self):
        if self.fail_release_once:
            self.fail_release_once = False
            raise RuntimeError("injected checkpoint release failure")
        value = self.active_checkpoint
        self.active_checkpoint = None
        self.recovery = None
        return value

    def ensure_mutation_connection(self, _phase):
        return None

    def require_recovery(self):
        self.recovery_required_calls += 1


def character(entity_id, character_type, name, location):
    return {
        "op": "add_character",
        "entity_id": entity_id,
        "character_type": character_type,
        "name": name,
        "location": list(location),
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
    }


def _independent_dense_channels(ybot, dense_rotations, dense_joints, start_frame):
    bones = ybot.data.bones
    prefix = "mixamorig:" if any(bone.name.startswith("mixamorig:") for bone in bones) else ""
    rest_rotations = {}
    for cskel, target in motion_retarget.MIXAMO_TARGETS.items():
        if target is None:
            continue
        bone = bones.get(f"{prefix}{target}")
        if bone is not None:
            rest_rotations[cskel] = numpy.asarray(bone.matrix_local.to_3x3())
    rig_thigh = (
        bones[f"{prefix}RightLeg"].head_local
        - bones[f"{prefix}RightUpLeg"].head_local
    ).length
    scale = motion_retarget.derive_scale(dense_joints[0], rig_thigh)
    tracks = motion_retarget.build_pose_tracks(
        dense_rotations,
        dense_joints,
        rest_rotations,
        bones[f"{prefix}Hips"].head_local,
        scale,
    )
    inventory = hand_shapes.validate_rig_bones(
        ybot.get("cclay.character_type"), (bone.name for bone in bones)
    )
    deltas = hand_shapes.preset_deltas("open", "open")
    bone_to_role = {
        name: (side, role)
        for side in ("left", "right")
        for role, name in inventory[side].items()
    }
    frames = [float(start_frame + offset) for offset in range(len(dense_rotations))]
    channels = {}
    for cskel, quaternions in tracks["rotations"].items():
        target = motion_retarget.MIXAMO_TARGETS[cskel]
        if target is None:
            continue
        bone_name = f"{prefix}{target}"
        bone = ybot.pose.bones.get(bone_name)
        if bone is None:
            continue
        role = bone_to_role.get(bone_name)
        values = [
            hand_shapes.compose_quaternions(quaternion, deltas[role[0]][role[1]])
            if role is not None
            else quaternion
            for quaternion in quaternions
        ]
        data_path = bone.path_from_id("rotation_quaternion")
        for index in range(4):
            channels[(data_path, index)] = {
                "bone": bone,
                "property": "rotation_quaternion",
                "group": bone_name,
                "frames": frames,
                "values": [float(value[index]) for value in values],
            }
    hips = ybot.pose.bones[f"{prefix}Hips"]
    hips_path = hips.path_from_id("location")
    for index in range(3):
        channels[(hips_path, index)] = {
            "bone": hips,
            "property": "location",
            "group": hips.name,
            "frames": frames,
            "values": [float(location[index]) for location in tracks["hips_locations"]],
        }
    return channels


def _write_bulk_benchmark_action(ybot, channels, name):
    action = bpy.data.actions.new(name)
    started = None
    try:
        slot, channelbag = stage_scene_module._create_detached_action_topology(
            action, ybot.name
        )
        expected = {}
        for (data_path, index), channel in channels.items():
            if started is None:
                started = time.perf_counter()
            stage_scene_module._bulk_fcurve(
                channelbag, data_path, index, channel["group"],
                channel["frames"], channel["values"],
            )
            expected[(data_path, index)] = (
                channel["group"], channel["frames"], channel["values"]
            )
        stage_scene_module._validate_detached_curves(
            action, slot, channelbag, expected
        )
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        return action, slot, list(channelbag.fcurves), elapsed_ms
    except BaseException:
        if action.name in bpy.data.actions and action.users == 0:
            bpy.data.actions.remove(action)
        raise


def _write_legacy_benchmark_action(ybot, channels, name):
    action = bpy.data.actions.new(name)
    slot = action.slots.new(id_type="OBJECT", name=ybot.name)
    ybot.animation_data.action = action
    ybot.animation_data.action_slot = slot
    started = None
    defaults = {
        name: bpy.types.Keyframe.bl_rna.properties[name].default
        for name in ("back", "amplitude", "period")
    }
    try:
        for (_data_path, index), channel in channels.items():
            bone = channel["bone"]
            property_name = channel["property"]
            if property_name == "rotation_quaternion":
                bone.rotation_mode = "QUATERNION"
            property_value = getattr(bone, property_name)
            for frame, value in zip(channel["frames"], channel["values"]):
                property_value[index] = value
                if started is None:
                    started = time.perf_counter()
                bone.keyframe_insert(property_name, index=index, frame=frame)
        curves = animation_fcurves(ybot.animation_data)
        for fcurve in curves:
            for point in fcurve.keyframe_points:
                point.easing = "AUTO"
                point.interpolation = "BEZIER"
                for property_name, default in defaults.items():
                    setattr(point, property_name, default)
            fcurve.update()
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        return action, slot, curves, elapsed_ms
    except BaseException:
        ybot.animation_data.action = None
        if action.name in bpy.data.actions and action.users == 0:
            bpy.data.actions.remove(action)
        raise


def _curve_map(curves):
    return {(fcurve.data_path, fcurve.array_index): fcurve for fcurve in curves}


def _points_match(left, right):
    return (
        all(abs(a - b) <= 1e-9 for a, b in zip(left.co, right.co))
        and left.interpolation == right.interpolation
        and left.easing == right.easing
        and left.handle_left_type == right.handle_left_type
        and all(
            abs(a - b) <= 1e-9
            for a, b in zip(left.handle_left, right.handle_left)
        )
        and left.handle_right_type == right.handle_right_type
        and all(
            abs(a - b) <= 1e-9
            for a, b in zip(left.handle_right, right.handle_right)
        )
        and left.back == right.back
        and left.amplitude == right.amplitude
        and left.period == right.period
    )


def _benchmark_writer_order():
    value = os.environ.get("CCLAY_BENCHMARK_WRITER_ORDER", "bulk_first")
    if value == "bulk_first":
        return ("bulk", "legacy")
    if value == "legacy_first":
        return ("legacy", "bulk")
    raise RuntimeError(
        "CCLAY_BENCHMARK_WRITER_ORDER must be bulk_first or legacy_first"
    )


MOTION_RECEIPTS = []


class _MotionReceiptHandler(logging.StreamHandler):
    def emit(self, record):
        message = record.getMessage()
        try:
            parsed = json.loads(message)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            MOTION_RECEIPTS.append((message, parsed))
        super().emit(record)


def _install_motion_receipt_logger():
    logger = logging.getLogger("cclay.motion_keyframes")
    saved = (list(logger.handlers), logger.level, logger.propagate)
    for handler in tuple(logger.handlers):
        logger.removeHandler(handler)
    handler = _MotionReceiptHandler(sys.stdout)
    handler.setLevel(logging.INFO)
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    return logger, handler, saved


def _restore_motion_receipt_logger(logger, handler, saved):
    logger.removeHandler(handler)
    handlers, level, propagate = saved
    for saved_handler in handlers:
        logger.addHandler(saved_handler)
    logger.setLevel(level)
    logger.propagate = propagate


def main():
    for scene_object in list(bpy.data.objects):
        bpy.data.objects.remove(scene_object, do_unlink=True)
    bpy.context.scene["cclay.project_id"] = PROJECT_ID
    connection = FakeConnection()
    base = extract_scene_manifest_v2()
    committed = []
    result = apply_stage_scene_transaction(
        {
            "schema_version": 1,
            "expected_revision_id": base["revisionId"],
            "operations": [
                character(YBOT_ID, "Y_BOT", "Fighter One", (1, 0, 0)),
                character(XBOT_ID, "X_BOT", "Fighter Two", (-1, 0, 0)),
            ],
        },
        base["sceneHash"],
        connection,
        committed.append,
    )

    ybot = next(o for o in bpy.data.objects if o.get("cclay.entity_id") == YBOT_ID)
    xbot = next(o for o in bpy.data.objects if o.get("cclay.entity_id") == XBOT_ID)
    ybot_children = [o for o in bpy.data.objects if o.parent is ybot]
    manifest = result["manifest"]
    manifest_types = {o["entityId"]: o["type"] for o in manifest["objects"]}

    results = {
        "rootsAreArmatures": ybot.type == "ARMATURE" and xbot.type == "ARMATURE",
        "rootNames": [ybot.name, xbot.name] == ["Fighter One", "Fighter Two"],
        "rootLocation": tuple(round(v, 6) for v in ybot.location) == (1.0, 0.0, 0.0),
        "importScalePreserved": all(abs(s - 0.01) < 1e-6 for s in ybot.scale),
        "characterTypeTagged": ybot["cclay.character_type"] == "Y_BOT"
        and xbot["cclay.character_type"] == "X_BOT",
        "childrenExist": len(ybot_children) >= 2,
        "childrenOwned": all(
            o.get("cclay.owned_project_id") == PROJECT_ID
            and isinstance(o.get("cclay.entity_id"), str)
            and UUID4.fullmatch(o["cclay.entity_id"]) is not None
            for o in ybot_children
        ),
        "childIdsDeterministic": all(
            o["cclay.entity_id"]
            == _derived_child_entity_id(YBOT_ID, o.name.removeprefix("Fighter One "))
            for o in ybot_children
        ),
        "manifestHasArmatures": manifest_types.get(YBOT_ID) == "ARMATURE"
        and manifest_types.get(XBOT_ID) == "ARMATURE",
        "manifestBonesPopulated": len(manifest.get("bones", [])) > 0,
        "committed": len(committed) == 1,
        "identityCoversCharacters": [
            identity["entity_id"] for identity in result["entity_identities"]
        ] == [YBOT_ID, XBOT_ID],
        "checkpointReleased": connection.active_checkpoint is None,
    }

    object_count = len(bpy.data.objects)
    dupe_code = None
    try:
        apply_stage_scene_transaction(
            {
                "schema_version": 1,
                "expected_revision_id": result["manifest"]["revisionId"],
                "operations": [
                    character(DUPE_ID, "Y_BOT", "Fighter One", (0, 0, 0)),
                ],
            },
            result["scene_hash"],
            connection,
            committed.append,
        )
    except StageSceneError as error:
        dupe_code = getattr(error, "code", None)
    results["dupeNameCode"] = dupe_code
    results["dupeRollback"] = len(bpy.data.objects) == object_count
    results["dupeCheckpointReleased"] = connection.active_checkpoint is None
    camera_commit_failure_matched = False
    try:
        apply_stage_scene_transaction(
            {
                "schema_version": 1,
                "expected_revision_id": result["manifest"]["revisionId"],
                "operations": [{
                    "op": "add_camera",
                    "entity_id": FAILED_CAMERA_ID,
                    "name": "Rollback Camera",
                    "location": [0, -5, 3],
                    "rotation": [1.1, 0, 0],
                }],
            },
            result["scene_hash"],
            connection,
            lambda _candidate: (_ for _ in ()).throw(RuntimeError("commit failed")),
        )
    except RuntimeError as error:
        camera_commit_failure_matched = str(error) == "commit failed"
    results["cameraRollback"] = (
        camera_commit_failure_matched
        and bpy.context.scene.camera is None
        and bpy.data.objects.get("Rollback Camera") is None
        and bpy.data.cameras.get("Rollback Camera Data") is None
        and connection.active_checkpoint is None
    )
    camera_result = apply_stage_scene_transaction(
        {
            "schema_version": 1,
            "expected_revision_id": result["manifest"]["revisionId"],
            "operations": [{
                "op": "add_camera",
                "entity_id": CAMERA_ID,
                "name": "Shot Camera",
                "location": [4, -6, 3],
                "rotation": [1.1, 0, 0.6],
                "lens": 55,
            }],
        },
        result["scene_hash"],
        connection,
        committed.append,
    )
    camera = next(o for o in bpy.data.objects if o.get("cclay.entity_id") == CAMERA_ID)
    results["cameraCreatedAndActive"] = (
        camera.type == "CAMERA"
        and bpy.context.scene.camera is camera
        and abs(camera.data.lens - 55) < 1e-6
    )
    results["cameraIdentityReturned"] = camera_result["entity_identities"] == [{
        "entity_id": CAMERA_ID,
        "requested_name": "Shot Camera",
        "actual_name": "Shot Camera",
    }]

    fixture = json.loads(
        pathlib.Path(__file__).with_name("ardy_motion_3frames.json").read_text(
            encoding="utf-8"
        )
    )
    with tempfile.TemporaryDirectory() as project_directory:
        motions = pathlib.Path(project_directory) / ".cclay" / "motions"
        motions.mkdir(parents=True)
        numpy.savez(
            motions / "fixture-motion.npz",
            local_rot_mats=numpy.asarray(fixture["local_rot_mats"]),
            posed_joints=numpy.asarray(fixture["posed_joints"]),
            fps=numpy.asarray(fixture["fps"]),
        )
        connection.project_directory = project_directory
        motion_result = apply_stage_scene_transaction(
            {
                "schema_version": 1,
                "expected_revision_id": camera_result["manifest"]["revisionId"],
                "operations": [{
                    "op": "apply_motion",
                    "entity_id": YBOT_ID,
                    "motion_id": "fixture-motion",
                    "start_frame": 1,
                }],
            },
            camera_result["scene_hash"],
            connection,
            committed.append,
        )
        relaxed_paths = {
            fcurve.data_path for fcurve in animation_fcurves(ybot.animation_data)
        }
        relaxed_right = ybot.pose.bones["mixamorig:RightHandIndex3"]
        relaxed_left = ybot.pose.bones["mixamorig:LeftHandIndex3"]
        results["relaxedFingerCompletion"] = (
            ybot.animation_data.action["cclay.hand_pose"] == "relaxed"
            and relaxed_right.rotation_quaternion.angle > 0.1
            and relaxed_left.rotation_quaternion.angle > 0.1
            and 'pose.bones["mixamorig:RightHandIndex3"].rotation_quaternion'
            in relaxed_paths
            and 'pose.bones["mixamorig:LeftHandIndex3"].rotation_quaternion'
            in relaxed_paths
        )
        results["defaultAppliedHandShapes"] = motion_result["applied_hand_shapes"] == [{
            "operation_index": 0,
            "entity_id": YBOT_ID,
            "motion_id": "fixture-motion",
            "left": "relaxed",
            "right": "relaxed",
            "library_version": LIBRARY_VERSION,
        }]
        results["completeHandInventory"] = all(
            ybot.pose.bones.get(f"mixamorig:{side.title()}Hand{role}") is not None
            for side in ("left", "right")
            for role in CANONICAL_ROLE_ORDER
        )
        motion_result = apply_stage_scene_transaction(
            {
                "schema_version": 1,
                "expected_revision_id": motion_result["manifest"]["revisionId"],
                "operations": [{
                    "op": "apply_motion",
                    "entity_id": YBOT_ID,
                    "motion_id": "fixture-motion",
                    "hand_pose": "open",
                    "start_frame": 1,
                }],
            },
            motion_result["scene_hash"],
            connection,
            committed.append,
        )
        results["openFingerOverride"] = (
            ybot.animation_data.action["cclay.hand_pose"] == "open"
            and ybot.pose.bones[
                "mixamorig:RightHandIndex3"
            ].rotation_quaternion.angle < 1e-6
            and ybot.pose.bones[
                "mixamorig:LeftHandIndex3"
            ].rotation_quaternion.angle < 1e-6
        )
        motion_result = apply_stage_scene_transaction(
            {
                "schema_version": 1,
                "expected_revision_id": motion_result["manifest"]["revisionId"],
                "operations": [{
                    "op": "apply_motion",
                    "entity_id": YBOT_ID,
                    "motion_id": "fixture-motion",
                    "hand_shapes": {"left": "point", "right": "fist"},
                    "start_frame": 1,
                }],
            },
            motion_result["scene_hash"],
            connection,
            committed.append,
        )
        asymmetric_action = ybot.animation_data.action
        results["asymmetricHandShapes"] = (
            asymmetric_action["cclay.hand_shape_left"] == "point"
            and asymmetric_action["cclay.hand_shape_right"] == "fist"
            and asymmetric_action["cclay.hand_shape_library"] == 1
            and asymmetric_action.get("cclay.hand_pose") is None
            and ybot.pose.bones[
                "mixamorig:LeftHandIndex3"
            ].rotation_quaternion.angle < 1e-6
            and ybot.pose.bones[
                "mixamorig:RightHandIndex3"
            ].rotation_quaternion.angle > 0.5
            and motion_result["applied_hand_shapes"] == [{
                "operation_index": 0,
                "entity_id": YBOT_ID,
                "motion_id": "fixture-motion",
                "left": "point",
                "right": "fist",
                "library_version": LIBRARY_VERSION,
            }]
        )
        results["handShapeLibraryVersion"] = LIBRARY_VERSION == "1.1.0"
        digit_curves = [
            fcurve
            for fcurve in animation_fcurves(ybot.animation_data)
            if "HandThumb" in fcurve.data_path
            or "HandIndex" in fcurve.data_path
            or "HandMiddle" in fcurve.data_path
            or "HandRing" in fcurve.data_path
            or "HandPinky" in fcurve.data_path
        ]
        results["handKeyBudgetAndInterpolation"] = (
            bool(digit_curves)
            and all(
                len(fcurve.keyframe_points) <= 3
                and all(point.interpolation == "BEZIER" for point in fcurve.keyframe_points)
                for fcurve in digit_curves
            )
        )
        dense_rotations = numpy.resize(
            numpy.asarray(fixture["local_rot_mats"], dtype=numpy.float64),
            (240, 27, 3, 3),
        )
        dense_joints = numpy.resize(
            numpy.asarray(fixture["posed_joints"], dtype=numpy.float64),
            (240, 27, 3),
        )
        numpy.savez(
            motions / "dense-motion.npz",
            local_rot_mats=dense_rotations,
            posed_joints=dense_joints,
            fps=numpy.asarray(fixture["fps"]),
        )
        dense_receipt_start = len(MOTION_RECEIPTS)
        dense_started = time.perf_counter()
        motion_result = apply_stage_scene_transaction(
            {
                "schema_version": 1,
                "expected_revision_id": motion_result["manifest"]["revisionId"],
                "operations": [{
                    "op": "apply_motion",
                    "entity_id": YBOT_ID,
                    "motion_id": "dense-motion",
                    "hand_pose": "open",
                    "start_frame": 11,
                }],
            },
            motion_result["scene_hash"],
            connection,
            committed.append,
        )
        dense_elapsed_ms = (time.perf_counter() - dense_started) * 1000.0
        dense_receipts = MOTION_RECEIPTS[dense_receipt_start:]
        matching_dense_receipts = [
            (message, receipt)
            for message, receipt in dense_receipts
            if receipt.get("schema") == "cclay.stage_scene_motion.v2"
            and receipt.get("outcome") == "SUCCESS"
            and receipt.get("motion_count") == 1
            and receipt.get("dense_motion_count") == 1
            and receipt.get("source_points") == 23760
        ]
        results["denseWriterTerminalReceiptExact"] = (
            len(matching_dense_receipts) == 1
            and len(matching_dense_receipts[0][0].encode("utf-8")) <= 4096
            and len(dense_receipts) == 1
        )
        dense_action = ybot.animation_data.action
        dense_slot = ybot.animation_data.action_slot
        dense_curves = animation_fcurves(ybot.animation_data)
        dense_points = sum(len(curve.keyframe_points) for curve in dense_curves)
        layer = dense_action.layers[0]
        strip = layer.strips[0]
        dense_bag = strip.channelbag(dense_slot)
        results["denseWriterExactInventory"] = (
            len(dense_curves) == 99
            and dense_points == 23760
            and all(len(curve.keyframe_points) == 240 for curve in dense_curves)
        )
        results["denseWriterLayeredTopology"] = (
            len(dense_action.slots) == 1
            and len(dense_action.layers) == 1
            and len(layer.strips) == 1
            and strip.type == "KEYFRAME"
            and dense_bag is not None
            and len(dense_bag.fcurves) == 99
            and dense_bag.slot_handle == dense_slot.handle
        )

        channels = _independent_dense_channels(
            ybot, dense_rotations, dense_joints, 11
        )
        expected_keys = set(channels)
        bulk_map = _curve_map(dense_curves)
        legacy_action, legacy_slot, legacy_curves, _legacy_parity_ms = (
            _write_legacy_benchmark_action(
                ybot, channels, "CCLAY Legacy Dense Parity"
            )
        )
        legacy_map = _curve_map(legacy_curves)
        key_sets_equal = (
            len(channels) == 99
            and len(bulk_map) == 99
            and len(legacy_map) == 99
            and set(bulk_map) == expected_keys
            and set(legacy_map) == expected_keys
        )
        lengths_equal = key_sets_equal and all(
            len(bulk_map[key].keyframe_points)
            == len(legacy_map[key].keyframe_points)
            == len(channels[key]["frames"])
            == 240
            for key in expected_keys
        )
        results["denseWriterBezierKeyParity"] = lengths_equal and all(
            _points_match(bulk_point, legacy_point)
            for key in expected_keys
            for bulk_point, legacy_point in zip(
                bulk_map[key].keyframe_points,
                legacy_map[key].keyframe_points,
            )
        )
        samples = [
            float(frame)
            for frame in range(11, 251)
        ] + [
            frame + fraction
            for frame in range(11, 250)
            for fraction in (0.25, 0.5, 0.75)
        ]
        results["denseWriterBezierEvaluationParity"] = (
            key_sets_equal
            and max(
                abs(
                    bulk_map[key].evaluate(sample)
                    - legacy_map[key].evaluate(sample)
                )
                for key in expected_keys
                for sample in samples
            ) <= 1e-9
        )
        results["denseWriterCompleteCurveParity"] = (
            key_sets_equal and lengths_equal
        )
        legacy_points_count = sum(
            len(curve.keyframe_points) for curve in legacy_map.values()
        )
        ybot.animation_data.action = dense_action
        ybot.animation_data.action_slot = dense_slot
        bpy.data.actions.remove(legacy_action)

        bulk_runs_ms = []
        legacy_runs_ms = []
        starting_writer_order = _benchmark_writer_order()
        for writer in starting_writer_order:
            if writer == "bulk":
                action, _slot, curves, elapsed_ms = (
                    _write_bulk_benchmark_action(
                        ybot, channels, "CCLAY Bulk Benchmark"
                    )
                )
                bulk_runs_ms.append(elapsed_ms)
                if len(curves) != 99:
                    raise AssertionError("bulk benchmark curve inventory changed")
                bpy.data.actions.remove(action)
            else:
                action, _slot, curves, elapsed_ms = (
                    _write_legacy_benchmark_action(
                        ybot, channels, "CCLAY Legacy Benchmark"
                    )
                )
                legacy_runs_ms.append(elapsed_ms)
                if (
                    len(curves) != 99
                    or sum(len(curve.keyframe_points) for curve in curves)
                    != 23760
                ):
                    raise AssertionError("legacy benchmark inventory changed")
                ybot.animation_data.action = dense_action
                ybot.animation_data.action_slot = dense_slot
                bpy.data.actions.remove(action)

        bulk_median_ms = float(numpy.median(bulk_runs_ms))
        legacy_median_ms = float(numpy.median(legacy_runs_ms))
        speedup = legacy_median_ms / bulk_median_ms
        results["denseWriterBenchmarkReceipt"] = {
            "curves": len(dense_curves),
            "points": dense_points,
            "legacyCurves": 99,
            "legacyPoints": legacy_points_count,
            "writerOrder": (
                "bulk_first"
                if starting_writer_order[0] == "bulk"
                else "legacy_first"
            ),
            "elapsedMs": dense_elapsed_ms,
            "bulkRunsMs": bulk_runs_ms,
            "legacyRunsMs": legacy_runs_ms,
            "bulkMedianMs": bulk_median_ms,
            "legacyMedianMs": legacy_median_ms,
            "speedup": speedup,
        }
        results["denseWriterPerformanceImproved"] = speedup >= 5.0
        results["denseWriterTemporaryActionsRemoved"] = not any(
            action.name.startswith(("CCLAY Bulk ", "CCLAY Legacy "))
            for action in bpy.data.actions
        )
        repeated_actions_before = set(bpy.data.actions)
        motion_result = apply_stage_scene_transaction(
            {
                "schema_version": 1,
                "expected_revision_id": motion_result["manifest"]["revisionId"],
                "operations": [
                    {
                        "op": "apply_motion",
                        "entity_id": YBOT_ID,
                        "motion_id": "dense-motion",
                        "hand_pose": "open",
                        "start_frame": 11,
                    },
                    {
                        "op": "apply_motion",
                        "entity_id": YBOT_ID,
                        "motion_id": "dense-motion",
                        "hand_pose": "open",
                        "start_frame": 11,
                    },
                ],
            },
            motion_result["scene_hash"],
            connection,
            committed.append,
        )
        repeated_new_actions = set(bpy.data.actions) - repeated_actions_before
        results["repeatedMotionNoIntermediateActionLeak"] = (
            len(repeated_new_actions) == 1
            and ybot.animation_data.action in repeated_new_actions
            and ybot.animation_data.action.users > 0
        )
        before_action = ybot.animation_data.action
        before_slot = (
            ybot.animation_data.action_slot
            if hasattr(ybot.animation_data, "action_slot")
            else None
        )
        before_slot_pointer = (
            before_slot.as_pointer() if before_slot is not None else None
        )
        before_pose = {
            bone.name: (
                bone.rotation_mode,
                tuple(bone.rotation_quaternion),
                tuple(bone.location),
            )
            for bone in ybot.pose.bones
        }
        before_actions = set(bpy.data.actions)
        before_selection = tuple(
            scene_object.name
            for scene_object in bpy.context.scene.objects
            if scene_object.select_get()
        )
        before_active_object = (
            bpy.context.view_layer.objects.active.name
            if bpy.context.view_layer.objects.active is not None
            else None
        )
        before_timing = (
            bpy.context.scene.render.fps,
            bpy.context.scene.render.fps_base,
            bpy.context.scene.frame_start,
            bpy.context.scene.frame_end,
            bpy.context.scene.frame_current,
        )
        try:
            apply_stage_scene_transaction(
                {
                    "schema_version": 1,
                    "expected_revision_id": motion_result["manifest"]["revisionId"],
                    "operations": [{
                        "op": "apply_motion",
                        "entity_id": YBOT_ID,
                        "motion_id": "fixture-motion",
                        "hand_shapes": {"left": "hook", "right": "cup"},
                        "start_frame": 17,
                    }],
                },
                motion_result["scene_hash"],
                connection,
                lambda _candidate: (_ for _ in ()).throw(
                    RuntimeError("injected commit failure")
                ),
            )
        except RuntimeError as error:
            results["postApplyRollbackRaised"] = str(error) == "injected commit failure"
        after_pose = {
            bone.name: (
                bone.rotation_mode,
                tuple(bone.rotation_quaternion),
                tuple(bone.location),
            )
            for bone in ybot.pose.bones
        }
        after_slot = (
            ybot.animation_data.action_slot
            if hasattr(ybot.animation_data, "action_slot")
            else None
        )
        results["postApplyRollbackActionRestored"] = (
            ybot.animation_data.action is before_action
        )
        results["postApplyRollbackSlotRestored"] = (
            (after_slot is None and before_slot_pointer is None)
            or (
                after_slot is not None
                and before_slot_pointer is not None
                and after_slot.as_pointer() == before_slot_pointer
            )
        )
        results["postApplyRollback40RolePoseRestored"] = all(
            before_pose[f"mixamorig:{side.title()}Hand{role}"]
            == after_pose[f"mixamorig:{side.title()}Hand{role}"]
            for side in ("left", "right")
            for role in CANONICAL_ROLE_ORDER
        )
        results["postApplyRollbackFullPoseRestored"] = before_pose == after_pose
        results["postApplyRollbackActionInventoryRestored"] = (
            set(bpy.data.actions) == before_actions
        )
        results["postApplyRollbackSelectionRestored"] = (
            before_selection
            == tuple(
                scene_object.name
                for scene_object in bpy.context.scene.objects
                if scene_object.select_get()
            )
            and before_active_object
            == (
                bpy.context.view_layer.objects.active.name
                if bpy.context.view_layer.objects.active is not None
                else None
            )
        )
        results["postApplyRollbackTimingRestored"] = before_timing == (
            bpy.context.scene.render.fps,
            bpy.context.scene.render.fps_base,
            bpy.context.scene.frame_start,
            bpy.context.scene.frame_end,
            bpy.context.scene.frame_current,
        )
        results["postApplyRollbackCheckpointReleased"] = (
            connection.active_checkpoint is None
        )
        results["postApplyRollbackComplete"] = all((
            results["postApplyRollbackActionRestored"],
            results["postApplyRollbackSlotRestored"],
            results["postApplyRollback40RolePoseRestored"],
            results["postApplyRollbackFullPoseRestored"],
            results["postApplyRollbackActionInventoryRestored"],
            results["postApplyRollbackTimingRestored"],
            results["postApplyRollbackCheckpointReleased"],
            results["postApplyRollbackSelectionRestored"],
        ))
        fault_plan = {
            "schema_version": 1,
            "expected_revision_id": motion_result["manifest"]["revisionId"],
            "operations": [{
                "op": "transform_entity",
                "entity_id": YBOT_ID,
                "location": [3, 4, 5],
            }],
        }
        recovery_calls_before = connection.recovery_required_calls
        original_rollback = stage_scene_module._StageTransaction.rollback

        def injected_rollback_failure(_transaction):
            raise RuntimeError("injected rollback failure")

        stage_scene_module._StageTransaction.rollback = injected_rollback_failure
        try:
            apply_stage_scene_transaction(
                fault_plan,
                motion_result["scene_hash"],
                connection,
                lambda _candidate: (_ for _ in ()).throw(
                    RuntimeError("injected pre-durable failure")
                ),
            )
        except DurableCommitReconciliationRequired:
            results["rollbackFailureRaisedReconciliation"] = True
        finally:
            stage_scene_module._StageTransaction.rollback = original_rollback
        results["rollbackFailureRetainedCheckpoint"] = (
            connection.active_checkpoint is not None
            and connection.recovery is not None
            and connection.recovery_required_calls == recovery_calls_before + 1
        )
        rollback_failure_recovered = connection.recovery()
        connection.release_checkpoint()

        original_live_base_manifest = stage_scene_module._live_base_manifest
        live_manifest_calls = 0

        def injected_base_hash_mismatch(expected_hash):
            nonlocal live_manifest_calls
            live_manifest_calls += 1
            manifest = original_live_base_manifest(expected_hash)
            if live_manifest_calls > 1:
                manifest = {**manifest, "sceneHash": "f" * 64}
            return manifest

        recovery_calls_before = connection.recovery_required_calls
        stage_scene_module._live_base_manifest = injected_base_hash_mismatch
        try:
            apply_stage_scene_transaction(
                fault_plan,
                motion_result["scene_hash"],
                connection,
                lambda _candidate: (_ for _ in ()).throw(
                    RuntimeError("injected pre-durable failure")
                ),
            )
        except DurableCommitReconciliationRequired:
            results["baseHashMismatchRaisedReconciliation"] = True
        finally:
            stage_scene_module._live_base_manifest = original_live_base_manifest
        results["baseHashMismatchRetainedCheckpoint"] = (
            connection.active_checkpoint is not None
            and connection.recovery is not None
            and connection.recovery_required_calls == recovery_calls_before + 1
        )
        base_hash_mismatch_recovered = connection.recovery()
        connection.release_checkpoint()

        recovery_calls_before = connection.recovery_required_calls
        connection.fail_release_once = True
        try:
            apply_stage_scene_transaction(
                fault_plan,
                motion_result["scene_hash"],
                connection,
                lambda _candidate: (_ for _ in ()).throw(
                    RuntimeError("injected pre-durable failure")
                ),
            )
        except DurableCommitReconciliationRequired:
            results["preCommitReleaseFailureRaisedReconciliation"] = True
        results["preCommitReleaseFailureRetainedCheckpoint"] = (
            connection.active_checkpoint is not None
            and connection.recovery is not None
            and connection.recovery_required_calls == recovery_calls_before + 1
        )
        pre_commit_release_recovered = connection.recovery()
        connection.release_checkpoint()
        results["preDurableFaultBoundaries"] = all((
            results.get("rollbackFailureRaisedReconciliation", False),
            results["rollbackFailureRetainedCheckpoint"],
            rollback_failure_recovered,
            results.get("baseHashMismatchRaisedReconciliation", False),
            results["baseHashMismatchRetainedCheckpoint"],
            base_hash_mismatch_recovered,
            results.get("preCommitReleaseFailureRaisedReconciliation", False),
            results["preCommitReleaseFailureRetainedCheckpoint"],
            pre_commit_release_recovered,
            connection.active_checkpoint is None,
        ))
        location_before_durable_commit = tuple(ybot.location)
        recovery_calls_before = connection.recovery_required_calls
        connection.fail_release_once = True
        durable_commits = []
        try:
            apply_stage_scene_transaction(
                {
                    "schema_version": 1,
                    "expected_revision_id": motion_result["manifest"]["revisionId"],
                    "operations": [{
                        "op": "transform_entity",
                        "entity_id": YBOT_ID,
                        "location": [7, 8, 9],
                    }],
                },
                motion_result["scene_hash"],
                connection,
                durable_commits.append,
            )
        except DurableCommitReconciliationRequired:
            results["postCommitFailureRaisedReconciliation"] = True
        results["postCommitFailureDidNotRollback"] = (
            tuple(ybot.location) == (7.0, 8.0, 9.0)
            and tuple(ybot.location) != location_before_durable_commit
            and len(durable_commits) == 1
            and connection.active_checkpoint is not None
            and connection.recovery_required_calls == recovery_calls_before + 1
        )
        forward_reconciled = connection.recovery()
        connection.release_checkpoint()
        results["postCommitCheckpointRetainedUntilReconciled"] = (
            forward_reconciled and connection.active_checkpoint is None
        )
    defaults = {
        name: bpy.types.Keyframe.bl_rna.properties[name].default
        for name in ("back", "amplitude", "period")
    }
    keyframes = [
        point
        for fcurve in animation_fcurves(ybot.animation_data)
        for point in fcurve.keyframe_points
    ]
    results["motionKeysNormalized"] = bool(keyframes) and all(
        point.easing == "AUTO"
        and all(getattr(point, name) == default for name, default in defaults.items())
        for point in keyframes
    )
    snapshot = extract_scene_snapshot()
    results["motionSnapshotInspectable"] = not any(
        animation["objectName"] == ybot.name
        for animation in snapshot["animations"]
    )
    baseline_animation = _animation_snapshot(
        ybot.name, "object", ybot.animation_data
    )
    point = keyframes[0]
    saved = {
        "interpolation": point.interpolation,
        "back": point.back,
        "amplitude": point.amplitude,
        "period": point.period,
    }
    point.interpolation = "BEZIER"
    point.back = 1.7
    point.amplitude = 0.8
    point.period = 4.1
    results["inertEasingFieldsRemainInspectable"] = (
        _animation_snapshot(ybot.name, "object", ybot.animation_data)
        == baseline_animation
    )
    point.interpolation = "BACK"
    point.back = defaults["back"] + 1
    try:
        _animation_snapshot(ybot.name, "object", ybot.animation_data)
        results["relevantEasingFieldRejected"] = False
    except UNSUPPORTED_FCURVE_FEATURE as error:
        results["relevantEasingFieldRejected"] = (
            error.code == "UNSUPPORTED_FCURVE_FEATURE"
            and str(error)
            == f"{ybot.name!r} object f-curve uses unsupported easing, "
            "interpolation, or easing parameters"
        )
    finally:
        for name, value in saved.items():
            setattr(point, name, value)

    print("CCLAY_STAGE_CHARACTER_RESULTS=" + json.dumps(results))


_logger, _handler, _saved_logger_state = _install_motion_receipt_logger()
try:
    main()
finally:
    _restore_motion_receipt_logger(_logger, _handler, _saved_logger_state)
