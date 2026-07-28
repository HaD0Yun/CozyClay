"""Real-Blender assembly hierarchy, transform, cycle, and reload fixture."""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

import bpy

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "blender-addon"))

from cclay.manifest import extract_scene_manifest_v4
from cclay.stage_scene import (
    STAGE_SCENE_PARENT_CYCLE,
    _StageTransaction,
    _create_assembly,
    _create_primitive,
    _set_parent,
    _transform_assembly,
)

PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
PART_A = "11111111-1111-4111-8111-111111111111"
PART_B = "22222222-2222-4222-8222-222222222222"


def primitive(entity_id: str, name: str, location: list[float], parent_id=None) -> dict:
    return {
        "op": "add_primitive", "entity_id": entity_id, "primitive_type": "CUBE",
        "name": name, "location": location, "rotation": [0, 0, 0],
        "scale": [1, 1, 1], "parent_id": parent_id,
    }


def main() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    scene["cclay.project_id"] = PROJECT_ID
    transaction = _StageTransaction(scene)
    root = _create_assembly({"op": "create_assembly", "name": "Two Part"}, transaction, PROJECT_ID)
    root_entity_id = root["cclay.entity_id"]
    assembly_id = root["cclay.assembly_id"]
    part_a = _create_primitive(primitive(PART_A, "Part A", [2, 0, 0]), transaction, PROJECT_ID)
    part_b = _create_primitive(primitive(PART_B, "Part B", [4, 0, 0]), transaction, PROJECT_ID)

    before = tuple(part_a.matrix_world.translation)
    _set_parent({"op": "set_parent", "entity_id": PART_A, "parent_id": root_entity_id}, transaction, PROJECT_ID)
    keep_transform = tuple(part_a.matrix_world.translation) == before
    _set_parent({"op": "set_parent", "entity_id": PART_B, "parent_id": root_entity_id}, transaction, PROJECT_ID)

    cycle_code = None
    try:
        _set_parent({"op": "set_parent", "entity_id": root_entity_id, "parent_id": PART_A}, transaction, PROJECT_ID)
    except STAGE_SCENE_PARENT_CYCLE as error:
        cycle_code = error.code

    before_a = tuple(part_a.matrix_world.translation)
    before_b = tuple(part_b.matrix_world.translation)
    _transform_assembly({
        "op": "transform_assembly", "assembly_id": assembly_id,
        "translation": [3, 2, 1], "rotation_euler": None, "scale": None,
    }, transaction, PROJECT_ID)
    bpy.context.view_layer.update()
    delta_a = tuple(part_a.matrix_world.translation[index] - before_a[index] for index in range(3))
    delta_b = tuple(part_b.matrix_world.translation[index] - before_b[index] for index in range(3))
    manifest = extract_scene_manifest_v4()

    with tempfile.TemporaryDirectory() as directory:
        blend_path = str(Path(directory) / "assembly.blend")
        bpy.ops.wm.save_as_mainfile(filepath=blend_path)
        bpy.ops.wm.open_mainfile(filepath=blend_path)
        reloaded = extract_scene_manifest_v4()

    print("CCLAY_STAGE_SCENE_ASSEMBLY_RESULTS=" + json.dumps({
        "keepTransform": keep_transform,
        "cycleCode": cycle_code,
        "movedTogether": delta_a == delta_b == (3.0, 2.0, 1.0),
        "rootType": next(item["type"] for item in manifest["objects"] if item["entityId"] == root_entity_id),
        "assemblyMembers": len(manifest["assemblies"][0]["memberIds"]),
        "hashStable": manifest["sceneHash"] == reloaded["sceneHash"],
    }, sort_keys=True))


main()
