from __future__ import annotations

import json
import pathlib
import sys

import bpy

REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

from cclay.manifest import extract_scene_manifest_v2, extract_scene_manifest_v3
from cclay.stage_scene import apply_stage_scene_transaction

PROJECT_ID = "00000000-0000-4000-8000-00000000000b"
OTHER_PROJECT_ID = "00000000-0000-4000-8000-00000000000c"
DEFAULT_CUBE_ID = "11111111-1111-4111-8111-111111111111"
FOREIGN_SPHERE_ID = "22222222-2222-4222-8222-222222222222"
SHARED_A_ID = "33333333-3333-4333-8333-333333333333"
SHARED_B_ID = "44444444-4444-4444-8444-444444444444"
OTHER_OWNED_ID = "55555555-5555-4555-8555-555555555555"
ROLLBACK_ID = "66666666-6666-4666-8666-666666666666"
UNKNOWN_ID = "77777777-7777-4777-8777-777777777777"


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


def foreign_mesh_object(name, entity_id, mesh=None):
    """A pre-existing object the user made: entity_id repaired in, no ownership."""
    if mesh is None:
        mesh = bpy.data.meshes.new(f"{name} Mesh")
    scene_object = bpy.data.objects.new(name, mesh)
    scene_object["cclay.entity_id"] = entity_id
    bpy.context.scene.collection.objects.link(scene_object)
    return scene_object


