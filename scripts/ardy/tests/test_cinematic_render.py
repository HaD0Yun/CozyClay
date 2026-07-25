from __future__ import annotations

import threading
from pathlib import Path
from types import SimpleNamespace

import numpy as np
from PIL import Image

from scripts.interactive_demo.cinematic_camera import CameraKeyframe, CameraPose, OutputFormat, ShotPlan
from scripts.interactive_demo.cinematic_export import ProcessCompleted, ProcessTimedOut
from scripts.interactive_demo.cinematic_render import CinematicRenderMixin
from scripts.interactive_demo.cinematic_state import CinematicSessionState


class ValueHandle:  # noqa: MUTABLE_OK
    """Small mutable fake for a Viser value handle."""

    def __init__(self, value: bool | float | int | str | np.ndarray) -> None:
        self.value = value
        self.visible = True
        self.disabled = False
        self.image = np.zeros((1, 1, 3), dtype=np.uint8)


class FakeRenderError(RuntimeError):
    """Injected renderer failure for adapter restoration tests."""


class MarkdownHandle:  # noqa: MUTABLE_OK
    """Fake for Viser's markdown handle, whose mutable property is content."""

    def __init__(self, content: str) -> None:
        self.content = content


class FakeCamera:  # noqa: MUTABLE_OK
    """Render fake that records the exact requested output dimensions."""

    def __init__(self, fail_at_call: int | None = None, cancel: threading.Event | None = None) -> None:
        self.position = np.array([9.0, 8.0, 7.0])
        self.look_at = np.array([0.0, 1.0, 0.0])
        self.up_direction = np.array([0.0, 1.0, 0.0])
        self.fov = 0.9
        self.fail_at_call = fail_at_call
        self.cancel = cancel
        self.calls: list[tuple[int, int, str]] = []

    def get_render(self, *, height: int, width: int, transport_format: str) -> np.ndarray:
        self.calls.append((height, width, transport_format))
        if self.cancel is not None and len(self.calls) == 1:
            self.cancel.set()
        if self.fail_at_call == len(self.calls):
            raise FakeRenderError("render failed")
        return np.full((height, width, 3), len(self.calls), dtype=np.uint8)


class FakeRunner:  # noqa: MUTABLE_OK
    def __init__(self, result: ProcessCompleted | ProcessTimedOut) -> None:
        self.result = result
        self.calls: list[list[str]] = []

    def run(
        self, argv: list[str], cancellation: threading.Event
    ) -> ProcessCompleted | ProcessTimedOut:
        self.calls.append(argv)
        output = Path(argv[-1])
        if isinstance(self.result, ProcessCompleted) and self.result.returncode == 0:
            output.write_bytes(b"video")
        return self.result


class FakeModal:
    def __enter__(self) -> FakeModal:
        return self

    def __exit__(self, *_args: BaseException | None) -> None:
        return None


class FakeGui:  # noqa: MUTABLE_OK
    def __init__(self) -> None:
        self.images: list[np.ndarray] = []

    def add_modal(self, *_args: str, **_kwargs: bool | str) -> FakeModal:
        return FakeModal()

    def add_image(self, image: np.ndarray, **_kwargs: str) -> None:
        self.images.append(image)


class FakeClient:  # noqa: MUTABLE_OK
    def __init__(self, camera: FakeCamera) -> None:
        self.camera = camera
        self.gui = FakeGui()
        self.scene = SimpleNamespace(
            world_axes=SimpleNamespace(visible=True),
        )
        self.notifications: list[tuple[str, str]] = []

    def add_notification(self, *, title: str, body: str, **_kwargs: bool | float | str) -> None:
        self.notifications.append((title, body))


def _pose(x: float) -> CameraPose:
    return CameraPose.create(
        position=(x, 2.0, 5.0),
        look_at=(x, 1.0, 0.0),
        up=(0.0, 1.0, 0.0),
        vertical_fov_radians=0.8,
    )


