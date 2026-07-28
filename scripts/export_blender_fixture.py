"""Apply an ARDY camera plan to a deterministic Blender scene and export it."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
import traceback

import bpy
from mathutils import Matrix, Vector

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

from cclay import manifest
from cclay.snapshot import UNSUPPORTED_PLAN_UP, validate_plan_pose


class FixtureCreationError(RuntimeError):
    """Raised when Blender cannot create the deterministic test scene."""


def _arguments() -> argparse.Namespace:
    blender_arguments = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args(blender_arguments)



def _set_interpolation(
    animation_data: object, frame: int | None, interpolation: str
) -> None:
    for fcurve in manifest.animation_fcurves(animation_data):
        for point in fcurve.keyframe_points:
            if frame is None or point.co.x == frame:
                point.interpolation = interpolation
                point.handle_left_type = "AUTO_CLAMPED"
                point.handle_right_type = "AUTO_CLAMPED"
                for name in ("back", "amplitude", "period"):
                    setattr(
                        point,
                        name,
                        bpy.types.Keyframe.bl_rna.properties[name].default,
                    )


def build_fixture_scene(plan: dict, *, manifest_identity: bool = False) -> object:
    """Build the canonical boxing fixture scene."""
    keyframes = plan["keyframes"]
    if keyframes[0]["transition"] != "smooth":
        raise FixtureCreationError("the first keyframe transition must be 'smooth'")
    for keyframe in keyframes:
        pose = keyframe["pose"]
        if pose["up"] != [0, 1, 0]:
            raise UNSUPPORTED_PLAN_UP(f"frame {keyframe['frame']} up must be [0, 1, 0]")
        validate_plan_pose(pose["position"], pose["look_at"], pose["up"])

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.name = "Boxing Demo"
    scene.frame_start = 0
    scene.frame_end = max(keyframe["frame"] for keyframe in keyframes)
    scene.render.fps = 24
    scene.render.resolution_x = plan["output_format"]["width"]
    scene.render.resolution_y = plan["output_format"]["height"]
    scene.render.resolution_percentage = 100

    bpy.ops.mesh.primitive_cube_add(location=(0.0, 0.0, 1.0))
    fighter = bpy.context.active_object
    if fighter is None:
        raise FixtureCreationError("Blender did not create the fixture object")
    fighter.name = "Fighter"
    if manifest_identity:
        fighter["cclay.entity_id"] = "00000000-0000-4000-8000-000000000002"

    camera_data = bpy.data.cameras.new("ARDY_CinematicCamera")
    camera_data.sensor_fit = "VERTICAL"
    camera = bpy.data.objects.new("ARDY_CinematicCamera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera.rotation_mode = "QUATERNION"
    if manifest_identity:
        scene["cclay.project_id"] = "00000000-0000-4000-8000-00000000000a"
        camera["cclay.entity_id"] = "00000000-0000-4000-8000-000000000003"

    for keyframe in keyframes:
        frame = keyframe["frame"]
        pose = keyframe["pose"]
        camera.location = pose["position"]
        z_axis = -(Vector(pose["look_at"]) - Vector(pose["position"])).normalized()
        x_axis = Vector((0.0, 1.0, 0.0)).cross(z_axis).normalized()
        y_axis = z_axis.cross(x_axis)
        camera.rotation_quaternion = Matrix((x_axis, y_axis, z_axis)).transposed().to_quaternion()
        camera_data.angle = pose["vertical_fov_radians"]
        camera.keyframe_insert(data_path="location", frame=frame)
        camera.keyframe_insert(data_path="rotation_quaternion", frame=frame)
        # Blender 5.1 exposes Camera.angle as settable but not directly animatable.
        # Seed an F-curve through lens, then retarget it to the protocol's angle path.
        camera_data.keyframe_insert(data_path="lens", frame=frame)
    angle_curve = next(
        fcurve
        for fcurve in manifest.animation_fcurves(camera_data.animation_data)
        if fcurve.data_path == "lens"
    )
    angle_curve.data_path = "angle"
    for point, keyframe in zip(angle_curve.keyframe_points, keyframes, strict=True):
        point.co.y = keyframe["pose"]["vertical_fov_radians"]
        point.handle_left_type = "AUTO_CLAMPED"
        point.handle_right_type = "AUTO_CLAMPED"
    angle_curve.update()

    _set_interpolation(camera.animation_data, None, "BEZIER")
    _set_interpolation(camera_data.animation_data, None, "BEZIER")
    for index, keyframe in enumerate(keyframes):
        if keyframe["transition"] != "cut":
            continue
        previous_frame = keyframes[index - 1]["frame"]
        _set_interpolation(camera.animation_data, previous_frame, "CONSTANT")
        _set_interpolation(camera_data.animation_data, previous_frame, "CONSTANT")
        marker = scene.timeline_markers.new(f"CUT_{keyframe['frame']}", frame=keyframe["frame"])
        marker.camera = camera

    return scene


def main() -> None:
    arguments = _arguments()
    plan = json.loads(arguments.plan.read_text(encoding="utf-8"))
    build_fixture_scene(plan)
    revision = manifest.write_scene_snapshot(arguments.output)
    print(f"CCLAY_REVISION={revision}")


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        traceback.print_exc()
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(1)
