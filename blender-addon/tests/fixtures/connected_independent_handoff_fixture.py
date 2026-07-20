"""Consume bridge and controller-peer generations independently in real Blender."""

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
import oh_my_blender.connection as connection_module
import oh_my_blender.controller_connection as controller_module
from apply_camera_plan_fixture import PROJECT_ID
from controller_lifecycle_support import cleanup, prepare_project, spawn_owner
from oh_my_blender.connection import Connection, consume_discovery_slot
from oh_my_blender.controller_connection import ControllerConnection
from oh_my_blender.ws_client import ProtocolError, WebSocketClient


def main() -> None:
    directory = prepare_project()
    child = None
    owner = None
    peer = None
    bridge = None
    result = None
    try:
        oh_my_blender.register()
        child, owner, runtime_directory = spawn_owner(directory)
        lineage_id = str(uuid.uuid4())

        first_bridge_ack = owner.publish_bridge_slot()
        first_bridge = json.loads(
            (runtime_directory / "bridge-slot.json").read_text(encoding="utf-8")
        )
        second_bridge_ack = owner.publish_bridge_slot()
        owner.publish_peer_slot(lineage_id)

        superseded_rejected = False
        try:
            stale = WebSocketClient.connect(
                owner.port,
                first_bridge["ticket"],
                timeout=1.0,
                role="bridge",
            )
        except ProtocolError:
            superseded_rejected = True
        else:
            stale.close()

        peer_slot = consume_discovery_slot(
            PROJECT_ID,
            "controller_peer",
            runtime_user_directory=runtime_directory.parent,
            lineage_id=lineage_id,
            launch_id=owner.launch_id,
        )
        if peer_slot is None:
            raise RuntimeError("peer slot unavailable")
        bridge_path = runtime_directory / "bridge-slot.json"
        peer = ControllerConnection.attach_peer(
            peer_slot,
            project_id=PROJECT_ID,
            addon_version="0.1.0",
            blender_version=bpy.app.version_string,
            start_reader=False,
            jitter=lambda _delay: 0.0,
        )
        bridge_slot_remained = bridge_path.is_file()

        bridge_slot = consume_discovery_slot(
            PROJECT_ID,
            "bridge",
            runtime_user_directory=runtime_directory.parent,
            launch_id=owner.launch_id,
        )
        if bridge_slot is None:
            raise RuntimeError("bridge slot unavailable")
        bridge = Connection.attach(
            bridge_slot.runtime_directory,
            bridge_slot.ticket,
            cwd=directory,
            project_id=PROJECT_ID,
            addon_version="0.1.0",
            blender_version=bpy.app.version_string,
        )
        initial_bridge_attached = bridge.state.value == "active"
        initial_peer_active = peer.state.value == "active"
        bridge.disconnect("handoff_fixture_switch", timeout=0.2)
        bridge = None
        peer.close()
        peer = None

        owner.publish_peer_slot(lineage_id)
        owner.publish_bridge_slot()
        tui_bridge = connection_module.connect_tui_spawned(
            cwd=directory,
            project_id=PROJECT_ID,
            addon_version="0.1.0",
            blender_version=bpy.app.version_string,
            runtime_user_directory=runtime_directory.parent,
        )
        tui_peer = controller_module._active_controller
        result = {
            "bridgeGenerationAdvanced": second_bridge_ack["generation"]
            > first_bridge_ack["generation"],
            "supersededBridgeRejected": superseded_rejected,
            "peerConsumedFirst": bridge_slot_remained,
            "bridgeAttached": initial_bridge_attached,
            "peerStillActive": initial_peer_active,
            "rolesIndependent": bridge_slot.slot == "bridge"
            and peer_slot.slot == "controller_peer",
            "tuiSpawnedModeConnected": tui_bridge.state.value == "active"
            and tui_peer is not None
            and tui_peer.state.value == "active"
            and tui_peer.authority == "peer",
        }
    finally:
        connection_module.disconnect_active("client_exit")
        cleanup(directory, child, owner, bridge, peer)
        oh_my_blender.unregister()
    if result is None:
        raise RuntimeError("independent handoff fixture produced no result")
    print("OMB_INDEPENDENT_HANDOFF_RESULTS=" + json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
