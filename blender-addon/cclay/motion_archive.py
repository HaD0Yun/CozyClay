"""Typed, read-only ARDY motion archive boundary."""

from __future__ import annotations

import ast
import math
import re
import struct
import sys
import zipfile
from pathlib import Path

from . import motion_retarget

MOTION_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


class MotionArchiveError(ValueError):
    """A motion archive failed a closed bridge-contract boundary."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


def validate_motion_id(motion_id: object) -> str:
    """Return a valid ARDY motion id or raise a typed domain error."""
    if not isinstance(motion_id, str) or MOTION_ID.fullmatch(motion_id) is None:
        raise MotionArchiveError(
            "APPLY_MOTION_MALFORMED",
            "motion_id must be a lowercase [a-z0-9-] slug of at most 64 characters",
        )
    return motion_id



_MAX_MOTION_FILE_BYTES = 64 * 1024 * 1024
_MAX_MOTION_PAYLOAD_BYTES = 96 * 1024 * 1024
_MAX_NPY_HEADER_BYTES = 16 * 1024
_MOTION_REQUIRED_MEMBERS = {
    "local_rot_mats.npy",
    "posed_joints.npy",
    "fps.npy",
}
# ARDY writes these next to the three members we consume: scripts/generate.py
# and both cclay_* generators end in np.savez(path, **motion_dict), so a real
# generated motion always carries them. Demanding an exact three-member set
# rejected every unmodified ARDY npz (measured: 16 of 42 staged motions failed
# APPLY_MOTION_MALFORMED), so they are validated and carried rather than
# stripped -- stripping would also throw away foot_contacts, which the model
# predicts and preflight currently re-derives from joint heights.
# Shapes are frame-locked to local_rot_mats so a carried member cannot smuggle
# in a different clip; ``None`` in a shape means "the clip's frame count".
_MOTION_OPTIONAL_MEMBERS = {
    "foot_contacts.npy": (("b",), (None, 4)),
    "global_rot_mats.npy": (("f",), (None, 27, 3, 3)),
    "global_root_heading.npy": (("f",), (None, 2)),
    "root_positions.npy": (("f",), (None, 3)),
    "smooth_root_pos.npy": (("f",), (None, 3)),
    "text.npy": (("U",), ()),
}
_MOTION_MEMBER_NAMES = _MOTION_REQUIRED_MEMBERS | set(_MOTION_OPTIONAL_MEMBERS)

def _malformed(motion_id: str, message: str) -> None:
    raise MotionArchiveError("APPLY_MOTION_MALFORMED", f"motion {motion_id} {message}")


def _inspect_member(archive, info, motion_id: str):
    try:
        with archive.open(info, "r") as member:
            if member.read(6) != b"\x93NUMPY":
                _malformed(motion_id, f"{info.filename} has an invalid npy magic")
            version = tuple(member.read(2))
            if version == (1, 0):
                header_length_bytes = member.read(2)
                if len(header_length_bytes) != 2:
                    raise EOFError("truncated npy header length")
                header_length = struct.unpack("<H", header_length_bytes)[0]
                encoding = "latin1"
            elif version in ((2, 0), (3, 0)):
                header_length_bytes = member.read(4)
                if len(header_length_bytes) != 4:
                    raise EOFError("truncated npy header length")
                header_length = struct.unpack("<I", header_length_bytes)[0]
                encoding = "utf-8" if version == (3, 0) else "latin1"
            else:
                _malformed(
                    motion_id,
                    f"{info.filename} uses unsupported npy version {version}",
                )
            if header_length > _MAX_NPY_HEADER_BYTES:
                _malformed(
                    motion_id,
                    f"{info.filename} header exceeds {_MAX_NPY_HEADER_BYTES} bytes",
                )
            header_bytes = member.read(header_length)
            if len(header_bytes) != header_length:
                raise EOFError("truncated npy header")
            header = ast.literal_eval(header_bytes.decode(encoding))
            payload_offset = member.tell()
    except (EOFError, OSError, UnicodeError, ValueError, SyntaxError) as error:
        _malformed(motion_id, f"has an invalid {info.filename} header: {error}")
    if not isinstance(header, dict) or set(header) != {
        "descr", "fortran_order", "shape"
    }:
        _malformed(motion_id, f"{info.filename} has invalid header fields")
    shape = header["shape"]
    fortran_order = header["fortran_order"]
    descr = header["descr"]
    if (
        not isinstance(shape, tuple)
        or any(
            isinstance(size, bool) or not isinstance(size, int) or size < 0
            for size in shape
        )
    ):
        _malformed(motion_id, f"{info.filename} has an invalid shape")
    if not isinstance(fortran_order, bool):
        _malformed(motion_id, f"{info.filename} has invalid order metadata")
    if fortran_order:
        _malformed(motion_id, f"{info.filename} must use C order")
    if not isinstance(descr, str):
        _malformed(motion_id, f"{info.filename} must have a scalar dtype")
    # Itemsize is multi-digit for the carried unicode prompt scalar (e.g. "<U187");
    # the numeric members stay pinned to 1/2/4/8 by _is_supported_motion_dtype.
    dtype_match = re.fullmatch(r"([<>=|])([A-Za-z?])([0-9]{1,4})", descr)
    if dtype_match is None:
        _malformed(motion_id, f"{info.filename} has an invalid dtype")
    byte_order, dtype_kind, itemsize_text = dtype_match.groups()
    itemsize = int(itemsize_text)
    if dtype_kind == "U":
        # numpy spells unicode width in characters ("<U187"), not bytes, and the
        # payload is UCS-4. Return bytes so every caller's size math is uniform.
        itemsize *= 4
    return shape, dtype_kind, itemsize, byte_order, payload_offset


def _is_supported_dtype(kind: str, itemsize: int, byte_order: str) -> bool:
    return (
        (
            (kind in ("i", "u") and itemsize in (1, 2, 4, 8))
            or (kind == "f" and itemsize in (2, 4, 8))
        )
        and (byte_order != "|" or itemsize == 1)
    )


def _is_supported_carried_dtype(
    kind: str, itemsize: int, byte_order: str, kinds: tuple
) -> bool:
    """Dtype rule for the carried members listed in _MOTION_OPTIONAL_MEMBERS.

    ``_is_supported_motion_dtype`` only covers the numeric arrays we read; the
    carried set adds boolean foot contacts and a unicode prompt scalar. Object
    dtypes stay rejected here, and ``numpy.load(allow_pickle=False)`` in
    ``load_motion_payload`` is the second line of defence.
    """
    if kind not in kinds:
        return False
    if kind == "b":
        return itemsize == 1
    if kind == "U":
        return itemsize > 0 and itemsize % 4 == 0
    return _is_supported_dtype(kind, itemsize, byte_order)


def inspect_motion_archive(path: Path, motion_id: str | None = None) -> int:
    motion_id = path.stem if motion_id is None else motion_id
    try:
        with zipfile.ZipFile(path, "r") as archive:
            infos = archive.infolist()
            names = [info.filename for info in infos]
            if len(names) != len(set(names)):
                _malformed(motion_id, "contains duplicate members")
            missing = sorted(_MOTION_REQUIRED_MEMBERS - set(names))
            if missing:
                _malformed(motion_id, f"is missing {missing}")
            unknown = sorted(set(names) - _MOTION_MEMBER_NAMES)
            if unknown:
                _malformed(motion_id, f"contains unknown member(s) {unknown}")
            if any(
                info.is_dir()
                or info.filename != Path(info.filename).name
                or "\\" in info.filename
                for info in infos
            ):
                _malformed(motion_id, "contains an unsafe member name")
            declared_size = sum(info.file_size for info in infos)
            if declared_size > _MAX_MOTION_PAYLOAD_BYTES:
                _malformed(
                    motion_id,
                    f"declares more than {_MAX_MOTION_PAYLOAD_BYTES} uncompressed bytes",
                )

            by_name = {info.filename: info for info in infos}
            (
                rotations_shape,
                rotations_kind,
                rotations_itemsize,
                rotations_byte_order,
                rotations_offset,
            ) = _inspect_member(
                archive, by_name["local_rot_mats.npy"], motion_id
            )
            (
                joints_shape,
                joints_kind,
                joints_itemsize,
                joints_byte_order,
                joints_offset,
            ) = _inspect_member(
                archive, by_name["posed_joints.npy"], motion_id
            )
            fps_shape, fps_kind, fps_itemsize, fps_byte_order, fps_offset = (
                _inspect_member(archive, by_name["fps.npy"], motion_id)
            )
            if (
                len(rotations_shape) != 4
                or rotations_shape[1:] != (27, 3, 3)
                or not 1 <= rotations_shape[0] <= motion_retarget.MAX_FRAMES
            ):
                _malformed(
                    motion_id, "local_rot_mats.npy must have shape (F, 27, 3, 3)"
                )
            if joints_shape != (rotations_shape[0], 27, 3):
                _malformed(
                    motion_id, "posed_joints.npy must have shape (F, 27, 3)"
                )
            if not _is_supported_dtype(
                rotations_kind, rotations_itemsize, rotations_byte_order
            ):
                _malformed(
                    motion_id, "local_rot_mats.npy must have a real numeric dtype"
                )
            if not _is_supported_dtype(
                joints_kind, joints_itemsize, joints_byte_order
            ):
                _malformed(
                    motion_id, "posed_joints.npy must have a real numeric dtype"
                )
            if (
                fps_shape != ()
                or fps_kind not in ("i", "u")
                or not _is_supported_dtype(
                    fps_kind, fps_itemsize, fps_byte_order
                )
            ):
                _malformed(
                    motion_id, "fps.npy must be a non-boolean integral scalar"
                )
            size_checks = [
                (
                    by_name["local_rot_mats.npy"],
                    rotations_shape,
                    rotations_itemsize,
                    rotations_offset,
                ),
                (
                    by_name["posed_joints.npy"],
                    joints_shape,
                    joints_itemsize,
                    joints_offset,
                ),
                (by_name["fps.npy"], fps_shape, fps_itemsize, fps_offset),
            ]
            frame_count = rotations_shape[0]
            for name, (kinds, template) in _MOTION_OPTIONAL_MEMBERS.items():
                info = by_name.get(name)
                if info is None:
                    continue
                shape, kind, itemsize, byte_order, offset = _inspect_member(
                    archive, info, motion_id
                )
                expected = tuple(
                    frame_count if dimension is None else dimension
                    for dimension in template
                )
                if shape != expected:
                    _malformed(motion_id, f"{name} must have shape {expected}")
                if not _is_supported_carried_dtype(kind, itemsize, byte_order, kinds):
                    _malformed(motion_id, f"{name} has an unsupported dtype")
                size_checks.append((info, shape, itemsize, offset))
            for info, shape, itemsize, payload_offset in size_checks:
                if payload_offset + math.prod(shape) * itemsize != info.file_size:
                    _malformed(
                        motion_id,
                        f"{info.filename} size does not match its header",
                    )
            with archive.open(by_name["fps.npy"], "r") as fps_member:
                fps_member.read(fps_offset)
                fps_bytes = fps_member.read(fps_itemsize)
            byte_order = (
                "little"
                if fps_byte_order == "<"
                or fps_byte_order == "|"
                or (fps_byte_order == "=" and sys.byteorder == "little")
                else "big"
            )
            fps = int.from_bytes(
                fps_bytes,
                byteorder=byte_order,
                signed=fps_kind == "i",
            )
            if not motion_retarget.FPS_BOUNDS[0] <= fps <= motion_retarget.FPS_BOUNDS[1]:
                _malformed(
                    motion_id,
                    f"fps must be in {motion_retarget.FPS_BOUNDS[0]}.."
                    f"{motion_retarget.FPS_BOUNDS[1]}",
                )
            return fps
    except MotionArchiveError:
        raise
    except (NotImplementedError, RuntimeError, zipfile.BadZipFile) as error:
        _malformed(motion_id, f"is not a readable npz: {error}")


def motion_path(project_directory: object, motion_id: str) -> Path:
    """Resolve a regular motion archive within the project's fenced motion directory."""
    motion_id = validate_motion_id(motion_id)
    if project_directory is None:
        raise MotionArchiveError(
            "APPLY_MOTION_PROJECT_DIR_UNKNOWN",
            "the mutation connection has no project directory bound",
        )
    motions_dir = (Path(project_directory) / ".cclay" / "motions").resolve()
    path = motions_dir / f"{motion_id}.npz"
    if path.is_symlink() or not path.is_file():
        raise MotionArchiveError(
            "APPLY_MOTION_NOT_FOUND",
            f".cclay/motions/{motion_id}.npz is not a regular file",
        )
    if path.resolve().parent != motions_dir:
        raise MotionArchiveError(
            "APPLY_MOTION_NOT_FOUND",
            f"motion {motion_id} escapes the motions directory",
        )
    if path.stat().st_size > _MAX_MOTION_FILE_BYTES:
        raise MotionArchiveError(
            "APPLY_MOTION_TOO_LARGE",
            f"motion {motion_id} exceeds {_MAX_MOTION_FILE_BYTES} bytes",
        )
    return path


