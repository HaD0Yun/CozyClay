"""Real-Blender CameraPlanV1 mutation with scoped rollback and smooth validation."""

from __future__ import annotations

import math
import time
import uuid
from collections.abc import Callable

from .checkpoint import Checkpoint, create_checkpoint, restore, verify
from .fixture_registry import (
    convert_ardy_plan_pose_to_blender,
    load_authorized_fixture,
    parse_camera_plan,
)

try:  # Blender is intentionally absent from host-side unit tests.
    import bpy  # type: ignore
    from mathutils import Matrix, Vector  # type: ignore
except ImportError:  # pragma: no cover
    bpy = None
    Matrix = None
    Vector = None


class CameraPlanError(RuntimeError):
    """A validated camera plan cannot be applied safely."""


class PLAN_MINIMUM_TWO_KEYFRAMES(CameraPlanError):
    code = "PLAN_MINIMUM_TWO_KEYFRAMES"


class SMOOTH_HANDLE_TYPE_INVALID(CameraPlanError):
    code = "SMOOTH_HANDLE_TYPE_INVALID"


class SMOOTH_HANDLE_TOLERANCE_EXCEEDED(CameraPlanError):
    code = "SMOOTH_HANDLE_TOLERANCE_EXCEEDED"


class SMOOTH_VALUE_NOT_FINITE(CameraPlanError):
    code = "SMOOTH_VALUE_NOT_FINITE"


class SMOOTH_HANDLE_OUT_OF_RANGE(CameraPlanError):
    code = "SMOOTH_HANDLE_OUT_OF_RANGE"


class SMOOTH_TANGENT_SIGN_INVALID(CameraPlanError):
    code = "SMOOTH_TANGENT_SIGN_INVALID"


class CAMERA_PLAN_CANCELLED(CameraPlanError):
    code = "CAMERA_PLAN_CANCELLED"


class CAMERA_PLAN_DEADLINE_EXCEEDED(CameraPlanError):
    code = "CAMERA_PLAN_DEADLINE_EXCEEDED"


_TARGET_NAME = "OMB Camera"
_TOLERANCE = 1e-6


def _fcurves(animation_data: object | None) -> list[object]:
    if animation_data is None or animation_data.action is None:
        return []
    from .manifest import animation_fcurves

    return animation_fcurves(animation_data)


def _set_key_defaults(point: object) -> None:
    point.handle_left_type = "AUTO_CLAMPED"
    point.handle_right_type = "AUTO_CLAMPED"
    for name in ("back", "amplitude", "period"):
        setattr(point, name, bpy.types.Keyframe.bl_rna.properties[name].default)


def _configure_interpolation(animation_data: object | None, cuts: set[int]) -> None:
    for fcurve in _fcurves(animation_data):
        for point in fcurve.keyframe_points:
            frame = int(round(float(point.co.x)))
            point.interpolation = "CONSTANT" if frame in cuts else "BEZIER"
            _set_key_defaults(point)
        fcurve.update()


def _smooth_points(animation_data: object | None, smooth_frames: set[int]):
    for fcurve in _fcurves(animation_data):
        points = list(fcurve.keyframe_points)
        for index, point in enumerate(points):
            frame = int(round(float(point.co.x)))
            if frame in smooth_frames:
                yield fcurve, points, index, point


def capture_smooth_handles(
    animation_data_values: list[object | None], smooth_frames: set[int]
) -> dict[tuple[str, int, int, str], tuple[float, float]]:
    """Capture Blender-evaluated handles immediately after f-curve update."""
    handles = {}
    for animation_data in animation_data_values:
        for fcurve, _points, _index, point in _smooth_points(animation_data, smooth_frames):
            frame = int(round(float(point.co.x)))
            prefix = (str(fcurve.data_path), int(fcurve.array_index), frame)
            handles[(*prefix, "left")] = tuple(float(value) for value in point.handle_left)
            handles[(*prefix, "right")] = tuple(float(value) for value in point.handle_right)
    return handles


def _sign(value: float) -> int:
    return 1 if value > 0 else -1 if value < 0 else 0


