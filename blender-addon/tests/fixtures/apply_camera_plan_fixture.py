"""Exercise G010 mutation and smooth predicates inside real Blender."""

from __future__ import annotations

import copy
import json
import math
import os
import sys
import traceback
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

from cclay.camera_plan import (
    PLAN_MINIMUM_TWO_KEYFRAMES,
    apply_camera_plan_transaction,
    capture_smooth_handles,
    validate_smooth_fcurves,
)
from cclay.fixture_registry import BOXING_V4_EVIDENCE_SHA256
from cclay.canonical import canonical_revision
from cclay.fixture_registry import convert_ardy_plan_pose_to_blender
from cclay.manifest import animation_fcurves, extract_scene_manifest_v4
from cclay.canonical import canonical_json
from cclay.revision import child_revision_id

REVISION = "7920614992fba50993b2cc2774dbf9a11fbd6feceaf00dc97ee0c75aa7e6768a"
SCENE_HASH = "81c57a255b9d51a6b66dd8bc7b2c898b30a7c2314ce962345277bcf86d6769ab"
PROJECT_ID = "00000000-0000-4000-8000-00000000000a"
SUBJECT_ID = "00000000-0000-4000-8000-000000000002"


class Connection:
    def __init__(self):
        self.active_checkpoint = None
    def ensure_mutation_connection(self, _phase):
        return None

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
    scene["cclay.project_id"] = PROJECT_ID
    scene.frame_start = 0
    scene.frame_end = 319
    scene.render.fps = 24
    scene.render.fps_base = 1.0
    bpy.ops.mesh.primitive_cube_add(location=(3.0, 4.0, 5.0))
    subject = bpy.data.objects["Cube"]
    subject.name = "Untouched Subject"
    subject["cclay.entity_id"] = SUBJECT_ID


def code(error: BaseException) -> str:
    return str(getattr(error, "code", type(error).__name__))


def camera_animation():
    camera = bpy.data.objects["CCLAY Camera"]
    return camera, [camera.animation_data, camera.data.animation_data]


def fresh(plan: dict):
    setup_scene()
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


def _round_trip_values_match(manifest: dict, plan: dict) -> bool:
    animations = {
        animation["target"]: animation
        for animation in manifest["cameraAnimations"]
        if animation["objectId"] == manifest["scene"]["activeCameraId"]
    }
    object_curves = {
        (curve["dataPath"], curve["arrayIndex"]): curve
        for curve in animations["object"]["fcurves"]
    }
    data_curves = {
        (curve["dataPath"], curve["arrayIndex"]): curve
        for curve in animations["cameraData"]["fcurves"]
    }
    for keyframe in plan["keyframes"]:
        frame = float(keyframe["frame"])
        converted = convert_ardy_plan_pose_to_blender(keyframe["pose"])
        position = Vector(converted["position"])
        look_at = Vector(converted["look_at"])
        up = Vector(converted["up"])
        z_axis = -(look_at - position).normalized()
        x_axis = up.cross(z_axis).normalized()
        y_axis = z_axis.cross(x_axis)
        quaternion = Matrix((x_axis, y_axis, z_axis)).transposed().to_quaternion()
        expected = {
            **{("location", index): float(value) for index, value in enumerate(position)},
            **{
                ("rotation_quaternion", index): float(value)
                for index, value in enumerate(quaternion)
            },
            ("angle", 0): float(converted["vertical_fov_radians"]),
        }
        for curve_key, value in expected.items():
            curve = (
                data_curves[curve_key]
                if curve_key[0] == "angle"
                else object_curves[curve_key]
            )
            actual = next(
                point["value"]
                for point in curve["keyframes"]
                if abs(point["frame"] - frame) <= 1e-6
            )
            if abs(actual - value) > 1e-6:
                return False
    return True


def _subject_hash(manifest: dict) -> str:
    subject = next(
        item for item in manifest["objects"] if item["entityId"] == SUBJECT_ID
    )
    return canonical_revision(subject)

