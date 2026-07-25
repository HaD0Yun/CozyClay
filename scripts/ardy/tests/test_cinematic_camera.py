import json
import math

import pytest

from scripts.interactive_demo import cinematic_camera


PRESET_CASES = (
    ("hd_16_9", (1920, 1080)),
    ("scope_2_39", (1920, 804)),
    ("flat_1_85", (1920, 1038)),
    ("vertical_9_16", (1080, 1920)),
    ("square_1_1", (1080, 1080)),
)


@pytest.mark.parametrize(("preset", "expected"), PRESET_CASES)
def test_output_format_preset_returns_exact_even_dimensions(preset: str, expected: tuple[int, int]) -> None:
    # Given / When
    output = cinematic_camera.OutputFormat.from_preset(cinematic_camera.OutputFormatPreset(preset))

    # Then
    assert (output.width, output.height) == expected


@pytest.mark.parametrize(
    ("width", "height"),
    ((0, 1080), (1921, 1080), (1920, 1079), (10000, 1080), (math.nan, 1080)),
)
def test_custom_output_format_rejects_invalid_dimensions(width: int | float, height: int | float) -> None:
    # Given / When / Then
    with pytest.raises(cinematic_camera.CinematicCameraError, match="dimensions"):
        cinematic_camera.OutputFormat.custom(width=width, height=height)


def test_custom_output_format_accepts_even_dimensions() -> None:
    # Given / When
    output = cinematic_camera.OutputFormat.custom(width=2048, height=858)

    # Then
    assert (output.width, output.height) == (2048, 858)


@pytest.mark.parametrize("focal_length", (24.0, 35.0, 50.0, 85.0))
def test_lens_fov_round_trip_preserves_full_frame_focal_length(focal_length: float) -> None:
    # Given
    lens = cinematic_camera.Lens.from_focal_length_mm(focal_length)

    # When
    round_trip = lens.focal_length_mm

    # Then
    assert round_trip == pytest.approx(focal_length)
    assert 0.0 < lens.vertical_fov_radians < math.pi


@pytest.mark.parametrize(
    ("preset", "focal_length"),
    (
        (cinematic_camera.LensPreset.WIDE_24MM, 24.0),
        (cinematic_camera.LensPreset.WIDE_35MM, 35.0),
        (cinematic_camera.LensPreset.NORMAL_50MM, 50.0),
        (cinematic_camera.LensPreset.PORTRAIT_85MM, 85.0),
    ),
)
def test_lens_preset_maps_to_named_full_frame_focal_length(
    preset: cinematic_camera.LensPreset,
    focal_length: float,
) -> None:
    # Given / When
    lens = cinematic_camera.Lens.from_preset(preset)

    # Then
    assert lens.focal_length_mm == pytest.approx(focal_length)


@pytest.mark.parametrize("vertical_fov", (0.0, math.pi, math.nan))
def test_lens_rejects_invalid_vertical_fov(vertical_fov: float) -> None:
    # Given / When / Then
    with pytest.raises(cinematic_camera.CinematicCameraError, match="field of view"):
        cinematic_camera.Lens.from_vertical_fov(vertical_fov)


@pytest.mark.parametrize(
    ("position", "look_at", "up"),
    (
        ((math.nan, 0.0, 0.0), (0.0, 0.0, 0.0), (0.0, 1.0, 0.0)),
        ((0.0, 0.0, 0.0), (0.0, 0.0, 0.0), (0.0, 1.0, 0.0)),
        ((0.0, 0.0, 1.0), (0.0, 0.0, 0.0), (0.0, 0.0, 2.0)),
    ),
)
def test_camera_pose_rejects_non_finite_or_degenerate_vectors(
    position: tuple[float, float, float],
    look_at: tuple[float, float, float],
    up: tuple[float, float, float],
) -> None:
    # Given / When / Then
    with pytest.raises(cinematic_camera.CinematicCameraError, match="camera pose"):
        cinematic_camera.CameraPose.create(
            position=position,
            look_at=look_at,
            up=up,
            vertical_fov_radians=1.0,
        )


def _pose(x: float, fov: float = 1.0) -> cinematic_camera.CameraPose:
    return cinematic_camera.CameraPose.create(
        position=(x, 1.0, 4.0),
        look_at=(x, 1.0, 0.0),
        up=(0.0, 1.0, 0.0),
        vertical_fov_radians=fov,
    )


