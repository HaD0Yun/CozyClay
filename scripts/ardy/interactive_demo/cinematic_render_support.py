"""Small image, camera, and scene helpers for cinematic rendering."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .cinematic_camera import CameraPose


@dataclass(frozen=True, slots=True)
class CinematicImageError(Exception):
    detail: str

    def __str__(self) -> str:
        return self.detail


@dataclass(frozen=True, slots=True)
class ViewerSnapshot:
    frame_idx: int
    playing: bool
    preview_enabled: bool
    camera_position: tuple[float, float, float]
    camera_look_at: tuple[float, float, float]
    camera_up: tuple[float, float, float]
    camera_fov: float
    helper_visibility: tuple[bool, bool, bool, bool, bool]


def normalize_render_image(
    image: np.ndarray, background: tuple[int, int, int] = (255, 255, 255)
) -> np.ndarray:
    """Return contiguous RGB uint8, compositing Viser RGBA over the viewport color."""

    if image.dtype != np.uint8 or image.ndim != 3 or image.shape[2] not in (3, 4):
        raise CinematicImageError("Camera render must be a uint8 RGB or RGBA array")
    if image.shape[2] == 3:
        return np.ascontiguousarray(image)
    alpha = image[..., 3:4].astype(np.float32) / 255.0
    backdrop = np.asarray(background, dtype=np.float32)
    composited = image[..., :3].astype(np.float32) * alpha + backdrop * (1.0 - alpha)
    return np.ascontiguousarray(np.rint(composited).clip(0, 255).astype(np.uint8))


def apply_camera_pose(camera, pose: CameraPose) -> None:
    camera.position = np.asarray(pose.position, dtype=np.float64)
    camera.look_at = np.asarray(pose.look_at, dtype=np.float64)
    camera.up_direction = np.asarray(pose.up, dtype=np.float64)
    camera.fov = pose.vertical_fov_radians


def show_preview_modal(client, image: np.ndarray, width: int, height: int) -> None:
    with client.gui.add_modal("Cinematic Output Preview", size="90vw", show_close_button=True):
        client.gui.add_image(image, label=f"{width}×{height}", format="png")


def render_background_color(gui) -> tuple[int, int, int]:
    return (20, 20, 20) if gui.gui_dark_mode_checkbox.value else (255, 255, 255)

