"""Real-Blender CameraPlanV1 mutation with scoped rollback and smooth validation."""

from __future__ import annotations

import hashlib
import math
import time
import uuid
from collections.abc import Callable

from .connection import DurableCommitReconciliationRequired
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


class STALE_BASE(CameraPlanError):
    code = "STALE_BASE"

class CameraPlanValidationError(CameraPlanError):
    """One precedence-ordered CameraPlanV1 validation failure."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code


_TARGET_NAME = "CCLAY Camera"
_TOLERANCE = 1e-6

def _validation_error(code: str, message: str) -> None:
    raise CameraPlanValidationError(code, message)


def _subtract(a: list, b: list) -> list[float]:
    return [float(a[index]) - float(b[index]) for index in range(3)]


def _dot(a: list, b: list) -> float:
    return sum(float(a[index]) * float(b[index]) for index in range(3))


def _cross(a: list, b: list) -> list[float]:
    return [
        float(a[1]) * float(b[2]) - float(a[2]) * float(b[1]),
        float(a[2]) * float(b[0]) - float(a[0]) * float(b[2]),
        float(a[0]) * float(b[1]) - float(a[1]) * float(b[0]),
    ]


def _magnitude(value: list) -> float:
    return math.hypot(*(float(component) for component in value))


def _ardy_to_blender(value: list) -> list[float]:
    return [float(value[0]), -float(value[2]), float(value[1])]


def _projected_scale(pose: dict, sample: dict) -> float:
    denominator = (
        _magnitude(
            _subtract(_ardy_to_blender(pose["position"]), sample["center"])
        )
        * 2
        * math.tan(float(pose["vertical_fov_radians"]) / 2)
    )
    if denominator == 0:
        return math.inf
    return float(sample["height_m"]) / denominator


def validate_camera_plan(plan_value: object, evidence: dict) -> dict:
    """Validate production CameraPlanV1 predicates in G010 row order."""
    plan = parse_camera_plan(plan_value)
    start = evidence["frame_range"]["start"]
    end = evidence["frame_range"]["end"]

    if any(keyframe["frame"] < start or keyframe["frame"] > end for keyframe in plan["keyframes"]):
        _validation_error(
            "PLAN_FRAME_OUT_OF_EVIDENCE_RANGE",
            "plan keyframe lies outside the valid evidence range",
        )

    samples_by_frame = {
        sample["frame"]: sample for sample in evidence["analysis"]["subject_samples"]
    }
    for keyframe in plan["keyframes"]:
        if (
            keyframe["transition"] == "cut"
            and (
                keyframe["frame"] - 1 not in samples_by_frame
                or keyframe["frame"] not in samples_by_frame
            )
        ):
            _validation_error(
                "EVIDENCE_SUBJECT_SAMPLE_MISSING",
                f"cut {keyframe['frame']} requires exact subject samples N-1 and N",
            )

    action_axis = evidence["analysis"]["action_axis"]
    axis = _subtract(action_axis["b"], action_axis["a"])
    axis_length = _magnitude(axis)
    if axis_length < 1e-9:
        _validation_error(
            "EVIDENCE_ACTION_AXIS_ZERO_LENGTH",
            "action axis length is below 1e-9",
        )
    axis_cross_up = _cross(axis, action_axis["up"])
    axis_cross_up_length = _magnitude(axis_cross_up)
    if axis_cross_up_length < 1e-9:
        _validation_error(
            "EVIDENCE_ACTION_AXIS_PARALLEL_TO_UP",
            "action axis is parallel to evidence up",
        )

    if any(not float(keyframe["frame"]).is_integer() for keyframe in plan["keyframes"]):
        _validation_error("PLAN_FRAME_NOT_INTEGER", "keyframe frames must be integers")
    if len(plan["keyframes"]) < 2:
        raise PLAN_MINIMUM_TWO_KEYFRAMES("camera plan requires at least two keyframes")
    for index in range(1, len(plan["keyframes"])):
        if plan["keyframes"][index]["frame"] <= plan["keyframes"][index - 1]["frame"]:
            _validation_error(
                "PLAN_FRAME_ORDER_INVALID",
                "keyframe frames must be strictly increasing",
            )
    if plan["keyframes"][0]["transition"] != "smooth":
        _validation_error(
            "PLAN_FIRST_TRANSITION_NOT_SMOOTH",
            "first transition must be literal smooth",
        )

    for keyframe in plan["keyframes"]:
        pose = keyframe["pose"]
        if any(
            abs(float(component) - expected) > 1e-9
            for component, expected in zip(pose["up"], [0.0, 1.0, 0.0], strict=True)
        ):
            _validation_error(
                "UNSUPPORTED_PLAN_UP",
                "plan up must equal [0,1,0] within 1e-9 per component",
            )
        direction = _subtract(pose["look_at"], pose["position"])
        distance = _magnitude(direction)
        if distance < 1e-9:
            _validation_error(
                "PLAN_ZERO_VIEW_DISTANCE",
                "camera view distance is below 1e-9",
            )
        sine = _magnitude(_cross(pose["up"], direction)) / (
            _magnitude(pose["up"]) * distance
        )
        if sine < 1e-9:
            _validation_error(
                "PLAN_POSE_COLLINEAR_UP",
                "camera direction is collinear with up",
            )

    for keyframe in plan["keyframes"]:
        fov = float(keyframe["pose"]["vertical_fov_radians"])
        framing_distance = 12 / math.tan(fov / 2)
        if framing_distance < 45 - _TOLERANCE or framing_distance > 52 + _TOLERANCE:
            _validation_error(
                "FRAMING_BAND_VIOLATION",
                "vertical field of view lies outside the 45..52 framing band",
            )

    cuts = [
        (index, keyframe)
        for index, keyframe in enumerate(plan["keyframes"])
        if keyframe["transition"] == "cut"
    ]
    for _index, keyframe in cuts:
        if not any(
            abs(frame - keyframe["frame"]) <= 1
            for frame in evidence["analysis"]["motion_valley_frames"]
        ):
            _validation_error(
                "CUT_NOT_AT_MOTION_VALLEY",
                f"cut {keyframe['frame']} has no motion valley within one frame",
            )
    for _index, keyframe in cuts:
        if any(
            keyframe["frame"] >= peak["start"] - 1
            and keyframe["frame"] <= peak["end"] + 1
            for peak in evidence["analysis"]["action_peak_ranges"]
        ):
            _validation_error(
                "CUT_SPLITS_ACTION_PEAK",
                f"cut {keyframe['frame']} intersects an expanded action peak",
            )

    for index, keyframe in cuts:
        if index == 0:
            continue
        previous_pose = plan["keyframes"][index - 1]["pose"]
        before = samples_by_frame[keyframe["frame"] - 1]
        after = samples_by_frame[keyframe["frame"]]
        projected = [
            _projected_scale(previous_pose, before),
            _projected_scale(keyframe["pose"], after),
        ]
        if any(not math.isfinite(value) or value <= 0 for value in projected):
            _validation_error(
                "CUT_SCALE_UNDEFINED",
                f"cut {keyframe['frame']} has undefined projected subject scale",
            )
        if max(projected) / min(projected) > 1.35 + _TOLERANCE:
            _validation_error(
                "CUT_SCALE_DISCONTINUITY",
                f"cut {keyframe['frame']} exceeds the subject-scale continuity ratio",
            )

    side = [component / axis_cross_up_length for component in axis_cross_up]
    side_scores = [
        _dot(
            _subtract(_ardy_to_blender(keyframe["pose"]["position"]), action_axis["a"]),
            side,
        )
        for keyframe in plan["keyframes"]
    ]
    if any(abs(score) < _TOLERANCE for score in side_scores):
        _validation_error("CAMERA_ON_ACTION_AXIS", "camera lies on the action axis")
    initial_sign = 1 if side_scores[0] > 0 else -1
    if any((1 if score > 0 else -1) != initial_sign for score in side_scores):
        _validation_error(
            "ACTION_AXIS_CROSSING",
            "camera changes side across the action axis",
        )
    return plan


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
        "entity_id": target.get("cclay.entity_id"),
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
            if "cclay.entity_id" in target:
                del target["cclay.entity_id"]
        else:
            target["cclay.entity_id"] = target_state["entity_id"]
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


def _target_entity_id(scene: object) -> str:
    project_id = scene.get("cclay.project_id")
    digest = bytearray(
        hashlib.sha256(f"{project_id}\0{_TARGET_NAME}".encode("utf-8")).digest()[:16]
    )
    digest[6] = (digest[6] & 0x0F) | 0x40
    digest[8] = (digest[8] & 0x3F) | 0x80
    return str(uuid.UUID(bytes=bytes(digest)))


def _camera_for_plan(scene: object) -> object:
    camera = bpy.data.objects.get(_TARGET_NAME)
    if camera is None:
        camera_data = bpy.data.cameras.new(f"{_TARGET_NAME} Data")
        camera_data.sensor_fit = "VERTICAL"
        camera = bpy.data.objects.new(_TARGET_NAME, camera_data)
        camera["cclay.entity_id"] = _target_entity_id(scene)
        scene.collection.objects.link(camera)
    if camera.type != "CAMERA":
        raise CameraPlanError(f"{_TARGET_NAME!r} exists but is not a camera")
    scene.camera = camera
    camera.rotation_mode = "QUATERNION"
    return camera


def _clear_plan_artifacts(scene: object, camera: object) -> None:
    camera.animation_data_clear()
    camera.data.animation_data_clear()
    for marker in list(scene.timeline_markers):
        if marker.name.startswith("CUT_"):
            scene.timeline_markers.remove(marker)


def _apply_keyframes(
    scene: object,
    camera: object,
    plan: dict,
    connection_guard: Callable[[str], None],
) -> tuple[set[int], set[int]]:
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
        connection_guard("keyframe_write")

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
            connection_guard("marker_write")
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


def _extract_live_scene_manifest(current_scene_hash: str) -> dict:
    from .manifest import resolve_manifest_for_expected_hash

    manifest = resolve_manifest_for_expected_hash(current_scene_hash)
    if manifest is not None:
        return manifest
    raise STALE_BASE(
        "live main-thread manifest hash differs from the durable expected base"
    )


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
    evidence = load_authorized_fixture(plan, current_scene_hash)
    plan = validate_camera_plan(plan, evidence)
    _check_abort(deadline, cancelled)
    live_manifest = _extract_live_scene_manifest(current_scene_hash)
    if live_manifest["sceneHash"] != evidence["scene_hash"]:
        raise STALE_BASE(
            "live main-thread manifest hash differs from the authorized evidence base"
        )

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
        connection.ensure_mutation_connection("after_checkpoint")
        camera = _camera_for_plan(scene)
        _clear_plan_artifacts(scene, camera)
        scene.render.resolution_x = int(plan["output_format"]["width"])
        scene.render.resolution_y = int(plan["output_format"]["height"])
        scene.render.resolution_percentage = 100
        smooth_frames, _cut_previous_frames = _apply_keyframes(
            scene,
            camera,
            plan,
            connection.ensure_mutation_connection,
        )
        animation_values = [camera.animation_data, camera.data.animation_data]
        expected_handles = capture_smooth_handles(animation_values, smooth_frames)
        validate_smooth_fcurves(animation_values, smooth_frames, expected_handles)
        _check_abort(deadline, cancelled)
        scene.frame_set(scene.frame_current)
        bpy.context.view_layer.update()
        connection.ensure_mutation_connection("before_verify")

        from .manifest import (
            extract_scene_manifest_v2,
            extract_scene_manifest_v3,
            extract_scene_manifest_v4,
        )
        from .scene_manifest import finalize_scene_manifest_child

        extracted_v4 = extract_scene_manifest_v4()
        uses_v4 = (
            any(item["parentId"] is not None for item in extracted_v4["objects"])
            or bool(extracted_v4["assemblies"])
        )
        if uses_v4:
            manifest = finalize_scene_manifest_child(
                extracted_v4,
                plan["expected_revision_id"],
                plan,
            )
        elif live_manifest["schemaVersion"] == 3:
            manifest = finalize_scene_manifest_child(
                extract_scene_manifest_v3(),
                plan["expected_revision_id"],
                plan,
            )
        else:
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
    except DurableCommitReconciliationRequired:
        # The live mutation and checkpoint are intentionally retained until a
        # later durable-state reconciliation can determine the terminal action.
        raise
    except BaseException:
        if connection.active_checkpoint is not checkpoint:
            raise
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
        recovered = False
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
            recovered = True
        finally:
            if not recovered:
                connection.require_recovery()
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
