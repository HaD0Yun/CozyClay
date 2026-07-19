"""Host-side clauses for the Pi-driven-only Blender status panel."""

from __future__ import annotations

import importlib
import os
import sys
import types
import unittest
from unittest import mock


class _Layout:
    def __init__(self):
        self.labels: list[str] = []
        self.operators: list[str] = []

    def label(self, *, text: str, **_kwargs) -> None:
        self.labels.append(text)

    def operator(self, operator: str, **_kwargs) -> None:
        self.operators.append(operator)


class _Registry:
    def __init__(self, bpy_types: types.SimpleNamespace):
        self.bpy_types = bpy_types
        self.registered: list[type] = []

    def register_class(self, cls: type) -> None:
        self.registered.append(cls)
        setattr(self.bpy_types, cls.__name__, cls)

    def unregister_class(self, cls: type) -> None:
        if cls in self.registered:
            self.registered.remove(cls)
        if hasattr(self.bpy_types, cls.__name__):
            delattr(self.bpy_types, cls.__name__)


def _fake_bpy() -> tuple[types.ModuleType, _Registry]:
    bpy = types.ModuleType("bpy")
    bpy.types = types.SimpleNamespace(Operator=type("Operator", (), {}), Panel=type("Panel", (), {}))
    bpy.props = types.SimpleNamespace(
        StringProperty=lambda **_kwargs: None,
        IntProperty=lambda **_kwargs: None,
    )
    registry = _Registry(bpy.types)
    bpy.utils = types.SimpleNamespace(
        register_class=registry.register_class,
        unregister_class=registry.unregister_class,
    )
    bpy.data = types.SimpleNamespace(filepath="", is_dirty=False)
    bpy.path = types.SimpleNamespace(abspath=lambda value: value)
    bpy.app = types.SimpleNamespace(version_string="test")
    return bpy, registry


