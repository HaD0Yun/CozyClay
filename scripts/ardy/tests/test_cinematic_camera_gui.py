from pathlib import Path
from types import SimpleNamespace

import numpy as np

from scripts.interactive_demo.cinematic_camera import OutputFormatPreset
from scripts.interactive_demo.cinematic_state import CinematicSessionState
from scripts.interactive_demo.gui.visualize import GuiVisualizeMixin


class FakeHandle:
    def __init__(self, label: str = "", *, value=None, visible: bool = True, disabled: bool = False) -> None:
        self.label = label
        self.value = value
        self.content = value if isinstance(value, str) else ""
        self.visible = visible
        self.disabled = disabled
        self.uuid = f"handle-{id(self)}"
        self._updates = []
        self._clicks = []

    def on_update(self, callback):
        self._updates.append(callback)
        return callback

    def on_click(self, callback):
        self._clicks.append(callback)
        return callback

    def update(self) -> None:
        for callback in self._updates:
            callback(SimpleNamespace())

    def click(self) -> None:
        for callback in self._clicks:
            callback(SimpleNamespace())

    def __enter__(self):
        return self

    def __exit__(self, *_args) -> None:
        return None


class FakeTabGroup:
    def add_tab(self, label, _icon):
        return FakeHandle(label)


class FakeGui:
    def __init__(self) -> None:
        self.created: list[FakeHandle] = []

    def add_tab_group(self):
        return FakeTabGroup()

    def add_folder(self, label, **kwargs):
        handle = FakeHandle(label, visible=kwargs.get("visible", True))
        handle.expand_by_default = kwargs.get("expand_by_default", True)
        self.created.append(handle)
        return handle

    def __getattr__(self, name):
        if not name.startswith("add_"):
            raise AttributeError(name)

        def add(*args, **kwargs):
            label = kwargs.get("label", args[0] if args else "")
            value = kwargs.get("initial_value", kwargs.get("value", args[0] if args else None))
            if name == "add_markdown":
                value = label
            handle = FakeHandle(
                label,
                value=value,
                visible=kwargs.get("visible", True),
                disabled=kwargs.get("disabled", False),
            )
            handle.min = kwargs.get("min")
            handle.max = kwargs.get("max")
            self.created.append(handle)
            return handle

        return add


class FakeClient:
    def __init__(self) -> None:
        self.gui = FakeGui()
        self.camera = SimpleNamespace(
            position=np.array((1.0, 2.0, 4.0)),
            look_at=np.array((0.0, 1.0, 0.0)),
            up_direction=np.array((0.0, 1.0, 0.0)),
            fov=0.75,
        )
        self.notifications = []

    def add_notification(self, **kwargs) -> None:
        self.notifications.append(kwargs)


class FakeFrameMask:
    def __init__(self) -> None:
        self.output_formats = []
        self.enabled_values = []

    def set_output_format(self, width: int, height: int) -> None:
        self.output_formats.append((width, height))

    def set_enabled(self, enabled: bool) -> None:
        self.enabled_values.append(enabled)


class FakeDemo(GuiVisualizeMixin):
    def __init__(self) -> None:
        self.client = FakeClient()
        self.g = SimpleNamespace(gui_frame_idx_input=FakeHandle("Frame", value=12))
        self.client_sessions = {
            7: SimpleNamespace(
                client=self.client,
                cinematic=CinematicSessionState(),
                cinematic_frame_mask=FakeFrameMask(),
                frame_idx=12,
                max_frame_idx=319,
                gui_elements=self.g,
                characters_lock=SimpleNamespace(__enter__=lambda _self: None, __exit__=lambda *_args: None),
                characters={},
            )
        }
        self.frames = []
        self.preview_calls = []
        self.render_calls = []
        self.cancel_calls = []
        self._build_visualize_tab(self.client, 7, FakeTabGroup(), self.g, None, "prompt")

    def client_active(self, client_id: int) -> bool:
        return client_id == 7

    def set_frame(self, client_id: int, frame: int) -> None:
        self.frames.append((client_id, frame))

    def preview_cinematic_output(self, client_id: int) -> None:
        self.preview_calls.append(client_id)

    def start_cinematic_render(self, client_id: int) -> None:
        self.render_calls.append(client_id)

    def cancel_cinematic_render(self, client_id: int) -> None:
        self.cancel_calls.append(client_id)


