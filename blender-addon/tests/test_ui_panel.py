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


def _fake_windows() -> tuple[list[types.SimpleNamespace], dict[str, mock.Mock]]:
    """A realistic Blender layout: a viewport sidebar plus editors that must not redraw."""
    redraws = {
        "sidebar": mock.Mock(),
        "viewport_area": mock.Mock(),
        "viewport_window_region": mock.Mock(),
        "outliner_area": mock.Mock(),
        "outliner_sidebar": mock.Mock(),
    }
    viewport = types.SimpleNamespace(
        type="VIEW_3D",
        tag_redraw=redraws["viewport_area"],
        regions=[
            types.SimpleNamespace(
                type="WINDOW", tag_redraw=redraws["viewport_window_region"]
            ),
            types.SimpleNamespace(type="UI", tag_redraw=redraws["sidebar"]),
        ],
    )
    outliner = types.SimpleNamespace(
        type="OUTLINER",
        tag_redraw=redraws["outliner_area"],
        regions=[
            types.SimpleNamespace(type="UI", tag_redraw=redraws["outliner_sidebar"])
        ],
    )
    windows = [
        types.SimpleNamespace(
            screen=types.SimpleNamespace(areas=[viewport, outliner])
        )
    ]
    return windows, redraws


class _StepClock:
    """A manually advanced clock so redraw pacing is asserted, not slept through."""

    def __init__(self, start: float = 1000.0) -> None:
        self.value = start

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


