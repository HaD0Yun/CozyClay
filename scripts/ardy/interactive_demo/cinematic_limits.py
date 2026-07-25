"""Server-side resource limits for cinematic rendering."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

MAX_DIMENSION: Final = 4096
MAX_FRAME_PIXELS: Final = 9_000_000
MAX_FRAME_COUNT: Final = 2_000
MAX_TOTAL_PIXELS: Final = 750_000_000
DISK_BYTES_PER_PIXEL: Final = 4
DISK_RESERVE_BYTES: Final = 256 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class RenderBudget:
    width: int
    height: int
    frame_count: int


@dataclass(frozen=True, slots=True)
class CinematicLimitError(Exception):
    detail: str

    def __str__(self) -> str:
        return self.detail


def required_disk_bytes(budget: RenderBudget) -> int:
    return budget.width * budget.height * budget.frame_count * DISK_BYTES_PER_PIXEL + DISK_RESERVE_BYTES


def validate_render_budget(budget: RenderBudget, *, free_bytes: int) -> None:
    if budget.width <= 0 or budget.height <= 0 or budget.width > MAX_DIMENSION or budget.height > MAX_DIMENSION:
        raise CinematicLimitError("Output dimensions exceed the server limit")
    frame_pixels = budget.width * budget.height
    if frame_pixels > MAX_FRAME_PIXELS:
        raise CinematicLimitError("Output dimensions exceed the pixel limit")
    if budget.frame_count <= 0 or budget.frame_count > MAX_FRAME_COUNT:
        raise CinematicLimitError("Frame count exceeds the server limit")
    if frame_pixels * budget.frame_count > MAX_TOTAL_PIXELS:
        raise CinematicLimitError("Render total work exceeds the server limit")
    if free_bytes < required_disk_bytes(budget):
        raise CinematicLimitError("Not enough free disk space for this render")