def main():
    for scene_object in list(bpy.data.objects):
        bpy.data.objects.remove(scene_object, do_unlink=True)
    bpy.context.scene["cclay.project_id"] = PROJECT_ID
    connection = FakeConnection()

    default_cube = foreign_mesh_object("Default Cube", DEFAULT_CUBE_ID)
    foreign_sphere = foreign_mesh_object("Foreign Sphere", FOREIGN_SPHERE_ID)
    cube_foreign_before = default_cube.get("cclay.owned_project_id") is None

    # adopt_entity + delete_entity in ONE plan removes the pre-existing cube.
    adopt_delete = apply_stage_scene_transaction(
        plan("a" * 64, [
            {"op": "adopt_entity", "entity_id": DEFAULT_CUBE_ID},
            {"op": "delete_entity", "entity_id": DEFAULT_CUBE_ID},
        ]),
        extract_scene_manifest_v2()["sceneHash"],
        connection,
        lambda _candidate: {"type": "response"},
    )
    default_cube_gone = bpy.data.objects.get("Default Cube") is None
    cube_absent_from_manifest = all(
        item["entityId"] != DEFAULT_CUBE_ID
        for item in adopt_delete["manifest"]["objects"]
    )

    # Adopt in one plan, transform in a LATER plan.
    apply_stage_scene_transaction(
        plan("a" * 64, [{"op": "adopt_entity", "entity_id": FOREIGN_SPHERE_ID}]),
        extract_scene_manifest_v3()["sceneHash"],
        connection,
        lambda _candidate: {"type": "response"},
    )
    sphere_owned = foreign_sphere.get("cclay.owned_project_id") == PROJECT_ID
    apply_stage_scene_transaction(
        plan("a" * 64, [{
            "op": "transform_entity",
            "entity_id": FOREIGN_SPHERE_ID,
            "location": [1, 2, 3],
        }]),
        extract_scene_manifest_v3()["sceneHash"],
        connection,
        lambda _candidate: {"type": "response"},
    )
    sphere_transformed = tuple(foreign_sphere.location) == (1.0, 2.0, 3.0)

    # Re-adopting an entity this project already owns is an idempotent no-op.
    readopt_commit_entered = False

    def commit_readopt(_candidate):
        nonlocal readopt_commit_entered
        readopt_commit_entered = True
        return {"type": "response"}

    apply_stage_scene_transaction(
        plan("a" * 64, [{"op": "adopt_entity", "entity_id": FOREIGN_SPHERE_ID}]),
        extract_scene_manifest_v3()["sceneHash"],
        connection,
        commit_readopt,
    )
    sphere_still_owned = foreign_sphere.get("cclay.owned_project_id") == PROJECT_ID

    def attempt_adopt(entity_id):
        before = extract_scene_manifest_v3()
        code = None
        commit_entered = False

        def commit(_candidate):
            nonlocal commit_entered
            commit_entered = True
            return None

        try:
            apply_stage_scene_transaction(
                plan("a" * 64, [{"op": "adopt_entity", "entity_id": entity_id}]),
                before["sceneHash"],
                connection,
                commit,
            )
        except BaseException as error:
            code = getattr(error, "code", type(error).__name__)
        return code, extract_scene_manifest_v3() == before, commit_entered

    # Unknown entity id.
    unknown_code, unknown_rollback, unknown_commit_entered = attempt_adopt(UNKNOWN_ID)

    # Shared datablock: two pre-existing objects share one mesh.
    shared_mesh = bpy.data.meshes.new("Shared Foreign Mesh")
    shared_a = foreign_mesh_object("Shared Foreign A", SHARED_A_ID, shared_mesh)
    foreign_mesh_object("Shared Foreign B", SHARED_B_ID, shared_mesh)
    shared_code, shared_rollback, shared_commit_entered = attempt_adopt(SHARED_A_ID)
    shared_unstamped = shared_a.get("cclay.owned_project_id") is None

    # Objects owned by another CCLAY project stay fenced.
    other_owned = foreign_mesh_object("Other Project Object", OTHER_OWNED_ID)
    other_owned["cclay.owned_project_id"] = OTHER_PROJECT_ID
    other_code, other_rollback, _other_commit = attempt_adopt(OTHER_OWNED_ID)
    other_owner_kept = other_owned.get("cclay.owned_project_id") == OTHER_PROJECT_ID

    # Commit failure rolls the ownership stamp back off the foreign object.
    rollback_target = foreign_mesh_object("Rollback Target", ROLLBACK_ID)
    before_failure = extract_scene_manifest_v3()
    stamped_before_commit = False

    def fail_commit(_candidate):
        nonlocal stamped_before_commit
        stamped_before_commit = (
            rollback_target.get("cclay.owned_project_id") == PROJECT_ID
        )
        raise RuntimeError("commit failed")

    try:
        apply_stage_scene_transaction(
            plan("a" * 64, [{"op": "adopt_entity", "entity_id": ROLLBACK_ID}]),
            before_failure["sceneHash"],
            connection,
            fail_commit,
        )
    except RuntimeError:
        pass
    rollback_unstamped = rollback_target.get("cclay.owned_project_id") is None
    rollback_manifest = extract_scene_manifest_v3() == before_failure
    checkpoint_released = connection.active_checkpoint is None

    results = {
        "cubeForeignBefore": cube_foreign_before,
        "defaultCubeGone": default_cube_gone,
        "cubeAbsentFromManifest": cube_absent_from_manifest,
        "sphereOwned": sphere_owned,
        "sphereTransformed": sphere_transformed,
        "readoptCommitEntered": readopt_commit_entered,
        "sphereStillOwned": sphere_still_owned,
        "unknownCode": unknown_code,
        "unknownRollback": unknown_rollback,
        "unknownCommitEntered": unknown_commit_entered,
        "sharedCode": shared_code,
        "sharedRollback": shared_rollback,
        "sharedCommitEntered": shared_commit_entered,
        "sharedUnstamped": shared_unstamped,
        "otherCode": other_code,
        "otherRollback": other_rollback,
        "otherOwnerKept": other_owner_kept,
        "stampedBeforeCommit": stamped_before_commit,
        "rollbackUnstamped": rollback_unstamped,
        "rollbackManifest": rollback_manifest,
        "checkpointReleased": checkpoint_released,
    }
    print("CCLAY_STAGE_SCENE_ADOPT_RESULTS=" + json.dumps(results, sort_keys=True))


main()
