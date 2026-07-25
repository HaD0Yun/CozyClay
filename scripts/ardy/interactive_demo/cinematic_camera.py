"""Typed cinematic camera formats, poses, keyframes, and shot plans."""

from __future__ import annotations

import math
from dataclasses import dataclass
from enum import Enum, unique
from typing import Final, Literal, TypeAlias

import numpy as np
from pydantic import BaseModel, ConfigDict, ValidationError, field_validator, model_validator
from pydantic_core import PydanticCustomError
from scipy.spatial.transform import Rotation, Slerp
from typing_extensions import assert_never

Vector3: TypeAlias = tuple[float, float, float]
FULL_FRAME_SENSOR_HEIGHT_MM: Final = 24.0
MAX_OUTPUT_DIMENSION: Final = 8192


@dataclass(frozen=True, slots=True)
class CinematicCameraError(Exception):
    """A camera value or shot-plan boundary could not be parsed."""

    detail: str

    def __str__(self) -> str:
        return self.detail


class _FrozenModel(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", strict=True)


@unique
class OutputFormatPreset(str, Enum):
    HD_16_9 = "hd_16_9"
    SCOPE_2_39 = "scope_2_39"
    FLAT_1_85 = "flat_1_85"
    VERTICAL_9_16 = "vertical_9_16"
    SQUARE_1_1 = "square_1_1"


class OutputFormat(_FrozenModel):
    width: int
    height: int

    @field_validator("width", "height")
    @classmethod
    def _validate_dimension(cls, value: int) -> int:
        if value <= 0 or value > MAX_OUTPUT_DIMENSION or value % 2 != 0:
            raise PydanticCustomError(
                "output_dimension",
                "dimensions must be positive even integers no larger than 8192",
            )
        return value

    @classmethod
    def from_preset(cls, preset: OutputFormatPreset) -> OutputFormat:
        match preset:
            case OutputFormatPreset.HD_16_9:
                dimensions = (1920, 1080)
            case OutputFormatPreset.SCOPE_2_39:
                dimensions = (1920, 804)
            case OutputFormatPreset.FLAT_1_85:
                dimensions = (1920, 1038)
            case OutputFormatPreset.VERTICAL_9_16:
                dimensions = (1080, 1920)
            case OutputFormatPreset.SQUARE_1_1:
                dimensions = (1080, 1080)
            case unreachable:
                assert_never(unreachable)
        return cls(width=dimensions[0], height=dimensions[1])

    @classmethod
    def custom(cls, width: int | float, height: int | float) -> OutputFormat:
        try:
            return cls.model_validate({"width": width, "height": height})
        except ValidationError as error:
            raise CinematicCameraError(detail=f"invalid output dimensions: {error}") from None


@unique
class LensPreset(str, Enum):
    WIDE_24MM = "24mm"
    WIDE_35MM = "35mm"
    NORMAL_50MM = "50mm"
    PORTRAIT_85MM = "85mm"


class Lens(_FrozenModel):
    vertical_fov_radians: float

    @field_validator("vertical_fov_radians")
    @classmethod
    def _validate_fov(cls, value: float) -> float:
        if not math.isfinite(value) or value <= 0.0 or value >= math.pi:
            raise PydanticCustomError(
                "vertical_fov",
                "vertical field of view must be finite and between zero and pi radians",
            )
        return value

    @classmethod
    def from_preset(cls, preset: LensPreset) -> Lens:
        return cls.from_focal_length_mm(float(preset.value.removesuffix("mm")))

    @classmethod
    def from_focal_length_mm(cls, focal_length_mm: float) -> Lens:
        if not math.isfinite(focal_length_mm) or focal_length_mm <= 0.0:
            raise CinematicCameraError(detail="focal length must be a positive finite number")
        vertical_fov = 2.0 * math.atan(FULL_FRAME_SENSOR_HEIGHT_MM / (2.0 * focal_length_mm))
        return cls(vertical_fov_radians=vertical_fov)

    @classmethod
    def from_vertical_fov(cls, vertical_fov_radians: float) -> Lens:
        try:
            return cls(vertical_fov_radians=vertical_fov_radians)
        except ValidationError as error:
            raise CinematicCameraError(detail=f"invalid vertical field of view: {error}") from None

    @property
    def focal_length_mm(self) -> float:
        return FULL_FRAME_SENSOR_HEIGHT_MM / (2.0 * math.tan(self.vertical_fov_radians / 2.0))


class CameraPose(_FrozenModel):
    position: Vector3
    look_at: Vector3
    up: Vector3
    vertical_fov_radians: float

    @field_validator("position", "look_at", "up")
    @classmethod
    def _validate_vector(cls, value: Vector3) -> Vector3:
        if not all(math.isfinite(component) for component in value):
            raise PydanticCustomError("camera_vector", "camera vectors must contain only finite numbers")
        return value

    @field_validator("vertical_fov_radians")
    @classmethod
    def _validate_pose_fov(cls, value: float) -> float:
        return Lens(vertical_fov_radians=value).vertical_fov_radians

    @model_validator(mode="after")
    def _validate_basis(self) -> CameraPose:
        view = tuple(target - source for source, target in zip(self.position, self.look_at, strict=True))
        view_length = math.sqrt(sum(component * component for component in view))
        up_length = math.sqrt(sum(component * component for component in self.up))
        cross = (
            view[1] * self.up[2] - view[2] * self.up[1],
            view[2] * self.up[0] - view[0] * self.up[2],
            view[0] * self.up[1] - view[1] * self.up[0],
        )
        cross_length = math.sqrt(sum(component * component for component in cross))
        if view_length <= 1e-9 or up_length <= 1e-9 or cross_length <= 1e-9:
            raise PydanticCustomError(
                "camera_basis",
                "position, look-at, and up must define a non-degenerate camera pose",
            )
        return self

    @classmethod
    def create(
        cls,
        position: Vector3,
        look_at: Vector3,
        up: Vector3,
        vertical_fov_radians: float,
    ) -> CameraPose:
        try:
            return cls(position=position, look_at=look_at, up=up, vertical_fov_radians=vertical_fov_radians)
        except ValidationError as error:
            raise CinematicCameraError(detail=f"invalid camera pose: {error}") from None


@unique
class Transition(str, Enum):
    SMOOTH = "smooth"
    CUT = "cut"


class CameraKeyframe(_FrozenModel):
    """A pose at one frame; transition controls travel from the previous key."""

    frame: int
    pose: CameraPose
    transition: Transition = Transition.SMOOTH

    @field_validator("frame")
    @classmethod
    def _validate_frame(cls, value: int) -> int:
        if value < 0:
            raise PydanticCustomError("camera_frame", "frame must be zero or greater")
        return value


class ShotPlan(_FrozenModel):
    """An immutable, ordered cinematic camera timeline."""

    version: Literal[1]
    output_format: OutputFormat
    keyframes: tuple[CameraKeyframe, ...]

    @model_validator(mode="after")
    def _validate_key_order(self) -> ShotPlan:
        frames = tuple(key.frame for key in self.keyframes)
        if frames != tuple(sorted(set(frames))):
            raise PydanticCustomError(
                "keyframe_order",
                "keyframes must have unique frames in ascending order",
            )
        return self

    @classmethod
    def empty(cls, output_format: OutputFormat) -> ShotPlan:
        return cls(version=1, output_format=output_format, keyframes=())

    def add(self, keyframe: CameraKeyframe) -> ShotPlan:
        by_frame = {key.frame: key for key in self.keyframes}
        by_frame[keyframe.frame] = keyframe
        ordered = tuple(by_frame[frame] for frame in sorted(by_frame))
        return ShotPlan(version=1, output_format=self.output_format, keyframes=ordered)

    def remove(self, frame: int) -> ShotPlan:
        retained = tuple(key for key in self.keyframes if key.frame != frame)
        return ShotPlan(version=1, output_format=self.output_format, keyframes=retained)

    def evaluate(self, frame: int) -> CameraPose:
        if frame < 0:
            raise CinematicCameraError(detail="camera evaluation frame must be zero or greater")
        if not self.keyframes:
            raise CinematicCameraError(detail="shot plan has no camera keyframes")
        if frame <= self.keyframes[0].frame:
            return self.keyframes[0].pose
        if frame >= self.keyframes[-1].frame:
            return self.keyframes[-1].pose
        for left, right in zip(self.keyframes, self.keyframes[1:], strict=True):
            if frame > right.frame:
                continue
            if frame == right.frame:
                return right.pose
            match right.transition:
                case Transition.CUT:
                    return left.pose
                case Transition.SMOOTH:
                    span = right.frame - left.frame
                    progress = (frame - left.frame) / span
                    eased = progress * progress * (3.0 - 2.0 * progress)
                    return _interpolate_pose(left.pose, right.pose, eased)
                case unreachable:
                    assert_never(unreachable)
        raise CinematicCameraError(detail=f"camera frame {frame} is outside the keyframe timeline")

    def to_json(self) -> str:
        return self.model_dump_json(indent=2)

    @classmethod
    def from_json(cls, raw_json: str) -> ShotPlan:
        try:
            return cls.model_validate_json(raw_json)
        except ValidationError as error:
            raise CinematicCameraError(detail=f"invalid shot plan JSON: {error}") from None


def _interpolate_pose(start: CameraPose, end: CameraPose, amount: float) -> CameraPose:
    rotations = Rotation.concatenate((_camera_rotation(start), _camera_rotation(end)))
    matrix = Slerp((0.0, 1.0), rotations)((amount,)).as_matrix()[0]
    position = tuple(a + (b - a) * amount for a, b in zip(start.position, end.position, strict=True))
    start_distance = math.dist(start.position, start.look_at)
    focus_distance = start_distance + (math.dist(end.position, end.look_at) - start_distance) * amount
    look_at = tuple(float(position[index] - matrix[index, 2] * focus_distance) for index in range(3))
    up = tuple(float(matrix[index, 1]) for index in range(3))
    return CameraPose.create(
        position=position,
        look_at=look_at,
        up=up,
        vertical_fov_radians=start.vertical_fov_radians
        + (end.vertical_fov_radians - start.vertical_fov_radians) * amount,
    )


def _camera_rotation(pose: CameraPose) -> Rotation:
    forward = np.subtract(pose.look_at, pose.position)
    forward /= np.linalg.norm(forward)
    right = np.cross(forward, pose.up)
    right /= np.linalg.norm(right)
    corrected_up = np.cross(right, forward)
    return Rotation.from_matrix(np.column_stack((right, corrected_up, -forward)))
