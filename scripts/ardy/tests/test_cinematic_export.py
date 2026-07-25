import threading
from pathlib import Path

import pytest
from scripts.interactive_demo.cinematic_export import (
    FfmpegFailed,
    FfmpegSucceeded,
    FfmpegTimedOut,
    ProcessCompleted,
    ProcessTimedOut,
    RenderCancelled,
    RenderRequest,
    RenderRequestError,
    build_ffmpeg_argv,
    encode_video,
    frame_file_path,
)


class FakeRunner:
    def __init__(self, result: ProcessCompleted | ProcessTimedOut) -> None:
        self.result = result
        self.calls: list[list[str]] = []

    def run(
        self, argv: list[str], cancellation: threading.Event
    ) -> ProcessCompleted | ProcessTimedOut:
        self.calls.append(argv)
        return self.result


class CancellingSuccessRunner(FakeRunner):
    def run(self, argv: list[str], cancellation: threading.Event) -> ProcessCompleted:
        self.calls.append(argv)
        cancellation.set()
        Path(argv[-1]).write_bytes(b"partial")
        return ProcessCompleted(returncode=0, stderr="")


def make_request(tmp_path: Path) -> RenderRequest:
    return RenderRequest(
        frames_directory=tmp_path / "frames with spaces",
        output_path=tmp_path / "exports with spaces" / "shot one.mp4",
        start_frame=0,
        end_frame=2,
        width=1920,
        height=1080,
        frames_per_second=20.0,
    )


@pytest.mark.parametrize(
    ("start_frame", "end_frame"),
    [(-1, 2), (3, 2)],
)
def test_render_request_rejects_malformed_frame_range(
    tmp_path: Path,
    start_frame: int,
    end_frame: int,
) -> None:
    # Given
    request_fields = {
        "frames_directory": tmp_path / "frames",
        "output_path": tmp_path / "out.mp4",
        "start_frame": start_frame,
        "end_frame": end_frame,
        "width": 1920,
        "height": 1080,
        "frames_per_second": 20.0,
    }

    # When / Then
    with pytest.raises(RenderRequestError):
        RenderRequest(**request_fields)


@pytest.mark.parametrize(("width", "height"), [(0, 1080), (1920, -2), (1919, 1080), (1920, 1079)])
def test_render_request_rejects_nonpositive_or_odd_dimensions(
    tmp_path: Path,
    width: int,
    height: int,
) -> None:
    # Given / When / Then
    with pytest.raises(RenderRequestError):
        RenderRequest(
            frames_directory=tmp_path / "frames",
            output_path=tmp_path / "out.mp4",
            start_frame=0,
            end_frame=2,
            width=width,
            height=height,
            frames_per_second=20.0,
        )


def test_frame_file_path_is_zero_padded_and_deterministic(tmp_path: Path) -> None:
    # Given
    frames_directory = tmp_path / "frames"

    # When
    paths = [frame_file_path(frames_directory, index) for index in (0, 1, 42)]

    # Then
    assert [path.name for path in paths] == ["frame_000000.png", "frame_000001.png", "frame_000042.png"]


def test_build_ffmpeg_argv_preserves_paths_and_native_fps(tmp_path: Path) -> None:
    # Given
    request = make_request(tmp_path)

    # When
    argv = build_ffmpeg_argv(request)

    # Then
    assert argv[0] == "/usr/bin/ffmpeg"
    assert argv[argv.index("-framerate") + 1] == "20"
    assert argv[argv.index("-start_number") + 1] == "0"
    assert argv[argv.index("-frames:v") + 1] == "3"
    assert argv[argv.index("-c:v") + 1] == "libx264"
    assert argv[argv.index("-pix_fmt") + 1] == "yuv420p"
    assert str(request.frames_directory / "frame_%06d.png") in argv
    assert str(request.output_path) in argv


def test_encode_video_returns_cancelled_without_starting_process(tmp_path: Path) -> None:
    # Given
    request = make_request(tmp_path)
    runner = FakeRunner(ProcessCompleted(returncode=0, stderr=""))
    cancellation = threading.Event()
    cancellation.set()

    # When
    result = encode_video(request, runner, cancellation)

    # Then
    assert result == RenderCancelled(completed_frames=0, total_frames=3)
    assert runner.calls == []


def test_encode_video_reports_nonzero_ffmpeg_exit(tmp_path: Path) -> None:
    # Given
    request = make_request(tmp_path)
    runner = FakeRunner(ProcessCompleted(returncode=9, stderr="decoder exploded"))

    # When
    result = encode_video(request, runner, threading.Event())

    # Then
    assert isinstance(result, FfmpegFailed)
    assert result.returncode == 9
    assert result.stderr == "decoder exploded"
    assert result.argv == tuple(runner.calls[0])


def test_encode_video_reports_timeout(tmp_path: Path) -> None:
    # Given
    request = make_request(tmp_path)
    runner = FakeRunner(ProcessTimedOut(timeout_seconds=0.01))

    # When
    result = encode_video(request, runner, threading.Event())

    # Then
    assert isinstance(result, FfmpegTimedOut)
    assert result.timeout_seconds == 0.01


def test_encode_video_reports_success_only_for_zero_exit(tmp_path: Path) -> None:
    # Given
    request = make_request(tmp_path)
    runner = FakeRunner(ProcessCompleted(returncode=0, stderr="misleading warning"))

    # When
    result = encode_video(request, runner, threading.Event())

    # Then
    assert result == FfmpegSucceeded(output_path=request.output_path, frame_count=3)


def test_encode_video_cancel_after_runner_starts_overrides_success(tmp_path: Path) -> None:
    # Given
    request = make_request(tmp_path)
    request.output_path.parent.mkdir(parents=True)
    runner = CancellingSuccessRunner(ProcessCompleted(returncode=0, stderr=""))
    cancellation = threading.Event()

    # When
    result = encode_video(request, runner, cancellation)

    # Then
    assert result == RenderCancelled(completed_frames=3, total_frames=3)
