"""Exercise G010 mutation and smooth predicates inside real Blender."""

from __future__ import annotations

import copy
import json
import os
import sys
import traceback
from pathlib import Path

import bpy

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

from oh_my_blender.camera_plan import (
    PLAN_MINIMUM_TWO_KEYFRAMES,
    apply_camera_plan_transaction,
    capture_smooth_handles,
    validate_smooth_fcurves,
)
from oh_my_blender.fixture_registry import BOXING_V4_EVIDENCE_SHA256
from oh_my_blender.manifest import animation_fcurves, extract_scene_manifest_v2

REVISION = "ca8d4e064f2e3391958eeb0a7885cc4cd92f9d15d39cf2950909ec6294903ca3"
SCENE_HASH = "f65db0255801e77b209e1019a70d9d1bb4e82fe37e709ead111290934a8b8816"
PROJECT_ID = "00000000-0000-4000-8000-00000000000a"
SUBJECT_ID = "00000000-0000-4000-8000-000000000002"


class Connection:
    def __init__(self):
        self.active_checkpoint = None

    def hold_checkpoint(self, checkpoint):
        if self.active_checkpoint is not None:
            raise RuntimeError("checkpoint already held")
        self.active_checkpoint = checkpoint

    def release_checkpoint(self):
        checkpoint = self.active_checkpoint
        self.active_checkpoint = None
        return checkpoint


def bound_plan() -> dict:
    old_plan = json.loads(
        (REPOSITORY_ROOT / "packages/blender-protocol/test/fixtures/ardy-camera-plan-v4.json").read_text(
            encoding="utf-8"
        )
    )
    return {
        "schema_version": 1,
        "expected_revision_id": REVISION,
        "evidence_sha256": BOXING_V4_EVIDENCE_SHA256,
        "output_format": old_plan["output_format"],
        "keyframes": old_plan["keyframes"],
    }


def setup_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.name = "G010 Boxing Round Trip"
    scene["omb.project_id"] = PROJECT_ID
    scene.frame_start = 0
    scene.frame_end = 319
    scene.render.fps = 24
    scene.render.fps_base = 1.0
    bpy.ops.mesh.primitive_cube_add(location=(3.0, 4.0, 5.0))
    subject = bpy.context.active_object
    subject.name = "Untouched Subject"
    subject["omb.entity_id"] = SUBJECT_ID


def code(error: BaseException) -> str:
    return str(getattr(error, "code", type(error).__name__))


def camera_animation():
    camera = bpy.data.objects["OMB Camera"]
    return camera, [camera.animation_data, camera.data.animation_data]


def fresh(plan: dict):
    connection = Connection()
    apply_camera_plan_transaction(plan, SCENE_HASH, connection, lambda _result: None)
    camera, animation_values = camera_animation()
    smooth_frames = {
        int(keyframe["frame"])
        for keyframe in plan["keyframes"]
        if keyframe["transition"] == "smooth"
    } - {
        int(plan["keyframes"][index - 1]["frame"])
        for index in range(1, len(plan["keyframes"]))
        if plan["keyframes"][index]["transition"] == "cut"
    }
    return camera, animation_values, smooth_frames, capture_smooth_handles(animation_values, smooth_frames)


def expect_error(animation_values, smooth_frames, expected, mutate) -> str:
    mutate()
    try:
        validate_smooth_fcurves(animation_values, smooth_frames, expected)
    except BaseException as error:
        return code(error)
    raise AssertionError("smooth mutation unexpectedly passed")


