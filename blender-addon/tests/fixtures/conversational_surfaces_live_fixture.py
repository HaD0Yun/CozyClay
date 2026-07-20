"""Exercise both conversational surfaces against the production faux live stack."""

from __future__ import annotations

import base64
import copy
import json
import os
import queue
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

import bpy

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import oh_my_blender
import oh_my_blender.camera_plan as camera_plan
import oh_my_blender.connection as connection_module
import oh_my_blender.controller_connection as controller_module
import oh_my_blender.qa_render as qa_render
import oh_my_blender.stage_scene as stage_scene
from apply_camera_plan_fixture import PROJECT_ID, SCENE_HASH, bound_plan
from controller_lifecycle_support import spawn_owner
from oh_my_blender import ui_panel
from oh_my_blender.canonical import canonical_revision
from oh_my_blender.connection import (
    Connection,
    LifecycleState,
    _resolve_daemon_argv,
    configure_bridge_auto_reconnect,
    consume_discovery_slot,
    poll_active_bridge_reconnect,
)
from oh_my_blender.controller_connection import (
    ControllerConnection,
    ControllerConnectionError,
)
from oh_my_blender.manifest import extract_scene_manifest_v2, extract_scene_manifest_v3
from oh_my_blender.prepared_transaction import (
    PreparedTransactionError,
    StoreEvidence,
    reconcile_decision,
)
from oh_my_blender.ws_client import ProtocolError, WebSocketClient

RESULT_PREFIX = "OMB_CONVERSATIONAL_SURFACES_LIVE_RESULTS="
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII="
)
TERMINAL_TYPES = {
    "director_turn_completed",
    "director_turn_failed",
    "director_turn_cancelled",
}
DURABLE_TYPES = {
    "director_turn_started",
    "director_assistant_utterance",
    "director_tool_call_started",
    "director_tool_call_finished",
    *TERMINAL_TYPES,
}


def _pump(directory: Path, bridge: Connection | None, count: int = 1) -> None:
    for _ in range(count):
        if bridge is not None and bridge.state == LifecycleState.ACTIVE:
            bridge.pump_bridge_messages()
        ui_panel.pump_controller_panel(
            bpy_module=bpy,
            project_directory=directory,
        )


def _wait_until(
    predicate,
    directory: Path,
    bridge: Connection | None,
    *,
    timeout: float,
    description: str,
) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        _pump(directory, bridge)
        if predicate():
            return
        time.sleep(0.005)
    raise RuntimeError(f"timed out waiting for {description}")


def _bridge_request(
    bridge: Connection,
    method: str,
    params: dict[str, object],
    expected_revision_id: str,
    *,
    timeout: float = 30.0,
) -> dict[str, object]:
    request_id = str(uuid.uuid4())
    responses: queue.Queue = queue.Queue(maxsize=1)
    bridge._response_queues[request_id] = responses
    try:
        bridge._send_json({
            "type": "request",
            "id": request_id,
            "method": method,
            "params": params,
            "expected_revision_id": expected_revision_id,
            "deadline_ms": min(300_000, max(100, int(timeout * 1000))),
        })
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            bridge.pump_bridge_messages()
            try:
                return responses.get_nowait()
            except queue.Empty:
                time.sleep(0.005)
        raise RuntimeError(f"{method} response timed out")
    finally:
        bridge._response_queues.pop(request_id, None)


def _event_signature(message: dict[str, object]) -> tuple[str, int, str]:
    event_id = message.get("id")
    sequence = message.get("sequence")
    if not isinstance(event_id, str) or not isinstance(sequence, int):
        raise RuntimeError("durable director event identity is invalid")
    content = {
        key: value
        for key, value in message.items()
        if key not in {"at", "id", "sequence"}
    }
    return event_id, sequence, json.dumps(content, sort_keys=True, separators=(",", ":"))


