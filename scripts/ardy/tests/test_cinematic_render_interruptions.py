from __future__ import annotations

import threading
from pathlib import Path

import numpy as np
import pytest

from scripts.interactive_demo.cinematic_camera import CameraKeyframe, OutputFormat, ShotPlan
from scripts.interactive_demo.cinematic_export import ProcessCompleted
from test_cinematic_render import FakeCamera, FakeRunner, RenderHarness, _join_worker, _pose


class BlockingCamera(FakeCamera):  # noqa: MUTABLE_OK
    """Camera that models Viser waiting forever for a browser response."""

    def __init__(self) -> None:
        super().__init__()
        self.entered = threading.Event()
        self.release = threading.Event()

    def get_render(self, *, height: int, width: int, transport_format: str) -> np.ndarray:
        self.calls.append((height, width, transport_format))
        self.entered.set()
        self.release.wait()
        return np.full((height, width, 3), 77, dtype=np.uint8)


class BlockingSuccessRunner(FakeRunner):  # noqa: MUTABLE_OK
    """Encoder that finishes successfully only after cancellation arrives."""

    def __init__(self, cancellation: threading.Event) -> None:
        super().__init__(ProcessCompleted(returncode=0, stderr=""))
        self.cancellation = cancellation
        self.started = threading.Event()

    def run(self, argv: list[str], cancellation: threading.Event) -> ProcessCompleted:
        self.calls.append(argv)
        self.started.set()
        assert cancellation is self.cancellation
        assert cancellation.wait(timeout=1.0)
        Path(argv[-1]).write_bytes(b"late video")
        return ProcessCompleted(returncode=0, stderr="")


class BlockingFirstCamera(FakeCamera):  # noqa: MUTABLE_OK
    """Hold the first frame while the editor replaces its live shot plan."""

    def __init__(self) -> None:
        super().__init__()
        self.first_entered = threading.Event()
        self.release_first = threading.Event()
        self.captured_x: list[float] = []

    def get_render(self, *, height: int, width: int, transport_format: str) -> np.ndarray:
        self.calls.append((height, width, transport_format))
        self.captured_x.append(float(self.position[0]))
        if len(self.calls) == 1:
            self.first_entered.set()
            assert self.release_first.wait(timeout=1.0)
        return np.zeros((height, width, 3), dtype=np.uint8)


class BlockingBeforeReadCamera(FakeCamera):  # noqa: MUTABLE_OK
    """Hold the render request before reading camera pose to expose timeline races."""

    def __init__(self) -> None:
        super().__init__()
        self.entered = threading.Event()
        self.release = threading.Event()
        self.captured_x: list[float] = []

    def get_render(self, *, height: int, width: int, transport_format: str) -> np.ndarray:
        self.calls.append((height, width, transport_format))
        if len(self.calls) == 1:
            self.entered.set()
            assert self.release.wait(timeout=1.0)
        self.captured_x.append(float(self.position[0]))
        return np.zeros((height, width, 3), dtype=np.uint8)


def _replacement_plan() -> ShotPlan:
    plan = ShotPlan.empty(OutputFormat.custom(8, 6))
    plan = plan.add(CameraKeyframe(frame=0, pose=_pose(100.0)))
    return plan.add(CameraKeyframe(frame=2, pose=_pose(102.0)))


