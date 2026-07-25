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
FLOOR_ID = "11111111-1111-4111-8111-111111111111"
CUBE_ID = "22222222-2222-4222-8222-222222222222"
SPHERE_ID = "33333333-3333-4333-8333-333333333333"
LIGHT_ID = "44444444-4444-4444-8444-444444444444"
EXTRA_ID = "55555555-5555-4555-8555-555555555555"
USER_ID = "66666666-6666-4666-8666-666666666666"
SHARED_MESH_ID = "77777777-7777-4777-8777-777777777777"
SHARED_LIGHT_ID = "88888888-8888-4888-8888-888888888888"
SHARED_MATERIAL_ID = "99999999-9999-4999-8999-999999999999"
EXCLUSIVE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
OTHER_MESH_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
OTHER_LIGHT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
OTHER_MATERIAL_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
COLLISION_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"


class FakeConnection:
    def __init__(self):
        self.active_checkpoint = None
        self.recovery = None

    def hold_checkpoint(self, checkpoint, recovery_fn=None):
        if self.active_checkpoint is not None:
            raise RuntimeError("checkpoint already held")
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
        raise AssertionError("fixture rollback must not require recovery")


def plan(revision, operations):
    return {
        "schema_version": 1,
        "expected_revision_id": revision,
        "operations": operations,
    }


def transform(location=(0, 0, 0), scale=(1, 1, 1)):
    return {
        "location": list(location),
        "rotation": [0, 0, 0],
        "scale": list(scale),
    }


def add_primitive(entity_id, primitive_type, name, **values):
    return {
        "op": "add_primitive",
        "entity_id": entity_id,
        "primitive_type": primitive_type,
        "name": name,
        **values,
    }