class UiPanelTests(unittest.TestCase):
    def setUp(self) -> None:
        self.saved_modules = {
            name: module
            for name, module in sys.modules.items()
            if name == "bpy" or name == "cclay" or name.startswith("cclay.")
        }
        for name in tuple(self.saved_modules):
            sys.modules.pop(name, None)
        self.bpy, self.registry = _fake_bpy()
        sys.modules["bpy"] = self.bpy
        self.addon = importlib.import_module("cclay")
        self.connection_module = importlib.import_module("cclay.connection")
        self.controller_module = importlib.import_module(
            "cclay.controller_connection"
        )
        self.ui_panel = importlib.import_module("cclay.ui_panel")

    def tearDown(self) -> None:
        self.controller_module._active_controller = None
        for name in tuple(sys.modules):
            if name == "bpy" or name == "cclay" or name.startswith("cclay."):
                sys.modules.pop(name, None)
        sys.modules.update(self.saved_modules)

    def _draw(self, active=None) -> _Layout:
        self.connection_module._active_connection = active
        panel = self.addon.CCLAY_PT_pi_status()
        panel.layout = _Layout()
        panel.draw(types.SimpleNamespace(
            scene=types.SimpleNamespace(
                cclay_panel_chat=types.SimpleNamespace(prompt="")
            )
        ))
        return panel.layout

    def test_panel_is_discoverable_and_cleanly_unloads(self) -> None:
        panel = self.addon.CCLAY_PT_pi_status
        self.assertEqual(panel.bl_space_type, "VIEW_3D")
        self.assertEqual(panel.bl_region_type, "UI")
        self.assertEqual(panel.bl_category, "CozyClay")

        for _cycle in range(10):
            self.addon.register()
            self.assertIn(panel, self.registry.registered)
            self.assertIs(self.bpy.types.CCLAY_PT_pi_status, panel)
            self.assertTrue(hasattr(self.bpy.types.Scene, "cclay_panel_chat"))
            self.assertTrue(
                self.bpy.app.timers.is_registered(self.addon._pump_lifecycle)
            )
            self.addon.unregister()
            self.assertNotIn(panel, self.registry.registered)
            self.assertFalse(hasattr(self.bpy.types, "CCLAY_PT_pi_status"))
            self.assertFalse(hasattr(self.bpy.types.Scene, "cclay_panel_chat"))
            self.assertFalse(
                self.bpy.app.timers.is_registered(self.addon._pump_lifecycle)
            )

    def test_connect_starts_the_blender_owned_bridge(self) -> None:
        operator = self.addon.CCLAY_OT_connect()
        reports = []
        operator.report = lambda levels, message: reports.append((levels, message))
        context = types.SimpleNamespace(
            scene={"cclay.project_id": "33333333-3333-4333-8333-333333333333"}
        )
        with (
            mock.patch.dict(os.environ, {}, clear=True),
            mock.patch.object(
                self.addon.project_store, "verify_connect_precondition"
            ),
            mock.patch.object(
                self.connection_module, "start_blender_server"
            ) as start_server,
        ):
            result = operator.execute(context)

        self.assertEqual(result, {"FINISHED"})
        start_server.assert_called_once()

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
                    bridge_requests_allowed=state is self.connection_module.LifecycleState.ACTIVE,
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
                    self.assertIn(
                        "Tools: Available, but bridge calls fail until reconnect verification succeeds",
                        labels,
                    )

    def test_panel_never_renders_environment_secret_or_bearer_identity(self) -> None:
        secret = "sk-secret-ui-must-never-render"
        active = types.SimpleNamespace(
            state=self.connection_module.LifecycleState.ACTIVE,
            bridge_requests_allowed=True,
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
            bridge_requests_allowed=False,
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
        self.assertIn("cclay.send_prompt", layout.operators)
        self.assertIn("cclay.reconnect_controller", layout.operators)
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
        operator = self.addon.CCLAY_OT_send_prompt()
        operator.report = mock.Mock()
        windows, redraws = _fake_windows()
        self.bpy.context.window_manager.windows = windows
        with mock.patch.object(
            self.addon.project_store,
            "read_project_index",
            return_value={"current_revision_id": "a" * 64},
        ):
            result = operator.execute(types.SimpleNamespace(
                scene=types.SimpleNamespace(cclay_panel_chat=properties)
            ))

        self.assertEqual(result, {"FINISHED"})
        self.assertEqual(properties.prompt, "")
        self.assertEqual(controller.sent[-1]["type"], "director_turn")
        self.assertEqual(controller.sent[-1]["prompt"], "Build a hero shot")
        self.assertEqual(controller.sent[-1]["expected_revision_id"], "a" * 64)
        self.assertEqual(controller.sent[-1]["deadline_ms"], 300_000)
        redraws["sidebar"].assert_called_once()
        self.assertEqual(redraws["viewport_area"].call_count, 0)

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
        windows, redraws = _fake_windows()
        self.bpy.context.window_manager.windows = windows

        interval = self.ui_panel.pump_controller_panel(bpy_module=self.bpy)

        self.assertEqual(interval, 0.016)
        self.assertEqual(controller.pending_update_count, 8)
        self.assertEqual(controller.sent[0]["type"], "director_transcript_request")
        redraws["sidebar"].assert_called_once()
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

    def _streaming_controller(self, count: int) -> object:
        controller = _FakeController(
            self.controller_module.ControllerState.ACTIVE,
            [{
                "type": "director_transcript",
                "schema_version": 2,
                "id": "33333333-3333-4333-8333-333333333333",
                "session_id": "44444444-4444-4444-8444-444444444444",
                "events": [],
                "next_cursor": None,
                "snapshot_cursor": 0,
            }],
        )
        controller.updates.extend({
            "type": "director_turn_started",
            "id": f"{index:08x}-0000-4000-8000-000000000000",
            "sequence": 0,
            "at": "2026-07-20T00:00:00.000Z",
            "prompt": "Build",
        } for index in range(count))
        self.controller_module._active_controller = controller
        return controller

    def _turn_started(self, prefix: str) -> dict[str, object]:
        return {
            "type": "director_turn_started",
            "id": f"{prefix}-0000-4000-8000-000000000000",
            "sequence": 0,
            "at": "2026-07-20T00:00:01.000Z",
            "prompt": "Build",
        }

    def test_redraw_never_tags_the_viewport_or_unrelated_editors(self) -> None:
        windows, redraws = _fake_windows()
        self.bpy.context.window_manager.windows = windows

        self.ui_panel._tag_redraw(self.bpy)

        redraws["sidebar"].assert_called_once()
        for name in (
            "viewport_area",
            "viewport_window_region",
            "outliner_area",
            "outliner_sidebar",
        ):
            self.assertEqual(redraws[name].call_count, 0, name)

    def test_streaming_deltas_cannot_redraw_faster_than_the_pace_limit(self) -> None:
        self._streaming_controller(200)
        windows, redraws = _fake_windows()
        self.bpy.context.window_manager.windows = windows
        clock = _StepClock()

        for _pump in range(60):
            self.ui_panel.pump_controller_panel(bpy_module=self.bpy, redraw_clock=clock)
            clock.advance(self.ui_panel._PANEL_ACTIVE_INTERVAL)

        # 60 pumps at 62.5 Hz span ~0.96s, which allows at most 10 paced redraws.
        elapsed = 60 * self.ui_panel._PANEL_ACTIVE_INTERVAL
        allowed = int(elapsed / self.ui_panel._PANEL_REDRAW_MIN_INTERVAL) + 1
        self.assertLessEqual(redraws["sidebar"].call_count, allowed)
        self.assertGreater(redraws["sidebar"].call_count, 0)

    def test_coalesced_redraw_is_flushed_without_further_controller_traffic(self) -> None:
        controller = self._streaming_controller(1)
        windows, redraws = _fake_windows()
        self.bpy.context.window_manager.windows = windows
        clock = _StepClock()

        self.ui_panel.pump_controller_panel(bpy_module=self.bpy, redraw_clock=clock)
        self.assertEqual(redraws["sidebar"].call_count, 1)

        clock.advance(0.01)
        controller.updates.append(self._turn_started("aaaaaaaa"))
        self.ui_panel.pump_controller_panel(bpy_module=self.bpy, redraw_clock=clock)
        self.assertEqual(redraws["sidebar"].call_count, 1)
        self.assertTrue(self.ui_panel._redraw_pending)

        self.assertEqual(controller.pending_update_count, 0)
        clock.advance(self.ui_panel._PANEL_REDRAW_MIN_INTERVAL)
        self.ui_panel.pump_controller_panel(bpy_module=self.bpy, redraw_clock=clock)

        self.assertEqual(redraws["sidebar"].call_count, 2)
        self.assertFalse(self.ui_panel._redraw_pending)

    def test_a_pending_redraw_is_flushed_by_the_first_pump_past_the_window(self) -> None:
        controller = self._streaming_controller(1)
        windows, redraws = _fake_windows()
        self.bpy.context.window_manager.windows = windows
        clock = _StepClock()

        self.ui_panel.pump_controller_panel(bpy_module=self.bpy, redraw_clock=clock)
        clock.advance(0.01)
        controller.updates.append(self._turn_started("dddddddd"))
        self.ui_panel.pump_controller_panel(bpy_module=self.bpy, redraw_clock=clock)
        self.assertTrue(self.ui_panel._redraw_pending)

        # Pumps inside the window keep it pending; the first pump after the
        # window expires emits it.
        while clock.value < 1000.0 + self.ui_panel._PANEL_REDRAW_MIN_INTERVAL:
            self.assertEqual(redraws["sidebar"].call_count, 1)
            clock.advance(self.ui_panel._PANEL_ACTIVE_INTERVAL)
            self.ui_panel.pump_controller_panel(
                bpy_module=self.bpy, redraw_clock=clock
            )

        self.assertEqual(redraws["sidebar"].call_count, 2)
        self.assertFalse(self.ui_panel._redraw_pending)

    def test_a_backward_pacing_clock_is_rejected_rather_than_mishandled(self) -> None:
        windows, redraws = _fake_windows()
        self.bpy.context.window_manager.windows = windows
        clock = _StepClock()

        self.ui_panel._force_redraw(self.bpy, clock=clock)
        self.assertEqual(redraws["sidebar"].call_count, 1)

        # A clock that regresses can neither bound a rate nor be waited out, so
        # absorbing it would either wedge the pending redraw or waive pacing.
        clock.value -= 1_000_000.0
        for _attempt in range(5):
            with self.assertRaises(self.ui_panel.PanelStateError):
                self.ui_panel._request_redraw(clock=clock, bpy_module=self.bpy)

        self.assertEqual(redraws["sidebar"].call_count, 1)

    def test_a_non_finite_pacing_clock_is_rejected(self) -> None:
        windows, redraws = _fake_windows()
        self.bpy.context.window_manager.windows = windows

        for value in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(value=value):
                with self.assertRaises(self.ui_panel.PanelStateError):
                    self.ui_panel._request_redraw(
                        clock=lambda: value, bpy_module=self.bpy
                    )

        self.assertEqual(redraws["sidebar"].call_count, 0)

    def test_the_drain_budget_clock_cannot_influence_redraw_pacing(self) -> None:
        controller = self._streaming_controller(400)
        windows, redraws = _fake_windows()
        self.bpy.context.window_manager.windows = windows
        pacing = _StepClock()
        budget = _StepClock(start=5_000.0)

        for _pump in range(40):
            self.ui_panel.pump_controller_panel(
                bpy_module=self.bpy, clock=budget, redraw_clock=pacing
            )
            # The budget clock jumps wildly; pacing must ignore it entirely.
            budget.value += 999.0
            pacing.advance(self.ui_panel._PANEL_ACTIVE_INTERVAL)

        elapsed = 40 * self.ui_panel._PANEL_ACTIVE_INTERVAL
        allowed = int(elapsed / self.ui_panel._PANEL_REDRAW_MIN_INTERVAL) + 1
        self.assertLessEqual(redraws["sidebar"].call_count, allowed)
        self.assertGreater(redraws["sidebar"].call_count, 0)

    def test_pending_redraw_is_flushed_after_the_controller_disappears(self) -> None:
        controller = self._streaming_controller(1)
        windows, redraws = _fake_windows()
        self.bpy.context.window_manager.windows = windows
        clock = _StepClock()

        self.ui_panel.pump_controller_panel(bpy_module=self.bpy, redraw_clock=clock)
        clock.advance(0.01)
        controller.updates.append(self._turn_started("bbbbbbbb"))
        self.ui_panel.pump_controller_panel(bpy_module=self.bpy, redraw_clock=clock)
        self.assertTrue(self.ui_panel._redraw_pending)
        self.assertEqual(redraws["sidebar"].call_count, 1)

        self.controller_module._active_controller = None
        clock.advance(self.ui_panel._PANEL_REDRAW_MIN_INTERVAL)
        self.ui_panel.pump_controller_panel(bpy_module=self.bpy, redraw_clock=clock)

        self.assertEqual(redraws["sidebar"].call_count, 2)
        self.assertFalse(self.ui_panel._redraw_pending)

    def test_pending_redraw_is_flushed_after_the_controller_goes_lost(self) -> None:
        controller = self._streaming_controller(1)
        windows, redraws = _fake_windows()
        self.bpy.context.window_manager.windows = windows
        clock = _StepClock()

        self.ui_panel.pump_controller_panel(bpy_module=self.bpy, redraw_clock=clock)
        clock.advance(0.01)
        controller.updates.append(self._turn_started("cccccccc"))
        self.ui_panel.pump_controller_panel(bpy_module=self.bpy, redraw_clock=clock)
        self.assertTrue(self.ui_panel._redraw_pending)

        controller.state = self.controller_module.ControllerState.LOST
        clock.advance(self.ui_panel._PANEL_REDRAW_MIN_INTERVAL)
        self.ui_panel.pump_controller_panel(bpy_module=self.bpy, redraw_clock=clock)

        self.assertEqual(redraws["sidebar"].call_count, 2)
        self.assertFalse(self.ui_panel._redraw_pending)

    def test_direct_user_actions_redraw_immediately(self) -> None:
        windows, redraws = _fake_windows()
        self.bpy.context.window_manager.windows = windows
        clock = _StepClock()

        self.ui_panel._force_redraw(self.bpy, clock=clock)
        self.ui_panel._force_redraw(self.bpy, clock=clock)

        self.assertEqual(redraws["sidebar"].call_count, 2)
        self.assertFalse(self.ui_panel._redraw_pending)

    def _snapshot_with(self, entries, active_text: str = ""):
        panel_state = importlib.import_module("cclay.panel_state")
        return panel_state.PanelSnapshot(
            entries=tuple(
                panel_state.PanelEntry(
                    turn_id="66666666-6666-4666-8666-666666666666",
                    sequence=index,
                    kind=kind,
                    text=text,
                    at="2026-07-20T00:00:00.000Z",
                )
                for index, (kind, text) in enumerate(entries)
            ),
            active_turn_id=None,
            active_text=active_text,
            status="Connected",
            error=None,
            can_submit=True,
            can_cancel=False,
            replaying=False,
            displayed_qa_digest=None,
        )

    def test_panel_body_is_bounded_and_keeps_the_newest_lines(self) -> None:
        snapshot = self._snapshot_with(
            [("assistant", f"message {index}") for index in range(400)]
        )

        body, truncated = self.ui_panel._panel_body_lines(snapshot)

        self.assertTrue(truncated)
        self.assertEqual(len(body), self.ui_panel._MAX_PANEL_BODY_LINES)
        self.assertEqual(body[-1], "Pi: message 399")
        self.assertNotIn("Pi: message 0", body)

    def test_truncation_flag_is_exact_at_the_line_budget(self) -> None:
        limit = self.ui_panel._MAX_PANEL_BODY_LINES
        for count, expected_truncated in (
            (0, False),
            (limit - 1, False),
            (limit, False),
            (limit + 1, True),
        ):
            with self.subTest(count=count):
                snapshot = self._snapshot_with(
                    [("assistant", f"m{index}") for index in range(count)]
                )

                body, truncated = self.ui_panel._panel_body_lines(snapshot)

                self.assertEqual(truncated, expected_truncated)
                self.assertEqual(len(body), min(count, limit))
                if count:
                    self.assertEqual(body[-1], f"Pi: m{count - 1}")

    def test_body_lines_are_ordered_oldest_to_newest(self) -> None:
        snapshot = self._snapshot_with(
            [("user", "first"), ("assistant", "second")],
            active_text="third",
        )

        body, truncated = self.ui_panel._panel_body_lines(snapshot)

        self.assertFalse(truncated)
        self.assertEqual(body, ("You: first", "Pi: second", "Pi: third"))

    def test_panel_body_keeps_short_history_whole(self) -> None:
        snapshot = self._snapshot_with(
            [("user", "build stairs"), ("assistant", "done")]
        )

        body, truncated = self.ui_panel._panel_body_lines(snapshot)

        self.assertFalse(truncated)
        self.assertEqual(body, ("You: build stairs", "Pi: done"))

    def test_streaming_text_is_the_last_bounded_line(self) -> None:
        snapshot = self._snapshot_with(
            [("assistant", f"message {index}") for index in range(400)],
            active_text="streaming tail",
        )

        body, truncated = self.ui_panel._panel_body_lines(snapshot)

        self.assertTrue(truncated)
        self.assertEqual(len(body), self.ui_panel._MAX_PANEL_BODY_LINES)
        self.assertEqual(body[-1], "Pi: streaming tail")

    def test_a_single_huge_entry_cannot_exceed_the_line_budget(self) -> None:
        snapshot = self._snapshot_with([("tool", "x" * 16_384)])

        body, truncated = self.ui_panel._panel_body_lines(snapshot)

        self.assertTrue(truncated)
        self.assertEqual(len(body), self.ui_panel._MAX_PANEL_BODY_LINES)

    def test_history_the_panel_cannot_show_is_never_wrapped(self) -> None:
        snapshot = self._snapshot_with(
            [("assistant", "line\n" * 200) for _index in range(400)]
        )
        wrapped = mock.Mock(side_effect=self.ui_panel._wrapped_lines)

        with mock.patch.object(self.ui_panel, "_wrapped_lines", wrapped):
            body, truncated = self.ui_panel._panel_body_lines(snapshot)

        self.assertTrue(truncated)
        self.assertEqual(len(body), self.ui_panel._MAX_PANEL_BODY_LINES)
        self.assertEqual(wrapped.call_count, 1)

    def test_draw_bounds_widget_count_regardless_of_history(self) -> None:
        for index in range(400):
            self.ui_panel._panel_state.apply_update({
                "type": "director_turn_started",
                "id": f"{index:08x}-0000-4000-8000-000000000000",
                "sequence": 0,
                "at": "2026-07-20T00:00:00.000Z",
                "prompt": "x" * 2_000,
            })

        layout = self._draw()

        self.assertLessEqual(
            len(layout.labels),
            self.ui_panel._MAX_PANEL_BODY_LINES + 32,
        )
        self.assertIn(
            "Older messages hidden - full history is in the terminal",
            layout.labels,
        )

    def test_migration_status_label_reports_pending_and_complete_states(self) -> None:
        self.assertEqual(
            self.ui_panel._migration_status_label({}),
            "Migration: Pending foreign-object lock",
        )
        self.assertEqual(
            self.ui_panel._migration_status_label({"cclay.migration_version": 1}),
            "Migration: Foreign objects locked",
        )
if __name__ == "__main__":
    unittest.main()
