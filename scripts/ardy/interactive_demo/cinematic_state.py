"""Mutable per-client state for cinematic preview and rendering."""

import threading
from dataclasses import dataclass, field

from .cinematic_camera import OutputFormat, OutputFormatPreset, ShotPlan


def _default_shot_plan() -> ShotPlan:
    return ShotPlan.empty(OutputFormat.from_preset(OutputFormatPreset.HD_16_9))


@dataclass(slots=True)  # noqa: MUTABLE_OK
class CinematicSessionState:
    """Editor state intentionally mutated by one client's controls and render worker."""

    shot_plan: ShotPlan = field(default_factory=_default_shot_plan)
    render_plan: ShotPlan | None = None
    preview_enabled: bool = False
    render_lock: threading.Lock = field(default_factory=threading.Lock)
    render_cancel: threading.Event = field(default_factory=threading.Event)
    frame_camera_lock: threading.RLock = field(default_factory=threading.RLock)
    render_owner_thread_id: int | None = None
    queued_frame: tuple[int, bool] | None = None

    def defer_external_frame(self, frame_idx: int, trigger_by_gui_timeline: bool) -> bool:
        owner = self.render_owner_thread_id
        if owner is None or owner == threading.get_ident():
            return False
        self.queued_frame = (frame_idx, trigger_by_gui_timeline)
        return True
