"""Exercise durable Initialize Project behavior in real Blender."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import traceback
from pathlib import Path

import bpy

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

from oh_my_blender import manifest, project_store, register, unregister

PROJECT_ID = "123e4567-e89b-42d3-a456-426614174000"
OTHER_ID = "223e4567-e89b-42d3-a456-426614174000"


def save_in(directory: Path) -> None:
    bpy.ops.wm.save_as_mainfile(filepath=str(directory / "fixture.blend"))


def reset_scene(directory: Path, project_id: str | None = None) -> None:
    scene = bpy.context.scene
    for obj in list(scene.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    if "omb.project_id" in scene:
        del scene["omb.project_id"]
    if project_id is not None:
        scene["omb.project_id"] = project_id
    bpy.ops.mesh.primitive_cube_add()
    save_in(directory)


def initialize_allowing_reported_failure():
    try:
        return bpy.ops.omb.initialize_project()
    except RuntimeError:
        return {"CANCELLED"}


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="omb-initialize-durable-"))
    results = {}
    register()
    try:
        fresh = root / "fresh"
        fresh.mkdir()
        reset_scene(fresh)
        results["freshResult"] = sorted(bpy.ops.omb.initialize_project())
        project_path = fresh / ".omb" / "project.json"
        document = json.loads(project_path.read_text(encoding="utf-8"))
        live = manifest.extract_scene_manifest_v2()
        results["freshFull"] = set(document) == {
            "schema_version", "project_id", "current_revision_id", "manifest"
        }
        results["freshManifestMatches"] = document["manifest"] == live
        results["freshRevisionMatches"] = document["current_revision_id"] == live["revisionId"]

        bpy.context.scene.objects[0].location.x = 2.0
        child_manifest = manifest.extract_scene_manifest_v2()
        child_document = {
            "schema_version": 1,
            "project_id": document["project_id"],
            "current_revision_id": child_manifest["revisionId"],
            "manifest": child_manifest,
        }
        project_path.write_text(
            json.dumps(child_document, separators=(",", ":"), sort_keys=True) + "\n",
            encoding="utf-8",
        )
        committed_bytes = project_path.read_bytes()
        results["reinitResult"] = sorted(bpy.ops.omb.initialize_project())
        results["reinitByteIdentical"] = project_path.read_bytes() == committed_bytes

        legacy = root / "legacy"
        legacy.mkdir()
        reset_scene(legacy, PROJECT_ID)
        legacy_omb = legacy / ".omb"
        legacy_omb.mkdir()
        legacy_path = legacy_omb / "project.json"
        legacy_path.write_text(json.dumps({"project_id": PROJECT_ID}) + "\n", encoding="utf-8")
        results["legacyResult"] = sorted(bpy.ops.omb.initialize_project())
        upgraded = json.loads(legacy_path.read_text(encoding="utf-8"))
        results["legacyUpgraded"] = (
            upgraded["project_id"] == PROJECT_ID
            and upgraded["current_revision_id"] == upgraded["manifest"]["revisionId"]
            and upgraded["schema_version"] == 1
        )

        mismatch = root / "mismatch"
        mismatch.mkdir()
        reset_scene(mismatch, PROJECT_ID)
        mismatch_omb = mismatch / ".omb"
        mismatch_omb.mkdir()
        mismatch_path = mismatch_omb / "project.json"
        mismatch_path.write_text(json.dumps({"project_id": OTHER_ID}) + "\n", encoding="utf-8")
        before = mismatch_path.read_bytes()
        try:
            mismatch_result = bpy.ops.omb.initialize_project()
        except RuntimeError:
            mismatch_result = {"CANCELLED"}
        results["mismatchResult"] = sorted(mismatch_result)
        results["mismatchUnchanged"] = mismatch_path.read_bytes() == before
        existing = root / "existing"
        existing.mkdir()
        reset_scene(existing)
        existing_omb = existing / ".omb"
        existing_omb.mkdir()
        existing_path = existing_omb / "project.json"
        existing_path.write_bytes(committed_bytes)
        existing_scene_before = dict(bpy.context.scene.items())
        existing_entity_before = [
            obj.get("omb.entity_id") for obj in bpy.context.scene.objects
        ]
        results["existingResult"] = sorted(initialize_allowing_reported_failure())
        results["existingUnchanged"] = (
            dict(bpy.context.scene.items()) == existing_scene_before
            and [obj.get("omb.entity_id") for obj in bpy.context.scene.objects]
            == existing_entity_before
            and existing_path.read_bytes() == committed_bytes
        )

        corrupt = root / "corrupt"
        corrupt.mkdir()
        reset_scene(corrupt)
        corrupt_omb = corrupt / ".omb"
        corrupt_omb.mkdir()
        corrupt_path = corrupt_omb / "project.json"
        corrupt_bytes = b'{"project_id":'
        corrupt_path.write_bytes(corrupt_bytes)
        corrupt_scene_before = dict(bpy.context.scene.items())
        results["corruptResult"] = sorted(initialize_allowing_reported_failure())
        results["corruptUnchanged"] = (
            dict(bpy.context.scene.items()) == corrupt_scene_before
            and "omb.entity_id" not in bpy.context.scene.objects[0]
            and corrupt_path.read_bytes() == corrupt_bytes
        )

        journal_failure = root / "journal-failure"
        journal_failure.mkdir()
        reset_scene(journal_failure)
        original_append_journal = project_store.append_journal

        def fail_journal(*_args, **_kwargs):
            raise project_store.ProjectStoreError("injected journal failure")

        project_store.append_journal = fail_journal
        try:
            results["journalFailureResult"] = sorted(
                initialize_allowing_reported_failure()
            )
        finally:
            project_store.append_journal = original_append_journal
        journal_document = json.loads(
            (journal_failure / ".omb" / "project.json").read_text(encoding="utf-8")
        )
        journal_live = manifest.extract_scene_manifest_v2()
        results["journalFailureConsistent"] = (
            bpy.context.scene["omb.project_id"] == journal_document["project_id"]
            and journal_document["manifest"] == journal_live
            and journal_document["current_revision_id"] == journal_live["revisionId"]
            and all(obj.get("omb.entity_id") for obj in bpy.context.scene.objects)
        )
    finally:
        unregister()
    print("OMB_INITIALIZE_DURABLE_RESULTS=" + json.dumps(results, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        traceback.print_exc()
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(1)