def test_cinematic_folder_constructs_compact_initial_state() -> None:
    # Given / When
    demo = FakeDemo()

    # Then
    folder = next(handle for handle in demo.client.gui.created if handle.label == "Cinematic Camera")
    assert folder.expand_by_default is False
    assert demo.g.gui_cinematic_format.value == "16:9 HD"
    assert demo.g.gui_cinematic_lens.value == "Custom"
    assert demo.g.gui_cinematic_custom_fov.value == 50.0
    assert demo.g.gui_cinematic_custom_fov.visible is True
    assert np.degrees(demo.client.camera.fov) == 50.0
    assert demo.g.gui_cinematic_width.visible is False
    assert demo.g.gui_cinematic_cancel.visible is False
    assert demo.g.gui_cinematic_cancel.disabled is True
    assert demo.g.gui_cinematic_progress.visible is False
    assert demo.g.gui_cinematic_preview_image.visible is False
    assert demo.g.gui_cinematic_remove_key.disabled is True
    assert demo.g.gui_cinematic_render.disabled is True
    assert demo.g.gui_cinematic_transition.disabled is True


def test_manual_fov_change_marks_lens_custom_without_losing_value() -> None:
    # Given
    demo = FakeDemo()
    demo.g.gui_cinematic_lens.value = "24mm"
    demo.g.gui_cinematic_lens.update()

    # When
    demo.g.gui_viz_camera_fov_slider.value = 42.0
    demo.g.gui_viz_camera_fov_slider.update()

    # Then
    assert demo.g.gui_cinematic_lens.value == "Custom"
    assert demo.g.gui_cinematic_custom_fov.value == 42.0
    assert demo.g.gui_cinematic_custom_fov.visible is True
    assert np.degrees(demo.client.camera.fov) == 42.0


def test_85mm_fov_is_inside_manual_slider_range() -> None:
    # Given
    demo = FakeDemo()

    # When
    demo.g.gui_cinematic_lens.value = "85mm"
    demo.g.gui_cinematic_lens.update()

    # Then
    degrees = float(np.degrees(demo.client.camera.fov))
    assert demo.g.gui_viz_camera_fov_slider.min <= degrees
    assert demo.g.gui_viz_camera_fov_slider.value == degrees


def test_format_and_lens_presets_update_plan_and_camera() -> None:
    # Given
    demo = FakeDemo()

    # When
    demo.g.gui_cinematic_format.value = "2.39:1 Scope"
    demo.g.gui_cinematic_format.update()
    demo.g.gui_cinematic_lens.value = "85mm"
    demo.g.gui_cinematic_lens.update()

    # Then
    output = demo.client_sessions[7].cinematic.shot_plan.output_format
    expected = OutputFormatPreset.SCOPE_2_39
    assert (output.width, output.height) == (1920, 804)
    assert expected.value == "scope_2_39"
    assert demo.client.camera.fov < 0.5


def test_same_frame_add_replaces_existing_key() -> None:
    # Given
    demo = FakeDemo()
    demo.g.gui_cinematic_add_key.click()
    demo.client.camera.position = np.array((9.0, 2.0, 4.0))

    # When
    demo.g.gui_cinematic_add_key.click()

    # Then
    keys = demo.client_sessions[7].cinematic.shot_plan.keyframes
    assert len(keys) == 1
    assert keys[0].frame == 12
    assert keys[0].pose.position == (9.0, 2.0, 4.0)
    assert demo.client.notifications[-1]["title"] == "Camera key replaced"


