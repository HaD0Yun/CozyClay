"""State-safe Viser adapter for cinematic still and video rendering."""

from __future__ import annotations

import threading
from typing import Final

import numpy as np
from PIL import Image
from typing_extensions import assert_never

from .cinematic_camera import ShotPlan
from .cinematic_export import FfmpegFailed, FfmpegSucceeded, FfmpegTimedOut, FrameCaptureCancelled, FrameCaptureGate
from .cinematic_export import RenderCancelled, RenderRequest, RenderRequestError, SubprocessFfmpegRunner, encode_video, frame_file_path
from .cinematic_render_support import ViewerSnapshot, apply_camera_pose, normalize_render_image
from .cinematic_render_support import render_background_color, show_preview_modal
from .cinematic_scene_state import SceneHelperVisibility, enforce_render_scene_helpers_hidden
from .cinematic_scene_state import hide_render_scene_helpers, restore_render_scene_helpers
from .cinematic_viewer_state import CinematicViewerStateMixin
from .cinematic_limits import CinematicLimitError
from .cinematic_paths import (
    CinematicPathError,
    safe_remove_owned_directory,
    safe_remove_regular,
)
from .cinematic_render_security import CinematicRenderError, CinematicRenderSecurityMixin, GLOBAL_RENDER_LOCK

PNG_TRANSPORT: Final = "png"
CAPTURE_TIMEOUT_SECONDS: Final = 30.0
_CAPTURE_GATE_INIT_LOCK: Final = threading.Lock()


