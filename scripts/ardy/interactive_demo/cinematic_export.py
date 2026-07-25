"""Typed contracts for cinematic frame rendering and MP4 encoding."""

from __future__ import annotations

import math
import subprocess
import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Callable, Final, Protocol

import numpy as np
from typing_extensions import assert_never

FFMPEG_BINARY: Final = "/usr/bin/ffmpeg"
FRAME_PATTERN: Final = "frame_%06d.png"


class RenderRequestErrorCode(str, Enum):
    INVALID_FRAME_RANGE = "invalid_frame_range"
    INVALID_WIDTH = "invalid_width"
    INVALID_HEIGHT = "invalid_height"
    INVALID_FRAMES_PER_SECOND = "invalid_frames_per_second"
    INVALID_FRAME_INDEX = "invalid_frame_index"


@dataclass(frozen=True, slots=True)
class RenderRequestError(Exception):
    code: RenderRequestErrorCode
    detail: str

    def __str__(self) -> str:
        return f"{self.code.value}: {self.detail}"


@dataclass(frozen=True, slots=True)
class RenderRequest:
    """Validated frame range and output settings for one cinematic export."""

    frames_directory: Path
    output_path: Path
    start_frame: int
    end_frame: int
    width: int
    height: int
    frames_per_second: float

    def __post_init__(self) -> None:
        if self.start_frame < 0 or self.end_frame < self.start_frame:
            raise RenderRequestError(
                code=RenderRequestErrorCode.INVALID_FRAME_RANGE,
                detail=f"expected 0 <= start <= end, got {self.start_frame}..{self.end_frame}",
            )
        if self.width <= 0 or self.width % 2 != 0:
            raise RenderRequestError(
                code=RenderRequestErrorCode.INVALID_WIDTH,
                detail=f"width must be a positive even integer, got {self.width}",
            )
        if self.height <= 0 or self.height % 2 != 0:
            raise RenderRequestError(
                code=RenderRequestErrorCode.INVALID_HEIGHT,
                detail=f"height must be a positive even integer, got {self.height}",
            )
        if not math.isfinite(self.frames_per_second) or self.frames_per_second <= 0:
            raise RenderRequestError(
                code=RenderRequestErrorCode.INVALID_FRAMES_PER_SECOND,
                detail=f"frames per second must be finite and positive, got {self.frames_per_second}",
            )

    @property
    def frame_count(self) -> int:
        return self.end_frame - self.start_frame + 1


@dataclass(frozen=True, slots=True)
class RenderProgress:
    completed_frames: int
    total_frames: int


class ProgressReporter(Protocol):
    def report(self, progress: RenderProgress) -> None: ...


class CancellationSignal(Protocol):
    def is_set(self) -> bool: ...

    def wait(self, timeout: float) -> bool: ...


@dataclass(frozen=True, slots=True)
class FrameCaptureError(Exception):
    detail: str

    def __str__(self) -> str:
        return self.detail


class FrameCaptureCancelled(Exception):
    """The caller stopped waiting for a browser frame."""


@dataclass(slots=True)  # noqa: MUTABLE_OK
class _FrameCaptureState:
    """Request-private result box intentionally filled by one daemon helper."""

    done: threading.Event = field(default_factory=threading.Event)
    result: np.ndarray | None = None
    error: Exception | None = None


