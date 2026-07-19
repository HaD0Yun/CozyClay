from __future__ import annotations

import json
import pathlib
import sys

import bpy

REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

from oh_my_blender.manifest import extract_scene_manifest_v2, extract_scene_manifest_v3
from oh_my_blender.stage_scene import apply_stage_scene_transaction

PROJECT_ID = "00000000-0000-4000-8000-00000000000a"
FLOOR_ID = "11111111-1111-4111-8111-111111111111"
CUBE_ID = "22222222-2222-4222-8222-222222222222"
SPHERE_ID = "33333333-3333-4333-8333-333333333333"
LIGHT_ID = "44444444-4444-4444-8444-444444444444"
EXTRA_ID = "55555555-5555-4555-8555-555555555555"
USER_ID = "66666666-6666-4666-8666-666666666666"


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
    bpy.context.scene["omb.project_id"] = PROJECT_ID
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
    ids = {scene_object.get("omb.entity_id") for scene_object in bpy.context.scene.objects}

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
    user["omb.entity_id"] = USER_ID
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

    results = {
        "created": all(bpy.data.objects.get(name) is not None for name in ("Floor", "Hero Cube", "Key Light")),
        "idsExact": {FLOOR_ID, CUBE_ID, SPHERE_ID, LIGHT_ID}.issubset(ids),
        "manifestAdvanced": first["manifest"]["sceneHash"] != base["sceneHash"],
        "manifestStageState": (
            len(staged["stagePrimitives"]) == 3
            and len(staged["stageMaterials"]) == 3
            and next(light for light in staged["lights"] if light["objectId"] == LIGHT_ID)["areaSize"] == 3
        ),
        "creationRollback": creation_rollback,
        "checkpointReleased": checkpoint_released,
        "deleteRetainedBeforeAck": delete_retained_before_ack,
        "deleteRollback": delete_rollback,
        "deleteRetainedUntilAck": delete_retained_until_ack,
        "deleteDestroyedAfterAck": bpy.data.objects.get("Hero Sphere") is None,
        "userDeleteCode": user_code,
    }
    print("OMB_STAGE_SCENE_RESULTS=" + json.dumps(results, sort_keys=True))


main()
