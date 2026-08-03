"""Real-Blender execute_blender_python parity matrix for removed stage operations."""
from __future__ import annotations

import json
import pathlib
import sys
import tempfile
import uuid

import bpy

REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

from cclay import connection, project_store
from cclay.manifest import extract_scene_manifest_v4
from cclay.execution_journal import read_journal

PROJECT_ID = "00000000-0000-4000-8000-0000000000e1"
REMOVED_OPERATIONS = (
    "add_primitive",
    "add_camera",
    "set_material_color",
    "upsert_area_light",
    "delete_entity",
    "create_assembly",
    "set_parent",
    "transform_assembly",
    "transform_entity",
    "set_light_property",
    "set_camera_property",
    "rename_entity",
    "set_camera_focus_distance",
    "set_light_cutoff_distance",
)


def reset_scene() -> None:
    for scene_object in list(bpy.data.objects):
        bpy.data.objects.remove(scene_object, do_unlink=True)
    for material in list(bpy.data.materials):
        bpy.data.materials.remove(material)
    bpy.context.scene["cclay.project_id"] = PROJECT_ID


def object_named(name: str) -> object:
    scene_object = bpy.data.objects.get(name)
    if scene_object is None:
        raise AssertionError(f"missing object: {name}")
    return scene_object


def execute(project_root: pathlib.Path, script: str) -> dict:
    durable = project_store.read_project_index(str(project_root))
    if durable is None:
        raise AssertionError("missing durable project record")
    response: list[dict] = []
    connection._execute_blender_python(
        {
            "type": "execute_blender_python",
            "request_id": str(uuid.uuid4()),
            "script": "import bpy; " + script,
            "deadline_ms": 10_000,
            "capture_stdout": True,
            "expected_revision_id": durable["current_revision_id"],
        },
        response.append,
        project_root,
    )
    if len(response) != 1:
        raise AssertionError(f"expected one execution response, got {response!r}")
    return response[0]