def validate_smooth_fcurves(
    animation_data_values: list[object | None],
    smooth_frames: set[int],
    expected_handles: dict[tuple[str, int, int, str], tuple[float, float]],
) -> None:
    """Validate exact G010 smooth rows 23 through 27 in precedence order."""
    entries = [
        entry
        for animation_data in animation_data_values
        for entry in _smooth_points(animation_data, smooth_frames)
    ]

    # Row 23: smooth key not BEZIER or either handle type not AUTO_CLAMPED.
    for _fcurve, _points, _index, point in entries:
        if (
            point.interpolation != "BEZIER"
            or point.handle_left_type != "AUTO_CLAMPED"
            or point.handle_right_type != "AUTO_CLAMPED"
        ):
            raise SMOOTH_HANDLE_TYPE_INVALID("smooth key requires BEZIER/AUTO_CLAMPED handles")

    # Row 24: generated/evaluated Blender handle differs by more than 1e-6.
    for fcurve, _points, _index, point in entries:
        frame = int(round(float(point.co.x)))
        prefix = (str(fcurve.data_path), int(fcurve.array_index), frame)
        for side, actual in (("left", point.handle_left), ("right", point.handle_right)):
            expected = expected_handles.get((*prefix, side))
            if expected is None or any(
                math.isfinite(float(actual[index]))
                and abs(float(actual[index]) - expected[index]) > _TOLERANCE
                for index in (0, 1)
            ):
                raise SMOOTH_HANDLE_TOLERANCE_EXCEEDED(
                    "Blender-evaluated handle differs from its generated value"
                )

    # Row 25: any smooth key, handle, or tangent is nonfinite.
    tangents: list[tuple[object, list[object], int, list[float]]] = []
    for _fcurve, points, index, point in entries:
        values = [
            float(point.co.x),
            float(point.co.y),
            float(point.handle_left.x),
            float(point.handle_left.y),
            float(point.handle_right.x),
            float(point.handle_right.y),
        ]
        point_tangents = []
        for handle in (point.handle_left, point.handle_right):
            delta_x = float(handle.x) - float(point.co.x)
            point_tangents.append(
                (float(handle.y) - float(point.co.y)) / delta_x
                if delta_x != 0
                else math.nan
            )
        if not all(math.isfinite(value) for value in (*values, *point_tangents)):
            raise SMOOTH_VALUE_NOT_FINITE("smooth key, handle, or tangent is nonfinite")
        tangents.append((point, points, index, point_tangents))

    # Row 26: each handle stays within its adjacent value interval +/- 1e-6.
    for point, points, index, _point_tangents in tangents:
        value = float(point.co.y)
        if index > 0:
            low, high = sorted((float(points[index - 1].co.y), value))
            if not low - _TOLERANCE <= float(point.handle_left.y) <= high + _TOLERANCE:
                raise SMOOTH_HANDLE_OUT_OF_RANGE("left handle exceeds its adjacent value interval")
        if index + 1 < len(points):
            low, high = sorted((value, float(points[index + 1].co.y)))
            if not low - _TOLERANCE <= float(point.handle_right.y) <= high + _TOLERANCE:
                raise SMOOTH_HANDLE_OUT_OF_RANGE("right handle exceeds its adjacent value interval")

    # Row 27: endpoint/zero/interior tangent sign and magnitude contract.
    for _point, points, index, point_tangents in tangents:
        left_secant = None
        right_secant = None
        if index > 0:
            left_secant = (
                float(points[index].co.y) - float(points[index - 1].co.y)
            ) / (float(points[index].co.x) - float(points[index - 1].co.x))
        if index + 1 < len(points):
            right_secant = (
                float(points[index + 1].co.y) - float(points[index].co.y)
            ) / (float(points[index + 1].co.x) - float(points[index].co.x))

        allowed_sign = 0
        if left_secant is None:
            allowed_sign = _sign(right_secant)
        elif right_secant is None:
            allowed_sign = _sign(left_secant)
        elif _sign(left_secant) != 0 and _sign(left_secant) == _sign(right_secant):
            allowed_sign = _sign(left_secant)

        relevant = []
        if index > 0:
            relevant.append(point_tangents[0])
        if index + 1 < len(points):
            relevant.append(point_tangents[1])
        for tangent in relevant:
            if allowed_sign == 0:
                if abs(tangent) > _TOLERANCE:
                    raise SMOOTH_TANGENT_SIGN_INVALID(
                        "zero or opposing secants require tangent magnitude <= 1e-6"
                    )
            elif abs(tangent) > _TOLERANCE and _sign(tangent) != allowed_sign:
                raise SMOOTH_TANGENT_SIGN_INVALID("tangent sign differs from its allowed secant sign")