def motion_fps(project_directory: object, motion_id: str) -> int:
    """The npz's native fps, read from headers only.

    Cheap enough to call for every apply_motion in a plan before any mutation:
    ``inspect_motion_archive`` never materializes an array.
    """
    return inspect_motion_archive(
        motion_path(project_directory, motion_id), motion_id
    )


def load_motion_payload(
    project_directory: object,
    motion_id: str,
    *,
    validate: bool = True,
    carried: tuple = (),
) -> tuple[object, object, int, dict]:
    """Load and validate .cclay/motions/<motion_id>.npz from the project dir."""
    path = motion_path(project_directory, motion_id)
    fps = inspect_motion_archive(path, motion_id)

    import numpy

    try:
        with numpy.load(path, allow_pickle=False) as data:
            local_rot_mats = data["local_rot_mats"]
            posed_joints = data["posed_joints"]
            # Only the requested carried arrays are materialized: global_rot_mats
            # alone is as large as local_rot_mats, so apply_motion must not pay
            # for members it never reads.
            carried_arrays = {
                name: data[name] for name in carried if name in data.files
            }
    except MotionArchiveError:
        raise
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        raise MotionArchiveError(
            "APPLY_MOTION_MALFORMED",
            f"motion {motion_id} is not a readable npz: {error}",
        ) from error
    if validate:
        try:
            motion_retarget.validate_motion(local_rot_mats, posed_joints, fps)
        except motion_retarget.MotionRetargetError as error:
            raise MotionArchiveError("APPLY_MOTION_MALFORMED", str(error)) from error
    return local_rot_mats, posed_joints, fps, carried_arrays
