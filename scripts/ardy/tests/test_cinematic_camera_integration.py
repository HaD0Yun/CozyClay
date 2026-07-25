import threading
from types import SimpleNamespace

import numpy as np
from scripts.interactive_demo.cinematic_camera import (
    CameraKeyframe,
    CameraPose,
    OutputFormat,
    OutputFormatPreset,
    ShotPlan,
)

from scripts.interactive_demo.cinematic_state import CinematicSessionState
from scripts.interactive_demo.common import ClientSession
from scripts.interactive_demo.playback import PlaybackMixin


class FakeCamera:
    def __init__(self) -> None:
        self.position = np.array((1.0, 2.0, 3.0))
        self.look_at = np.array((0.0, 1.0, 0.0))
        self.up_direction = np.array((0.0, 1.0, 0.0))
        self.fov = 0.75


def _pose(x: float, fov: float) -> CameraPose:
    return CameraPose.create(
        position=(x, 2.0, 4.0),
        look_at=(x, 1.0, 0.0),
        up=(0.0, 1.0, 0.0),
        vertical_fov_radians=fov,
    )


def _shot_plan() -> ShotPlan:
    plan = ShotPlan.empty(OutputFormat.from_preset(OutputFormatPreset.HD_16_9))
    plan = plan.add(CameraKeyframe(frame=0, pose=_pose(0.0, 0.8)))
    return plan.add(CameraKeyframe(frame=10, pose=_pose(10.0, 1.2)))


class FakeDemo(PlaybackMixin):
    def __init__(
        self,
        *,
        auto_follow: bool,
        preview_enabled: bool = False,
        shot_plan: ShotPlan | None = None,
    ) -> None:
        camera = FakeCamera()
        cinematic = CinematicSessionState()
        cinematic.preview_enabled = preview_enabled
        if shot_plan is not None:
            cinematic.shot_plan = shot_plan
        gui = SimpleNamespace(
            gui_current_time=SimpleNamespace(value=-1.0),
            gui_frame_idx_input=SimpleNamespace(value=-1),
            gui_replan_trigger_thresh=SimpleNamespace(value=4),
            gui_enable_auto_replan_checkbox=SimpleNamespace(value=False),
            gui_viz_hand_orientations_checkbox=SimpleNamespace(value=False),
            gui_viz_hide_distant_constraints_checkbox=SimpleNamespace(value=False),
            gui_future_crop_length=SimpleNamespace(value=4),
            gui_viz_ref_motion_checkbox=SimpleNamespace(value=False),
            gui_use_target_velocity_checkbox=SimpleNamespace(value=False),
            gui_viz_auto_camera_checkbox=SimpleNamespace(value=auto_follow),
        )
        self.client_sessions = {
            7: SimpleNamespace(
                client=SimpleNamespace(camera=camera),
                gui_elements=gui,
                frame_idx=-1,
                max_frame_idx=-1,
                model_fps=20,
                gen_horizon_len=40,
                replan_lock=threading.Lock(),
                constraints={},
                characters_lock=threading.Lock(),
                characters={},
                root_velocities=None,
                foot_contacts=None,
                ref_character=None,
                ref_joints_pos=None,
                hand_gizmos={},
                target_velocity_arrow=None,
                cinematic=cinematic,
            )
        }
        self.followed_frames: list[int] = []

    def client_active(self, client_id: int) -> bool:
        return client_id in self.client_sessions

    def update_camera_follow(self, client_id: int, frame_idx: int) -> None:
        self.followed_frames.append(frame_idx)
        self.client_sessions[client_id].client.camera.position = np.array((9.0, 9.0, 9.0))


def test_set_frame_preserves_manual_camera_when_auto_follow_is_off() -> None:
    # Given
    demo = FakeDemo(auto_follow=False)
    camera = demo.client_sessions[7].client.camera
    original_position = camera.position.copy()

    # When
    demo.set_frame(client_id=7, frame_idx=0)

    # Then
    np.testing.assert_array_equal(camera.position, original_position)
    assert demo.followed_frames == []


def test_set_frame_runs_existing_auto_follow_when_enabled() -> None:
    # Given
    demo = FakeDemo(auto_follow=True)

    # When
    demo.set_frame(client_id=7, frame_idx=0)

    # Then
    assert demo.followed_frames == [0]
    np.testing.assert_array_equal(
        demo.client_sessions[7].client.camera.position,
        np.array((9.0, 9.0, 9.0)),
    )