def _empty_plan(
    preset: cinematic_camera.OutputFormatPreset = cinematic_camera.OutputFormatPreset.HD_16_9,
) -> cinematic_camera.ShotPlan:
    return cinematic_camera.ShotPlan.empty(cinematic_camera.OutputFormat.from_preset(preset))


def test_add_key_replaces_same_frame_and_keeps_order() -> None:
    # Given
    plan = _empty_plan()

    # When
    plan = plan.add(cinematic_camera.CameraKeyframe(frame=20, pose=_pose(20.0)))
    plan = plan.add(cinematic_camera.CameraKeyframe(frame=5, pose=_pose(5.0)))
    plan = plan.add(cinematic_camera.CameraKeyframe(frame=20, pose=_pose(21.0)))

    # Then
    assert tuple(key.frame for key in plan.keyframes) == (5, 20)
    assert plan.keyframes[1].pose.position[0] == 21.0


def test_remove_key_returns_sorted_plan_without_requested_frame() -> None:
    # Given
    plan = _empty_plan()
    for frame in (20, 5, 10):
        plan = plan.add(cinematic_camera.CameraKeyframe(frame=frame, pose=_pose(float(frame))))

    # When
    result = plan.remove(frame=10)

    # Then
    assert tuple(key.frame for key in result.keyframes) == (5, 20)


def test_evaluate_holds_pose_before_first_and_after_last_key() -> None:
    # Given
    plan = _empty_plan()
    plan = plan.add(cinematic_camera.CameraKeyframe(frame=10, pose=_pose(1.0)))
    plan = plan.add(cinematic_camera.CameraKeyframe(frame=20, pose=_pose(9.0)))

    # When
    before = plan.evaluate(frame=0)
    after = plan.evaluate(frame=99)

    # Then
    assert before == _pose(1.0)
    assert after == _pose(9.0)


def test_smooth_transition_uses_eased_midpoint_for_pose_and_fov() -> None:
    # Given
    plan = _empty_plan()
    plan = plan.add(cinematic_camera.CameraKeyframe(frame=0, pose=_pose(0.0, 0.8)))
    plan = plan.add(
        cinematic_camera.CameraKeyframe(
            frame=10,
            pose=_pose(10.0, 1.2),
            transition=cinematic_camera.Transition.SMOOTH,
        )
    )

    # When
    quarter = plan.evaluate(frame=2)
    midpoint = plan.evaluate(frame=5)

    # Then
    assert quarter.position[0] == pytest.approx(1.04)
    assert midpoint.position[0] == pytest.approx(5.0)
    assert midpoint.vertical_fov_radians == pytest.approx(1.0)


def test_smooth_transition_remains_valid_when_camera_crosses_original_target() -> None:
    # Given
    start = cinematic_camera.CameraPose.create(
        position=(0.0, 0.0, 1.0),
        look_at=(0.0, 0.0, 0.0),
        up=(0.0, 1.0, 0.0),
        vertical_fov_radians=1.0,
    )
    end = cinematic_camera.CameraPose.create(
        position=(0.0, 0.0, -1.0),
        look_at=(0.0, 0.0, 0.0),
        up=(0.0, 1.0, 0.0),
        vertical_fov_radians=1.0,
    )
    plan = _empty_plan().add(cinematic_camera.CameraKeyframe(frame=0, pose=start))
    plan = plan.add(cinematic_camera.CameraKeyframe(frame=10, pose=end))

    # When
    poses = tuple(plan.evaluate(frame) for frame in range(11))

    # Then
    assert poses[0] == start
    assert poses[-1] == end
    assert all(
        math.isfinite(component)
        for pose in poses
        for vector in (pose.position, pose.look_at, pose.up)
        for component in vector
    )
    assert all(pose.position != pose.look_at for pose in poses)
    assert max(
        math.dist(poses[index].look_at, poses[index + 1].look_at)
        for index in range(len(poses) - 1)
    ) < 1.0


