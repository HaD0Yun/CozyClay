"""Exercise peer ratchet and bridge slot auto-reconnect through real sockets."""

from __future__ import annotations

import json
import sys
import time
import uuid
from pathlib import Path

import bpy

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import oh_my_blender
import oh_my_blender.connection as connection_module
from apply_camera_plan_fixture import PROJECT_ID
from controller_lifecycle_support import cleanup, prepare_project, spawn_owner
from oh_my_blender.connection import (
    Connection,
    configure_bridge_auto_reconnect,
    consume_discovery_slot,
    poll_active_bridge_reconnect,
)
from oh_my_blender.controller_connection import ControllerConnection


def main() -> None:
    directory = prepare_project()
    child = None
    owner = None
    peer = None
    bridge = None
    replacement = None
    result = None
    try:
        oh_my_blender.register()
        child, owner, runtime_directory = spawn_owner(directory)
        lineage_id = str(uuid.uuid4())
        owner.publish_peer_slot(lineage_id)
        owner.publish_bridge_slot()
        peer_slot = consume_discovery_slot(
            PROJECT_ID,
            "controller_peer",
            runtime_user_directory=runtime_directory.parent,
            lineage_id=lineage_id,
            launch_id=owner.launch_id,
        )
        bridge_slot = consume_discovery_slot(
            PROJECT_ID,
            "bridge",
            runtime_user_directory=runtime_directory.parent,
            launch_id=owner.launch_id,
        )
        if peer_slot is None or bridge_slot is None:
            raise RuntimeError("initial lifecycle slots unavailable")
        peer = ControllerConnection.attach_peer(
            peer_slot,
            project_id=PROJECT_ID,
            addon_version="0.1.0",
            blender_version=bpy.app.version_string,
            start_reader=False,
            jitter=lambda _delay: 0.0,
        )
        bridge = Connection.attach(
            bridge_slot.runtime_directory,
            bridge_slot.ticket,
            cwd=directory,
            project_id=PROJECT_ID,
            addon_version="0.1.0",
            blender_version=bpy.app.version_string,
        )
        configure_bridge_auto_reconnect(
            bridge,
            cwd=directory,
            project_id=PROJECT_ID,
            addon_version="0.1.0",
            blender_version=bpy.app.version_string,
            runtime_user_directory=runtime_directory.parent,
            live_scene_hash_fn=lambda expected: expected,
            jitter=lambda _delay: 0.0,
        )
        connection_module._active_connection = bridge

        peer.websocket.close()
        peer.mark_lost()
        peer_resumed = peer.poll_reconnect(force=True)

        bridge.websocket.close()
        bridge._mark_lost_if_active()
        bridge.pump_bridge_messages()
        owner.publish_bridge_slot()
        started = time.monotonic()
        bridge_reconnected = poll_active_bridge_reconnect(force=True)
        elapsed_ms = (time.monotonic() - started) * 1000
        replacement = connection_module._active_connection
        result = {
            "peerResumed": peer_resumed,
            "peerGenerationRatcheted": peer.generation == 2,
            "peerAuthorityPreserved": peer.authority == "peer",
            "bridgeReconnected": bridge_reconnected,
            "bridgeGenerationIndependent": peer.generation == 2
            and replacement is not bridge,
            "reconnectWithinWindow": elapsed_ms < 5_000,
            "replacementToolsExposed": bool(
                replacement is not None and replacement.tools_exposed
            ),
        }
    finally:
        connection_module._active_connection = None
        connection_module.reset_lifecycle_state()
        cleanup(directory, child, owner, replacement or bridge, peer)
        oh_my_blender.unregister()
    if result is None:
        raise RuntimeError("auto reconnect fixture produced no result")
    print("OMB_AUTO_RECONNECT_RESULTS=" + json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