def _animation_state(animation_data: object | None) -> list[dict]:
    return [
        {
            "data_path": str(fcurve.data_path),
            "array_index": int(fcurve.array_index),
            "points": [
                {
                    "co": [float(point.co.x), float(point.co.y)],
                    "interpolation": str(point.interpolation),
                    "handle_left": [float(point.handle_left.x), float(point.handle_left.y)],
                    "handle_right": [float(point.handle_right.x), float(point.handle_right.y)],
                    "handle_left_type": str(point.handle_left_type),
                    "handle_right_type": str(point.handle_right_type),
                }
                for point in fcurve.keyframe_points
            ],
        }
        for fcurve in _fcurves(animation_data)
    ]


def _target_state(target: object | None) -> dict | None:
    if target is None:
        return None
    return {
        "location": [float(value) for value in target.location],
        "rotation_mode": str(target.rotation_mode),
        "rotation_quaternion": [float(value) for value in target.rotation_quaternion],
        "angle": float(target.data.angle),
        "sensor_fit": str(target.data.sensor_fit),
        "entity_id": target.get("omb.entity_id"),
        "object_animation": _animation_state(target.animation_data),
        "data_animation": _animation_state(target.data.animation_data),
    }


def _restore_animation(owner: object, curves: list[dict]) -> None:
    owner.animation_data_clear()
    curves_by_path: dict[str, list[dict]] = {}
    for curve in curves:
        curves_by_path.setdefault(curve["data_path"], []).append(curve)
    for path, path_curves in curves_by_path.items():
        points_by_frame: dict[float, dict[int, float]] = {}
        for curve in path_curves:
            for point in curve["points"]:
                frame, value = point["co"]
                points_by_frame.setdefault(frame, {})[curve["array_index"]] = value
        for frame, values in sorted(points_by_frame.items()):
            if path == "angle":
                owner.keyframe_insert(data_path="lens", frame=frame)
                continue
            property_value = getattr(owner, path)
            if hasattr(property_value, "__len__"):
                for index, value in values.items():
                    property_value[index] = value
            else:
                setattr(owner, path, next(iter(values.values())))
            owner.keyframe_insert(data_path=path, frame=frame)

    restored_curves = _fcurves(owner.animation_data)
    angle_curves = [
        fcurve for fcurve in restored_curves if fcurve.data_path == "lens"
    ]
    if any(curve["data_path"] == "angle" for curve in curves):
        if len(angle_curves) != 1:
            raise CameraPlanError("could not restore camera angle animation")
        angle_curves[0].data_path = "angle"

    by_key = {
        (str(fcurve.data_path), int(fcurve.array_index)): fcurve
        for fcurve in _fcurves(owner.animation_data)
    }
    for curve in curves:
        fcurve = by_key[(curve["data_path"], curve["array_index"])]
        for point, saved in zip(fcurve.keyframe_points, curve["points"], strict=True):
            point.interpolation = saved["interpolation"]
            point.easing = "AUTO"
            for name in ("back", "amplitude", "period"):
                setattr(point, name, bpy.types.Keyframe.bl_rna.properties[name].default)
            point.handle_left_type = saved["handle_left_type"]
            point.handle_right_type = saved["handle_right_type"]
            point.handle_left = saved["handle_left"]
            point.handle_right = saved["handle_right"]
        fcurve.update()


def _scope_state(scene: object) -> dict[str, dict]:
    target = bpy.data.objects.get(_TARGET_NAME)
    return {
        "camera_plan_scope": {
            "target": _target_state(target),
            "active_camera": scene.camera.name if scene.camera else None,
            "selected": sorted(obj.name for obj in scene.objects if obj.select_get()),
            "resolution": [
                int(scene.render.resolution_x),
                int(scene.render.resolution_y),
                int(scene.render.resolution_percentage),
            ],
            "markers": [
                [marker.name, int(marker.frame), marker.camera.name if marker.camera else None]
                for marker in scene.timeline_markers
            ],
        }
    }