def main():
    for scene_object in list(bpy.data.objects):
        bpy.data.objects.remove(scene_object, do_unlink=True)
    bpy.context.scene["cclay.project_id"] = PROJECT_ID
    connection = FakeConnection()
    base = extract_scene_manifest_v2()
    first_plan = plan(
        "a" * 64,
        [
            add_primitive(FLOOR_ID, "PLANE", "Floor", **transform(scale=(5, 5, 1))),
            {"op": "set_material_color", "entity_id": FLOOR_ID, "color": [0.12, 0.18, 0.3, 1]},
            add_primitive(CUBE_ID, "CUBE", "Hero Cube", **transform(location=(0, 0, 1))),
            {"op": "set_material_color", "entity_id": CUBE_ID, "color": [0.8, 0.2, 0.1, 1]},
            add_primitive(SPHERE_ID, "UV_SPHERE", "Hero Sphere", **transform(location=(2, 0, 1))),
            {"op": "set_material_color", "entity_id": SPHERE_ID, "color": [0.1, 0.35, 0.8, 1]},
            {
                "op": "upsert_area_light",
                "entity_id": LIGHT_ID,
                "name": "Key Light",
                **transform(location=(4, -4, 6)),
                "energy": 800,
                "color": [1, 0.9, 0.8],
                "size": 3,
            },
        ],
    )
    first = apply_stage_scene_transaction(
        first_plan,
        base["sceneHash"],
        connection,
        lambda _candidate: {"type": "response"},
    )
    staged = extract_scene_manifest_v3()
    ids = {scene_object.get("cclay.entity_id") for scene_object in bpy.context.scene.objects}

    floor_object = next(
        scene_object
        for scene_object in bpy.context.scene.objects
        if scene_object.get("cclay.entity_id") == FLOOR_ID
    )
    floor_material = floor_object.material_slots[0].material
    principled = floor_material.node_tree.nodes["Principled BSDF"]
    original_node_color = tuple(principled.inputs["Base Color"].default_value)
    principled.inputs["Base Color"].default_value = [0.9, 0.1, 0.2, 1]
    node_color_drift_hashes = extract_scene_manifest_v3()["sceneHash"] != staged["sceneHash"]
    principled.inputs["Base Color"].default_value = original_node_color
    material_drift_restored = extract_scene_manifest_v3()["sceneHash"] == staged["sceneHash"]
    # Blender >= 4 cannot disable material nodes: the use_nodes setter is a no-op,
    # so useNodes cannot drift. Prove the extractor reads live node state instead by
    # removing the Principled node (principledBaseColor -> None) and restoring it.
    floor_material.use_nodes = False
    use_nodes_permanently_enabled = floor_material.use_nodes is True
    saved_principled_color = tuple(principled.inputs["Base Color"].default_value)
    floor_material.node_tree.nodes.remove(principled)
    principled_removal_drift = extract_scene_manifest_v3()["sceneHash"] != staged["sceneHash"]
    restored_node = floor_material.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
    restored_node.name = "Principled BSDF"
    restored_node.inputs["Base Color"].default_value = saved_principled_color
    principled_removal_restored = extract_scene_manifest_v3()["sceneHash"] == staged["sceneHash"]

    before_creation_failure = extract_scene_manifest_v3()
    failure_plan = plan(
        first["manifest"]["revisionId"],
        [add_primitive(EXTRA_ID, "CUBE", "Rollback Cube", **transform(location=(0, 3, 1)))],
    )
    try:
        apply_stage_scene_transaction(
            failure_plan,
            before_creation_failure["sceneHash"],
            connection,
            lambda _candidate: (_ for _ in ()).throw(RuntimeError("commit failed")),
        )
    except RuntimeError:
        pass
    creation_rollback = extract_scene_manifest_v3() == before_creation_failure
    checkpoint_released = connection.active_checkpoint is None

    before_delete = extract_scene_manifest_v3()
    delete_retained_before_ack = False

    def fail_delete(_candidate):
        nonlocal delete_retained_before_ack
        target = bpy.data.objects.get("Hero Cube")
        delete_retained_before_ack = target is not None and target.name not in bpy.context.scene.objects
        raise RuntimeError("commit failed")

    try:
        apply_stage_scene_transaction(
            plan(first["manifest"]["revisionId"], [{"op": "delete_entity", "entity_id": CUBE_ID}]),
            before_delete["sceneHash"],
            connection,
            fail_delete,
        )
    except RuntimeError:
        pass
    delete_rollback = extract_scene_manifest_v3() == before_delete

    delete_retained_until_ack = False

    def commit_delete(_candidate):
        nonlocal delete_retained_until_ack
        target = bpy.data.objects.get("Hero Sphere")
        delete_retained_until_ack = target is not None and target.name not in bpy.context.scene.objects
        return {"type": "response"}

    apply_stage_scene_transaction(
        plan(first["manifest"]["revisionId"], [{"op": "delete_entity", "entity_id": SPHERE_ID}]),
        before_delete["sceneHash"],
        connection,
        commit_delete,
    )

    mesh = bpy.data.meshes.new("User Mesh")
    user = bpy.data.objects.new("User Object", mesh)
    user["cclay.entity_id"] = USER_ID
    bpy.context.scene.collection.objects.link(user)
    user_code = None
    try:
        apply_stage_scene_transaction(
            plan(first["manifest"]["revisionId"], [{"op": "delete_entity", "entity_id": USER_ID}]),
            extract_scene_manifest_v3()["sceneHash"],
            connection,
            lambda _candidate: None,
        )
    except BaseException as error:
        user_code = getattr(error, "code", type(error).__name__)

    def attempt_delete(entity_id):
        before = extract_scene_manifest_v3()
        code = None
        commit_entered = False

        def commit(_candidate):
            nonlocal commit_entered
            commit_entered = True
            return None

        try:
            apply_stage_scene_transaction(
                plan(first["manifest"]["revisionId"], [{"op": "delete_entity", "entity_id": entity_id}]),
                before["sceneHash"],
                connection,
                commit,
            )
        except BaseException as error:
            code = getattr(error, "code", type(error).__name__)
        return code, extract_scene_manifest_v3() == before, commit_entered

    shared_mesh = bpy.data.meshes.new("Shared Mesh")
    shared_mesh_target = bpy.data.objects.new("Shared Mesh Target", shared_mesh)
    shared_mesh_target["cclay.entity_id"] = SHARED_MESH_ID
    shared_mesh_target["cclay.owned_project_id"] = PROJECT_ID
    shared_mesh_other = bpy.data.objects.new("Shared Mesh Other", shared_mesh)
    shared_mesh_other["cclay.entity_id"] = OTHER_MESH_ID
    bpy.context.scene.collection.objects.link(shared_mesh_target)
    bpy.context.scene.collection.objects.link(shared_mesh_other)
    shared_mesh_code, shared_mesh_rollback, shared_mesh_commit_entered = attempt_delete(SHARED_MESH_ID)
    for name in ("Shared Mesh Target", "Shared Mesh Other"):
        scene_object = bpy.data.objects.get(name)
        if scene_object is not None:
            bpy.data.objects.remove(scene_object, do_unlink=True)
    if shared_mesh.name in bpy.data.meshes and shared_mesh.users == 0:
        bpy.data.meshes.remove(shared_mesh)

    shared_light = bpy.data.lights.new("Shared Light Data", "AREA")
    shared_light_target = bpy.data.objects.new("Shared Light Target", shared_light)
    shared_light_target["cclay.entity_id"] = SHARED_LIGHT_ID
    shared_light_target["cclay.owned_project_id"] = PROJECT_ID
    shared_light_other = bpy.data.objects.new("Shared Light Other", shared_light)
    shared_light_other["cclay.entity_id"] = OTHER_LIGHT_ID
    bpy.context.scene.collection.objects.link(shared_light_target)
    bpy.context.scene.collection.objects.link(shared_light_other)
    shared_light_code, shared_light_rollback, shared_light_commit_entered = attempt_delete(SHARED_LIGHT_ID)
    for name in ("Shared Light Target", "Shared Light Other"):
        scene_object = bpy.data.objects.get(name)
        if scene_object is not None:
            bpy.data.objects.remove(scene_object, do_unlink=True)
    if shared_light.name in bpy.data.lights and shared_light.users == 0:
        bpy.data.lights.remove(shared_light)

    target_mesh = bpy.data.meshes.new("Shared Material Target Mesh")
    other_mesh = bpy.data.meshes.new("Shared Material Other Mesh")
    shared_material = bpy.data.materials.new("Shared Generated Material")
    shared_material["cclay.generated_for_entity_id"] = SHARED_MATERIAL_ID
    material_target = bpy.data.objects.new("Shared Material Target", target_mesh)
    material_target["cclay.entity_id"] = SHARED_MATERIAL_ID
    material_target["cclay.owned_project_id"] = PROJECT_ID
    material_other = bpy.data.objects.new("Shared Material Other", other_mesh)
    material_other["cclay.entity_id"] = OTHER_MATERIAL_ID
    target_mesh.materials.append(shared_material)
    other_mesh.materials.append(shared_material)
    bpy.context.scene.collection.objects.link(material_target)
    bpy.context.scene.collection.objects.link(material_other)
    shared_material_code, shared_material_rollback, shared_material_commit_entered = attempt_delete(SHARED_MATERIAL_ID)
    for name in ("Shared Material Target", "Shared Material Other"):
        scene_object = bpy.data.objects.get(name)
        if scene_object is not None:
            bpy.data.objects.remove(scene_object, do_unlink=True)
    for name in ("Shared Material Target Mesh", "Shared Material Other Mesh"):
        datablock = bpy.data.meshes.get(name)
        if datablock is not None and datablock.users == 0:
            bpy.data.meshes.remove(datablock)
    if shared_material.name in bpy.data.materials and shared_material.users == 0:
        bpy.data.materials.remove(shared_material)

    exclusive_mesh = bpy.data.meshes.new("Exclusive Mesh")
    exclusive_material = bpy.data.materials.new("Exclusive Generated Material")
    exclusive_material["cclay.generated_for_entity_id"] = EXCLUSIVE_ID
    exclusive_mesh.materials.append(exclusive_material)
    exclusive_target = bpy.data.objects.new("Exclusive Target", exclusive_mesh)
    exclusive_target["cclay.entity_id"] = EXCLUSIVE_ID
    exclusive_target["cclay.owned_project_id"] = PROJECT_ID
    bpy.context.scene.collection.objects.link(exclusive_target)
    exclusive_code, _exclusive_rollback, exclusive_commit_entered = attempt_delete(EXCLUSIVE_ID)
    exclusive_destroyed = (
        exclusive_code is None
        and bpy.data.objects.get("Exclusive Target") is None
        and bpy.data.meshes.get("Exclusive Mesh") is None
        and bpy.data.materials.get("Exclusive Generated Material") is None
    )

    collision_mesh = bpy.data.meshes.new("Collision Mesh")
    collision_object = bpy.data.objects.new("Collision Light", collision_mesh)
    collision_object["cclay.entity_id"] = COLLISION_ID
    bpy.context.scene.collection.objects.link(collision_object)
    collision_result = apply_stage_scene_transaction(
        plan(first["manifest"]["revisionId"], [{
            "op": "upsert_area_light",
            "entity_id": LIGHT_ID,
            "name": "Collision Light",
            **transform(location=(4, -4, 6)),
            "energy": 800,
            "color": [1, 0.9, 0.8],
            "size": 3,
        }]),
        extract_scene_manifest_v3()["sceneHash"],
        connection,
        lambda _candidate: None,
    )
    collision_identity = collision_result["entity_identities"][0]
    collision_manifest_name = next(
        item["name"]
        for item in collision_result["manifest"]["objects"]
        if item["entityId"] == LIGHT_ID
    )
    bpy.data.objects.get(collision_identity["actual_name"]).name = "Key Light"
    bpy.data.objects.remove(collision_object, do_unlink=True)
    if collision_mesh.users == 0:
        bpy.data.meshes.remove(collision_mesh)

    results = {
        "created": all(bpy.data.objects.get(name) is not None for name in ("Floor", "Hero Cube", "Key Light")),
        "idsExact": {FLOOR_ID, CUBE_ID, SPHERE_ID, LIGHT_ID}.issubset(ids),
        "manifestAdvanced": first["manifest"]["sceneHash"] != base["sceneHash"],
        "manifestStageState": (
            len(staged["stagePrimitives"]) == 3
            and len(staged["stageMaterials"]) == 3
            and next(light for light in staged["lights"] if light["objectId"] == LIGHT_ID)["areaSize"] == 3
        ),
        "nodeColorDriftHashes": node_color_drift_hashes,
        "materialDriftRestored": material_drift_restored,
        "useNodesPermanentlyEnabled": use_nodes_permanently_enabled,
        "principledRemovalDrift": principled_removal_drift,
        "principledRemovalRestored": principled_removal_restored,
        "creationRollback": creation_rollback,
        "checkpointReleased": checkpoint_released,
        "deleteRetainedBeforeAck": delete_retained_before_ack,
        "deleteRollback": delete_rollback,
        "deleteRetainedUntilAck": delete_retained_until_ack,
        "deleteDestroyedAfterAck": bpy.data.objects.get("Hero Sphere") is None,
        "userDeleteCode": user_code,
        "sharedMeshCode": shared_mesh_code,
        "sharedMeshRollback": shared_mesh_rollback,
        "sharedLightCode": shared_light_code,
        "sharedLightRollback": shared_light_rollback,
        "sharedMaterialCode": shared_material_code,
        "sharedMaterialRollback": shared_material_rollback,
        "sharedMeshCommitEntered": shared_mesh_commit_entered,
        "sharedLightCommitEntered": shared_light_commit_entered,
        "sharedMaterialCommitEntered": shared_material_commit_entered,
        "exclusiveDeleteDestroyed": exclusive_destroyed,
        "exclusiveCommitEntered": exclusive_commit_entered,
        "collisionIdentity": collision_identity,
        "collisionManifestName": collision_manifest_name,
    }
    print("CCLAY_STAGE_SCENE_RESULTS=" + json.dumps(results, sort_keys=True))


main()
