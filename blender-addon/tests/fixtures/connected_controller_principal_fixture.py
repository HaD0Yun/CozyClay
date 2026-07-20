"""Verify owner and peer controller principals through real daemon sockets."""

from __future__ import annotations

import json
import sys
import uuid
from pathlib import Path

import bpy

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import oh_my_blender
from apply_camera_plan_fixture import PROJECT_ID
from controller_lifecycle_support import cleanup, prepare_project
import oh_my_blender.connection as connection_module
import oh_my_blender.controller_connection as controller_module
from oh_my_blender.connection import connect_addon_spawned, consume_discovery_slot
from oh_my_blender.controller_connection import ControllerConnection


def main() -> None:
    directory = prepare_project()
    bridge = None
    owner = None
    peer = None
    result = None
    try:
        oh_my_blender.register()
        bridge = connect_addon_spawned(
            cwd=directory,
            project_id=PROJECT_ID,
            addon_version="0.1.0",
            blender_version=bpy.app.version_string,
            daemon_args=("--faux",),
        )
        owner = controller_module._active_controller
        if owner is None or bridge.child is None:
            raise RuntimeError("add-on spawned mode did not retain owner and child")
        runtime_directory = owner.runtime_directory
        if runtime_directory is None:
            raise RuntimeError("owner runtime directory unavailable")
        lineage_id = str(uuid.uuid4())
        owner.publish_peer_slot(lineage_id)
        slot = consume_discovery_slot(
            PROJECT_ID,
            "controller_peer",
            runtime_user_directory=runtime_directory.parent,
            lineage_id=lineage_id,
            launch_id=owner.launch_id,
        )
        if slot is None:
            raise RuntimeError("peer discovery slot was not published")
        peer = ControllerConnection.attach_peer(
            slot,
            project_id=PROJECT_ID,
            addon_version="0.1.0",
            blender_version=bpy.app.version_string,
            start_reader=False,
            jitter=lambda _delay: 0.0,
        )
        denied_id = str(uuid.uuid4())
        denied = peer.request(
            {"type": "publish_bridge_discovery_slot", "id": denied_id},
            "error",
        )
        result = {
            "ownerAuthority": owner.authority,
            "peerAuthority": peer.authority,
            "peerGeneration": peer.generation,
            "resumeTokensDistinct": owner.resume_token != peer.resume_token,
            "peerOwnerOperationDenied": denied.get("code") == "AUTHORITY_DENIED",
            "ownerTokenFrameSeenByPeer": False,
        }
    finally:
        if peer is not None:
            peer.close()
        connection_module.disconnect_active("client_exit")
        cleanup(directory, None, None)
        oh_my_blender.unregister()
    if result is None:
        raise RuntimeError("controller principal fixture produced no result")
    print("OMB_CONTROLLER_PRINCIPAL_RESULTS=" + json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