@pytest.mark.parametrize("initial_preview", [False, True])
def test_removing_live_plan_mid_render_keeps_snapshot_and_restores_safely(
    tmp_path: Path, initial_preview: bool
) -> None:
    camera = BlockingFirstCamera()
    demo = RenderHarness(tmp_path / f"remove-{initial_preview}.mp4", camera=camera)
    demo.session.cinematic.preview_enabled = initial_preview
    original_camera = camera.position.copy()
    original_frame = demo.session.frame_idx

    demo.start_cinematic_render(7)
    assert camera.first_entered.wait(timeout=1.0)
    demo.session.cinematic.shot_plan = ShotPlan.empty(OutputFormat.custom(8, 6))
    camera.release_first.set()
    _join_worker(demo)

    assert camera.captured_x == [0.0, 1.0, 2.0]
    assert demo.session.frame_idx == original_frame
    np.testing.assert_array_equal(camera.position, original_camera)
    assert demo.session.cinematic.preview_enabled is False
    assert demo.session.cinematic.render_plan is None
    assert demo.session.cinematic.render_lock.locked() is False

    captured = camera.captured_x.copy()
    demo.gui.gui_cinematic_output_path.value = str(tmp_path / f"invalid-{initial_preview}.mp4")
    demo.start_cinematic_render(7)
    assert camera.captured_x == captured
    assert "Add at least one camera keyframe" in demo.gui.gui_cinematic_status.content


def test_render_uses_one_plan_snapshot_while_live_plan_changes(tmp_path: Path) -> None:
    # Given
    camera = BlockingFirstCamera()
    demo = RenderHarness(tmp_path / "first-plan.mp4", camera=camera)

    # When
    demo.start_cinematic_render(7)
    assert camera.first_entered.wait(timeout=1.0)
    demo.session.cinematic.shot_plan = _replacement_plan()
    camera.release_first.set()
    _join_worker(demo)

    # Then
    assert camera.captured_x == [0.0, 1.0, 2.0]
    demo.gui.gui_cinematic_output_path.value = str(tmp_path / "second-plan.mp4")
    camera.calls.clear()
    camera.captured_x.clear()
    demo.start_cinematic_render(7)
    _join_worker(demo)
    assert camera.captured_x == [100.0, 101.0, 102.0]


def test_external_timeline_scrub_is_deferred_while_render_frame_is_captured(tmp_path: Path) -> None:
    # Given
    camera = BlockingBeforeReadCamera()
    demo = RenderHarness(tmp_path / "serialized.mp4", camera=camera)

    # When
    demo.start_cinematic_render(7)
    assert camera.entered.wait(timeout=1.0)
    scrub = threading.Thread(target=demo.set_frame, args=(7, 2), daemon=True)
    scrub.start()
    scrub.join(timeout=0.1)
    scrub_returned_without_waiting = not scrub.is_alive()
    camera.release.set()
    _join_worker(demo)

    # Then
    assert scrub_returned_without_waiting is True
    assert camera.captured_x == [0.0, 1.0, 2.0]
    assert demo.session.frame_idx == 2
    assert demo.session.cinematic.queued_frame is None
    assert demo.session.cinematic.render_owner_thread_id is None


def test_cancel_during_successful_ffmpeg_has_priority_and_removes_output(tmp_path: Path) -> None:
    # Given
    output = tmp_path / "late.mp4"
    demo = RenderHarness(output)
    runner = BlockingSuccessRunner(demo.session.cinematic.render_cancel)
    demo.runner = runner

    # When
    demo.start_cinematic_render(7)
    assert runner.started.wait(timeout=1.0)
    assert (demo.gui.gui_cinematic_cancel.visible, demo.gui.gui_cinematic_cancel.disabled) == (True, False)
    assert demo.gui.gui_cinematic_render.disabled is True
    demo.cancel_cinematic_render(7)
    _join_worker(demo)

    # Then
    assert demo.gui.gui_cinematic_status.content == "**Render cancelled**"
    assert not output.exists()
    assert not (tmp_path / "late_frames").exists()
    assert all(title != "Render complete" for title, _body in demo.session.client.notifications)
    assert demo.session.cinematic.render_lock.locked() is False
    assert (demo.gui.gui_cinematic_cancel.visible, demo.gui.gui_cinematic_cancel.disabled) == (False, True)
    assert demo.gui.gui_cinematic_render.disabled is False