def _plan() -> ShotPlan:
    plan = ShotPlan.empty(OutputFormat.custom(8, 6))
    plan = plan.add(CameraKeyframe(frame=0, pose=_pose(0.0)))
    return plan.add(CameraKeyframe(frame=2, pose=_pose(2.0)))


def _gui(output_path: Path) -> SimpleNamespace:
    return SimpleNamespace(
        gui_cinematic_width=ValueHandle(8),
        gui_cinematic_height=ValueHandle(6),
        gui_cinematic_output_path=ValueHandle(str(output_path)),
        gui_cinematic_start_frame=ValueHandle(0),
        gui_cinematic_end_frame=ValueHandle(2),
        gui_cinematic_status=MarkdownHandle("Ready"),
        gui_cinematic_progress=ValueHandle(0.0),
        gui_cinematic_preview_image=ValueHandle(np.zeros((1, 1, 3), dtype=np.uint8)),
        gui_cinematic_render=ValueHandle(False),
        gui_cinematic_cancel=ValueHandle(False),
        gui_viz_skeleton_checkbox=ValueHandle(True),
        gui_viz_foot_contacts_checkbox=ValueHandle(True),
        gui_viz_hand_orientations_checkbox=ValueHandle(True),
        gui_show_start_direction_checkbox=ValueHandle(True),
        gui_show_timeline_checkbox=ValueHandle(True),
        gui_dark_mode_checkbox=ValueHandle(False),
    )


class RenderHarness(CinematicRenderMixin):  # noqa: MUTABLE_OK
    cinematic_capture_timeout_seconds = 0.05

    def __init__(
        self,
        output_path: Path,
        *,
        camera: FakeCamera | None = None,
        runner: FakeRunner | None = None,
    ) -> None:
        camera = camera or FakeCamera()
        cinematic = CinematicSessionState()
        cinematic.shot_plan = _plan()
        cinematic.preview_enabled = False
        self.gui = _gui(output_path)
        self.session = SimpleNamespace(
            client=FakeClient(camera),
            gui_elements=self.gui,
            cinematic=cinematic,
            frame_idx=1,
            max_frame_idx=2,
            playing=True,
            model_fps=20,
            constraints={},
            characters={},
            hand_gizmos={},
            target_velocity_arrow=None,
            start_direction_marker=None,
            render_grid_handle=SimpleNamespace(visible=True),
        )
        self.client_sessions = {7: self.session}
        self.cinematic_render_roots = (output_path.parent,)
        self.runner = runner or FakeRunner(ProcessCompleted(returncode=0, stderr=""))
        self.frames_seen: list[int] = []

    def client_active(self, client_id: int) -> bool:
        return client_id in self.client_sessions

    def set_frame(self, client_id: int, frame_idx: int, trigger_by_gui_timeline: bool = False) -> None:
        session = self.client_sessions[client_id]
        if session.cinematic.defer_external_frame(frame_idx, trigger_by_gui_timeline):
            return
        with session.cinematic.frame_camera_lock:
            if session.cinematic.defer_external_frame(frame_idx, trigger_by_gui_timeline):
                return
            self._set_frame_locked(client_id, frame_idx)

    def _set_frame_locked(self, client_id: int, frame_idx: int) -> None:
        session = self.client_sessions[client_id]
        session.frame_idx = frame_idx
        self.frames_seen.append(frame_idx)
        if session.cinematic.preview_enabled:
            plan = session.cinematic.render_plan or session.cinematic.shot_plan
            if not plan.keyframes:
                return
            pose = plan.evaluate(frame_idx)
            session.client.camera.position = np.asarray(pose.position)
            session.client.camera.look_at = np.asarray(pose.look_at)
            session.client.camera.up_direction = np.asarray(pose.up)
            session.client.camera.fov = pose.vertical_fov_radians

    def _cinematic_ffmpeg_runner(self) -> FakeRunner:
        return self.runner

    def _update_start_direction_marker(self, _client_id: int) -> None:
        return None


def _join_worker(demo: RenderHarness) -> None:
    demo._cinematic_render_threads[7].join(timeout=5.0)
    assert not demo._cinematic_render_threads[7].is_alive()