def main() -> None:
    global REVISION, SCENE_HASH
    setup_scene()
    initial_manifest = extract_scene_manifest_v4()
    REVISION = initial_manifest["revisionId"]
    SCENE_HASH = initial_manifest["sceneHash"]
    plan = bound_plan()
    results = {}
    scene = bpy.context.scene
    untouched = bpy.data.objects["Untouched Subject"]
    untouched_before = tuple(untouched.location)

    # Losing commit race: target was newly created, so rollback must remove it and restore scope.
    connection = Connection()
    before = extract_scene_manifest_v4()
    subject_hash_before = _subject_hash(before)
    try:
        apply_camera_plan_transaction(
            plan,
            SCENE_HASH,
            connection,
            lambda _result: (_ for _ in ()).throw(RuntimeError("commit conflict")),
        )
    except RuntimeError:
        pass
    after = extract_scene_manifest_v4()
    results["rollback"] = before["sceneHash"] == after["sceneHash"] and "CCLAY Camera" not in bpy.data.objects
    results["checkpointReleased"] = connection.active_checkpoint is None

    selected_before = [obj.name for obj in scene.objects if obj.select_get()]
    active_before = bpy.context.view_layer.objects.active.name
    first = apply_camera_plan_transaction(plan, SCENE_HASH, Connection(), lambda _result: None)
    first_manifest = first["manifest"]
    results["flatChildRevision"] = first_manifest["revisionId"] == child_revision_id(
        PROJECT_ID,
        plan["expected_revision_id"],
        canonical_json(plan),
        first_manifest["sceneHash"],
        canonical_json([]),
    )
    results["selectionPreserved"] = (
        [obj.name for obj in scene.objects if obj.select_get()] == selected_before
        and bpy.context.view_layer.objects.active.name == active_before
    )
    setup_scene()
    plan_without_evidence = copy.deepcopy(plan)
    del plan_without_evidence["evidence_sha256"]
    no_evidence = apply_camera_plan_transaction(
        plan_without_evidence, SCENE_HASH, Connection(), lambda _result: None
    )
    results["noEvidenceChildRevision"] = no_evidence["manifest"]["revisionId"] == child_revision_id(
        PROJECT_ID,
        plan_without_evidence["expected_revision_id"],
        canonical_json(plan_without_evidence),
        no_evidence["manifest"]["sceneHash"],
        canonical_json([]),
    )

    setup_scene()
    scene = bpy.context.scene
    untouched = bpy.data.objects["Untouched Subject"]
    second = apply_camera_plan_transaction(plan, SCENE_HASH, Connection(), lambda _result: None)
    second_manifest = second["manifest"]
    results["cuts"] = sorted(marker.frame for marker in scene.timeline_markers if marker.name.startswith("CUT_"))
    results["roundTrip"] = (
        all(
            marker.name == f"CUT_{marker.frame}" and marker.camera == scene.camera
            for marker in scene.timeline_markers
            if marker.name.startswith("CUT_")
        )
        and _round_trip_values_match(second_manifest, plan)
    )
    results["stableHash"] = first_manifest["sceneHash"] == second_manifest["sceneHash"]
    results["unrelatedUnchanged"] = (
        tuple(untouched.location) == untouched_before
        and _subject_hash(second_manifest) == subject_hash_before
    )
    evidence = json.loads(
        (
            REPOSITORY_ROOT
            / "blender-addon/cclay/fixtures/boxing-v4-directing-evidence.json"
        ).read_text(encoding="utf-8")
    )
    valleys = evidence["analysis"]["motion_valley_frames"]
    peak_ranges = evidence["analysis"]["action_peak_ranges"]
    cuts_with_indices = [
        (index, keyframe)
        for index, keyframe in enumerate(plan["keyframes"])
        if keyframe["transition"] == "cut"
    ]
    results["row29PassedCuts"] = [
        keyframe["frame"]
        for _index, keyframe in cuts_with_indices
        if any(abs(keyframe["frame"] - valley) <= 1 for valley in valleys)
    ]
    results["row30PassedCuts"] = [
        keyframe["frame"]
        for _index, keyframe in cuts_with_indices
        if not any(
            value_range["start"] - 1
            <= keyframe["frame"]
            <= value_range["end"] + 1
            for value_range in peak_ranges
        )
    ]

    samples = {
        sample["frame"]: sample
        for sample in evidence["analysis"]["subject_samples"]
    }
    scale_ratios = []
    for index, keyframe in cuts_with_indices:
        previous_pose = plan["keyframes"][index - 1]["pose"]
        before = samples[keyframe["frame"] - 1]
        after_sample = samples[keyframe["frame"]]

        def projected_scale(pose, sample):
            camera_position = Vector(
                convert_ardy_plan_pose_to_blender(pose)["position"]
            )
            distance = (camera_position - Vector(sample["center"])).length
            return sample["height_m"] / (
                distance * 2 * math.tan(pose["vertical_fov_radians"] / 2)
            )

        before_scale = projected_scale(previous_pose, before)
        after_scale = projected_scale(keyframe["pose"], after_sample)
        scale_ratios.append(
            max(before_scale, after_scale) / min(before_scale, after_scale)
        )
    results["row32ScaleRatios"] = scale_ratios

    axis = evidence["analysis"]["action_axis"]
    axis_side = (
        (Vector(axis["b"]) - Vector(axis["a"]))
        .cross(Vector(axis["up"]))
        .normalized()
    )
    side_scores = [
        (
            Vector(convert_ardy_plan_pose_to_blender(keyframe["pose"])["position"])
            - Vector(axis["a"])
        ).dot(axis_side)
        for keyframe in plan["keyframes"]
    ]
    results["row34AxisSigns"] = [
        1 if score > 0 else -1 if score < 0 else 0
        for score in side_scores
    ]
    results["evidenceCuts"] = (
        results["row29PassedCuts"] == results["cuts"]
        and results["row30PassedCuts"] == results["cuts"]
        and all(ratio <= 1.35 + 1e-6 for ratio in scale_ratios)
        and len(set(results["row34AxisSigns"])) == 1
        and results["row34AxisSigns"][0] != 0
    )
    setup_scene()
    rollback_base = extract_scene_manifest_v4()
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
    restored_existing = extract_scene_manifest_v4()
    results["existingRollback"] = (
        restored_existing["sceneHash"] == rollback_base["sceneHash"]
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

    print("CCLAY_CAMERA_PLAN_RESULTS=" + json.dumps(results, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        traceback.print_exc()
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(1)