def test_cancel_releases_worker_while_camera_capture_never_returns(tmp_path: Path) -> None:
    # Given
    output = tmp_path / "stuck.mp4"
    camera = BlockingCamera()
    demo = RenderHarness(output, camera=camera)

    # When
    demo.start_cinematic_render(7)
    assert camera.entered.wait(timeout=1.0)
    demo.cancel_cinematic_render(7)
    worker = demo._cinematic_render_threads[7]
    worker.join(timeout=0.5)

    # Then
    assert not worker.is_alive()
    assert demo.session.cinematic.render_lock.locked() is False
    assert demo.session.frame_idx == 1
    assert demo.session.playing is True
    assert demo.gui.gui_cinematic_cancel.disabled is True
    assert not output.exists()
    frozen_status = demo.gui.gui_cinematic_status.content
    frozen_progress = demo.gui.gui_cinematic_progress.value
    camera.release.set()
    assert demo._cinematic_capture_gate(7).wait_until_drained(timeout=1.0)
    assert not (tmp_path / "stuck_frames").exists()
    assert demo.gui.gui_cinematic_status.content == frozen_status
    assert demo.gui.gui_cinematic_progress.value == frozen_progress


def test_global_render_lease_rejects_second_client(tmp_path: Path) -> None:
    first_camera = BlockingCamera()
    first = RenderHarness(tmp_path / "first.mp4", camera=first_camera)
    second = RenderHarness(tmp_path / "second.mp4")

    first.start_cinematic_render(7)
    assert first_camera.entered.wait(timeout=1.0)
    second.start_cinematic_render(7)

    assert second.gui.gui_cinematic_status.content == "**Another client is already rendering**"
    assert second.session.client.camera.calls == []
    first.cancel_cinematic_render(7)
    _join_worker(first)
    first_camera.release.set()


def test_disconnect_shutdown_cancels_and_bounded_joins_worker(tmp_path: Path) -> None:
    camera = BlockingCamera()
    demo = RenderHarness(tmp_path / "disconnect.mp4", camera=camera)
    demo.start_cinematic_render(7)
    assert camera.entered.wait(timeout=1.0)

    joined = demo.shutdown_cinematic_render(7, timeout_seconds=0.5)

    assert joined is True
    assert not demo._cinematic_render_threads[7].is_alive()
    assert demo.session.cinematic.render_cancel.is_set()
    camera.release.set()


def test_preview_timeout_ignores_late_stale_camera_result(tmp_path: Path) -> None:
    # Given
    camera = BlockingCamera()
    demo = RenderHarness(tmp_path / "preview-timeout.mp4", camera=camera)
    original = demo.gui.gui_cinematic_preview_image.image.copy()
    caller = threading.Thread(target=demo.preview_cinematic_output, args=(7,), daemon=True)

    # When
    caller.start()
    assert camera.entered.wait(timeout=1.0)
    caller.join(timeout=0.5)

    # Then
    assert not caller.is_alive()
    np.testing.assert_array_equal(demo.gui.gui_cinematic_preview_image.image, original)
    assert "timed out" in demo.gui.gui_cinematic_status.content
    frozen_status = demo.gui.gui_cinematic_status.content
    notification_count = len(demo.session.client.notifications)
    camera.release.set()
    assert demo._cinematic_capture_gate(7).wait_until_drained(timeout=1.0)
    np.testing.assert_array_equal(demo.gui.gui_cinematic_preview_image.image, original)
    assert demo.gui.gui_cinematic_status.content == frozen_status
    assert len(demo.session.client.notifications) == notification_count


def test_timed_out_capture_refuses_overlap_until_old_helper_drains(tmp_path: Path) -> None:
    # Given
    camera = BlockingCamera()
    demo = RenderHarness(tmp_path / "draining.mp4", camera=camera)

    # When
    demo.preview_cinematic_output(7)
    demo.preview_cinematic_output(7)

    # Then
    assert len(camera.calls) == 1
    assert "still draining" in demo.gui.gui_cinematic_status.content
    camera.release.set()
    assert demo._cinematic_capture_gate(7).wait_until_drained(timeout=1.0)
    demo.preview_cinematic_output(7)
    assert len(camera.calls) == 2
    assert demo.gui.gui_cinematic_status.content == "**Preview:** 8×6"