def test_preview_requests_exact_dimensions_and_updates_image(tmp_path: Path) -> None:
    # Given
    demo = RenderHarness(tmp_path / "preview.mp4")

    # When
    demo.preview_cinematic_output(7)

    # Then
    assert demo.session.client.camera.calls == [(6, 8, "png")]
    assert demo.gui.gui_cinematic_preview_image.image.shape == (6, 8, 3)
    assert demo.gui.gui_cinematic_status.content == "**Preview:** 8×6"
    assert len(demo.session.client.gui.images) == 1
    assert demo.session.render_grid_handle.visible is True
    assert demo.session.client.scene.world_axes.visible is True


def test_render_writes_one_png_per_inclusive_frame_in_order(tmp_path: Path) -> None:
    # Given
    output = tmp_path / "shot.mp4"
    demo = RenderHarness(output)

    # When
    demo.start_cinematic_render(7)
    _join_worker(demo)

    # Then
    frame_dir = tmp_path / "shot_frames"
    assert demo.frames_seen[:3] == [0, 1, 2]
    assert [path.name for path in sorted(frame_dir.glob("*.png"))] == [
        "frame_000000.png",
        "frame_000001.png",
        "frame_000002.png",
    ]
    assert Image.open(frame_dir / "frame_000002.png").size == (8, 6)
    assert demo.gui.gui_cinematic_progress.value == 1.0
    assert output.read_bytes() == b"video"


def test_cancel_stops_before_next_frame_and_never_runs_ffmpeg(tmp_path: Path) -> None:
    # Given
    output = tmp_path / "cancel.mp4"
    demo = RenderHarness(output)
    demo.session.client.camera.cancel = demo.session.cinematic.render_cancel

    # When
    demo.start_cinematic_render(7)
    _join_worker(demo)

    # Then
    assert len(demo.session.client.camera.calls) == 1
    assert demo.runner.calls == []
    assert not output.exists()
    assert not (tmp_path / "cancel_frames").exists()
    assert demo.gui.gui_cinematic_status.content == "**Render cancelled**"
    assert (demo.session.frame_idx, demo.session.playing, demo.session.cinematic.preview_enabled) == (1, True, False)


def test_concurrent_render_is_refused(tmp_path: Path) -> None:
    # Given
    demo = RenderHarness(tmp_path / "busy.mp4")
    assert demo.session.cinematic.render_lock.acquire(blocking=False)

    # When
    demo.start_cinematic_render(7)

    # Then
    assert demo.gui.gui_cinematic_status.content == "**Render already running**"
    assert demo.session.client.camera.calls == []
    demo.session.cinematic.render_lock.release()


def test_invalid_frame_range_is_reported_without_starting_worker(tmp_path: Path) -> None:
    # Given
    demo = RenderHarness(tmp_path / "range.mp4")
    demo.gui.gui_cinematic_start_frame.value = 2
    demo.gui.gui_cinematic_end_frame.value = 1

    # When
    demo.start_cinematic_render(7)

    # Then
    assert "invalid_frame_range" in demo.gui.gui_cinematic_status.content
    assert demo.session.cinematic.render_lock.locked() is False
    assert demo.runner.calls == []


def test_excessive_dimensions_and_low_disk_are_rejected_before_worker(tmp_path: Path) -> None:
    oversized = RenderHarness(tmp_path / "oversized.mp4")
    oversized.gui.gui_cinematic_width.value = 8192
    oversized.gui.gui_cinematic_height.value = 8192
    oversized.start_cinematic_render(7)
    assert "server limit" in oversized.gui.gui_cinematic_status.content

    low_disk = RenderHarness(tmp_path / "low-disk.mp4")
    low_disk.cinematic_free_disk_bytes = 1_000
    low_disk.start_cinematic_render(7)
    assert "free disk space" in low_disk.gui.gui_cinematic_status.content
    assert not hasattr(low_disk, "_cinematic_render_threads")