def test_set_frame_applies_evaluated_camera_when_preview_is_enabled() -> None:
    # Given
    demo = FakeDemo(auto_follow=False, preview_enabled=True, shot_plan=_shot_plan())
    camera = demo.client_sessions[7].client.camera

    # When
    recorded = []
    for frame in (0, 5, 10):
        demo.set_frame(client_id=7, frame_idx=frame)
        recorded.append((camera.position.copy(), camera.look_at.copy(), camera.up_direction.copy(), camera.fov))

    # Then
    for frame, (position, look_at, up, fov) in zip((0, 5, 10), recorded, strict=True):
        expected = _shot_plan().evaluate(frame)
        np.testing.assert_allclose(position, expected.position)
        np.testing.assert_allclose(look_at, expected.look_at)
        np.testing.assert_allclose(up, expected.up)
        assert fov == expected.vertical_fov_radians


def test_cinematic_preview_wins_without_running_auto_follow() -> None:
    # Given
    demo = FakeDemo(auto_follow=True, preview_enabled=True, shot_plan=_shot_plan())

    # When
    demo.set_frame(client_id=7, frame_idx=5)

    # Then
    assert demo.followed_frames == []
    np.testing.assert_allclose(demo.client_sessions[7].client.camera.position, _shot_plan().evaluate(5).position)


def test_empty_preview_plan_preserves_auto_follow_behavior() -> None:
    # Given
    demo = FakeDemo(auto_follow=True, preview_enabled=True)

    # When
    demo.set_frame(client_id=7, frame_idx=5)

    # Then
    assert demo.followed_frames == [5]


def test_render_plan_owns_camera_when_live_preview_plan_is_empty() -> None:
    # Given
    demo = FakeDemo(auto_follow=True, preview_enabled=True)
    cinematic = demo.client_sessions[7].cinematic
    cinematic.render_plan = _shot_plan()

    # When
    demo.set_frame(client_id=7, frame_idx=5)

    # Then
    assert demo.followed_frames == []
    np.testing.assert_allclose(demo.client_sessions[7].client.camera.position, _shot_plan().evaluate(5).position)


def test_external_playback_frame_is_queued_while_render_owns_camera() -> None:
    # Given
    demo = FakeDemo(auto_follow=True)
    session = demo.client_sessions[7]
    original_position = session.client.camera.position.copy()
    session.cinematic.render_owner_thread_id = -1

    # When
    demo.set_frame(client_id=7, frame_idx=5, trigger_by_gui_timeline=True)

    # Then
    assert session.frame_idx == -1
    assert session.cinematic.queued_frame == (5, True)
    np.testing.assert_array_equal(session.client.camera.position, original_position)


def test_negative_frame_does_not_apply_cinematic_camera() -> None:
    # Given
    demo = FakeDemo(auto_follow=False, preview_enabled=True, shot_plan=_shot_plan())
    camera = demo.client_sessions[7].client.camera
    original_position = camera.position.copy()

    # When
    demo.set_frame(client_id=7, frame_idx=-1)

    # Then
    np.testing.assert_array_equal(camera.position, original_position)


def test_frame_after_motion_bounds_holds_last_cinematic_key_without_crashing() -> None:
    # Given
    demo = FakeDemo(auto_follow=False, preview_enabled=True, shot_plan=_shot_plan())

    # When
    demo.set_frame(client_id=7, frame_idx=999)

    # Then
    np.testing.assert_allclose(demo.client_sessions[7].client.camera.position, _shot_plan().evaluate(999).position)


def test_repeated_preview_toggles_switch_camera_owner_deterministically() -> None:
    # Given
    demo = FakeDemo(auto_follow=True, preview_enabled=True, shot_plan=_shot_plan())
    cinematic = demo.client_sessions[7].cinematic

    # When
    demo.set_frame(client_id=7, frame_idx=5)
    cinematic.preview_enabled = False
    demo.set_frame(client_id=7, frame_idx=6)
    cinematic.preview_enabled = True
    demo.set_frame(client_id=7, frame_idx=10)

    # Then
    assert demo.followed_frames == [6]
    np.testing.assert_allclose(demo.client_sessions[7].client.camera.position, _shot_plan().evaluate(10).position)


def test_stale_client_frame_update_is_ignored() -> None:
    # Given
    demo = FakeDemo(auto_follow=True, preview_enabled=True, shot_plan=_shot_plan())
    del demo.client_sessions[7]

    # When
    demo.set_frame(client_id=7, frame_idx=5)

    # Then
    assert demo.followed_frames == []


def test_client_sessions_own_independent_cinematic_editor_state() -> None:
    # Given / When
    first = ClientSession(client=SimpleNamespace(), gui_elements=SimpleNamespace())
    second = ClientSession(client=SimpleNamespace(), gui_elements=SimpleNamespace())
    first.cinematic.preview_enabled = True
    first.cinematic.render_cancel.set()

    # Then
    assert first.cinematic is not second.cinematic
    assert first.cinematic.shot_plan.keyframes == ()
    assert second.cinematic.preview_enabled is False
    assert second.cinematic.render_cancel.is_set() is False
    assert first.cinematic.render_lock is not second.cinematic.render_lock