def _durable_signatures(
    messages: list[dict[str, object]],
    turn_ids: set[str],
) -> list[tuple[str, int, str]]:
    return [
        _event_signature(message)
        for message in messages
        if message.get("type") in DURABLE_TYPES and message.get("id") in turn_ids
    ]


def _restart_scene_hash(blend_path: Path, directory: Path) -> str:
    probe = directory / ".omb" / "live-restart-probe.py"
    probe.write_text(
        "from pathlib import Path\n"
        "import json, sys\n"
        f"sys.path.insert(0, {str(REPOSITORY_ROOT / 'blender-addon')!r})\n"
        "from oh_my_blender.manifest import extract_scene_manifest_v3\n"
        "print('OMB_RESTART_PROBE=' + json.dumps(extract_scene_manifest_v3(), separators=(',', ':')))\n",
        encoding="utf-8",
    )
    try:
        completed = subprocess.run(
            [
                bpy.app.binary_path,
                "--background",
                str(blend_path),
                "--python",
                str(probe),
            ],
            cwd=directory,
            env=os.environ.copy(),
            capture_output=True,
            text=True,
            timeout=90,
            check=False,
        )
    finally:
        probe.unlink(missing_ok=True)
    if completed.returncode != 0:
        raise RuntimeError(
            "Blender restart probe failed: "
            + (completed.stderr or completed.stdout)[-2000:]
        )
    records = [
        line.removeprefix("OMB_RESTART_PROBE=")
        for line in completed.stdout.splitlines()
        if line.startswith("OMB_RESTART_PROBE=")
    ]
    if len(records) != 1:
        raise RuntimeError("Blender restart probe did not emit exactly one result")
    manifest = json.loads(records[0])
    scene_hash = manifest.get("sceneHash")
    if not isinstance(scene_hash, str):
        raise RuntimeError("Blender restart probe scene hash is invalid")
    return scene_hash


def _audit_journal(directory: Path) -> tuple[int, int]:
    journal = directory / ".omb" / "journal.jsonl"
    if not journal.exists():
        return 0, 0
    uuid_violations = 0
    hash_mismatches = 0
    for raw_line in journal.read_text(encoding="utf-8").splitlines():
        if not raw_line:
            continue
        record = json.loads(raw_line)
        for key in ("idempotency_key",):
            value = record.get(key)
            try:
                parsed = uuid.UUID(value)
            except (AttributeError, TypeError, ValueError):
                uuid_violations += 1
            else:
                uuid_violations += int(parsed.version != 4 or str(parsed) != value)
        entry = record.get("journal_entry")
        if isinstance(entry, dict):
            request_id = entry.get("request_id")
            try:
                parsed_request = uuid.UUID(request_id)
            except (AttributeError, TypeError, ValueError):
                uuid_violations += 1
            else:
                uuid_violations += int(
                    parsed_request.version != 4 or str(parsed_request) != request_id
                )
        if record.get("kind") == "revision_commit_v2":
            payload = {
                key: record.get(key)
                for key in (
                    "kind",
                    "idempotency_key",
                    "expected_revision_id",
                    "target_revision_id",
                    "project",
                    "journal_entry",
                )
            }
            hash_mismatches += int(
                canonical_revision(payload) != record.get("commit_hash")
            )
    return uuid_violations, hash_mismatches


