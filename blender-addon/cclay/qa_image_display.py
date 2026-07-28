"""Digest-bound QA artifact loading into Blender Image Editor spaces."""

from __future__ import annotations

import hashlib
import heapq
import os
from os import PathLike
from pathlib import Path
import stat
import tempfile

try:  # Blender is intentionally absent from host-side tests.
    import bpy  # type: ignore
except ImportError:  # pragma: no cover - exercised through dependency injection
    bpy = None

_MAX_QA_IMAGE_BYTES = 16 * 1024 * 1024
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_MAX_ARTIFACT_SCAN = 256
_MAX_FALLBACK_CANDIDATES = 16
_owned_images: list[tuple[object, object]] = []


class QaImageDisplayError(RuntimeError):
    """A QA artifact cannot be safely resolved or displayed."""


def display_qa_artifact(
    project_directory: str | PathLike[str],
    digest: str,
    *,
    bpy_module=None,
) -> str:
    """Verify one artifact by digest and assign its exact bytes to Image Editors."""
    contents = _read_verified_payload(Path(project_directory), digest)
    host = bpy if bpy_module is None else bpy_module
    if host is None:
        raise QaImageDisplayError("Blender image display is unavailable")

    temporary_path: str | None = None
    image = None
    try:
        descriptor, temporary_path = tempfile.mkstemp(prefix="cclay-qa-", suffix=".png")
        try:
            os.fchmod(descriptor, 0o600)
            remaining = memoryview(contents)
            while remaining:
                written = os.write(descriptor, remaining)
                if written <= 0:
                    raise OSError("short QA image write")
                remaining = remaining[written:]
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

        if not cleanup_qa_images():
            raise QaImageDisplayError("Previous QA image could not be released")
        image = host.data.images.load(temporary_path, check_existing=False)
        pack_image = getattr(image, "pack", None)
        if not callable(pack_image):
            raise QaImageDisplayError("QA image could not be retained safely")
        pack_image()
        image.name = f"CCLAY QA {digest[:12]}"

        displayed = False
        for screen in getattr(host.data, "screens", ()):
            for area in getattr(screen, "areas", ()):
                if getattr(area, "type", None) != "IMAGE_EDITOR":
                    continue
                space = getattr(getattr(area, "spaces", None), "active", None)
                if space is not None:
                    space.image = image
                    displayed = True
        if not displayed:
            raise QaImageDisplayError("Open an Image Editor to display QA output")
        _owned_images.append((host, image))
        return digest
    except QaImageDisplayError:
        if image is not None and not _remove_image(host, image):
            _owned_images.append((host, image))
        raise
    except (OSError, RuntimeError, TypeError, ValueError) as error:
        if image is not None and not _remove_image(host, image):
            _owned_images.append((host, image))
        raise QaImageDisplayError("QA image could not be loaded") from error
    finally:
        if temporary_path is not None:
            try:
                os.unlink(temporary_path)
            except FileNotFoundError:
                pass


def display_latest_qa_artifact(
    project_directory: str | PathLike[str],
    preferred_digest: str,
    *,
    bpy_module=None,
) -> str:
    """Prefer the event digest, then the newest verified PNG artifact in the store."""
    project = Path(project_directory)
    if _valid_digest(preferred_digest):
        try:
            return display_qa_artifact(
                project,
                preferred_digest,
                bpy_module=bpy_module,
            )
        except QaImageDisplayError:
            pass
    root = project / ".cclay" / "artifacts"
    try:
        entries = root.iterdir()
    except OSError as error:
        raise QaImageDisplayError("QA artifact store is unavailable") from error
    candidates: list[tuple[int, str]] = []
    try:
        for scanned, entry in enumerate(entries):
            if scanned >= _MAX_ARTIFACT_SCAN:
                break
            if not _valid_digest(entry.name):
                continue
            try:
                directory_stat = entry.lstat()
                payload_stat = (entry / "payload").lstat()
            except OSError:
                continue
            if (
                stat.S_ISLNK(directory_stat.st_mode)
                or not stat.S_ISDIR(directory_stat.st_mode)
                or stat.S_ISLNK(payload_stat.st_mode)
                or not stat.S_ISREG(payload_stat.st_mode)
            ):
                continue
            candidate = (payload_stat.st_mtime_ns, entry.name)
            if len(candidates) < _MAX_FALLBACK_CANDIDATES:
                heapq.heappush(candidates, candidate)
            else:
                heapq.heappushpop(candidates, candidate)
    except OSError as error:
        raise QaImageDisplayError("QA artifact store is unavailable") from error
    for _mtime, candidate_name in sorted(candidates, reverse=True):
        if candidate_name == preferred_digest:
            continue
        try:
            return display_qa_artifact(
                project,
                candidate_name,
                bpy_module=bpy_module,
            )
        except QaImageDisplayError:
            continue
    raise QaImageDisplayError("No verified QA image artifact is available")