def _restore_scope(
    _entity_key: str,
    values: dict,
    action_backups: tuple[object | None, object | None] | None = None,
) -> None:
    scene = bpy.context.scene
    target = bpy.data.objects.get(_TARGET_NAME)
    target_state = values["target"]
    if target_state is None and target is not None:
        data = target.data
        bpy.data.objects.remove(target, do_unlink=True)
        if data is not None and data.users == 0:
            bpy.data.cameras.remove(data)
    elif target_state is not None:
        if target is None or target.type != "CAMERA":
            raise CameraPlanError("checkpoint target camera no longer exists")
        target.location = target_state["location"]
        target.rotation_mode = target_state["rotation_mode"]
        target.rotation_quaternion = target_state["rotation_quaternion"]
        target.data.angle = target_state["angle"]
        target.data.sensor_fit = target_state["sensor_fit"]
        if target_state["entity_id"] is None:
            if "omb.entity_id" in target:
                del target["omb.entity_id"]
        else:
            target["omb.entity_id"] = target_state["entity_id"]
        if action_backups is None:
            _restore_animation(target, target_state["object_animation"])
            _restore_animation(target.data, target_state["data_animation"])
        else:
            target.animation_data_clear()
            target.data.animation_data_clear()
            if action_backups[0] is not None:
                target.animation_data_create().action = action_backups[0]
            if action_backups[1] is not None:
                target.data.animation_data_create().action = action_backups[1]
        target.location = target_state["location"]
        target.rotation_mode = target_state["rotation_mode"]
        target.rotation_quaternion = target_state["rotation_quaternion"]
        target.data.angle = target_state["angle"]
    scene.camera = bpy.data.objects.get(values["active_camera"]) if values["active_camera"] else None
    scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = values["resolution"]
    for marker in list(scene.timeline_markers):
        scene.timeline_markers.remove(marker)
    for name, frame, camera_name in values["markers"]:
        marker = scene.timeline_markers.new(name, frame=frame)
        marker.camera = bpy.data.objects.get(camera_name) if camera_name else None
    for obj in scene.objects:
        obj.select_set(obj.name in values["selected"])


def _read_scope(_entity_key: str) -> dict:
    return _scope_state(bpy.context.scene)["camera_plan_scope"]


def _camera_for_plan(scene: object) -> object:
    camera = bpy.data.objects.get(_TARGET_NAME)
    if camera is None:
        camera_data = bpy.data.cameras.new(f"{_TARGET_NAME} Data")
        camera_data.sensor_fit = "VERTICAL"
        camera = bpy.data.objects.new(_TARGET_NAME, camera_data)
        camera["omb.entity_id"] = str(uuid.uuid4())
        scene.collection.objects.link(camera)
    if camera.type != "CAMERA":
        raise CameraPlanError(f"{_TARGET_NAME!r} exists but is not a camera")
    for obj in scene.objects:
        obj.select_set(False)
    camera.select_set(True)
    bpy.context.view_layer.objects.active = camera
    scene.camera = camera
    camera.rotation_mode = "QUATERNION"
    return camera


def _clear_plan_artifacts(scene: object, camera: object) -> None:
    camera.animation_data_clear()
    camera.data.animation_data_clear()
    for marker in list(scene.timeline_markers):
        if marker.name.startswith("CUT_"):
            scene.timeline_markers.remove(marker)


def _apply_keyframes(scene: object, camera: object, plan: dict) -> tuple[set[int], set[int]]:
    keyframes = plan["keyframes"]
    cut_previous_frames = {
        int(keyframes[index - 1]["frame"])
        for index in range(1, len(keyframes))
        if keyframes[index]["transition"] == "cut"
    }
    smooth_frames = {
        int(keyframe["frame"])
        for keyframe in keyframes
        if keyframe["transition"] == "smooth"
    } - cut_previous_frames

    for keyframe in keyframes:
        frame = int(keyframe["frame"])
        converted = convert_ardy_plan_pose_to_blender(keyframe["pose"])
        position = Vector(converted["position"])
        look_at = Vector(converted["look_at"])
        up = Vector(converted["up"])
        z_axis = -(look_at - position).normalized()
        x_axis = up.cross(z_axis).normalized()
        y_axis = z_axis.cross(x_axis)
        camera.location = position
        camera.rotation_quaternion = Matrix((x_axis, y_axis, z_axis)).transposed().to_quaternion()
        camera.data.angle = float(converted["vertical_fov_radians"])
        camera.keyframe_insert(data_path="location", frame=frame)
        camera.keyframe_insert(data_path="rotation_quaternion", frame=frame)
        camera.data.keyframe_insert(data_path="lens", frame=frame)

    angle_curve = next(
        fcurve for fcurve in _fcurves(camera.data.animation_data) if fcurve.data_path == "lens"
    )
    angle_curve.data_path = "angle"
    for point, keyframe in zip(angle_curve.keyframe_points, keyframes, strict=True):
        point.co.y = float(keyframe["pose"]["vertical_fov_radians"])
    angle_curve.update()

    _configure_interpolation(camera.animation_data, cut_previous_frames)
    _configure_interpolation(camera.data.animation_data, cut_previous_frames)
    for keyframe in keyframes:
        if keyframe["transition"] == "cut":
            frame = int(keyframe["frame"])
            marker = scene.timeline_markers.new(f"CUT_{frame}", frame=frame)
            marker.camera = camera
    return smooth_frames, cut_previous_frames