def main() -> None:
    directory = Path(os.environ.get("OMB_LIVE_PROJECT", bpy.path.abspath("//"))).resolve()
    blend_path = Path(bpy.data.filepath).resolve()
    if blend_path.parent != directory:
        raise RuntimeError("live blend must be copied into OMB_LIVE_PROJECT")

    child = None
    owner = None
    peer = None
    bridge = None
    original_camera_evidence = camera_plan.load_authorized_fixture
    original_render_transaction = qa_render.render_qa_frames_transaction
    original_stage_transaction = stage_scene.apply_stage_scene_transaction
    owner_messages: list[dict[str, object]] = []
    peer_messages: list[dict[str, object]] = []
    arrival_times: dict[tuple[str, str], float] = {}
    known_credentials: list[str] = []
    result: dict[str, object] | None = None
    owner_shutdown_succeeded = False
    peer_shutdown_denied = False

    try:
        bpy.context.scene["omb.project_id"] = PROJECT_ID
        for scene_object in bpy.context.scene.objects:
            if not isinstance(scene_object.get("omb.entity_id"), str):
                scene_object["omb.entity_id"] = str(uuid.uuid4())
            if scene_object.type == "ARMATURE":
                for bone in scene_object.data.bones:
                    if not isinstance(bone.get("omb.entity_id"), str):
                        bone["omb.entity_id"] = str(uuid.uuid4())
        initial_manifest = extract_scene_manifest_v2()
        omb = directory / ".omb"
        omb.mkdir(exist_ok=True)
        project_path = omb / "project.json"
        project_path.write_text(
            json.dumps({
                "schema_version": 1,
                "project_id": PROJECT_ID,
                "current_revision_id": initial_manifest["revisionId"],
                "manifest": initial_manifest,
            }),
            encoding="utf-8",
        )
        project_existed_before_spawn = project_path.is_file()

        oh_my_blender.register()
        stage_probe = None
        sentinel = "private-live-stage-sentinel"

        def fail_stage(*_args, **_kwargs):
            raise RuntimeError(sentinel)

        try:
            stage_probe = Connection.start(
                _resolve_daemon_argv(("--faux",)),
                cwd=directory,
                project_id=PROJECT_ID,
                addon_version="0.1.0",
                blender_version=bpy.app.version_string,
            )
            stage_scene.apply_stage_scene_transaction = fail_stage
            failed_stage = _bridge_request(
                stage_probe,
                "stage_scene",
                {
                    "schema_version": 1,
                    "expected_revision_id": initial_manifest["revisionId"],
                    "operations": [{
                        "op": "add_primitive",
                        "primitive_type": "CUBE",
                        "name": "Must Not Persist",
                        "location": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "scale": [1, 1, 1],
                    }],
                },
                initial_manifest["revisionId"],
            )
            stage_code = failed_stage.get("code")
            bridge_survived = stage_probe.state == LifecycleState.ACTIVE
            if sentinel in json.dumps(failed_stage):
                raise RuntimeError("stage failure leaked its private exception")
        finally:
            stage_scene.apply_stage_scene_transaction = original_stage_transaction
            if stage_probe is not None:
                stage_probe.disconnect("stage_probe_complete", timeout=0.2)

        child, owner, runtime_directory = spawn_owner(directory)
        project_bound_before_listen = (
            project_existed_before_spawn and owner.project_id == PROJECT_ID
        )
        known_credentials.append(owner.resume_token)

        first_bridge_ack = owner.publish_bridge_slot()
        first_bridge_slot = json.loads(
            (runtime_directory / "bridge-slot.json").read_text(encoding="utf-8")
        )
        known_credentials.append(first_bridge_slot["ticket"])
        second_bridge_ack = owner.publish_bridge_slot()
        second_bridge_slot = json.loads(
            (runtime_directory / "bridge-slot.json").read_text(encoding="utf-8")
        )
        known_credentials.append(second_bridge_slot["ticket"])
        superseded_accepted = 0
        try:
            stale = WebSocketClient.connect(
                owner.port,
                first_bridge_slot["ticket"],
                timeout=1.0,
                role="bridge",
            )
        except ProtocolError:
            pass
        else:
            superseded_accepted = 1
            stale.close()
        if second_bridge_ack["generation"] <= first_bridge_ack["generation"]:
            raise RuntimeError("bridge discovery generation did not advance")

        lineage_id = str(uuid.uuid4())
        owner.publish_peer_slot(lineage_id)
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
            raise RuntimeError("live discovery slots are unavailable")
        peer = ControllerConnection.attach_peer(
            peer_slot,
            project_id=PROJECT_ID,
            addon_version="0.1.0",
            blender_version=bpy.app.version_string,
            start_reader=False,
            jitter=lambda _delay: 0.0,
        )
        known_credentials.append(peer.resume_token)
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
            live_scene_hash_fn=lambda _expected: extract_scene_manifest_v3()["sceneHash"],
            jitter=lambda _delay: 0.0,
        )
        connection_module._active_connection = bridge
        controller_module._active_controller = peer

        def observe(
            authority: str,
            target: list[dict[str, object]],
            original,
        ):
            def receive(message: object) -> None:
                if isinstance(message, dict):
                    copied = copy.deepcopy(message)
                    target.append(copied)
                    if copied.get("type") == "director_turn_delta":
                        turn_id = copied.get("id")
                        if isinstance(turn_id, str):
                            arrival_times.setdefault(
                                (authority, turn_id), time.monotonic()
                            )
                original(message)

            return receive

        owner.handle_server_message = observe(
            "owner", owner_messages, owner.handle_server_message
        )
        peer.handle_server_message = observe(
            "peer", peer_messages, peer.handle_server_message
        )
        owner.start_reader()
        peer.start_reader()

        ui_panel.reset_panel_state()
        image_areas = [
            area
            for screen in bpy.data.screens
            for area in screen.areas
            if area.type == "IMAGE_EDITOR"
        ]
        if not image_areas and bpy.data.screens and bpy.data.screens[0].areas:
            bpy.data.screens[0].areas[0].type = "IMAGE_EDITOR"
            image_areas = [bpy.data.screens[0].areas[0]]
        _wait_until(
            lambda: not ui_panel.panel_snapshot().replaying,
            directory,
            bridge,
            timeout=10,
            description="initial transcript watermark",
        )

        authorized_evidence = original_camera_evidence(bound_plan(), SCENE_HASH)

        def rebound_evidence(plan: dict, scene_hash: str) -> dict:
            evidence = copy.deepcopy(authorized_evidence)
            evidence["revision_id"] = plan["expected_revision_id"]
            evidence["scene_hash"] = scene_hash
            return evidence

        def render_faux_batch(
            frames: list[int],
            *,
            deadline: float,
            cancelled,
        ) -> list[tuple[int, bytes]]:
            rendered = []
            for frame in frames:
                qa_render._check_abort(deadline, cancelled)
                bpy.context.scene.frame_set(frame)
                bpy.context.view_layer.update()
                rendered.append((frame, PNG))
            return rendered

        def render_faux_transaction(request_value, current_scene_hash, **kwargs):
            return original_render_transaction(
                request_value,
                current_scene_hash,
                render_batch=render_faux_batch,
                **kwargs,
            )

        delay_consumed = False

        def delayed_stage(*args, **kwargs):
            nonlocal delay_consumed
            if not delay_consumed:
                delay_consumed = True
                deadline = time.monotonic() + 20.0
                while time.monotonic() < deadline:
                    time.sleep(0.01)
            return original_stage_transaction(*args, **kwargs)

        camera_plan.load_authorized_fixture = rebound_evidence
        qa_render.render_qa_frames_transaction = render_faux_transaction
        stage_scene.apply_stage_scene_transaction = delayed_stage

        long_turn = ui_panel.submit_prompt(
            "Build a delayed, tool-separated hero scene.", directory, controller=peer
        )
        _wait_until(
            lambda: any(
                message.get("type") == "director_turn_started"
                and message.get("id") == long_turn
                for message in peer_messages
            ),
            directory,
            None,
            timeout=10,
            description="delayed turn start",
        )
        losing_turn = str(uuid.uuid4())
        owner._send_json({
            "type": "director_turn",
            "id": losing_turn,
            "prompt": "Competing owner submission.",
            "expected_revision_id": initial_manifest["revisionId"],
            "deadline_ms": 300_000,
        })
        _wait_until(
            lambda: any(
                message.get("type") in TERMINAL_TYPES
                and message.get("id") == long_turn
                for message in peer_messages
            ),
            directory,
            bridge,
            timeout=150,
            description="delayed turn terminal",
        )
        stage_scene.apply_stage_scene_transaction = original_stage_transaction
        tool_order = [
            message.get("tool_name")
            for message in peer_messages
            if message.get("type") == "director_tool_call_started"
            and message.get("id") == long_turn
        ]
        if tool_order != [
            "inspect_project",
            "stage_scene",
            "inspect_project",
            "render_qa_frames",
            "apply_camera_plan",
        ]:
            raise RuntimeError(f"delayed turn tool segments are invalid: {tool_order}")

        cancelled_turn = ui_panel.submit_prompt(
            "Start a turn that the other controller cancels.",
            directory,
            controller=peer,
        )
        _wait_until(
            lambda: any(
                message.get("type") == "director_turn_started"
                and message.get("id") == cancelled_turn
                for message in peer_messages
            ),
            directory,
            None,
            timeout=10,
            description="cancellable turn start",
        )
        owner._send_json({"type": "cancel", "id": cancelled_turn})
        _wait_until(
            lambda: any(
                message.get("type") in TERMINAL_TYPES
                and message.get("id") == cancelled_turn
                for message in peer_messages
            ),
            directory,
            bridge,
            timeout=30,
            description="cancelled turn terminal",
        )

        durable_project = json.loads(project_path.read_text(encoding="utf-8"))

        for _ in range(100):
            _pump(directory, bridge)
            if peer.pending_update_count == 0:
                break
            time.sleep(0.005)
        panel_snapshot = ui_panel.panel_snapshot()
        qa_displayed = (
            panel_snapshot.displayed_qa_digest is not None
            and any(
                area.spaces.active.image is not None
                for area in image_areas
            )
        )

        turn_ids = {long_turn, cancelled_turn}
        owner_durable = _durable_signatures(owner_messages, turn_ids)
        peer_durable = _durable_signatures(peer_messages, turn_ids)
        durable_drop = len(set(owner_durable).symmetric_difference(peer_durable))
        owner_delta = arrival_times.get(("owner", long_turn))
        peer_delta = arrival_times.get(("peer", long_turn))
        if owner_delta is None or peer_delta is None:
            raise RuntimeError("delayed turn emitted no first delta to both surfaces")
        first_delta_ms = abs(owner_delta - peer_delta) * 1000
        busy_owner = sum(
            message.get("type") == "error"
            and message.get("code") == "BUSY"
            and message.get("id") == losing_turn
            for message in owner_messages
        )
        busy_peer = sum(
            message.get("type") == "error"
            and message.get("code") == "BUSY"
            and message.get("id") == losing_turn
            for message in peer_messages
        )
        busy_target_count = busy_owner + busy_peer
        rate_limited_controls = sum(
            message.get("type") == "error"
            and message.get("code") == "RATE_LIMITED"
            and message.get("id") == cancelled_turn
            for message in owner_messages + peer_messages
        )
        for turn_id in turn_ids:
            terminals = [
                message
                for message in peer_messages
                if message.get("type") in TERMINAL_TYPES
                and message.get("id") == turn_id
            ]
            if len(terminals) != 1:
                raise RuntimeError(f"turn {turn_id} did not have exactly one terminal")

        peer.websocket.close()
        peer.mark_lost()
        if peer._reader_thread is not None:
            peer._reader_thread.join(timeout=1.0)
        peer_reconnected = peer.poll_reconnect(force=True)
        replay_id = str(uuid.uuid4())
        replay = peer.request(
            {
                "type": "director_transcript_request",
                "id": replay_id,
                "cursor": 0,
                "page_size": 64,
                "snapshot_cursor": None,
            },
            "director_transcript",
            timeout=10,
        )
        replay_events = replay.get("events")
        if not isinstance(replay_events, list):
            raise RuntimeError("watermark replay events are invalid")
        replay_durable = _durable_signatures(
            [event for event in replay_events if isinstance(event, dict)],
            turn_ids,
        )
        replay_keys = [(event_id, sequence) for event_id, sequence, _ in replay_durable]
        live_keys = [(event_id, sequence) for event_id, sequence, _ in peer_durable]
        replay_gap = len(set(live_keys) - set(replay_keys))
        replay_duplicate = len(replay_keys) - len(set(replay_keys))

        bridge.websocket.close()
        bridge._mark_lost_if_active()
        bridge.pump_bridge_messages()
        owner.publish_bridge_slot()
        reconnect_started = time.monotonic()
        bridge_reconnected = poll_active_bridge_reconnect(force=True)
        reconnect_ms = (time.monotonic() - reconnect_started) * 1000
        bridge = connection_module._active_connection
        if bridge is None:
            raise RuntimeError("bridge reconnect produced no active connection")

        durable_project = json.loads(project_path.read_text(encoding="utf-8"))
        live_manifest = extract_scene_manifest_v3()
        restarted_scene_hash = _restart_scene_hash(blend_path, directory)
        revision_matches = (
            durable_project["current_revision_id"]
            == durable_project["manifest"]["revisionId"]
        )
        live_scene_matches = (
            durable_project["manifest"]["sceneHash"] == live_manifest["sceneHash"]
        )
        restart_scene_matches = (
            restarted_scene_hash == durable_project["manifest"]["sceneHash"]
        )
        transaction_mismatch = int(
            not revision_matches or not live_scene_matches or not restart_scene_matches
        )
        transaction_directories = list((omb / "transactions").glob("*")) \
            if (omb / "transactions").is_dir() else []
        ordinary_crash_recovery_required = len(transaction_directories)

        drift_target = next(iter(bpy.context.scene.objects), None)
        if drift_target is None:
            drift_target = bpy.data.objects.new("OMB Drift", None)
            bpy.context.scene.collection.objects.link(drift_target)
        drift_target.location.x += 0.125
        bpy.context.view_layer.update()
        drift_bridge_messages: list[dict[str, object]] = []
        send_bridge_json = bridge._send_json

        def observe_drift_response(message: dict[str, object]) -> None:
            drift_bridge_messages.append(copy.deepcopy(message))
            send_bridge_json(message)

        bridge._send_json = observe_drift_response
        drift_turn = ui_panel.submit_prompt(
            "Attempt a mutation after genuine live-scene drift.",
            directory,
            controller=peer,
        )
        _wait_until(
            lambda: any(
                message.get("type") in TERMINAL_TYPES
                and message.get("id") == drift_turn
                for message in peer_messages
            ),
            directory,
            bridge,
            timeout=30,
            description="genuine drift terminal",
        )
        drift_code = next(
            (
                message.get("code")
                for message in drift_bridge_messages
                if message.get("type") == "bridge_error"
            ),
            None,
        )
        if drift_code != "STALE_BASE":
            raise RuntimeError(
                f"genuine scene drift was not rejected: {drift_bridge_messages}"
            )

        try:
            peer.shutdown("client_exit")
        except ControllerConnectionError:
            peer_shutdown_denied = True
        unknown_reconcile_phases_accepted = 0
        try:
            reconcile_decision("unknown", StoreEvidence.BASE)
        except PreparedTransactionError:
            pass
        else:
            unknown_reconcile_phases_accepted = 1

        uuid_violations, hash_mismatches = _audit_journal(directory)
        transcript_path = omb / "director-transcript.json"
        transcript_text = transcript_path.read_text(encoding="utf-8")
        unauthorized_credential_matches = sum(
            transcript_text.count(credential)
            for credential in known_credentials
            if credential
        )
        if "director_turn_delta" in transcript_text:
            raise RuntimeError("ephemeral director deltas were persisted")
        if base64.b64encode(PNG).decode("ascii") in transcript_text:
            raise RuntimeError("QA image bytes were persisted in transcript")
        owner_resume_seen_by_peer = owner.resume_token in json.dumps(peer_messages)
        p95_ms, maximum_ms = ui_panel.panel_timer_metrics()
        result = {
            "projectBoundBeforeListen": project_bound_before_listen,
            "ownerResumeSeenByPeer": owner_resume_seen_by_peer,
            "supersededAccepted": superseded_accepted,
            "firstDeltaMs": first_delta_ms,
            "replayGap": replay_gap,
            "replayDuplicate": replay_duplicate,
            "durableDrop": durable_drop,
            "busyTargetCount": busy_target_count,
            "stageCode": stage_code,
            "bridgeSurvived": bridge_survived,
            "reconnectMs": reconnect_ms,
            "transactionMismatch": transaction_mismatch,
            "revisionMatches": revision_matches,
            "liveSceneMatches": live_scene_matches,
            "restartSceneMatches": restart_scene_matches,
            "ordinaryCrashRecoveryRequired": ordinary_crash_recovery_required,
            "timerP95Ms": p95_ms,
            "timerMaxMs": maximum_ms,
            "qaDisplayed": qa_displayed,
            "unauthorizedCredentialMatches": unauthorized_credential_matches,
            "uuidTransactionViolations": uuid_violations,
            "commitHashMismatches": hash_mismatches,
            "resumeHeaderViolations": int(
                not peer_reconnected or peer.authority != "peer" or peer.generation != 2
            ),
            "rateLimitStateMismatches": (
                int(busy_owner != 1 or busy_peer != 0) + rate_limited_controls
            ),
            "unknownReconcilePhasesAccepted": unknown_reconcile_phases_accepted,
            "cleanupTimerCount": 0,
            "cleanupControllerCount": 0,
            "cleanupThreadCount": 0,
            "cleanupClassCount": 0,
            "cleanupSocketCount": 0,
            "bridgeReconnected": bridge_reconnected,
            "peerShutdownDenied": peer_shutdown_denied,
            "ownerShutdownSucceeded": False,
        }
    finally:
        camera_plan.load_authorized_fixture = original_camera_evidence
        qa_render.render_qa_frames_transaction = original_render_transaction
        stage_scene.apply_stage_scene_transaction = original_stage_transaction
        controller_module._active_controller = None
        connection_module._active_connection = None
        connection_module.reset_lifecycle_state()
        if bridge is not None:
            try:
                bridge.disconnect("live_fixture_complete", timeout=0.2)
            except BaseException:
                pass
        if peer is not None:
            peer.close()
        if owner is not None:
            try:
                owner.shutdown("client_exit", timeout=3.0)
                owner_shutdown_succeeded = True
            except BaseException:
                owner.close()
        if child is not None:
            if child.process.poll() is None:
                child.kill()
            else:
                child.close_streams()
        oh_my_blender.unregister()

    if result is None:
        raise RuntimeError("live conversational fixture produced no result")
    result["ownerShutdownSucceeded"] = owner_shutdown_succeeded
    result["cleanupTimerCount"] = int(
        oh_my_blender._lifecycle_timer_registered
        or bpy.app.timers.is_registered(oh_my_blender._pump_lifecycle)
    )
    result["cleanupControllerCount"] = int(
        controller_module._active_controller is not None
        or connection_module._active_connection is not None
    )
    result["cleanupThreadCount"] = sum(
        thread.is_alive()
        and thread.name.startswith("omb-")
        for thread in threading.enumerate()
    )
    result["cleanupClassCount"] = len(oh_my_blender._registered_classes)
    result["cleanupSocketCount"] = int(
        (owner is not None and not owner.websocket.closed)
        or (peer is not None and not peer.websocket.closed)
        or (bridge is not None and not bridge.websocket.closed)
    )
    print(RESULT_PREFIX + json.dumps(result, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