def main() -> None:
    setup_scene()
    plan = bound_plan()
    results = {}
    scene = bpy.context.scene
    untouched = bpy.data.objects["Untouched Subject"]
    untouched_before = tuple(untouched.location)

    # Losing commit race: target was newly created, so rollback must remove it and restore scope.
    connection = Connection()
    before = extract_scene_manifest_v2()
    try:
        apply_camera_plan_transaction(
            plan,
            SCENE_HASH,
            connection,
            lambda _result: (_ for _ in ()).throw(RuntimeError("commit conflict")),
        )
    except RuntimeError:
        pass
    after = extract_scene_manifest_v2()
    results["rollback"] = before["sceneHash"] == after["sceneHash"] and "OMB Camera" not in bpy.data.objects
    results["checkpointReleased"] = connection.active_checkpoint is None

    first = apply_camera_plan_transaction(plan, SCENE_HASH, Connection(), lambda _result: None)
    first_manifest = first["manifest"]
    second = apply_camera_plan_transaction(plan, SCENE_HASH, Connection(), lambda _result: None)
    second_manifest = second["manifest"]
    results["cuts"] = sorted(marker.frame for marker in scene.timeline_markers if marker.name.startswith("CUT_"))
    results["roundTrip"] = all(
        marker.name == f"CUT_{marker.frame}" and marker.camera == scene.camera
        for marker in scene.timeline_markers
        if marker.name.startswith("CUT_")
    )
    results["stableHash"] = first_manifest["sceneHash"] == second_manifest["sceneHash"]
    results["unrelatedUnchanged"] = tuple(untouched.location) == untouched_before
    changed_plan = copy.deepcopy(plan)
    changed_plan["output_format"]["width"] = 1280
    changed_plan["keyframes"][0]["pose"]["position"][0] = 9.0
    existing_connection = Connection()
    try:
        apply_camera_plan_transaction(
            changed_plan,
            SCENE_HASH,
            existing_connection,
            lambda _result: (_ for _ in ()).throw(RuntimeError("commit conflict")),
        )
    except RuntimeError:
        pass
    restored_existing = extract_scene_manifest_v2()
    results["existingRollback"] = (
        restored_existing["sceneHash"] == second_manifest["sceneHash"]
        and existing_connection.active_checkpoint is None
    )

    camera, animation_values, smooth_frames, expected = fresh(plan)
    point = next(
        point
        for data in animation_values
        for curve in animation_fcurves(data)
        for point in curve.keyframe_points
        if int(point.co.x) in smooth_frames
    )
    results["row23"] = expect_error(
        animation_values,
        smooth_frames,
        expected,
        lambda: setattr(point, "interpolation", "LINEAR"),
    )

    camera, animation_values, smooth_frames, expected = fresh(plan)
    point = next(
        point
        for data in animation_values
        for curve in animation_fcurves(data)
        for point in curve.keyframe_points
        if int(point.co.x) in smooth_frames
    )
    results["row24"] = expect_error(
        animation_values,
        smooth_frames,
        expected,
        lambda: setattr(point.handle_right, "y", float(point.handle_right.y) + 1e-4),
    )

    camera, animation_values, smooth_frames, expected = fresh(plan)
    point = next(
        point
        for data in animation_values
        for curve in animation_fcurves(data)
        for point in curve.keyframe_points
        if int(point.co.x) in smooth_frames
    )
    results["row25"] = expect_error(
        animation_values,
        smooth_frames,
        expected,
        lambda: setattr(point.handle_right, "y", float("nan")),
    )

    camera, animation_values, smooth_frames, _expected = fresh(plan)
    curve = next(curve for curve in animation_fcurves(camera.animation_data) if curve.data_path == "location")
    point = next(point for point in curve.keyframe_points if int(point.co.x) in smooth_frames)
    point.handle_right.y = max(float(item.co.y) for item in curve.keyframe_points) + 10.0
    expected = capture_smooth_handles(animation_values, smooth_frames)
    results["row26"] = expect_error(animation_values, smooth_frames, expected, lambda: None)

    # A 5e-7 opposing-secant perturbation stays inside row 26's range tolerance
    # while its handle-derived tangent exceeds row 27's 1e-6 zero limit.
    camera.animation_data_clear()
    for frame, value in ((1, 1.0), (2, 1.0), (3, 1.0)):
        camera.location.x = value
        camera.keyframe_insert(data_path="location", index=0, frame=frame)
    curve = next(
        curve
        for curve in animation_fcurves(camera.animation_data)
        if curve.data_path == "location" and curve.array_index == 0
    )
    for item in curve.keyframe_points:
        item.interpolation = "BEZIER"
        item.handle_left_type = "AUTO_CLAMPED"
        item.handle_right_type = "AUTO_CLAMPED"
    curve.update()
    middle = next(item for item in curve.keyframe_points if int(round(item.co.x)) == 2)
    middle.handle_left.y += 9e-7
    smooth_frames = {2}
    animation_values = [camera.animation_data]
    expected = capture_smooth_handles(animation_values, smooth_frames)
    results["row27"] = expect_error(animation_values, smooth_frames, expected, lambda: None)

    # Fresh Blender-generated handles exercise zero secants and one-sided endpoints.
    camera.animation_data_clear()
    for frame, value in ((1, 1.0), (2, 1.0), (3, 2.0)):
        camera.location.x = value
        camera.keyframe_insert(data_path="location", index=0, frame=frame)
    curve = next(curve for curve in animation_fcurves(camera.animation_data) if curve.data_path == "location" and curve.array_index == 0)
    for item in curve.keyframe_points:
        item.interpolation = "BEZIER"
        item.handle_left_type = "AUTO_CLAMPED"
        item.handle_right_type = "AUTO_CLAMPED"
    curve.update()
    smooth_frames = {1, 2, 3}
    animation_values = [camera.animation_data]
    expected = capture_smooth_handles(animation_values, smooth_frames)
    validate_smooth_fcurves(animation_values, smooth_frames, expected)
    results["zeroSecant"] = True
    results["endpoints"] = True

    singleton = copy.deepcopy(plan)
    singleton["keyframes"] = singleton["keyframes"][:1]
    try:
        apply_camera_plan_transaction(singleton, SCENE_HASH, Connection(), lambda _result: None)
    except PLAN_MINIMUM_TWO_KEYFRAMES as error:
        results["singleton"] = code(error)

    print("OMB_CAMERA_PLAN_RESULTS=" + json.dumps(results, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        traceback.print_exc()
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(1)