def test_smooth_transition_remains_valid_when_endpoint_up_vectors_are_opposite() -> None:
    # Given
    start = cinematic_camera.CameraPose.create(
        position=(0.0, 0.0, 1.0),
        look_at=(0.0, 0.0, 0.0),
        up=(0.0, 1.0, 0.0),
        vertical_fov_radians=1.0,
    )
    end = cinematic_camera.CameraPose.create(
        position=(0.0, 0.0, 1.0),
        look_at=(0.0, 0.0, 0.0),
        up=(0.0, -1.0, 0.0),
        vertical_fov_radians=1.0,
    )
    plan = _empty_plan().add(cinematic_camera.CameraKeyframe(frame=0, pose=start))
    plan = plan.add(cinematic_camera.CameraKeyframe(frame=10, pose=end))

    # When
    poses = tuple(plan.evaluate(frame) for frame in range(11))

    # Then
    assert poses[0] == start
    assert poses[-1] == end
    assert all(math.isfinite(component) for pose in poses for component in pose.up)
    assert all(math.sqrt(sum(component * component for component in pose.up)) > 0.99 for pose in poses)


def test_cut_transition_switches_exactly_at_destination_frame() -> None:
    # Given
    first = _pose(0.0)
    second = _pose(10.0)
    plan = _empty_plan()
    plan = plan.add(cinematic_camera.CameraKeyframe(frame=0, pose=first))
    plan = plan.add(cinematic_camera.CameraKeyframe(frame=10, pose=second, transition=cinematic_camera.Transition.CUT))

    # When
    frame_nine = plan.evaluate(frame=9)
    frame_ten = plan.evaluate(frame=10)

    # Then
    assert frame_nine == first
    assert frame_ten == second


def test_json_round_trip_preserves_versioned_plan() -> None:
    # Given
    plan = _empty_plan(cinematic_camera.OutputFormatPreset.SCOPE_2_39)
    plan = plan.add(cinematic_camera.CameraKeyframe(frame=0, pose=_pose(0.0)))
    plan = plan.add(
        cinematic_camera.CameraKeyframe(
            frame=12,
            pose=_pose(4.0),
            transition=cinematic_camera.Transition.CUT,
        )
    )

    # When
    raw_json = plan.to_json()
    loaded = cinematic_camera.ShotPlan.from_json(raw_json)

    # Then
    assert loaded == plan
    assert json.loads(raw_json)["version"] == 1
    assert "\n  \"output_format\"" in raw_json


@pytest.mark.parametrize(
    "raw_json",
    (
        "not-json",
        '{"output_format": {"width": 1920, "height": 1080}, "keyframes": []}',
        '{"version": 2, "output_format": {"width": 1920, "height": 1080}, "keyframes": []}',
        '{"version": 1, "output_format": {"width": 1920, "height": 1080}}',
        '{"version": 1, "output_format": {"width": 1920, "height": 1080}, "keyframes": [{"frame": -1}]}',
        '{"version": 1, "output_format": {"width": 1920.0, "height": 1080}, "keyframes": []}',
        (
            '{"version": 1, "output_format": {"width": 1920, "height": 1080}, "keyframes": '
            '[{"frame": true, "pose": {"position": [0, 1, 4], "look_at": [0, 1, 0], '
            '"up": [0, 1, 0], "vertical_fov_radians": 1.0}}]}'
        ),
        (
            '{"version": 1, "output_format": {"width": 1920, "height": 1080}, "keyframes": '
            '[{"frame": 1.0, "pose": {"position": [0, 1, 4], "look_at": [0, 1, 0], '
            '"up": [0, 1, 0], "vertical_fov_radians": 1.0}}]}'
        ),
        (
            '{"version": 1, "output_format": {"width": 1920, "height": 1080}, "keyframes": '
            '[{"frame": 1, "pose": {"position": ["0", 1, 4], "look_at": [0, 1, 0], '
            '"up": [0, 1, 0], "vertical_fov_radians": 1.0}}]}'
        ),
    ),
)
def test_json_parser_reports_actionable_typed_error(raw_json: str) -> None:
    # Given / When / Then
    with pytest.raises(cinematic_camera.CinematicCameraError, match="shot plan JSON") as captured:
        cinematic_camera.ShotPlan.from_json(raw_json)

    assert captured.value.detail


def test_evaluate_empty_plan_reports_typed_error() -> None:
    # Given
    plan = _empty_plan()

    # When / Then
    with pytest.raises(cinematic_camera.CinematicCameraError, match="no camera keyframes"):
        plan.evaluate(frame=0)