class UiPanelTests(unittest.TestCase):
    def setUp(self) -> None:
        self.saved_modules = {
            name: module
            for name, module in sys.modules.items()
            if name == "bpy" or name == "oh_my_blender" or name.startswith("oh_my_blender.")
        }
        for name in tuple(self.saved_modules):
            sys.modules.pop(name, None)
        self.bpy, self.registry = _fake_bpy()
        sys.modules["bpy"] = self.bpy
        self.addon = importlib.import_module("oh_my_blender")
        self.connection_module = importlib.import_module("oh_my_blender.connection")

    def tearDown(self) -> None:
        for name in tuple(sys.modules):
            if name == "bpy" or name == "oh_my_blender" or name.startswith("oh_my_blender."):
                sys.modules.pop(name, None)
        sys.modules.update(self.saved_modules)

    def _draw(self, active=None) -> _Layout:
        self.connection_module._active_connection = active
        panel = self.addon.OMB_PT_pi_status()
        panel.layout = _Layout()
        panel.draw(types.SimpleNamespace())
        return panel.layout

    def test_panel_is_discoverable_and_cleanly_unloads(self) -> None:
        panel = self.addon.OMB_PT_pi_status
        self.assertEqual(panel.bl_space_type, "VIEW_3D")
        self.assertEqual(panel.bl_region_type, "UI")
        self.assertEqual(panel.bl_category, "Oh My Blender")

        self.addon.register()
        self.addon.register()
        self.assertIn(panel, self.registry.registered)
        self.assertIs(self.bpy.types.OMB_PT_pi_status, panel)
        self.addon.unregister()
        self.addon.unregister()
        self.assertNotIn(panel, self.registry.registered)
        self.assertFalse(hasattr(self.bpy.types, "OMB_PT_pi_status"))

    def test_connect_reports_tui_instruction_when_no_spawn_or_handoff_exists(self) -> None:
        operator = self.addon.OMB_OT_connect()
        reports = []
        operator.report = lambda levels, message: reports.append((levels, message))
        context = types.SimpleNamespace(
            scene={"omb.project_id": "33333333-3333-4333-8333-333333333333"}
        )
        with (
            mock.patch.dict(os.environ, {}, clear=True),
            mock.patch.object(
                self.addon.project_store, "verify_connect_precondition"
            ),
            mock.patch.object(
                self.connection_module, "consume_attach_handoff", return_value=None
            ),
        ):
            result = operator.execute(context)

        self.assertEqual(result, {"CANCELLED"})
        self.assertIn("run the omb TUI first", reports[-1][1])

    def test_each_lifecycle_state_has_human_readable_rendering(self) -> None:
        expected = {
            self.connection_module.LifecycleState.ACTIVE: "Active",
            self.connection_module.LifecycleState.LOST: "Connection lost",
            self.connection_module.LifecycleState.DISCONNECTED: "Disconnected",
            self.connection_module.LifecycleState.RECOVERY_REQUIRED: "Recovery required",
            self.connection_module.LifecycleState.DRAINING: "Draining",
            self.connection_module.LifecycleState.STOPPED: "Stopped",
        }
        for state, rendered in expected.items():
            with self.subTest(state=state):
                active = types.SimpleNamespace(
                    state=state,
                    tools_exposed=state is self.connection_module.LifecycleState.ACTIVE,
                    identity={"launch_id": "launch", "bearer_token_fingerprint": "fingerprint"},
                    active_checkpoint=None,
                    durable_commit_reconciliation=None,
                    last_bridge_response=None,
                    child=types.SimpleNamespace(
                        process=types.SimpleNamespace(
                            args=["node", "main.ts", "--provider", "anthropic", "--model", "claude-sonnet-4"]
                        )
                    ),
                )
                labels = self._draw(active).labels
                self.assertIn(f"Lifecycle: {rendered}", labels)
                self.assertIn("Provider: anthropic", labels)
                self.assertIn("Model: claude-sonnet-4", labels)
                if state is self.connection_module.LifecycleState.RECOVERY_REQUIRED:
                    self.assertIn("Tools: Hidden until verified recovery", labels)

    def test_panel_never_renders_environment_secret_or_bearer_identity(self) -> None:
        secret = "sk-secret-ui-must-never-render"
        active = types.SimpleNamespace(
            state=self.connection_module.LifecycleState.ACTIVE,
            tools_exposed=True,
            identity={"launch_id": "launch", "bearer_token": secret, "bearer_token_fingerprint": secret},
            active_checkpoint=None,
            durable_commit_reconciliation=None,
            last_bridge_response={"secret": secret},
            child=types.SimpleNamespace(
                process=types.SimpleNamespace(
                    args=["node", "main.ts", "--provider", "anthropic", "--model", secret]
                )
            ),
        )
        with mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": secret}, clear=False):
            rendered = "\n".join(self._draw(active).labels)
        self.assertNotIn(secret, rendered)
        self.assertNotIn("bearer", rendered.lower())

    def test_panel_is_read_only_and_surfaces_real_progress_evidence(self) -> None:
        active = types.SimpleNamespace(
            state=self.connection_module.LifecycleState.RECOVERY_REQUIRED,
            tools_exposed=False,
            task_status=self.connection_module.TaskStatus(
                task_kind="qa_render",
                descriptor="QA render revision aaaaaaaa, frames 80, 161",
                phase="publishing",
                completed=1,
                total=2,
                outcome="recovery_required",
                evidence="Frame 80 sha256:bbbbbbbbbbbb",
            ),
            child=types.SimpleNamespace(process=types.SimpleNamespace(args=["node", "main.ts", "--faux"])),
        )
        layout = self._draw(active)
        self.assertEqual(layout.operators, [])
        self.assertIn("Task: QA render", layout.labels)
        self.assertIn("Descriptor: QA render revision aaaaaaaa, frames 80, 161", layout.labels)
        self.assertIn("Progress: Publishing (1/2)", layout.labels)
        self.assertIn("Outcome: Recovery required", layout.labels)
        self.assertIn("Evidence: Frame 80 sha256:bbbbbbbbbbbb", layout.labels)
        self.assertFalse(any(label.startswith("Prompt:") for label in layout.labels))


if __name__ == "__main__":
    unittest.main()
