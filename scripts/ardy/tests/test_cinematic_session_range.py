from types import SimpleNamespace

from scripts.interactive_demo.session_io import sync_cinematic_frame_range


class NumberHandle:
    """Mutable stand-in for a Viser numeric input."""

    def __init__(self, value: int, maximum: int) -> None:
        self.value = value
        self.min = 0
        self.max = maximum


def test_sync_cinematic_frame_range_resets_controls_to_loaded_motion() -> None:
    # Given
    gui = SimpleNamespace(
        gui_cinematic_start_frame=NumberHandle(value=99, maximum=5000),
        gui_cinematic_end_frame=NumberHandle(value=5000, maximum=5000),
    )

    # When
    sync_cinematic_frame_range(gui, max_frame_idx=319)

    # Then
    assert (gui.gui_cinematic_start_frame.min, gui.gui_cinematic_start_frame.max) == (0, 319)
    assert gui.gui_cinematic_start_frame.value == 0
    assert (gui.gui_cinematic_end_frame.min, gui.gui_cinematic_end_frame.max) == (0, 319)
    assert gui.gui_cinematic_end_frame.value == 319


def test_sync_cinematic_frame_range_accepts_gui_without_cinematic_controls() -> None:
    # Given
    gui = SimpleNamespace()

    # When / Then
    sync_cinematic_frame_range(gui, max_frame_idx=7)
