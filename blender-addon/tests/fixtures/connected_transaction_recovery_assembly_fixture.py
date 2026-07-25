"""Exercise both prepared-transaction authorities with V4 assembly blends."""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

import bpy

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "blender-addon"))

from cclay.connection import Connection, _reconcile_connected_transaction
from cclay.manifest import extract_scene_manifest_v4, resolve_manifest_for_expected_hash
from cclay.prepared_transaction import prepare_transaction, save_candidate
from cclay.stage_scene import _StageTransaction, _create_assembly, _create_primitive, _set_parent

PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
TRANSACTION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
REQUEST_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
BASE_REVISION = "a" * 64
CANDIDATE_REVISION = "c" * 64
MEMBER_ID = "11111111-1111-4111-8111-111111111111"


class ReconcileSocket:
    def __init__(self, status: str, revision_id: str):
        self.status = status
        self.revision_id = revision_id
        self.sent = []
        self.closed = False

    def send_json(self, message):
        self.sent.append(message)

    def recv_json(self):
        reconcile = self.sent[-1]
        return {
            "type": "bridge_transaction_status",
            "id": reconcile["id"],
            "transaction_id": TRANSACTION_ID,
            "status": self.status,
            "revision_id": self.revision_id,
        }

    def close(self, *_args):
        self.closed = True


def build_base() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    scene["cclay.project_id"] = PROJECT_ID
    transaction = _StageTransaction(scene)
    root = _create_assembly(
        {"op": "create_assembly", "name": "Recovery Assembly"}, transaction, PROJECT_ID
    )
    member = _create_primitive({
        "op": "add_primitive", "entity_id": MEMBER_ID, "primitive_type": "CUBE",
        "name": "Assembly Member", "location": [1, 0, 0], "rotation": [0, 0, 0],
        "scale": [1, 1, 1], "parent_id": None,
    }, transaction, PROJECT_ID)
    _set_parent({
        "op": "set_parent", "entity_id": MEMBER_ID,
        "parent_id": root["cclay.entity_id"],
    }, transaction, PROJECT_ID)
    bpy.context.view_layer.update()


def move_member() -> None:
    member = next(obj for obj in bpy.context.scene.objects if obj.get("cclay.entity_id") == MEMBER_ID)
    member.location.x += 2
    bpy.context.view_layer.update()


def project_id(_path: Path) -> str:
    return bpy.context.scene["cclay.project_id"]


def run_case(root: Path, authority: str) -> dict:
    canonical = root / "scene.blend"
    build_base()
    base_manifest = extract_scene_manifest_v4()
    bpy.ops.wm.save_as_mainfile(filepath=str(canonical))
    move_member()
    candidate_manifest = extract_scene_manifest_v4()
    bpy.ops.wm.open_mainfile(filepath=str(canonical))

    marker = prepare_transaction(
        project_root=root,
        transaction_id=TRANSACTION_ID,
        project_id=PROJECT_ID,
        operation="stage_scene",
        request_id=REQUEST_ID,
        base_revision_id=BASE_REVISION,
        base_scene_hash=base_manifest["sceneHash"],
        candidate_revision_id=CANDIDATE_REVISION,
        candidate_scene_hash=candidate_manifest["sceneHash"],
        canonical_blend_path=canonical,
        read_blend_project_id=project_id,
    )
    if authority == "candidate":
        move_member()
        marker = save_candidate(
            root, marker,
            save_blend=lambda path: bpy.ops.wm.save_as_mainfile(filepath=str(path)),
            read_blend_project_id=project_id,
        )

    revision = BASE_REVISION if authority == "base" else CANDIDATE_REVISION
    socket = ReconcileSocket(f"{authority}_authoritative", revision)
    connection = Connection(
        None, socket, project_directory=root,
        capabilities=frozenset(("mutation_bridge_v2", "scene_manifest_v3", "transaction_commit_v2")),
    )
    connection.tools_exposed = False
    _reconcile_connected_transaction(connection, root)
    expected_hash = base_manifest["sceneHash"] if authority == "base" else candidate_manifest["sceneHash"]
    resolved = resolve_manifest_for_expected_hash(expected_hash)
    assert resolved is not None
    return {
        "status": f"{authority}_authoritative",
        "revisionId": revision,
        "sceneHash": resolved["sceneHash"],
        "baseSceneHash": base_manifest["sceneHash"],
        "candidateSceneHash": candidate_manifest["sceneHash"],
        "schemaVersion": resolved["schemaVersion"],
        "toolsExposed": connection.tools_exposed,
        "markerExists": (root / ".cclay" / "prepared-transaction.json").exists(),
        "messages": [message["type"] for message in socket.sent],
    }


with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    base_root = root / "base"
    candidate_root = root / "candidate"
    base_root.mkdir()
    candidate_root.mkdir()
    result = {"base": run_case(base_root, "base"), "candidate": run_case(candidate_root, "candidate")}

print("CCLAY_ASSEMBLY_RECOVERY_RESULTS=" + json.dumps(result, sort_keys=True))
