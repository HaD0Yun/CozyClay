from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from scripts.interactive_demo.cinematic_export import ProcessTimedOut
from scripts.interactive_demo.cinematic_render_support import CinematicImageError, normalize_render_image
from scripts.interactive_demo.cinematic_scene_state import hide_render_scene_helpers, restore_render_scene_helpers
from test_cinematic_render import FakeCamera, FakeRunner, RenderHarness, _join_worker


class RgbaCamera(FakeCamera):
    def get_render(self, *, height: int, width: int, transport_format: str) -> np.ndarray:
        self.calls.append((height, width, transport_format))
        return np.zeros((height, width, 4), dtype=np.uint8)


class FakeArrow:
    def __init__(self, line_visible: bool, cone_visible: bool) -> None:
        self.should_show = True
        self.arrow_line = SimpleNamespace(visible=line_visible)
        self.arrow_cone = SimpleNamespace(visible=cone_visible)

    def set_visibility(self, visible: bool) -> None:
        self.arrow_line.visible = visible and self.should_show
        self.arrow_cone.visible = visible and self.should_show


class ArrowObservingCamera(FakeCamera):
    def __init__(self, arrows: tuple[FakeArrow, FakeArrow], fail_at_call: int | None = None) -> None:
        super().__init__(fail_at_call=fail_at_call)
        self.arrows = arrows
        self.visibility_during_capture: tuple[bool, ...] | None = None

    def get_render(self, *, height: int, width: int, transport_format: str) -> np.ndarray:
        self.visibility_during_capture = tuple(
            component.visible
            for arrow in self.arrows
            for component in (arrow.arrow_line, arrow.arrow_cone)
        )
        return super().get_render(height=height, width=width, transport_format=transport_format)


def _install_arrows(demo: RenderHarness, start: FakeArrow, target: FakeArrow) -> None:
    demo.session.start_direction_marker = start
    demo.session.target_velocity_arrow = target


def _assert_arrow_visibility(start: FakeArrow, target: FakeArrow) -> None:
    assert (start.arrow_line.visible, start.arrow_cone.visible) == (True, False)
    assert (target.arrow_line.visible, target.arrow_cone.visible) == (False, True)


def test_normalize_render_image_preserves_rgb_and_composites_rgba_over_white() -> None:
    # Given
    rgb = np.array([[[10, 20, 30]]], dtype=np.uint8)
    rgba = np.array([[[0, 0, 0, 0], [255, 0, 0, 128], [4, 5, 6, 255]]], dtype=np.uint8)

    # When
    normalized_rgb = normalize_render_image(rgb)
    normalized_rgba = normalize_render_image(rgba)

    # Then
    np.testing.assert_array_equal(normalized_rgb, rgb)
    np.testing.assert_array_equal(
        normalized_rgba,
        np.array([[[255, 255, 255], [255, 127, 127], [4, 5, 6]]], dtype=np.uint8),
    )
    assert normalized_rgba.shape == (1, 3, 3)


def test_normalize_render_image_rejects_non_rgb_or_rgba_arrays() -> None:
    # Given
    grayscale = np.zeros((2, 2), dtype=np.uint8)

    # When / Then
    with pytest.raises(CinematicImageError, match="RGB or RGBA"):
        normalize_render_image(grayscale)


def test_normalize_render_image_uses_dark_viewport_background() -> None:
    # Given
    transparent = np.zeros((1, 1, 4), dtype=np.uint8)

    # When
    normalized = normalize_render_image(transparent, (20, 20, 20))

    # Then
    np.testing.assert_array_equal(normalized, np.full((1, 1, 3), 20, dtype=np.uint8))


def test_render_scene_helpers_hide_grid_and_world_axes_then_restore() -> None:
    # Given
    grid = SimpleNamespace(visible=True)
    world_axes = SimpleNamespace(visible=True)
    session = SimpleNamespace(
        render_grid_handle=grid,
        client=SimpleNamespace(scene=SimpleNamespace(world_axes=world_axes)),
        start_direction_marker=None,
        target_velocity_arrow=None,
    )

    # When
    snapshot = hide_render_scene_helpers(session)

    # Then
    assert (grid.visible, world_axes.visible) == (False, False)
    restore_render_scene_helpers(session, snapshot)
    assert (grid.visible, world_axes.visible) == (True, True)


def test_preview_and_png_export_composite_transparent_viser_frames_over_white(tmp_path: Path) -> None:
    # Given
    output = tmp_path / "rgba.mp4"
    demo = RenderHarness(output, camera=RgbaCamera())

    # When
    demo.preview_cinematic_output(7)
    demo.start_cinematic_render(7)
    _join_worker(demo)

    # Then
    assert np.all(demo.gui.gui_cinematic_preview_image.image == 255)
    with Image.open(tmp_path / "rgba_frames" / "frame_000000.png") as frame:
        assert frame.mode == "RGB"
        assert frame.getpixel((0, 0)) == (255, 255, 255)


def test_preview_hides_direction_arrows_during_capture_and_restores_exact_visibility(tmp_path: Path) -> None:
    # Given
    start = FakeArrow(line_visible=True, cone_visible=False)
    target = FakeArrow(line_visible=False, cone_visible=True)
    camera = ArrowObservingCamera((start, target))
    demo = RenderHarness(tmp_path / "arrows.mp4", camera=camera)
    _install_arrows(demo, start, target)

    # When
    demo.preview_cinematic_output(7)

    # Then
    assert camera.visibility_during_capture == (False, False, False, False)
    _assert_arrow_visibility(start, target)


def test_preview_error_restores_exact_direction_arrow_visibility(tmp_path: Path) -> None:
    start = FakeArrow(line_visible=True, cone_visible=False)
    target = FakeArrow(line_visible=False, cone_visible=True)
    camera = ArrowObservingCamera((start, target), fail_at_call=1)
    demo = RenderHarness(tmp_path / "preview-error.mp4", camera=camera)
    _install_arrows(demo, start, target)

    demo.preview_cinematic_output(7)

    assert camera.visibility_during_capture == (False, False, False, False)
    _assert_arrow_visibility(start, target)


def test_cancelled_render_restores_exact_direction_arrow_visibility(tmp_path: Path) -> None:
    start = FakeArrow(line_visible=True, cone_visible=False)
    target = FakeArrow(line_visible=False, cone_visible=True)
    camera = ArrowObservingCamera((start, target))
    demo = RenderHarness(tmp_path / "arrow-cancel.mp4", camera=camera)
    _install_arrows(demo, start, target)
    camera.cancel = demo.session.cinematic.render_cancel

    demo.start_cinematic_render(7)
    _join_worker(demo)

    assert camera.visibility_during_capture == (False, False, False, False)
    _assert_arrow_visibility(start, target)


def test_timed_out_render_restores_exact_direction_arrow_visibility(tmp_path: Path) -> None:
    start = FakeArrow(line_visible=True, cone_visible=False)
    target = FakeArrow(line_visible=False, cone_visible=True)
    camera = ArrowObservingCamera((start, target))
    runner = FakeRunner(ProcessTimedOut(timeout_seconds=0.1))
    demo = RenderHarness(tmp_path / "arrow-timeout.mp4", camera=camera, runner=runner)
    _install_arrows(demo, start, target)

    demo.start_cinematic_render(7)
    _join_worker(demo)

    assert camera.visibility_during_capture == (False, False, False, False)
    _assert_arrow_visibility(start, target)