def test_key_actions_follow_current_frame_and_nonempty_plan() -> None:
    # Given
    demo = FakeDemo()

    # When
    demo.g.gui_cinematic_add_key.click()

    # Then
    assert demo.g.gui_cinematic_remove_key.disabled is False
    assert demo.g.gui_cinematic_render.disabled is False
    assert demo.g.gui_cinematic_transition.disabled is False

    # When
    demo.client_sessions[7].frame_idx = 13
    demo.g.gui_frame_idx_input.value = 13
    demo.g.gui_frame_idx_input.update()

    # Then
    assert demo.g.gui_cinematic_remove_key.disabled is True
    assert demo.g.gui_cinematic_render.disabled is False


def test_removing_last_key_disables_transition_again() -> None:
    # Given
    demo = FakeDemo()
    demo.g.gui_cinematic_add_key.click()

    # When
    demo.g.gui_cinematic_remove_key.click()

    # Then
    assert demo.g.gui_cinematic_transition.disabled is True


def test_missing_remove_and_invalid_custom_dimensions_notify() -> None:
    # Given
    demo = FakeDemo()

    # When
    demo.g.gui_cinematic_remove_key.click()
    demo.g.gui_cinematic_format.value = "Custom"
    demo.g.gui_cinematic_format.update()
    demo.g.gui_cinematic_width.value = 1919
    demo.g.gui_cinematic_width.update()

    # Then
    titles = [notification["title"] for notification in demo.client.notifications]
    assert "No camera key" in titles
    assert "Invalid output size" in titles


def test_key_summary_is_sorted_by_frame() -> None:
    # Given
    demo = FakeDemo()
    demo.client_sessions[7].frame_idx = 20
    demo.g.gui_cinematic_add_key.click()
    demo.client_sessions[7].frame_idx = 5

    # When
    demo.g.gui_cinematic_add_key.click()

    # Then
    summary = demo.g.gui_cinematic_key_summary.content
    assert summary.index("0005") < summary.index("0020")


def test_json_errors_notify_and_valid_round_trip_updates_controls(tmp_path: Path) -> None:
    # Given
    demo = FakeDemo()
    demo.cinematic_plan_roots = (tmp_path,)
    missing = tmp_path / "missing.json"
    demo.g.gui_cinematic_json_path.value = str(missing)

    # When
    demo.g.gui_cinematic_load.click()
    demo.g.gui_cinematic_add_key.click()
    saved = tmp_path / "shot.json"
    demo.g.gui_cinematic_json_path.value = str(saved)
    demo.g.gui_cinematic_save.click()
    demo.g.gui_cinematic_format.value = "1:1 Square"
    demo.g.gui_cinematic_format.update()
    demo.g.gui_cinematic_load.click()

    # Then
    assert saved.exists()
    assert demo.g.gui_cinematic_format.value == "16:9 HD"
    assert demo.client.notifications[0]["title"] == "Load failed"
    assert demo.g.gui_cinematic_transition.disabled is False


def test_corrupt_json_notifies_without_replacing_current_plan(tmp_path: Path) -> None:
    # Given
    demo = FakeDemo()
    demo.cinematic_plan_roots = (tmp_path,)
    demo.g.gui_cinematic_add_key.click()
    original = demo.client_sessions[7].cinematic.shot_plan
    corrupt = tmp_path / "corrupt.json"
    corrupt.write_text('{"version": 99}', encoding="utf-8")
    demo.g.gui_cinematic_json_path.value = str(corrupt)

    # When
    demo.g.gui_cinematic_load.click()

    # Then
    assert demo.client_sessions[7].cinematic.shot_plan == original
    assert demo.client.notifications[-1]["title"] == "Load failed"


def test_preview_render_cancel_and_path_preview_callbacks_are_wired() -> None:
    # Given
    demo = FakeDemo()

    # When
    demo.g.gui_cinematic_preview_path.value = True
    demo.g.gui_cinematic_preview_path.update()
    demo.g.gui_cinematic_preview_output.click()
    demo.g.gui_cinematic_render.click()
    demo.g.gui_cinematic_cancel.click()

    # Then
    assert demo.g.gui_viz_auto_camera_checkbox.value is False
    assert demo.frames == [(7, 12)]
    assert demo.preview_calls == [7]
    assert demo.render_calls == [7]
    assert demo.cancel_calls == [7]