class FrameCaptureGate:  # noqa: MUTABLE_OK
    """Allow one uncorrelated Viser capture until its helper truly drains."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state: _FrameCaptureState | None = None

    def is_busy(self) -> bool:
        with self._lock:
            return self._state is not None and not self._state.done.is_set()

    def wait_until_drained(self, timeout: float) -> bool:
        with self._lock:
            state = self._state
        return state is None or state.done.wait(timeout)

    def capture(self, call: Callable[[], np.ndarray], cancellation: CancellationSignal,
                timeout_seconds: float) -> np.ndarray:
        with self._lock:
            if self._state is not None and not self._state.done.is_set():
                raise FrameCaptureError("Previous camera capture is still draining")
            state = _FrameCaptureState()
            self._state = state
        helper = threading.Thread(target=self._run, args=(call, state), daemon=True, name="viser-frame-capture")
        try:
            helper.start()
        except RuntimeError:
            state.done.set()
            raise
        deadline = time.monotonic() + timeout_seconds
        while True:
            if cancellation.is_set():
                raise FrameCaptureCancelled()
            remaining = deadline - time.monotonic()
            if remaining <= 0.0:
                raise FrameCaptureError(f"Camera render timed out after {timeout_seconds:g}s")
            if state.done.wait(min(0.05, remaining)):
                break
        if cancellation.is_set():
            raise FrameCaptureCancelled()
        if state.error is not None:
            raise state.error
        assert state.result is not None
        return state.result

    @staticmethod
    def _run(call: Callable[[], np.ndarray], state: _FrameCaptureState) -> None:
        try:  # noqa: BROAD_EXCEPT_OK - daemon boundary returns the exact camera failure to its owner.
            state.result = call()
        except Exception as error:  # noqa: BROAD_EXCEPT_OK
            state.error = error
        finally:
            state.done.set()


@dataclass(frozen=True, slots=True)
class RenderCancelled:
    completed_frames: int
    total_frames: int


@dataclass(frozen=True, slots=True)
class FfmpegSucceeded:
    output_path: Path
    frame_count: int


@dataclass(frozen=True, slots=True)
class FfmpegFailed:
    output_path: Path
    returncode: int
    stderr: str
    argv: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class FfmpegTimedOut:
    output_path: Path
    timeout_seconds: float
    argv: tuple[str, ...]


RenderResult = RenderCancelled | FfmpegSucceeded | FfmpegFailed | FfmpegTimedOut


@dataclass(frozen=True, slots=True)
class ProcessCompleted:
    returncode: int
    stderr: str


@dataclass(frozen=True, slots=True)
class ProcessTimedOut:
    timeout_seconds: float


@dataclass(frozen=True, slots=True)
class ProcessCancelled:
    """The encoder process was stopped after cancellation was requested."""


ProcessResult = ProcessCompleted | ProcessTimedOut | ProcessCancelled


class FfmpegRunner(Protocol):
    def run(self, argv: list[str], cancellation: CancellationSignal) -> ProcessResult: ...


@dataclass(frozen=True, slots=True)
class SubprocessFfmpegRunner:
    """Run ffmpeg without a shell and bound how long encoding may block."""

    timeout_seconds: float = 300.0
    poll_seconds: float = 0.05
    terminate_timeout_seconds: float = 1.0

    def run(self, argv: list[str], cancellation: CancellationSignal) -> ProcessResult:
        process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        deadline = time.monotonic() + self.timeout_seconds
        while True:
            if cancellation.is_set():
                self._stop(process)
                return ProcessCancelled()
            remaining = deadline - time.monotonic()
            if remaining <= 0.0:
                self._stop(process)
                return ProcessTimedOut(timeout_seconds=self.timeout_seconds)
            try:
                _stdout, stderr = process.communicate(timeout=min(self.poll_seconds, remaining))
            except subprocess.TimeoutExpired:
                continue
            if cancellation.is_set():
                return ProcessCancelled()
            return ProcessCompleted(returncode=process.returncode, stderr=stderr)

    def _stop(self, process: subprocess.Popen[str]) -> None:
        try:
            process.terminate()
        except ProcessLookupError:
            process.communicate()
            return
        try:
            process.communicate(timeout=self.terminate_timeout_seconds)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()


def frame_file_path(frames_directory: Path, frame_index: int) -> Path:
    """Return the stable six-digit PNG path for a motion frame."""

    if frame_index < 0:
        raise RenderRequestError(
            code=RenderRequestErrorCode.INVALID_FRAME_INDEX,
            detail=f"frame index must be non-negative, got {frame_index}",
        )
    return frames_directory / f"frame_{frame_index:06d}.png"


def build_ffmpeg_argv(request: RenderRequest) -> list[str]:
    """Build a shell-free ffmpeg argument vector for the rendered PNG sequence."""

    fps = format(request.frames_per_second, "g")
    return [
        FFMPEG_BINARY, "-y", "-nostdin", "-framerate", fps,
        "-start_number", str(request.start_frame),
        "-i", str(request.frames_directory / FRAME_PATTERN),
        "-frames:v", str(request.frame_count),
        "-vf", f"scale={request.width}:{request.height}:flags=lanczos",
        "-r", fps, "-c:v", "libx264", "-pix_fmt", "yuv420p",
        str(request.output_path),
    ]


def encode_video(
    request: RenderRequest,
    runner: FfmpegRunner,
    cancellation: CancellationSignal,
) -> RenderResult:
    """Encode completed frames unless cancellation was already requested."""

    if cancellation.is_set():
        return RenderCancelled(completed_frames=0, total_frames=request.frame_count)

    argv = build_ffmpeg_argv(request)
    process_result = runner.run(argv, cancellation)
    if cancellation.is_set():
        return RenderCancelled(completed_frames=request.frame_count, total_frames=request.frame_count)
    match process_result:
        case ProcessCompleted(returncode=returncode, stderr=stderr):
            if returncode == 0:
                return FfmpegSucceeded(output_path=request.output_path, frame_count=request.frame_count)
            return FfmpegFailed(
                output_path=request.output_path,
                returncode=returncode,
                stderr=stderr,
                argv=tuple(argv),
            )
        case ProcessTimedOut(timeout_seconds=timeout_seconds):
            return FfmpegTimedOut(
                output_path=request.output_path,
                timeout_seconds=timeout_seconds,
                argv=tuple(argv),
            )
        case ProcessCancelled():
            return RenderCancelled(completed_frames=request.frame_count, total_frames=request.frame_count)
        case unreachable:
            assert_never(unreachable)
