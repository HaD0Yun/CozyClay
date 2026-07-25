"""Camera-attached matte that previews the selected cinematic aspect ratio."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Final

import numpy as np
import viser

MASK_ROOT: Final = "/ardy_editor/cinematic_frame_mask"
MASK_DISTANCE: Final = 0.02
MASK_TEXTURE_SIZE: Final = 512


@dataclass(frozen=True, slots=True)
class MaskBar:
    center_x: float
    center_y: float
    width: float
    height: float


@dataclass(frozen=True, slots=True)
class FrameMaskLayout:
    viewport_width: float
    viewport_height: float
    bars: tuple[MaskBar, ...]


def compute_frame_mask_layout(
    *,
    canvas_aspect: float,
    output_aspect: float,
    vertical_fov_radians: float,
    distance: float,
) -> FrameMaskLayout:
    """Return camera-plane bars that hide everything outside ``output_aspect``."""
    viewport_height = 2.0 * distance * math.tan(vertical_fov_radians / 2.0)
    viewport_width = viewport_height * canvas_aspect
    if math.isclose(canvas_aspect, output_aspect, rel_tol=1e-4):
        return FrameMaskLayout(viewport_width, viewport_height, ())
    if canvas_aspect > output_aspect:
        output_width = viewport_height * output_aspect
        bar_width = (viewport_width - output_width) / 2.0
        offset = (output_width + bar_width) / 2.0
        bars = (
            MaskBar(-offset, 0.0, bar_width, viewport_height),
            MaskBar(offset, 0.0, bar_width, viewport_height),
        )
    else:
        output_height = viewport_width / output_aspect
        bar_height = (viewport_height - output_height) / 2.0
        offset = (output_height + bar_height) / 2.0
        bars = (
            MaskBar(0.0, -offset, viewport_width, bar_height),
            MaskBar(0.0, offset, viewport_width, bar_height),
        )
    return FrameMaskLayout(viewport_width, viewport_height, bars)


def make_frame_mask_image(canvas_aspect: float, output_aspect: float) -> np.ndarray:
    """Build one RGBA matte with a transparent output window."""
    image = np.zeros((MASK_TEXTURE_SIZE, MASK_TEXTURE_SIZE, 4), dtype=np.uint8)
    if math.isclose(canvas_aspect, output_aspect, rel_tol=1e-4):
        return image
    if canvas_aspect > output_aspect:
        visible_fraction = output_aspect / canvas_aspect
        margin = round(MASK_TEXTURE_SIZE * (1.0 - visible_fraction) / 2.0)
        image[:, :margin, 3] = 255
        image[:, MASK_TEXTURE_SIZE - margin :, 3] = 255
    else:
        visible_fraction = canvas_aspect / output_aspect
        margin = round(MASK_TEXTURE_SIZE * (1.0 - visible_fraction) / 2.0)
        image[:margin, :, 3] = 255
        image[MASK_TEXTURE_SIZE - margin :, :, 3] = 255
    return image


class CinematicFrameMask:
    """Keep an editor-only matte attached to one Viser camera."""

    def __init__(self, client: viser.ClientHandle, output_width: int, output_height: int) -> None:
        self._client = client
        self._output_aspect = output_width / output_height
        self._enabled = True
        self._mask_key: tuple[float, float] | None = None
        camera = client.camera
        self.root = client.scene.add_frame(
            MASK_ROOT,
            show_axes=False,
            wxyz=camera.wxyz,
            position=camera.position,
        )
        self._mask = client.scene.add_image(
            f"{MASK_ROOT}/matte",
            np.zeros((2, 2, 4), dtype=np.uint8),
            render_width=0.001,
            render_height=0.001,
            cast_shadow=False,
            receive_shadow=False,
            visible=False,
        )
        camera.on_update(self._on_camera_update)
        self.refresh()

    def set_output_format(self, width: int, height: int) -> None:
        self._output_aspect = width / height
        self.refresh()

    def set_enabled(self, enabled: bool) -> None:
        self._enabled = enabled
        self.refresh()

    def refresh(self) -> None:
        camera = self._client.camera
        layout = compute_frame_mask_layout(
            canvas_aspect=camera.aspect,
            output_aspect=self._output_aspect,
            vertical_fov_radians=float(camera.fov),
            distance=max(MASK_DISTANCE, float(camera.near) * 2.0),
        )
        mask_key = (round(camera.aspect, 4), round(self._output_aspect, 4))
        with self._client.atomic():
            self.root.wxyz = camera.wxyz
            self.root.position = camera.position
            self.root.visible = self._enabled
            if mask_key != self._mask_key:
                self._mask.image = make_frame_mask_image(camera.aspect, self._output_aspect)
                self._mask_key = mask_key
            self._mask.position = (0.0, 0.0, max(MASK_DISTANCE, float(camera.near) * 2.0))
            self._mask.render_width = layout.viewport_width
            self._mask.render_height = layout.viewport_height
            self._mask.visible = self._enabled and bool(layout.bars)

    def _on_camera_update(self, _camera: viser.CameraHandle) -> None:
        self.refresh()


def setup_cinematic_frame_mask(session) -> CinematicFrameMask:
    """Create the live output matte after a client session is registered."""
    output = session.cinematic.shot_plan.output_format
    mask = CinematicFrameMask(session.client, output.width, output.height)
    session.cinematic_frame_mask = mask
    return mask
