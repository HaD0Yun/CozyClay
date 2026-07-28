"""Generate the real-Blender SceneManifestV2 parity fixture.

Regenerate from the repository root:

    blender --background --python blender-addon/tests/fixtures/generate_scene_manifest_v2_parity.py -- \
      --output packages/director-core/test/fixtures/scene-manifest-v2-parity.json
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys
import traceback

import bpy

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

from cclay import manifest

PROJECT_ID = "00000000-0000-4000-8000-00000000000a"
CAMERA_ID = "00000000-0000-4000-8000-000000000001"
SUBJECT_ID = "00000000-0000-4000-8000-000000000002"


def arguments() -> argparse.Namespace:
    blender_arguments = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args(blender_arguments)


def _configure_keyframes(animation_data: object) -> None:
    for fcurve in manifest.animation_fcurves(animation_data):
        for point in fcurve.keyframe_points:
            point.interpolation = "BEZIER"
            point.handle_left_type = "AUTO_CLAMPED"
            point.handle_right_type = "AUTO_CLAMPED"
            for name in ("back", "amplitude", "period"):
                setattr(point, name, bpy.types.Keyframe.bl_rna.properties[name].default)


def main() -> None:
    options = arguments()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.name = "Blender Generated V2 Parity"
    scene["cclay.project_id"] = PROJECT_ID
    scene.frame_start = 1
    scene.frame_end = 24
    scene.render.fps = 24
    scene.render.fps_base = 1.0
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = 100

    bpy.ops.mesh.primitive_cube_add(location=(0.0, 0.0, 0.0))
    subject = bpy.context.active_object
    if subject is None:
        raise RuntimeError("Blender did not create the subject")
    subject.name = "Parity Subject"
    subject["cclay.entity_id"] = SUBJECT_ID

    camera_data = bpy.data.cameras.new("Parity Camera Data")
    camera_data.sensor_fit = "VERTICAL"
    camera = bpy.data.objects.new("Parity Camera", camera_data)
    camera["cclay.entity_id"] = CAMERA_ID
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera.select_set(True)
    subject.select_set(False)

    for frame, location, lens in (
        (1, (0.0, -6.0, 2.0), 35.0),
        (24, (2.0, -4.0, 3.5), 55.0),
    ):
        camera.location = location
        camera_data.lens = lens
        camera.keyframe_insert(data_path="location", frame=frame)
        camera_data.keyframe_insert(data_path="lens", frame=frame)
    _configure_keyframes(camera.animation_data)
    _configure_keyframes(camera_data.animation_data)

    marker = scene.timeline_markers.new("Camera cut", frame=12)
    marker.camera = camera

    options.output.parent.mkdir(parents=True, exist_ok=True)
    revision = manifest.write_scene_manifest_v2(options.output)
    print(f"CCLAY_SCENE_MANIFEST_V2_REVISION={revision}")


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        traceback.print_exc()
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(1)
