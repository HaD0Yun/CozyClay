"""Host-side clauses for the connected Blender chat panel."""

from __future__ import annotations

from collections import deque
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
        self.props: list[str] = []

    def label(self, *, text: str, **_kwargs) -> None:
        self.labels.append(text)

    def operator(self, operator: str, **_kwargs):
        self.operators.append(operator)
        return types.SimpleNamespace()

    def row(self, **_kwargs):
        return self

    def prop(self, _owner, name: str, **_kwargs) -> None:
        self.props.append(name)


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


class _Timers:
    def __init__(self):
        self.registered: set[object] = set()

    def register(self, callback, **_kwargs) -> None:
        self.registered.add(callback)

    def unregister(self, callback) -> None:
        self.registered.discard(callback)

    def is_registered(self, callback) -> bool:
        return callback in self.registered


class _FakeController:
    def __init__(self, state, updates=()):
        self.state = state
        self.authority = "peer"
        self.capabilities = frozenset({"director_turn_v1", "director_transcript_v1"})
        self.session_id = "11111111-1111-4111-8111-111111111111"
        self.generation = 1
        self.updates = deque(updates)
        self.sent: list[dict[str, object]] = []

    @property
    def pending_update_count(self) -> int:
        return len(self.updates)

    def _send_json(self, message: dict[str, object]) -> None:
        self.sent.append(message)

    def drain_updates(self, *, max_updates, budget_ms, clock):
        del budget_ms
        clock()
        values = []
        while self.updates and len(values) < max_updates:
            values.append(self.updates.popleft())
        return values


