from __future__ import annotations

from pathlib import Path

import numpy as np

from scripts.interactive_demo.cinematic_export import ProcessCompleted, ProcessTimedOut
from test_cinematic_render import FakeCamera, FakeRunner, RenderHarness, _join_worker


def test_render_refuses_preexisting_frame_directory_without_deleting_it(tmp_path: Path) -> None:
    output = tmp_path / "safe.mp4"
    frame_dir = tmp_path / "safe_frames"
    frame_dir.mkdir()
    sentinel = frame_dir / "keep.txt"
    sentinel.write_text("mine", encoding="utf-8")
    demo = RenderHarness(output)

    demo.start_cinematic_render(7)

    assert sentinel.read_text(encoding="utf-8") == "mine"
    assert demo.runner.calls == []
    assert "already exists" in demo.gui.gui_cinematic_status.content


def test_render_error_removes_owned_artifacts_and_restores_viewer(tmp_path: Path) -> None:
    output = tmp_path / "broken.mp4"
    camera = FakeCamera(fail_at_call=2)
    demo = RenderHarness(output, camera=camera)
    original_camera = (camera.position.copy(), camera.look_at.copy(), camera.up_direction.copy(), camera.fov)

    demo.start_cinematic_render(7)
    _join_worker(demo)

    assert demo.runner.calls == []
    assert not (tmp_path / "broken_frames").exists()
    assert (demo.session.frame_idx, demo.session.playing, demo.session.cinematic.preview_enabled) == (1, True, False)
    np.testing.assert_array_equal(camera.position, original_camera[0])
    np.testing.assert_array_equal(camera.look_at, original_camera[1])
    np.testing.assert_array_equal(camera.up_direction, original_camera[2])
    assert camera.fov == original_camera[3]
    assert demo.gui.gui_viz_skeleton_checkbox.value is True
    assert demo.gui.gui_viz_foot_contacts_checkbox.value is True
    assert demo.gui.gui_viz_hand_orientations_checkbox.value is True
    assert demo.gui.gui_show_start_direction_checkbox.value is True
    assert demo.gui.gui_show_timeline_checkbox.value is True


def test_ffmpeg_failure_and_timeout_never_report_success(tmp_path: Path) -> None:
    failed = RenderHarness(
        tmp_path / "failed.mp4", runner=FakeRunner(ProcessCompleted(returncode=4, stderr="encode error"))
    )
    timed_out = RenderHarness(tmp_path / "timeout.mp4", runner=FakeRunner(ProcessTimedOut(timeout_seconds=0.1)))

    failed.start_cinematic_render(7)
    _join_worker(failed)
    timed_out.start_cinematic_render(7)
    _join_worker(timed_out)

    assert failed.gui.gui_cinematic_status.content == "**MP4 encoding failed**"
    assert timed_out.gui.gui_cinematic_status.content == "**MP4 encoding timed out**"
    assert not (tmp_path / "failed_frames").exists()
    assert not (tmp_path / "timeout_frames").exists()
    assert not (tmp_path / "failed.mp4").exists()
    assert not (tmp_path / "timeout.mp4").exists()
    assert (failed.session.frame_idx, failed.session.playing) == (1, True)
    assert (timed_out.session.frame_idx, timed_out.session.playing) == (1, True)


def test_render_success_restores_frame_playback_preview_and_camera(tmp_path: Path) -> None:
    output = tmp_path / "restore.mp4"
    demo = RenderHarness(output)
    camera = demo.session.client.camera
    original_position = camera.position.copy()

    demo.start_cinematic_render(7)
    _join_worker(demo)

    assert (demo.session.frame_idx, demo.session.playing, demo.session.cinematic.preview_enabled) == (1, True, False)
    np.testing.assert_array_equal(camera.position, original_position)
    assert demo.gui.gui_cinematic_status.content == "**Render complete:** restore.mp4"
    assert demo.session.cinematic.render_lock.locked() is False
    assert demo.session.render_grid_handle.visible is True
    assert demo.session.client.scene.world_axes.visible is True
