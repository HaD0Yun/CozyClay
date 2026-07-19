"""Register, render, and unload the Pi status panel in a real Blender host."""

from __future__ import annotations

import json
from pathlib import Path
import sys
from types import SimpleNamespace

import bpy

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

import oh_my_blender
from oh_my_blender import connection


class LayoutRecorder:
    def __init__(self):
        self.labels = []
        self.operators = []

    def label(self, *, text, **_kwargs):
        self.labels.append(text)

    def operator(self, operator, **_kwargs):
        self.operators.append(operator)


def main() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    oh_my_blender.register()
    panel_type = bpy.types.OMB_PT_pi_status
    connection._active_connection = SimpleNamespace(
        state=connection.LifecycleState.RECOVERY_REQUIRED,
        tools_exposed=False,
        identity={"bearer_token_fingerprint": "not-rendered"},
        active_checkpoint=object(),
        durable_commit_reconciliation={"outcome": "reconciliation_required"},
        last_bridge_response=None,
        child=SimpleNamespace(
            process=SimpleNamespace(
                args=["node", "main.ts", "--provider", "anthropic", "--model", "claude-sonnet-4"]
            )
        ),
    )
    layout = LayoutRecorder()
    panel_type.draw(SimpleNamespace(layout=layout), bpy.context)
    result = {
        "registered": panel_type.bl_rna.identifier == "OMB_PT_pi_status",
        "spaceType": panel_type.bl_space_type,
        "regionType": panel_type.bl_region_type,
        "category": panel_type.bl_category,
        "labels": layout.labels,
        "operators": layout.operators,
    }
    connection._active_connection = None
    oh_my_blender.unregister()
    result["unregistered"] = not hasattr(bpy.types, "OMB_PT_pi_status")
    print("OMB_UI_PANEL_RESULTS=" + json.dumps(result, separators=(",", ":")))


main()
