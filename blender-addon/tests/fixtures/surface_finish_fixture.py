"""Surface finish in real Blender: applied to the Principled node, exported only
when it leaves the defaults, and hash-neutral for a scene that never sets it."""

from __future__ import annotations

import json
import pathlib
import sys

import bpy

REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

from cclay.manifest import extract_scene_manifest_v2, extract_scene_manifest_v3
from cclay.stage_scene import apply_stage_scene_transaction

PROJECT_ID = "00000000-0000-4000-8000-00000000000a"
PLAIN_ID = "11111111-1111-4111-8111-111111111111"
METAL_ID = "22222222-2222-4222-8222-222222222222"


class FakeConnection:
    def __init__(self):
        self.active_checkpoint = None
        self.recovery = None

    def hold_checkpoint(self, checkpoint, recovery_fn=None):
        self.active_checkpoint = checkpoint
        self.recovery = recovery_fn

    def release_checkpoint(self):
        value = self.active_checkpoint
        self.active_checkpoint = None
        self.recovery = None
        return value

    def ensure_mutation_connection(self, _phase):
        return None

    def require_recovery(self):
        raise AssertionError("rollback must not require recovery")


def cube(entity_id, name, location):
    return {
        "op": "add_primitive",
        "entity_id": entity_id,
        "primitive_type": "CUBE",
        "name": name,
        "location": list(location),
        "rotation": [0.0, 0.0, 0.0],
        "scale": [1.0, 1.0, 1.0],
    }


def run(operations):
    for scene_object in list(bpy.data.objects):
        bpy.data.objects.remove(scene_object, do_unlink=True)
    for material in list(bpy.data.materials):
        bpy.data.materials.remove(material)
    bpy.context.scene["cclay.project_id"] = PROJECT_ID
    base = extract_scene_manifest_v2()
    apply_stage_scene_transaction(
        {"schema_version": 1, "expected_revision_id": "a" * 64, "operations": operations},
        base["sceneHash"],
        FakeConnection(),
        lambda _candidate: {"type": "response"},
    )
    return extract_scene_manifest_v3()


# A plan with no finish keys: exactly what every plan looked like before.
legacy = run([
    cube(PLAIN_ID, "Plain", (0, 0, 0)),
    {"op": "set_material_color", "entity_id": PLAIN_ID, "color": [0.5, 0.5, 0.5, 1.0]},
])
# The same plan plus an explicit finish on a SECOND object only.
mixed = run([
    cube(PLAIN_ID, "Plain", (0, 0, 0)),
    {"op": "set_material_color", "entity_id": PLAIN_ID, "color": [0.5, 0.5, 0.5, 1.0]},
    cube(METAL_ID, "Metal", (3, 0, 0)),
    {
        "op": "set_material_color",
        "entity_id": METAL_ID,
        "color": [0.7, 0.7, 0.72, 1.0],
        "roughness": 0.28,
        "metallic": 1.0,
    },
])

by_name = {}
for entry in mixed["stageMaterials"]:
    obj = next(o for o in bpy.context.scene.objects if o.get("cclay.entity_id") == entry["objectId"])
    by_name[obj.name] = entry

metal = bpy.data.objects["Metal"].material_slots[0].material
principled = metal.node_tree.nodes.get("Principled BSDF")

report = {
    "legacy_entry": legacy["stageMaterials"][0],
    "plain_entry": by_name["Plain"],
    "metal_entry": by_name["Metal"],
    "applied_roughness": round(float(principled.inputs["Roughness"].default_value), 4),
    "applied_metallic": round(float(principled.inputs["Metallic"].default_value), 4),
}
print(f"CCLAY_SURFACE_FINISH={json.dumps(report)}")