def _fake_bpy() -> tuple[types.ModuleType, _Registry]:
    bpy = types.ModuleType("bpy")
    bpy.types = types.SimpleNamespace(
        Operator=type("Operator", (), {}),
        Panel=type("Panel", (), {}),
        PropertyGroup=type("PropertyGroup", (), {}),
        Scene=type("Scene", (), {}),
    )
    bpy.props = types.SimpleNamespace(
        StringProperty=lambda **_kwargs: None,
        IntProperty=lambda **_kwargs: None,
        PointerProperty=lambda **_kwargs: None,
    )
    registry = _Registry(bpy.types)
    bpy.utils = types.SimpleNamespace(
        register_class=registry.register_class,
        unregister_class=registry.unregister_class,
    )
    bpy.data = types.SimpleNamespace(filepath="", is_dirty=False)
    bpy.path = types.SimpleNamespace(abspath=lambda value: value)
    bpy.app = types.SimpleNamespace(version_string="test", timers=_Timers())
    bpy.context = types.SimpleNamespace(
        window_manager=types.SimpleNamespace(windows=[])
    )
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
        self.controller_module = importlib.import_module(
            "oh_my_blender.controller_connection"
        )
        self.ui_panel = importlib.import_module("oh_my_blender.ui_panel")

    def tearDown(self) -> None:
        self.controller_module._active_controller = None
        for name in tuple(sys.modules):
            if name == "bpy" or name == "oh_my_blender" or name.startswith("oh_my_blender."):
                sys.modules.pop(name, None)
        sys.modules.update(self.saved_modules)

    def _draw(self, active=None) -> _Layout:
        self.connection_module._active_connection = active
        panel = self.addon.OMB_PT_pi_status()
        panel.layout = _Layout()
        panel.draw(types.SimpleNamespace(
            scene=types.SimpleNamespace(
                omb_panel_chat=types.SimpleNamespace(prompt="")
            )
        ))
        return panel.layout

    def test_panel_is_discoverable_and_cleanly_unloads(self) -> None:
        panel = self.addon.OMB_PT_pi_status
        self.assertEqual(panel.bl_space_type, "VIEW_3D")
        self.assertEqual(panel.bl_region_type, "UI")
        self.assertEqual(panel.bl_category, "Oh My Blender")

        for _cycle in range(10):
            self.addon.register()
            self.assertIn(panel, self.registry.registered)
            self.assertIs(self.bpy.types.OMB_PT_pi_status, panel)
            self.assertTrue(hasattr(self.bpy.types.Scene, "omb_panel_chat"))
            self.assertTrue(
                self.bpy.app.timers.is_registered(self.addon._pump_lifecycle)
            )
            self.addon.unregister()
            self.assertNotIn(panel, self.registry.registered)
            self.assertFalse(hasattr(self.bpy.types, "OMB_PT_pi_status"))
            self.assertFalse(hasattr(self.bpy.types.Scene, "omb_panel_chat"))
            self.assertFalse(
                self.bpy.app.timers.is_registered(self.addon._pump_lifecycle)
            )

    def test_connect_reports_pi_bridge_instruction_when_no_endpoint_exists(self) -> None:
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
        ):
            result = operator.execute(context)

        self.assertEqual(result, {"CANCELLED"})
        self.assertIn("Pi bridge endpoint", reports[-1][1])

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

    def test_panel_surfaces_progress_evidence_and_chat_controls(self) -> None:
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
        self.assertIn("omb.send_prompt", layout.operators)
        self.assertIn("omb.reconnect_controller", layout.operators)
        self.assertIn("prompt", layout.props)
        self.assertIn("Task: QA render", layout.labels)
        self.assertIn("Descriptor: QA render revision aaaaaaaa, frames 80, 161", layout.labels)
        self.assertIn("Progress: Publishing (1/2)", layout.labels)
        self.assertIn("Outcome: Recovery required", layout.labels)
        self.assertIn("Evidence: Frame 80 sha256:bbbbbbbbbbbb", layout.labels)

    def test_send_operator_uses_persisted_revision_and_clears_prompt(self) -> None:
        controller = _FakeController(self.controller_module.ControllerState.ACTIVE)
        self.controller_module._active_controller = controller
        properties = types.SimpleNamespace(prompt="  Build a hero shot  ")
        operator = self.addon.OMB_OT_send_prompt()
        operator.report = mock.Mock()
        with mock.patch.object(
            self.addon.project_store,
            "read_project_index",
            return_value={"current_revision_id": "a" * 64},
        ):
            result = operator.execute(types.SimpleNamespace(
                scene=types.SimpleNamespace(omb_panel_chat=properties)
            ))

        self.assertEqual(result, {"FINISHED"})
        self.assertEqual(properties.prompt, "")
        self.assertEqual(controller.sent[-1]["type"], "director_turn")
        self.assertEqual(controller.sent[-1]["prompt"], "Build a hero shot")
        self.assertEqual(controller.sent[-1]["expected_revision_id"], "a" * 64)
        self.assertEqual(controller.sent[-1]["deadline_ms"], 300_000)

    def test_timer_drains_at_most_32_updates_and_tags_redraw(self) -> None:
        events = [{
            "type": "director_transcript",
            "schema_version": 2,
            "id": "33333333-3333-4333-8333-333333333333",
            "session_id": "44444444-4444-4444-8444-444444444444",
            "events": [],
            "next_cursor": None,
            "snapshot_cursor": 0,
        }]
        events.extend({
            "type": "director_turn_started",
            "id": f"{index:08x}-0000-4000-8000-000000000000",
            "sequence": 0,
            "at": "2026-07-20T00:00:00.000Z",
            "prompt": "Build",
        } for index in range(39))
        controller = _FakeController(
            self.controller_module.ControllerState.ACTIVE,
            events,
        )
        self.controller_module._active_controller = controller
        redraw = mock.Mock()
        self.bpy.context.window_manager.windows = [
            types.SimpleNamespace(
                screen=types.SimpleNamespace(
                    areas=[types.SimpleNamespace(tag_redraw=redraw)]
                )
            )
        ]

        interval = self.ui_panel.pump_controller_panel(bpy_module=self.bpy)

        self.assertEqual(interval, 0.016)
        self.assertEqual(controller.pending_update_count, 8)
        self.assertEqual(controller.sent[0]["type"], "director_transcript_request")
        redraw.assert_called_once()
        p95, maximum = self.ui_panel.panel_timer_metrics()
        self.assertLessEqual(p95, 4.0)
        self.assertLessEqual(maximum, 8.0)

    def test_transcript_response_must_match_sent_request_and_session(self) -> None:
        controller = _FakeController(self.controller_module.ControllerState.ACTIVE)
        self.controller_module._active_controller = controller

        self.ui_panel.pump_controller_panel(bpy_module=self.bpy)
        request = controller.sent[-1]
        controller.updates.append({
            "type": "director_transcript",
            "schema_version": 2,
            "id": request["id"],
            "session_id": controller.session_id,
            "events": [],
            "next_cursor": None,
            "snapshot_cursor": 0,
        })
        self.ui_panel.pump_controller_panel(bpy_module=self.bpy)

        self.assertFalse(self.ui_panel.panel_snapshot().replaying)

if __name__ == "__main__":
    unittest.main()
