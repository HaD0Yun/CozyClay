#!/usr/bin/env python3
"""Render the bundled hand-shape library for visual calibration.

Run with Blender, for example:

    blender --background --factory-startup \
      --python scripts/calibrate_hand_shapes.py -- \
      --output /tmp/cclay-hand-calibration

The generated images are evidence for a human review; this script does not
modify or approve the calibrated preset data.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import sys
import tempfile
from pathlib import Path

import bpy
from mathutils import Quaternion, Vector


REPO_ROOT = Path(__file__).resolve().parents[1]
ADDON_PACKAGE = REPO_ROOT / "blender-addon" / "cclay"
ASSET_DIRECTORY = ADDON_PACKAGE / "assets" / "characters"
RIG_ASSETS = {
    "Y_BOT": ASSET_DIRECTORY / "y-bot-tpose.fbx",
    "X_BOT": ASSET_DIRECTORY / "x-bot-tpose.fbx",
}
SIDES = ("left", "right")
VIEWS = ("palm", "side")
RESOLUTION = 512
RENDER_SAMPLES = 32
CAMERA_LENS_MM = 70.0
CAMERA_SENSOR_MM = 36.0
BACKGROUND_COLOR = (0.025, 0.025, 0.025, 1.0)

# Import the exact pure runtime module without executing the add-on package's
# registration module. Blender is normally launched from the repository root,
# but the import must not depend on the caller's current directory.
sys.path.insert(0, str(ADDON_PACKAGE))
import hand_shapes  # noqa: E402

if Path(hand_shapes.__file__).resolve() != (ADDON_PACKAGE / "hand_shapes.py").resolve():
    raise RuntimeError("resolved hand_shapes module is not the repository runtime module")


def parse_arguments() -> argparse.Namespace:
    arguments = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(
        description="Render all bundled hand-shape presets on both bundled rigs."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(tempfile.gettempdir()) / "cclay-hand-calibration",
        help="output directory (default: the system temporary directory)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="replace an existing output path",
    )
    return parser.parse_args(arguments)


def prepare_output(path: Path, force: bool) -> Path:
    output = path.expanduser().resolve()
    if output == Path(output.anchor):
        raise RuntimeError("refusing to use a filesystem root as the output directory")
    if output.exists() or output.is_symlink():
        if not force:
            raise FileExistsError(
                f"output path already exists: {output}; pass --force to replace it"
            )
        if output.is_dir() and not output.is_symlink():
            shutil.rmtree(output)
        else:
            output.unlink()
    output.mkdir(parents=True)
    return output


def reset_scene_and_import(asset: Path):
    if not asset.is_file():
        raise FileNotFoundError(f"bundled character asset is missing: {asset}")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    objects_before = set(bpy.data.objects)
    result = bpy.ops.wm.fbx_import(filepath=str(asset))
    if "FINISHED" not in result:
        raise RuntimeError(f"Blender failed to import bundled character: {asset}")
    imported = [obj for obj in bpy.data.objects if obj not in objects_before]
    armatures = [obj for obj in imported if obj.type == "ARMATURE"]
    if len(armatures) != 1:
        raise RuntimeError(
            f"{asset.name} must import exactly one armature; found {len(armatures)}"
        )
    if not any(obj.type == "MESH" for obj in imported):
        raise RuntimeError(f"{asset.name} did not import a character mesh")
    armatures[0].animation_data_clear()
    return armatures[0]


def configure_render(scene) -> None:
    render = scene.render
    render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = RENDER_SAMPLES
    scene.cycles.use_denoising = False
    scene.cycles.use_preview_denoising = False
    render.use_motion_blur = False
    render.resolution_x = RESOLUTION
    render.resolution_y = RESOLUTION
    render.resolution_percentage = 100
    render.image_settings.file_format = "PNG"
    render.image_settings.color_mode = "RGBA"
    render.image_settings.color_depth = "8"
    render.image_settings.compression = 15
    render.film_transparent = False
    render.use_file_extension = True
    render.use_overwrite = True
    render.use_stamp = False
    render.dither_intensity = 0.0
    render.fps = 24
    scene.display_settings.display_device = "sRGB"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "Medium High Contrast"
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0
    scene.camera = None

    world = bpy.data.worlds.new("Hand Calibration World")
    world.use_nodes = True
    nodes = world.node_tree.nodes
    nodes.clear()
    background = nodes.new("ShaderNodeBackground")
    background.inputs["Color"].default_value = BACKGROUND_COLOR
    background.inputs["Strength"].default_value = 0.05
    output = nodes.new("ShaderNodeOutputWorld")
    world.node_tree.links.new(background.outputs["Background"], output.inputs["Surface"])
    scene.world = world

    material = bpy.data.materials.new("Hand Calibration Material")
    material.use_nodes = True
    principled = material.node_tree.nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = (0.12, 0.32, 0.62, 1.0)
    principled.inputs["Roughness"].default_value = 0.38
    principled.inputs["Metallic"].default_value = 0.08
    for scene_object in scene.objects:
        if scene_object.type == "MESH":
            scene_object.data.materials.clear()
            scene_object.data.materials.append(material)



def point_at(scene_object, target: Vector) -> None:
    scene_object.rotation_euler = (target - scene_object.location).to_track_quat(
        "-Z", "Y"
    ).to_euler()


def add_area_light(
    name: str, location: Vector, target: Vector, energy: float, size: float
) -> None:
    light_data = bpy.data.lights.new(name=name, type="AREA")
    light_data.energy = energy
    light_data.shape = "DISK"
    light_data.size = size
    light_object = bpy.data.objects.new(name, light_data)
    bpy.context.scene.collection.objects.link(light_object)
    light_object.location = location
    point_at(light_object, target)


def hand_points(armature, inventory, side: str) -> list[Vector]:
    prefix = "mixamorig:" if any(
        bone.name.startswith("mixamorig:") for bone in armature.data.bones
    ) else ""
    hand_name = f"{prefix}{side.title()}Hand"
    hand_bone = armature.pose.bones.get(hand_name)
    if hand_bone is None:
        raise RuntimeError(f"rig is missing required palm bone: {hand_name}")
    pose_bones = [hand_bone]
    for role in hand_shapes.CANONICAL_ROLE_ORDER:
        pose_bone = armature.pose.bones.get(inventory[side][role])
        if pose_bone is None:
            raise RuntimeError(
                f"validated hand bone is absent from the pose: {inventory[side][role]}"
            )
        pose_bones.append(pose_bone)
    points = []
    for pose_bone in pose_bones:
        points.append(armature.matrix_world @ pose_bone.head)
        points.append(armature.matrix_world @ pose_bone.tail)
    return points


def add_camera_and_lights(armature, inventory, side: str, view: str, frame_points) -> None:
    points = frame_points
    minimum = Vector(
        tuple(min(point[axis] for point in points) for axis in range(3))
    )
    maximum = Vector(
        tuple(max(point[axis] for point in points) for axis in range(3))
    )
    target = (minimum + maximum) * 0.5
    radius = max((point - target).length for point in points)
    if not math.isfinite(radius) or radius <= 1.0e-6:
        raise RuntimeError(f"cannot derive a camera frame for the {side} hand")

    # Derive both views from the palm plane. The side direction is perpendicular
    # to the palm camera and hand axis, exposing the depth of finger flexion.
    wrist_name = next(
        bone.name
        for bone in armature.pose.bones
        if bone.name.endswith(f"{side.title()}Hand")
    )
    wrist = armature.matrix_world @ armature.pose.bones[wrist_name].head
    middle = armature.matrix_world @ armature.pose.bones[
        inventory[side]["Middle1"]
    ].head
    index = armature.matrix_world @ armature.pose.bones[
        inventory[side]["Index1"]
    ].head
    pinky = armature.matrix_world @ armature.pose.bones[
        inventory[side]["Pinky1"]
    ].head
    palm_normal = (middle - wrist).cross(index - pinky)
    if palm_normal.length <= 1.0e-8:
        raise RuntimeError(f"cannot derive a palm plane for the {side} hand")
    palm_normal.normalize()
    if palm_normal.z > 0.0:
        palm_normal.negate()
    palm_offset = palm_normal
    hand_axis = (middle - wrist).normalized()
    side_offset = palm_offset.cross(hand_axis)
    if side_offset.length <= 1.0e-8:
        raise RuntimeError(f"cannot derive a side view for the {side} hand")
    side_offset.normalize()
    view_offset = palm_offset if view == "palm" else side_offset
    half_field_of_view = math.atan(CAMERA_SENSOR_MM / (2.0 * CAMERA_LENS_MM))
    # The bounds contain only palm and finger bones, so the hand fills the frame
    # without a forearm-biased target. The enclosing sphere keeps every point in
    # frame from either perpendicular direction, including flexed presets.
    distance = max(0.35, radius * 1.28 / math.tan(half_field_of_view))

    camera_data = bpy.data.cameras.new(name=f"Calibration Camera {side} {view}")
    camera_data.lens = CAMERA_LENS_MM
    camera_data.sensor_width = CAMERA_SENSOR_MM
    camera_data.clip_start = 0.01
    camera_data.clip_end = 100.0
    camera = bpy.data.objects.new(camera_data.name, camera_data)
    bpy.context.scene.collection.objects.link(camera)
    camera.location = target + view_offset * distance
    point_at(camera, target)
    bpy.context.scene.camera = camera

    camera_right = camera.rotation_euler.to_matrix().col[0].normalized()
    camera_up = camera.rotation_euler.to_matrix().col[1].normalized()
    toward_camera = (camera.location - target).normalized()
    add_area_light(
        f"Calibration Key {side} {view}",
        target + toward_camera * distance * 0.70 + camera_up * radius * 2.2
        + camera_right * radius * 1.8,
        target,
        8.0,
        max(0.25, radius * 3.0),
    )
    add_area_light(
        f"Calibration Fill {side} {view}",
        target + toward_camera * distance * 0.45 - camera_right * radius * 2.4,
        target,
        3.0,
        max(0.30, radius * 3.5),
    )
    add_area_light(
        f"Calibration Rim {side} {view}",
        target - toward_camera * distance * 0.35 + camera_up * radius * 2.8,
        target,
        5.0,
        max(0.20, radius * 2.5),
    )


def clear_calibration_camera_and_lights() -> None:
    for scene_object in list(bpy.data.objects):
        if scene_object.type in {"CAMERA", "LIGHT"}:
            bpy.data.objects.remove(scene_object, do_unlink=True)


def authored_base_rotations(armature, inventory):
    return {
        side: {
            role: armature.pose.bones[inventory[side][role]].matrix_basis.to_quaternion()
            for role in hand_shapes.CANONICAL_ROLE_ORDER
        }
        for side in SIDES
    }


def apply_preset(armature, inventory, authored_base, side: str, preset: str):
    selected = {
        "left": preset if side == "left" else "open",
        "right": preset if side == "right" else "open",
    }
    role_quaternions = hand_shapes.preset_deltas(
        selected["left"], selected["right"]
    )
    for inventory_side in SIDES:
        for role in hand_shapes.CANONICAL_ROLE_ORDER:
            pose_bone = armature.pose.bones[inventory[inventory_side][role]]
            pose_bone.rotation_mode = "QUATERNION"
            pose_bone.rotation_quaternion = (
                authored_base[inventory_side][role]
                @ Quaternion(role_quaternions[inventory_side][role])
            )
    bpy.context.view_layer.update()
    return role_quaternions


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def render_library(output: Path) -> list[dict[str, object]]:
    if not 10 <= len(hand_shapes.PRESET_NAMES) <= 20 or len(set(hand_shapes.PRESET_NAMES)) != len(hand_shapes.PRESET_NAMES):
        raise RuntimeError("runtime hand-shape library must contain 10 through 20 unique presets")

    entries: list[dict[str, object]] = []
    for rig, asset in RIG_ASSETS.items():
        armature = reset_scene_and_import(asset)
        try:
            inventory = hand_shapes.validate_rig_bones(
                rig, (bone.name for bone in armature.data.bones)
            )
        except hand_shapes.HandShapeError as error:
            raise RuntimeError(f"{rig} bone inventory is incomplete: {error}") from error
        if any(
            len(inventory[side]) != len(hand_shapes.CANONICAL_ROLE_ORDER)
            for side in SIDES
        ):
            raise RuntimeError(f"{rig} bone inventory did not resolve every canonical role")
        authored_base = authored_base_rotations(armature, inventory)
        open_frames = {
            side: hand_points(armature, inventory, side)
            for side in SIDES
        }

        configure_render(bpy.context.scene)
        for side in SIDES:
            for preset in hand_shapes.PRESET_NAMES:
                quaternions = apply_preset(armature, inventory, authored_base, side, preset)
                tip_world_positions = {
                    finger: [
                        float(value)
                        for value in (
                            armature.matrix_world
                            @ armature.pose.bones[inventory[side][f"{finger}4"]].tail
                        )
                    ]
                    for finger in ("Thumb", "Index", "Middle", "Ring", "Pinky")
                }
                for view in VIEWS:
                    clear_calibration_camera_and_lights()
                    add_camera_and_lights(
                        armature, inventory, side, view, open_frames[side]
                    )
                    relative_path = Path(rig) / side / preset / f"{view}.png"
                    image_path = output / relative_path
                    image_path.parent.mkdir(parents=True, exist_ok=True)
                    bpy.context.scene.render.filepath = str(image_path)
                    result = bpy.ops.render.render(write_still=True)
                    if "FINISHED" not in result or not image_path.is_file():
                        raise RuntimeError(
                            f"render failed for {rig} {side} {preset} {view}: "
                            f"{image_path}"
                        )
                    entries.append(
                        {
                            "library_version": hand_shapes.LIBRARY_VERSION,
                            "rig": rig,
                            "side": side,
                            "preset": preset,
                            "view": view,
                            "path": str(image_path),
                            "file_sha256": sha256_file(image_path),
                            "tip_world_positions": tip_world_positions,
                            "role_quaternions": {
                                applied_side: {
                                    role: [
                                        float(value)
                                        for value in quaternions[applied_side][role]
                                    ]
                                    for role in hand_shapes.CANONICAL_ROLE_ORDER
                                }
                                for applied_side in SIDES
                            },
                        }
                    )
    return entries


def main() -> None:
    arguments = parse_arguments()
    output = prepare_output(arguments.output, arguments.force)
    entries = render_library(output)
    expected_coverage = {
        (rig, side, preset, view)
        for rig in RIG_ASSETS
        for side in SIDES
        for preset in hand_shapes.PRESET_NAMES
        for view in VIEWS
    }
    actual_coverage = {
        (entry["rig"], entry["side"], entry["preset"], entry["view"])
        for entry in entries
    }
    if actual_coverage != expected_coverage or len(entries) != len(expected_coverage):
        raise RuntimeError(
            "incomplete calibration output: "
            f"expected {len(expected_coverage)} unique renders, got "
            f"{len(actual_coverage)} unique rows and {len(entries)} total rows"
        )
    index_path = output / "index.json"
    index_path.write_text(
        json.dumps({"renders": entries}, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"Rendered {len(entries)} hand calibrations to {output}")


if __name__ == "__main__":
    main()