def _remove_unused_actions(actions: tuple[object | None, object | None]) -> None:
    for action in actions:
        if action is None:
            continue
        try:
            if action.users == 0:
                bpy.data.actions.remove(action)
        except ReferenceError:
            pass


def _check_abort(deadline: float | None, cancelled: Callable[[], bool]) -> None:
    if cancelled():
        raise CAMERA_PLAN_CANCELLED("camera plan was cancelled")
    if deadline is not None and time.monotonic() >= deadline:
        raise CAMERA_PLAN_DEADLINE_EXCEEDED("camera plan deadline elapsed")


def apply_camera_plan_transaction(
    plan_value: object,
    current_scene_hash: str,
    connection: object,
    commit_fn: Callable[[dict], object],
    *,
    cancelled: Callable[[], bool] = lambda: False,
    deadline: float | None = None,
) -> dict:
    """Mutate on Blender's main thread and retain rollback state until durable commit."""
    if bpy is None:
        raise CameraPlanError("apply_camera_plan requires Blender")
    plan = parse_camera_plan(plan_value)
    load_authorized_fixture(plan, current_scene_hash)
    if len(plan["keyframes"]) < 2:
        raise PLAN_MINIMUM_TWO_KEYFRAMES("camera plan requires at least two keyframes")
    _check_abort(deadline, cancelled)

    scene = bpy.context.scene
    target_before = bpy.data.objects.get(_TARGET_NAME)
    action_backups = (
        target_before.animation_data.action
        if target_before is not None and target_before.animation_data is not None
        else None,
        target_before.data.animation_data.action
        if (
            target_before is not None
            and target_before.data.animation_data is not None
        )
        else None,
    )
    checkpoint: Checkpoint = create_checkpoint(_scope_state(scene))
    connection.hold_checkpoint(checkpoint)
    try:
        camera = _camera_for_plan(scene)
        _clear_plan_artifacts(scene, camera)
        scene.render.resolution_x = int(plan["output_format"]["width"])
        scene.render.resolution_y = int(plan["output_format"]["height"])
        scene.render.resolution_percentage = 100
        smooth_frames, _cut_previous_frames = _apply_keyframes(scene, camera, plan)
        animation_values = [camera.animation_data, camera.data.animation_data]
        expected_handles = capture_smooth_handles(animation_values, smooth_frames)
        validate_smooth_fcurves(animation_values, smooth_frames, expected_handles)
        _check_abort(deadline, cancelled)

        from .manifest import extract_scene_manifest_v2

        manifest = extract_scene_manifest_v2()
        result = {
            "expected_revision_id": plan["expected_revision_id"],
            "scene_hash": manifest["sceneHash"],
            "manifest": manifest,
        }
        commit_fn(result)
        connection.release_checkpoint()
        _remove_unused_actions(action_backups)
        return result
    except BaseException:
        mutated_target = bpy.data.objects.get(_TARGET_NAME)
        mutated_actions = (
            mutated_target.animation_data.action
            if mutated_target is not None and mutated_target.animation_data is not None
            else None,
            mutated_target.data.animation_data.action
            if (
                mutated_target is not None
                and mutated_target.data.animation_data is not None
            )
            else None,
        )
        try:
            restore(
                checkpoint,
                lambda entity_key, values: _restore_scope(
                    entity_key,
                    values,
                    action_backups,
                ),
            )
            if not verify(checkpoint, _read_scope):
                raise CameraPlanError("camera-plan checkpoint verification failed")
            _remove_unused_actions(tuple(
                action
                if action is not None and action not in action_backups
                else None
                for action in mutated_actions
            ))
        finally:
            connection.release_checkpoint()
        raise


def schedule_camera_plan_transaction(
    plan_value: object,
    current_scene_hash: str,
    connection: object,
    commit_fn: Callable[[dict], object],
    result_fn: Callable[[dict | None, BaseException | None], None],
    *,
    cancelled: Callable[[], bool] = lambda: False,
    deadline: float | None = None,
) -> None:
    """Register the transaction as a one-shot Blender main-thread timer."""
    if bpy is None:
        raise CameraPlanError("camera plan scheduling requires Blender")

    def run() -> None:
        try:
            result_fn(
                apply_camera_plan_transaction(
                    plan_value,
                    current_scene_hash,
                    connection,
                    commit_fn,
                    cancelled=cancelled,
                    deadline=deadline,
                ),
                None,
            )
        except BaseException as error:
            result_fn(None, error)
        return None

    bpy.app.timers.register(run, first_interval=0.0)
