from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from test_cinematic_render import FakeCamera, RenderHarness, ValueHandle, _join_worker


class CallbackValueHandle(ValueHandle):
    def __init__(self, value: bool, scene_handle: SimpleNamespace) -> None:
        self.scene_handle = scene_handle
        self._value = value
        super().__init__(value)

    @property
    def value(self) -> bool:
        return self._value

    @value.setter
    def value(self, value: bool) -> None:
        self._value = value
        self.scene_handle.visible = value


@pytest.mark.parametrize("exit_mode", ["success", "cancel", "error"])
def test_render_restores_callback_driven_gui_and_scene_visibility_exactly(
    tmp_path: Path, exit_mode: str
) -> None:
    # Given
    camera = FakeCamera(fail_at_call=1 if exit_mode == "error" else None)
    demo = RenderHarness(tmp_path / f"callbacks-{exit_mode}.mp4", camera=camera)
    handles = [SimpleNamespace(visible=True) for _ in range(5)]
    names = (
        "gui_viz_skeleton_checkbox",
        "gui_viz_foot_contacts_checkbox",
        "gui_viz_hand_orientations_checkbox",
        "gui_show_start_direction_checkbox",
        "gui_show_timeline_checkbox",
    )
    for name, handle in zip(names, handles, strict=True):
        setattr(demo.gui, name, CallbackValueHandle(True, handle))
    demo.session.constraints = {
        "Full-Body": SimpleNamespace(
            scene_elements={index: {"label": handle} for index, handle in enumerate(handles)},
            interval_labels={},
        )
    }
    if exit_mode == "cancel":
        camera.cancel = demo.session.cinematic.render_cancel

    # When
    demo.start_cinematic_render(7)
    _join_worker(demo)

    # Then
    assert tuple(getattr(demo.gui, name).value for name in names) == (True,) * 5
    assert tuple(handle.visible for handle in handles) == (True,) * 5