class CinematicRenderMixin(CinematicRenderSecurityMixin, CinematicViewerStateMixin):
    """Render cinematic camera plans through the connected Viser viewport."""

    cinematic_capture_timeout_seconds = CAPTURE_TIMEOUT_SECONDS

    def preview_cinematic_output(self, client_id: int) -> None:
        if not self.client_active(client_id):
            return
        session = self.client_sessions[client_id]
        gui = session.gui_elements
        scene_snapshot: SceneHelperVisibility | None = None
        try:
            if session.cinematic.render_lock.locked():
                raise CinematicRenderError("Preview is unavailable while a render is running")
            width, height = self._cinematic_dimensions(gui)
            background = render_background_color(gui)
            scene_snapshot = hide_render_scene_helpers(session)
            rendered = normalize_render_image(
                self._capture_cinematic_frame(client_id, session.client.camera, width, height, threading.Event()),
                background,
            )
            gui.gui_cinematic_preview_image.image = rendered
            gui.gui_cinematic_preview_image.visible = True
            gui.gui_cinematic_status.content = f"**Preview:** {width}×{height}"
            show_preview_modal(session.client, rendered, width, height)
        except Exception as error:  # noqa: BROAD_EXCEPT_OK - Viser UI boundary reports adapter failures.
            gui.gui_cinematic_status.content = f"**Preview failed:** {error}"
            self._notify_cinematic(session.client, "Preview failed", str(error), "red")
        finally:
            if scene_snapshot is not None:
                restore_render_scene_helpers(session, scene_snapshot)

    def start_cinematic_render(self, client_id: int) -> None:
        if not self.client_active(client_id):
            return
        session = self.client_sessions[client_id]
        gui = session.gui_elements
        try:
            request = self._cinematic_request(session)
            shot_plan = session.cinematic.shot_plan
            background = render_background_color(gui)
            if self._cinematic_capture_gate(client_id).is_busy():
                raise CinematicRenderError("Previous camera capture is still draining")
            if request.frames_directory.exists() or request.frames_directory.is_symlink():
                raise CinematicRenderError("Frame directory already exists")
            if request.output_path.exists() or request.output_path.is_symlink():
                raise CinematicRenderError("Output already exists")
        except (CinematicLimitError, CinematicPathError, CinematicRenderError, RenderRequestError, ValueError) as error:
            gui.gui_cinematic_status.content = f"**Render not started:** {error}"
            self._notify_cinematic(session.client, "Render not started", str(error), "red")
            return
        if not GLOBAL_RENDER_LOCK.acquire(blocking=False):
            gui.gui_cinematic_status.content = "**Another client is already rendering**"
            return
        if not session.cinematic.render_lock.acquire(blocking=False):
            GLOBAL_RENDER_LOCK.release()
            gui.gui_cinematic_status.content = "**Render already running**"
            return
        session.cinematic.render_owner_thread_id = -1
        session.cinematic.queued_frame = None
        session.cinematic.render_cancel.clear()
        gui.gui_cinematic_progress.value = 0.0
        gui.gui_cinematic_progress.visible = True
        gui.gui_cinematic_render.visible = False
        gui.gui_cinematic_render.disabled = True
        gui.gui_cinematic_cancel.visible = True
        gui.gui_cinematic_cancel.disabled = False
        gui.gui_cinematic_status.content = "**Preparing render…**"
        worker = threading.Thread(
            target=self._run_cinematic_render,
            args=(client_id, session, request, shot_plan, background),
            daemon=True,
        )
        if not hasattr(self, "_cinematic_render_threads"):
            self._cinematic_render_threads = {}
        self._cinematic_render_threads[client_id] = worker
        try:
            worker.start()
        except RuntimeError:
            session.cinematic.render_lock.release()
            GLOBAL_RENDER_LOCK.release()
            gui.gui_cinematic_render.visible = True
            gui.gui_cinematic_render.disabled = False
            gui.gui_cinematic_cancel.visible = False
            gui.gui_cinematic_cancel.disabled = True
            gui.gui_cinematic_status.content = "**Render worker could not start**"

    def cancel_cinematic_render(self, client_id: int) -> None:
        if not self.client_active(client_id):
            return
        session = self.client_sessions[client_id]
        if session.cinematic.render_lock.locked():
            session.cinematic.render_cancel.set()
            session.gui_elements.gui_cinematic_status.content = "**Cancelling…**"
        else:
            session.gui_elements.gui_cinematic_status.content = "**No render in progress**"

    def _cinematic_ffmpeg_runner(self) -> SubprocessFfmpegRunner:
        return SubprocessFfmpegRunner()

    def _cinematic_capture_gate(self, client_id: int) -> FrameCaptureGate:
        with _CAPTURE_GATE_INIT_LOCK:
            if not hasattr(self, "_cinematic_capture_gates"):
                self._cinematic_capture_gates = {}
            return self._cinematic_capture_gates.setdefault(client_id, FrameCaptureGate())

    def _capture_cinematic_frame(self, client_id: int, camera, width: int, height: int, cancellation) -> np.ndarray:
        return self._cinematic_capture_gate(client_id).capture(
            lambda: camera.get_render(height=height, width=width, transport_format=PNG_TRANSPORT), cancellation,
            self.cinematic_capture_timeout_seconds)

    def _run_cinematic_render(
        self,
        client_id: int,
        session,
        request: RenderRequest,
        shot_plan: ShotPlan,
        background: tuple[int, int, int],
    ) -> None:
        gui = session.gui_elements
        snapshot: ViewerSnapshot | None = None
        scene_snapshot: SceneHelperVisibility | None = None
        owned_frames = False
        encoding_started = False
        succeeded = False
        try:  # noqa: BROAD_EXCEPT_OK - top-level background worker must restore viewer state.
            with session.cinematic.frame_camera_lock:
                session.cinematic.render_owner_thread_id = threading.get_ident()
                if session.cinematic.render_plan is not None:
                    raise CinematicRenderError("A render plan is already active")
                session.cinematic.render_plan = shot_plan
                snapshot = self._snapshot_cinematic_viewer(session)
                scene_snapshot = hide_render_scene_helpers(session)
                session.cinematic.preview_enabled = True
                self._set_cinematic_helper_values(gui, False)
            request.output_path.parent.mkdir(parents=True, exist_ok=True)
            request.frames_directory.mkdir(exist_ok=False)
            owned_frames = True
            session.playing = False
            total = request.frame_count
            for completed, frame_idx in enumerate(range(request.start_frame, request.end_frame + 1), start=1):
                if session.cinematic.render_cancel.is_set():
                    gui.gui_cinematic_status.content = "**Render cancelled**"
                    return
                with session.cinematic.frame_camera_lock:
                    self.set_frame(client_id, frame_idx, trigger_by_gui_timeline=True)
                    enforce_render_scene_helpers_hidden(session)
                    apply_camera_pose(session.client.camera, shot_plan.evaluate(frame_idx))
                    rendered = normalize_render_image(
                        self._capture_cinematic_frame(
                            client_id, session.client.camera, request.width, request.height,
                            session.cinematic.render_cancel,
                        ),
                        background,
                    )
                Image.fromarray(rendered).save(frame_file_path(request.frames_directory, frame_idx))
                gui.gui_cinematic_progress.value = completed / total
                gui.gui_cinematic_status.content = f"**Rendering:** {completed}/{total}"
            if session.cinematic.render_cancel.is_set():
                gui.gui_cinematic_status.content = "**Render cancelled**"
                return
            encoding_started = True
            result = encode_video(request, self._cinematic_ffmpeg_runner(), session.cinematic.render_cancel)
            match result:
                case FfmpegSucceeded():
                    succeeded = True
                    gui.gui_cinematic_progress.value = 1.0
                    gui.gui_cinematic_status.content = f"**Render complete:** {request.output_path.name}"
                    self._notify_cinematic(session.client, "Render complete", str(request.output_path), "green")
                case RenderCancelled():
                    gui.gui_cinematic_status.content = "**Render cancelled**"
                case FfmpegFailed():
                    gui.gui_cinematic_status.content = "**MP4 encoding failed**"
                case FfmpegTimedOut():
                    gui.gui_cinematic_status.content = "**MP4 encoding timed out**"
                case unreachable:
                    assert_never(unreachable)
        except FrameCaptureCancelled:
            gui.gui_cinematic_status.content = "**Render cancelled**"
        except Exception:  # noqa: BROAD_EXCEPT_OK - background boundary reports a sanitized failure and restores.
            gui.gui_cinematic_status.content = "**Render failed safely**"
            self._notify_cinematic(session.client, "Render failed", "The render could not be completed safely.", "red")
        finally:
            try:
                if not succeeded:
                    if owned_frames:
                        safe_remove_owned_directory(request.frames_directory)
                    if encoding_started and request.output_path.exists():
                        safe_remove_regular(request.output_path)
            finally:
                try:
                    with session.cinematic.frame_camera_lock:
                        try:
                            session.cinematic.render_plan = None
                            if snapshot is not None:
                                self._restore_cinematic_viewer(client_id, session, snapshot)
                            if scene_snapshot is not None:
                                restore_render_scene_helpers(session, scene_snapshot)
                        finally:
                            queued_frame = session.cinematic.queued_frame
                            session.cinematic.queued_frame = None
                            session.cinematic.render_owner_thread_id = None
                            if queued_frame is not None:
                                self.set_frame(client_id, queued_frame[0], queued_frame[1])
                finally:
                    gui.gui_cinematic_render.visible = True
                    gui.gui_cinematic_render.disabled = not bool(session.cinematic.shot_plan.keyframes)
                    gui.gui_cinematic_cancel.visible = False
                    gui.gui_cinematic_cancel.disabled = True
                    session.cinematic.render_lock.release()
                    GLOBAL_RENDER_LOCK.release()

    @staticmethod
    def _notify_cinematic(client, title: str, body: str, color: str) -> None:
        client.add_notification(title=title, body=body, color=color, auto_close_seconds=5.0)