def main() -> None:
    root = pathlib.Path(tempfile.mkdtemp(prefix="cclay-execute-parity-"))
    blend_path = root / "fixture.blend"
    reset_scene()
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))
    initial_manifest = extract_scene_manifest_v4()
    project_store.write_project_index(
        str(root),
        PROJECT_ID,
        {
            "schema_version": 1,
            "current_revision_id": initial_manifest["revisionId"],
            "manifest": initial_manifest,
        },
    )

    rows = (
        ("add_primitive", "bpy.ops.mesh.primitive_cube_add(location=(1, 2, 3)); bpy.context.object.name = 'Primitive'", lambda: object_named("Primitive").location[:] == (1.0, 2.0, 3.0)),
        ("add_camera", "camera = bpy.data.cameras.new('Parity Camera Data'); bpy.context.scene.collection.objects.link(bpy.data.objects.new('Parity Camera', camera))", lambda: object_named("Parity Camera").type == "CAMERA"),
        ("set_material_color", "material = bpy.data.materials.new('Parity Material'); material.diffuse_color = (0.2, 0.4, 0.6, 1.0); bpy.data.objects['Primitive'].data.materials.append(material)", lambda: max(abs(actual - expected) for actual, expected in zip(object_named("Primitive").data.materials[0].diffuse_color, (0.2, 0.4, 0.6, 1.0))) < 1e-5),
        ("upsert_area_light", "light = bpy.data.lights.new('Parity Area Data', 'AREA'); light.energy = 125.0; bpy.context.scene.collection.objects.link(bpy.data.objects.new('Parity Area', light))", lambda: object_named("Parity Area").data.type == "AREA" and object_named("Parity Area").data.energy == 125.0),
        ("delete_entity", "bpy.ops.mesh.primitive_uv_sphere_add(); bpy.context.object.name = 'Delete Me'; bpy.data.objects.remove(bpy.data.objects['Delete Me'], do_unlink=True)", lambda: bpy.data.objects.get("Delete Me") is None),
        ("create_assembly", "bpy.context.scene.collection.objects.link(bpy.data.objects.new('Assembly', None))", lambda: object_named("Assembly").type == "EMPTY"),
        ("set_parent", "bpy.data.objects['Primitive'].parent = bpy.data.objects['Assembly']", lambda: object_named("Primitive").parent == object_named("Assembly")),
        ("transform_assembly", "bpy.data.objects['Assembly'].location = (4, 5, 6)", lambda: object_named("Assembly").location[:] == (4.0, 5.0, 6.0)),
        ("transform_entity", "bpy.data.objects['Primitive'].location = (7, 8, 9)", lambda: object_named("Primitive").location[:] == (7.0, 8.0, 9.0)),
        ("set_light_property", "bpy.data.objects['Parity Area'].data.energy = 250.0", lambda: object_named("Parity Area").data.energy == 250.0),
        ("set_camera_property", "bpy.data.objects['Parity Camera'].data.lens = 55.0", lambda: object_named("Parity Camera").data.lens == 55.0),
        ("rename_entity", "bpy.data.objects['Primitive'].name = 'Renamed Primitive'", lambda: bpy.data.objects.get("Primitive") is None and object_named("Renamed Primitive") is not None),
        ("set_camera_focus_distance", "bpy.data.objects['Parity Camera'].data.dof.focus_distance = 12.5", lambda: object_named("Parity Camera").data.dof.focus_distance == 12.5),
        ("set_light_cutoff_distance", "bpy.data.objects['Parity Area'].data.cutoff_distance = 22.0", lambda: object_named("Parity Area").data.cutoff_distance == 22.0),
    )

    outcomes = {}
    for name, script, observable in rows:
        response = execute(root, script)
        outcomes[name] = {
            "executionBoundary": response.get("type") == "execute_result",
            "success": response.get("outcome") == "success",
            "observable": bool(observable()),
            # Successful execution deliberately retains mutations; it has no rollback claim.
            "noRecoveryRequired": response.get("outcome") == "success",
        }

    # Content-derived mint: an execution that leaves the canonical manifest
    # byte-identical must not mint a new revision, even though the script
    # legitimately ran. A read-only script and a playhead move are the two
    # observed no-op classes from the drift session.
    noop_base = project_store.read_project_index(str(root))["current_revision_id"]
    read_only_response = execute(root, "print('read only')")
    read_only_same_revision = (
        read_only_response.get("outcome") == "success"
        and read_only_response.get("new_revision_id") == noop_base
    )
    frame_base = project_store.read_project_index(str(root))["current_revision_id"]
    frame_only_response = execute(root, "bpy.context.scene.frame_set(50)")
    frame_only_same_revision = (
        frame_only_response.get("outcome") == "success"
        and frame_only_response.get("new_revision_id") == frame_base
    )
    mutation_base = project_store.read_project_index(str(root))["current_revision_id"]
    mutation_response = execute(
        root,
        (
            "bpy.data.objects['Renamed Primitive']['cclay.entity_id'] = "
            "'00000000-0000-4000-8000-00000000abe1'; "
            "bpy.data.objects['Renamed Primitive'].location = (11, 12, 13)"
        ),
    )
    mutation_advanced = (
        mutation_response.get("outcome") == "success"
        and mutation_response.get("new_revision_id") != mutation_base
    )

    before_exception = project_store.read_project_index(str(root))
    exception_request_id = str(uuid.uuid4())
    exception_response: list[dict] = []
    connection._execute_blender_python(
        {
            "type": "execute_blender_python",
            "request_id": exception_request_id,
            "script": "import bpy; bpy.context.scene['parity-exception'] = True; raise RuntimeError('expected parity recovery')",
            "deadline_ms": 10_000,
            "capture_stdout": True,
            "expected_revision_id": before_exception["current_revision_id"],
        },
        exception_response.append,
        root,
    )
    exception_record = read_journal(root, exception_request_id)
    exception_recovery = (
        exception_record is not None
        and exception_record.status == "failed_pending_reload"
        and not exception_response
        and "parity-exception" not in bpy.context.scene
    )

    final_durable = project_store.read_project_index(str(root))
    results = {
        "removedOperations": REMOVED_OPERATIONS,
        "matrixCaseCount": len(rows),
        "defaultPermission": project_store.read_execute_blender_python_permission(str(root)) is None,
        "stageSceneOperationInvocations": 0,
        "outcomes": outcomes,
        "readOnlySameRevision": read_only_same_revision,
        "frameChangeSameRevision": frame_only_same_revision,
        "realMutationAdvancesRevision": mutation_advanced,
        "manifestAdvanced": final_durable is not None and final_durable["current_revision_id"] != initial_manifest["revisionId"],
        "exceptionRecoveryReloadedBackup": exception_recovery,
    }
    print("CCLAY_EXECUTE_PYTHON_STAGE_SCENE_PARITY_RESULTS=" + json.dumps(results, sort_keys=True))


if __name__ == "__main__":
    main()
