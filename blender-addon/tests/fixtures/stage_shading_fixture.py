"""Face shading must reach the hashed manifest, without changing an all-flat one.

An old flat UV_SPHERE and a newly built smooth one used to export the same entry
and therefore the same sceneHash while rendering completely differently, so a
stored revision could not prove its own shading. This drives the REAL transaction
in headless Blender and prints CCLAY_STAGE_SHADING=<json> for the host test.
"""

from __future__ import annotations

import json
import pathlib
import sys

import bpy

REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

from cclay.manifest import extract_scene_manifest_v2, extract_scene_manifest_v3
from cclay.scene_manifest import _validate_manifest
from cclay.stage_scene import apply_stage_scene_transaction

PROJECT_ID = "00000000-0000-4000-8000-00000000000f"
# One shape per shading policy: flat, all-smooth, and smooth-sides-flat-caps.
SHAPES = (("CUBE", "flat"), ("UV_SPHERE", "curved"), ("CYLINDER", "swept"))


class FakeConnection:
    def __init__(self):
        self.active_checkpoint = None

    def hold_checkpoint(self, checkpoint, recovery_fn=None):
        self.active_checkpoint = checkpoint

    def release_checkpoint(self):
        value = self.active_checkpoint
        self.active_checkpoint = None
        return value

    def ensure_mutation_connection(self, _phase):
        return None

    def require_recovery(self):
        raise AssertionError("no recovery expected")


def reset():
    for scene_object in list(bpy.data.objects):
        bpy.data.objects.remove(scene_object, do_unlink=True)
    for material in list(bpy.data.materials):
        bpy.data.materials.remove(material)
    for mesh in list(bpy.data.meshes):
        bpy.data.meshes.remove(mesh)
    bpy.context.scene["cclay.project_id"] = PROJECT_ID


def stage(operations):
    return apply_stage_scene_transaction(
        {"schema_version": 1, "expected_revision_id": "a" * 64, "operations": operations},
        extract_scene_manifest_v2()["sceneHash"],
        FakeConnection(), lambda _candidate: {"type": "response"},
    )


reset()
stage([
    {
        "op": "add_primitive",
        "entity_id": f"99999999-9999-4999-8999-00000000000{index}",
        "primitive_type": shape,
        "name": shape.title(),
        "location": [index * 3.0, 0.0, 0.0],
        "rotation": [0.0, 0.0, 0.0],
        "scale": [1.0, 1.0, 1.0],
    }
    for index, (shape, _policy) in enumerate(SHAPES)
])

manifest = extract_scene_manifest_v3()
by_type = {entry["primitiveType"]: entry for entry in manifest["stagePrimitives"]}
exported = {shape: by_type[shape].get("shading", "<absent>") for shape, _ in SHAPES}
cube_entry_keys = sorted(by_type["CUBE"])

# Flatten the sphere by hand, exactly the way a user editing the scene out of
# band would, and confirm the manifest notices. This is the drift the hash exists
# to detect and could not see before.
sphere = bpy.data.objects["Uv_Sphere"]
smooth_hash = manifest["sceneHash"]
for polygon in sphere.data.polygons:
    polygon.use_smooth = False
flattened = extract_scene_manifest_v3()
flattened_entry = next(
    entry for entry in flattened["stagePrimitives"] if entry["primitiveType"] == "UV_SPHERE"
)

# Un-smooth a single face to reach MIXED from SMOOTH.
for polygon in sphere.data.polygons:
    polygon.use_smooth = True
sphere.data.polygons[0].use_smooth = False
mixed = extract_scene_manifest_v3()
mixed_entry = next(
    entry for entry in mixed["stagePrimitives"] if entry["primitiveType"] == "UV_SPHERE"
)

validation_error = None
try:
    _validate_manifest(json.loads(json.dumps(mixed)))
except Exception as error:  # the exported manifest must satisfy its own validator
    validation_error = f"{type(error).__name__}: {error}"

bad = json.loads(json.dumps(mixed))
next(e for e in bad["stagePrimitives"] if e["primitiveType"] == "UV_SPHERE")["shading"] = "GLOSSY"
rejected = None
try:
    _validate_manifest(bad)
except Exception as error:
    rejected = type(error).__name__

print("CCLAY_STAGE_SHADING=" + json.dumps({
    "exported": exported,
    "cubeEntryKeys": cube_entry_keys,
    "smoothHash": smooth_hash,
    "flattenedHash": flattened["sceneHash"],
    "flattenedShading": flattened_entry.get("shading", "<absent>"),
    "mixedShading": mixed_entry.get("shading", "<absent>"),
    "mixedHash": mixed["sceneHash"],
    "validationError": validation_error,
    "unknownShadingRejected": rejected,
}))
