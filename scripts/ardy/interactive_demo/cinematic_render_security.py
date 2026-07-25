"""Validated render requests, global ownership, and disconnect shutdown."""

from __future__ import annotations

import shutil
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from .cinematic_export import RenderRequest
from .cinematic_limits import RenderBudget, required_disk_bytes, validate_render_budget
from .cinematic_paths import resolve_render_path

GLOBAL_RENDER_LOCK: Final = threading.Lock()
REPO_ROOT: Final = Path(__file__).resolve().parents[1]


@dataclass(frozen=True, slots=True)
class CinematicRenderError(Exception):
    detail: str

    def __str__(self) -> str:
        return self.detail


class CinematicRenderSecurityMixin:
    """Own server-side render trust boundaries shared by all clients."""

    def shutdown_cinematic_render(self, client_id: int, *, timeout_seconds: float = 2.0) -> bool:
        session = self.client_sessions.get(client_id)
        if session is None:
            return True
        session.cinematic.render_cancel.set()
        worker = getattr(self, "_cinematic_render_threads", {}).get(client_id)
        if worker is None or worker is threading.current_thread():
            return True
        worker.join(timeout=timeout_seconds)
        return not worker.is_alive()

    def _cinematic_dimensions(self, gui) -> tuple[int, int]:
        width = int(gui.gui_cinematic_width.value)
        height = int(gui.gui_cinematic_height.value)
        if width <= 0 or height <= 0 or width % 2 != 0 or height % 2 != 0:
            raise CinematicRenderError("Output dimensions must be positive even integers")
        budget = RenderBudget(width=width, height=height, frame_count=1)
        validate_render_budget(budget, free_bytes=required_disk_bytes(budget))
        return width, height

    def _cinematic_request(self, session) -> RenderRequest:
        gui = session.gui_elements
        if not session.cinematic.shot_plan.keyframes:
            raise CinematicRenderError("Add at least one camera keyframe before rendering")
        width, height = self._cinematic_dimensions(gui)
        start_frame = int(gui.gui_cinematic_start_frame.value)
        end_frame = int(gui.gui_cinematic_end_frame.value)
        if end_frame > session.max_frame_idx:
            raise CinematicRenderError(f"End frame must be at most {session.max_frame_idx}")
        raw_path = str(gui.gui_cinematic_output_path.value).strip()
        if not raw_path:
            raise CinematicRenderError("Choose an MP4 output path")
        roots = getattr(self, "cinematic_render_roots", None)
        output_path = resolve_render_path(raw_path, REPO_ROOT, roots)
        request = RenderRequest(
            frames_directory=output_path.with_name(f"{output_path.stem}_frames"),
            output_path=output_path,
            start_frame=start_frame,
            end_frame=end_frame,
            width=width,
            height=height,
            frames_per_second=float(session.model_fps),
        )
        disk_parent = output_path.parent
        while not disk_parent.exists():
            disk_parent = disk_parent.parent
        free_bytes = int(getattr(self, "cinematic_free_disk_bytes", shutil.disk_usage(disk_parent).free))
        validate_render_budget(
            RenderBudget(width=width, height=height, frame_count=request.frame_count),
            free_bytes=free_bytes,
        )
        return request
