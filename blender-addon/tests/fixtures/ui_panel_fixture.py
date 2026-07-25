"""Exercise real Blender bridge operators and panel formatting against live task state.

Blender background mode has no VIEW_3D window/area/region, so panel formatting is
invoked directly with a recorder rather than presented as interactive UI rendering.
The in-flight snapshots are captured from inside transactions reached through real
``dispatch_bridge_message`` and registered ``bpy.ops.cclay`` operator execution.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace

import bpy

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

import cclay
from cclay import camera_plan, connection, qa_render, ui_panel


CREDENTIAL_SENTINEL = "sk-real-host-ui-sentinel"
REVISION = "a" * 64
CANDIDATE_REVISION = "c" * 64


class FakeSocket:
    def __init__(self):
        self.closed = False
        self.sent = []
        self.response = None

    def send_json(self, message):
        self.sent.append(message)

    def recv_json(self):
        response = self.response
        self.response = None
        if response is None:
            raise StopIteration
        return response

    def close(self):
        self.closed = True


class FakeProcess:
    args = [
        "node",
        "main.ts",
        "--provider",
        "anthropic",
        "--model",
        CREDENTIAL_SENTINEL,
    ]

    def poll(self):
        return None


class LayoutRecorder:
    def __init__(self):
        self.bl_rna = SimpleNamespace(identifier="UILayout")
        self.labels = []
        self.operators = []

    def label(self, *, text, **_kwargs):
        self.labels.append(text)

    def operator(self, operator, **_kwargs):
        self.operators.append(operator)
        return SimpleNamespace()


def main() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    os.environ["ANTHROPIC_API_KEY"] = CREDENTIAL_SENTINEL
    cclay.register()
    panel_type = bpy.types.CCLAY_PT_pi_status
    captures = []
    original_draw_status = ui_panel.draw_status
    original_camera_transaction = camera_plan.apply_camera_plan_transaction
    original_qa_transaction = qa_render.render_qa_frames_transaction

    def observed_draw(layout, active):
        labels = original_draw_status(layout, active)
        captures.append({
            "layoutType": layout.bl_rna.identifier,
            "labels": list(labels),
            "operators": list(layout.operators),
        })
        return labels

    ui_panel.draw_status = observed_draw

    def redraw():
        panel_type.draw(SimpleNamespace(layout=LayoutRecorder()), bpy.context)

    socket = FakeSocket()
    active = connection.Connection(
        SimpleNamespace(process=FakeProcess()),
        socket,
    )

    def camera_transaction(_plan, _scene_hash, _active, commit, **_kwargs):
        redraw()
        result = {
            "expected_revision_id": REVISION,
            "scene_hash": "b" * 64,
            "manifest": {"revisionId": CANDIDATE_REVISION},
        }
        commit(result)
        return result

    def qa_transaction(_request, _scene_hash, *, progress, **_kwargs):
        redraw()
        progress("validating", 0, 2)
        progress("rendering", 0, 2)
        progress("rendered", 2, 2)
        return {
            "schema_version": 1,
            "revision_id": REVISION,
            "profile_version": qa_render.PROFILE_VERSION,
            "frames": [{
                "frame": frame,
                "width": qa_render.WIDTH,
                "height": qa_render.HEIGHT,
                "profile_version": qa_render.PROFILE_VERSION,
                "byte_length": 1,
                "sha256": hashlib.sha256(b"x").hexdigest(),
                "png_base64": base64.b64encode(b"x").decode("ascii"),
            } for frame in (80, 161)],
        }

    camera_plan.apply_camera_plan_transaction = camera_transaction
    qa_render.render_qa_frames_transaction = qa_transaction
    stages = []

    def disconnected():
        connection._active_connection = None

    def camera_lifecycle():
        connection._active_connection = active
        socket.response = {
            "type": "response",
            "id": "camera-request",
            "resulting_revision_id": CANDIDATE_REVISION,
        }
        active.dispatch_bridge_message({
            "type": "bridge_request",
            "id": "camera-bridge",
            "request_id": "camera-request",
            "method": "apply_camera_plan",
            "params": {
                "expected_revision_id": REVISION,
                "keyframes": [{}, {}],
                "credential": CREDENTIAL_SENTINEL,
            },
            "expected_revision_id": REVISION,
            "current_scene_hash": "b" * 64,
            "deadline_ms": 30000,
        })

    def qa_lifecycle():
        active.dispatch_bridge_message({
            "type": "bridge_request",
            "id": "qa-bridge",
            "request_id": "qa-request",
            "method": "render_qa_frames",
            "params": {
                "schema_version": 1,
                "revision_id": REVISION,
                "frames": [80, 161],
                "credential": CREDENTIAL_SENTINEL,
            },
            "expected_revision_id": REVISION,
            "current_scene_hash": "b" * 64,
            "deadline_ms": 30000,
        })

    def recovery():
        active.require_recovery()

    stages.extend([
        disconnected,
        camera_lifecycle,
        qa_lifecycle,
        recovery,
    ])

    def cleanup():
        ui_panel.draw_status = original_draw_status
        camera_plan.apply_camera_plan_transaction = original_camera_transaction
        qa_render.render_qa_frames_transaction = original_qa_transaction
        connection._active_connection = None
        cclay.unregister()

    for stage in stages:
        stage()
        redraw()
    if not captures:
        raise RuntimeError("registered Pi panel was not drawn by Blender")
    rendered = "\n".join(
        label
        for capture in captures
        for label in capture["labels"]
    )
    result = {
        "registered": panel_type.bl_rna.identifier == "CCLAY_PT_pi_status",
        "spaceType": panel_type.bl_space_type,
        "regionType": panel_type.bl_region_type,
        "category": panel_type.bl_category,
        "captures": captures,
        "credentialSuppressed": CREDENTIAL_SENTINEL not in rendered,
        "operators": [
            operator
            for capture in captures
            for operator in capture["operators"]
        ],
    }
    cleanup()
    result["unregistered"] = not hasattr(bpy.types, "CCLAY_PT_pi_status")
    print("CCLAY_UI_PANEL_RESULTS=" + json.dumps(result, separators=(",", ":")))


main()