def cleanup_qa_images() -> bool:
    """Detach and remove owned images, retaining failed removals for retry."""
    retained: list[tuple[object, object]] = []
    for host, image in reversed(_owned_images):
        for screen in getattr(getattr(host, "data", None), "screens", ()):
            for area in getattr(screen, "areas", ()):
                space = getattr(getattr(area, "spaces", None), "active", None)
                if space is not None and getattr(space, "image", None) is image:
                    space.image = None
        if not _remove_image(host, image):
            retained.append((host, image))
    _owned_images[:] = reversed(retained)
    return not retained


def _read_verified_payload(project: Path, digest: str) -> bytes:
    if not _valid_digest(digest):
        raise QaImageDisplayError("artifact digest is invalid")
    descriptor_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    descriptors: list[int] = []
    try:
        project_metadata = project.lstat()
        if not _safe_directory(project_metadata):
            raise QaImageDisplayError("artifact path is unsafe")
        project_descriptor = os.open(project, descriptor_flags | nofollow)
        descriptors.append(project_descriptor)
        opened_project = os.fstat(project_descriptor)
        if not _same_file(project_metadata, opened_project):
            raise QaImageDisplayError("artifact path is unsafe")

        parent = project_descriptor
        for component in (".cclay", "artifacts", digest):
            child = os.open(component, descriptor_flags | nofollow, dir_fd=parent)
            descriptors.append(child)
            if not _safe_directory(os.fstat(child)):
                raise QaImageDisplayError("artifact path is unsafe")
            parent = child

        payload_descriptor = os.open("payload", os.O_RDONLY | nofollow, dir_fd=parent)
        descriptors.append(payload_descriptor)
        payload_metadata = os.fstat(payload_descriptor)
        if (
            not stat.S_ISREG(payload_metadata.st_mode)
            or payload_metadata.st_nlink != 1
            or not _owned_by_current_user(payload_metadata)
            or stat.S_IMODE(payload_metadata.st_mode) & 0o077
            or payload_metadata.st_size < len(_PNG_SIGNATURE)
            or payload_metadata.st_size > _MAX_QA_IMAGE_BYTES
        ):
            raise QaImageDisplayError("artifact payload is invalid")
        chunks: list[bytes] = []
        remaining = payload_metadata.st_size
        while remaining:
            chunk = os.read(payload_descriptor, min(remaining, 1024 * 1024))
            if not chunk:
                raise QaImageDisplayError("artifact payload is invalid")
            chunks.append(chunk)
            remaining -= len(chunk)
        if os.read(payload_descriptor, 1):
            raise QaImageDisplayError("artifact payload is invalid")
        contents = b"".join(chunks)
    except QaImageDisplayError:
        raise
    except OSError as error:
        raise QaImageDisplayError("artifact payload is unavailable") from error
    finally:
        for descriptor in reversed(descriptors):
            try:
                os.close(descriptor)
            except OSError:
                pass
    if (
        not contents.startswith(_PNG_SIGNATURE)
        or hashlib.sha256(contents).hexdigest() != digest
    ):
        raise QaImageDisplayError("artifact payload is invalid")
    return contents


def _remove_image(host: object, image: object) -> bool:
    images = getattr(getattr(host, "data", None), "images", None)
    remove = getattr(images, "remove", None)
    if not callable(remove):
        return False
    try:
        remove(image, do_unlink=True)
    except TypeError:
        try:
            remove(image)
        except ReferenceError:
            return True
        except RuntimeError:
            return False
    except ReferenceError:
        return True
    except RuntimeError:
        return False
    return True


def _safe_directory(metadata: os.stat_result) -> bool:
    return (
        stat.S_ISDIR(metadata.st_mode)
        and not stat.S_ISLNK(metadata.st_mode)
        and _owned_by_current_user(metadata)
    )


def _same_file(first: os.stat_result, second: os.stat_result) -> bool:
    return first.st_dev == second.st_dev and first.st_ino == second.st_ino


def _owned_by_current_user(metadata: os.stat_result) -> bool:
    getuid = getattr(os, "getuid", None)
    return not callable(getuid) or metadata.st_uid == getuid()


def _valid_digest(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )
