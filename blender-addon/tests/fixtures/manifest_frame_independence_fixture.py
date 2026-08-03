"""Real-Blender proof that the canonical manifest is playhead-independent.

Builds a tracked animated cube and a tracked armature with a posed bone,
extracts the manifest at several playhead positions, and reports:

- the scene hash is identical across frames (frame_start sampling),
- the playhead is restored after every extraction,
- a keyframe edit changes the hash (per-object animationDigest coverage),
- moving a static object changes the hash,
- animated objects carry an animationDigest and static ones carry null,
- a driver on a tracked object fails closed with UNSUPPORTED_FCURVE_FEATURE,
  mirroring the camera contract.

Run from the repository root:

    blender --background --factory-startup --python \
      blender-addon/tests/fixtures/manifest_frame_independence_fixture.py
"""

from __future__ import annotations

import json
import os
import pathlib
import sys
import traceback
import uuid

import bpy

REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

from cclay import manifest  # noqa: E402

PROJECT_ID = "00000000-0000-4000-8000-00000000000b"
CUBE_ID = "00000000-0000-4000-8000-000000000003"
ARMATURE_ID = "00000000-0000-4000-8000-000000000004"
BONE_ID = "00000000-0000-4000-8000-000000000005"
STATIC_ID = "00000000-0000-4000-8000-000000000006"

report: dict = {}


def _manifest() -> dict:
    return manifest.extract_scene_manifest_v4()


def _object_by_id(manifest_value: dict, entity_id: str) -> dict:
    return next(entry for entry in manifest_value["objects"] if entry["entityId"] == entity_id)


def _scene_hash(manifest_value: dict) -> str:
    return manifest_value["sceneHash"]


def main() -> None:
    scene = bpy.context.scene
    scene.name = "Manifest Frame Independence"
    scene["cclay.project_id"] = PROJECT_ID
    scene.frame_start = 1
    scene.frame_end = 50

    cube = bpy.data.objects.new("probe-cube", bpy.data.meshes.new("probe-mesh"))
    scene.collection.objects.link(cube)
    cube["cclay.entity_id"] = CUBE_ID
    cube.location = (0.0, 0.0, 0.0)
    cube.keyframe_insert("location", frame=1)
    cube.location = (5.0, 5.0, 5.0)
    cube.keyframe_insert("location", frame=50)

    armature_data = bpy.data.armatures.new("probe-armature")
    armature = bpy.data.objects.new("probe-armature", armature_data)
    scene.collection.objects.link(armature)
    armature["cclay.entity_id"] = ARMATURE_ID
    bpy.context.view_layer.objects.active = armature
    armature.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    armature_data.edit_bones.new("Bone")
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.context.view_layer.update()
    bone = armature_data.bones["Bone"]
    bone["cclay.entity_id"] = BONE_ID
    pose_bone = armature.pose.bones["Bone"]
    pose_bone.rotation_quaternion = (1.0, 0.0, 0.0, 0.0)
    pose_bone.keyframe_insert("rotation_quaternion", frame=1)
    pose_bone.rotation_quaternion = (0.0, 0.7071, 0.7071, 0.0)
    pose_bone.keyframe_insert("rotation_quaternion", frame=50)

    static = bpy.data.objects.new("probe-static", bpy.data.meshes.new("probe-mesh2"))
    scene.collection.objects.link(static)
    static["cclay.entity_id"] = STATIC_ID
    static.location = (1.0, 2.0, 3.0)

    bpy.context.view_layer.update()
    scene.frame_set(25)  # interpolated playhead position

    hashes = []
    digests = {}
    static_entries = {}
    for label, frame in (("frame1", 1), ("frame25", 25), ("frame50", 50)):
        scene.frame_set(frame)
        before = scene.frame_current
        manifest_value = _manifest()
        report[f"{label}PlayheadRestored"] = scene.frame_current == before
        hashes.append(_scene_hash(manifest_value))
        digests[f"cube{label}"] = _object_by_id(manifest_value, CUBE_ID)["animationDigest"]
        static_entries[label] = _object_by_id(manifest_value, STATIC_ID)
    report["hashesEqual"] = len(set(hashes)) == 1
    report["sceneHash"] = hashes[0]

    cube_digest = digests["cubeframe1"]
    report["cubeDigestPresent"] = isinstance(cube_digest, str) and len(cube_digest) == 64
    report["staticDigestAbsent"] = "animationDigest" not in static_entries["frame1"]
    report["cubeDigestStable"] = len({digests[f"cube{label}"] for label in ("frame1", "frame25", "frame50")}) == 1

    # A keyframe edit must change the canonical hash even though the pose at
    # frame_start is untouched: the per-object animationDigest covers it.
    cube.location = (9.0, 9.0, 9.0)
    cube.keyframe_insert("location", frame=50)
    scene.frame_set(1)
    after_keyframe_edit = _scene_hash(_manifest())
    report["keyframeEditChangedHash"] = after_keyframe_edit != hashes[0]

    # A static object move is a plain authored transform change.
    static.location = (4.0, 5.0, 6.0)
    after_static_move = _scene_hash(_manifest())
    report["staticMoveChangedHash"] = after_static_move != after_keyframe_edit

    # A driver on a tracked object fails closed, mirroring the camera path.
    try:
        driver_cube = bpy.data.objects.new("probe-driven", bpy.data.meshes.new("probe-mesh3"))
        scene.collection.objects.link(driver_cube)
        driver_cube["cclay.entity_id"] = str(uuid.uuid4())
        driver_cube.driver_add("location", 0).driver.expression = "frame"
        _manifest()
        report["driverFailsClosed"] = False
    except manifest.UNSUPPORTED_FCURVE_FEATURE:
        report["driverFailsClosed"] = True
    except BaseException as error:  # noqa: BLE001 - record, do not re-raise
        report["driverFailsClosed"] = False
        report["driverError"] = f"{type(error).__name__}: {error}"

    print(f"CCLAY_MANIFEST_FRAME_REPORT={json.dumps(report, default=str, sort_keys=True)}")


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        traceback.print_exc()
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(1)
