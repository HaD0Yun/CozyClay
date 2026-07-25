"""Material finish rollback in real Blender: a failed transaction that mutated a
pre-existing material's Principled Roughness/Metallic must restore both sockets so
the scene hash returns to its pre-transaction value.

Mirrors surface_finish_fixture.py: drive the REAL apply_stage_scene_transaction
inside headless Blender, print a CCLAY_MATERIAL_ROLLBACK=<json> line consumed by a
host-side unittest.
"""

from __future__ import annotations

import json
import pathlib
import sys

import bpy

REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

from cclay.manifest import extract_scene_manifest_v2, extract_scene_manifest_v3
from cclay.stage_scene import apply_stage_scene_transaction

PROJECT_ID = "00000000-0000-4000-8000-00000000000c"
CUBE_ID = "33333333-3333-4333-8333-333333333333"
# A syntactically valid UUIDv4 that no operation creates, so a set_material_color
# targeting it raises STAGE_SCENE_TARGET_NOT_FOUND AFTER the prior material op has
# already mutated the pre-existing material's finish sockets.
GHOST_ID = "44444444-4444-4444-8444-444444444444"


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


def reset_scene():
    for scene_object in list(bpy.data.objects):
        bpy.data.objects.remove(scene_object, do_unlink=True)
    for material in list(bpy.data.materials):
        bpy.data.materials.remove(material)
    bpy.context.scene["cclay.project_id"] = PROJECT_ID


def apply(operations, base_hash):
    return apply_stage_scene_transaction(
        {"schema_version": 1, "expected_revision_id": base_hash, "operations": operations},
        base_hash,
        FakeConnection(),
        lambda _candidate: {"type": "response"},
    )


# Transaction A: create a cube and commit a NON-default finish on its generated
# material. This material is pre-existing for every later transaction.
reset_scene()
empty_hash = extract_scene_manifest_v2()["sceneHash"]
committed = apply(
    [
        cube(CUBE_ID, "Cube", (0, 0, 0)),
        {
            "op": "set_material_color",
            "entity_id": CUBE_ID,
            "color": [0.5, 0.5, 0.5, 1.0],
            "roughness": 0.28,
            "metallic": 1.0,
        },
    ],
    empty_hash,
)
committed_hash = committed["scene_hash"]

cube_obj = bpy.data.objects["Cube"]
material = cube_obj.material_slots[0].material
principled = material.node_tree.nodes.get("Principled BSDF")
pre_roughness = float(principled.inputs["Roughness"].default_value)
pre_metallic = float(principled.inputs["Metallic"].default_value)

# Transaction B: mutate the pre-existing material's finish to DIFFERENT values,
# then fail on a later operation in the same plan (set_material_color targets a
# non-existent entity_id, parsed as a valid UUID but absent from the scene). The
# material op runs first and mutates the sockets; the second op raises, forcing
# rollback of the whole transaction.
failure = None
try:
    apply(
        [
            {
                "op": "set_material_color",
                "entity_id": CUBE_ID,
                "color": [0.5, 0.5, 0.5, 1.0],
                "roughness": 0.7,
                "metallic": 0.2,
            },
            {
                "op": "set_material_color",
                "entity_id": GHOST_ID,
                "color": [0.1, 0.1, 0.1, 1.0],
            },
        ],
        committed_hash,
    )
except BaseException as error:  # noqa: BLE001 - probe the rollback disposition
    failure = type(error).__name__

# Read back the sockets and re-export the v3 scene hash after the failed
# transaction's rollback. A correct rollback restores the pre-transaction finish
# so the hash equals committed_hash; a defective one leaves the sockets mutated.
post_roughness = float(principled.inputs["Roughness"].default_value)
post_metallic = float(principled.inputs["Metallic"].default_value)
post_hash = extract_scene_manifest_v3()["sceneHash"]

# Transaction C: attempt the same failure against a material with `use_nodes`
# turned OFF out of band, which would be the one state where a snapshot gated on
# `use_nodes` diverges from the exporter (the exporter reads Principled values
# whenever a node tree exists). On Blender 5.2 that state is UNREACHABLE:
# Material.use_nodes is writable but always reads back True, because every
# material is node-based. Record whether the disable took effect, so a future
# Blender that honours it fails here and sends someone back to this reasoning
# instead of leaving a silent hole.
reset_scene()
committed_c = apply(
    [
        cube(CUBE_ID, "Cube", (0, 0, 0)),
        {
            "op": "set_material_color",
            "entity_id": CUBE_ID,
            "color": [0.5, 0.5, 0.5, 1.0],
            "roughness": 0.31,
            "metallic": 0.0,
        },
    ],
    extract_scene_manifest_v2()["sceneHash"],
)
material_c = bpy.data.objects["Cube"].material_slots[0].material
material_c.use_nodes = False
principled_c = material_c.node_tree.nodes.get("Principled BSDF")
disable_took_effect = not material_c.use_nodes
disabled_pre_roughness = float(principled_c.inputs["Roughness"].default_value)
# Re-read the hash AFTER the disable attempt: `useNodes` is itself an exported
# field, so this - not committed_c - is the state rollback has to return to.
disabled_committed_hash = extract_scene_manifest_v3()["sceneHash"]

disabled_failure = None
try:
    apply(
        [
            {
                "op": "set_material_color",
                "entity_id": CUBE_ID,
                "color": [0.5, 0.5, 0.5, 1.0],
                "roughness": 0.93,
                "metallic": 1.0,
            },
            {
                "op": "set_material_color",
                "entity_id": GHOST_ID,
                "color": [0.1, 0.1, 0.1, 1.0],
            },
        ],
        extract_scene_manifest_v2()["sceneHash"],
    )
except BaseException as error:  # noqa: BLE001 - probe the rollback disposition
    disabled_failure = type(error).__name__

report = {
    "committed_hash": committed_hash,
    "post_hash": post_hash,
    "pre_roughness": pre_roughness,
    "pre_metallic": pre_metallic,
    "post_roughness": post_roughness,
    "post_metallic": post_metallic,
    "failure": failure,
    "disabled_nodes_committed_hash": disabled_committed_hash,
    "disabled_nodes_post_hash": extract_scene_manifest_v3()["sceneHash"],
    "disabled_nodes_pre_roughness": disabled_pre_roughness,
    "disabled_nodes_post_roughness": float(
        principled_c.inputs["Roughness"].default_value
    ),
    "disabled_nodes_disable_took_effect": disable_took_effect,
    "disabled_nodes_failure": disabled_failure,
}
print(f"CCLAY_MATERIAL_ROLLBACK={json.dumps(report)}")
