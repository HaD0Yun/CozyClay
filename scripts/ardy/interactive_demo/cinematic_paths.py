"""Filesystem trust boundaries for cinematic shot plans and renders."""

from __future__ import annotations

import os
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Final

MAX_SHOT_JSON_BYTES: Final = 1024 * 1024


@dataclass(frozen=True, slots=True)
class CinematicPathError(Exception):
    detail: str

    def __str__(self) -> str:
        return self.detail


def default_plan_roots(repo_root: Path) -> tuple[Path, ...]:
    return (repo_root / ".cache", Path.home() / "ardy-local" / "plans")


def default_render_roots(repo_root: Path) -> tuple[Path, ...]:
    return (repo_root / ".cache" / "video_export", Path.home() / "ardy-local" / "renders")


def resolve_plan_path(raw_path: str, repo_root: Path, roots: tuple[Path, ...] | None = None) -> Path:
    return _resolve_allowed(raw_path, repo_root, roots or default_plan_roots(repo_root), "Shot")


def resolve_render_path(raw_path: str, repo_root: Path, roots: tuple[Path, ...] | None = None) -> Path:
    return _resolve_allowed(raw_path, repo_root, roots or default_render_roots(repo_root), "Render")


def read_shot_json(path: Path) -> str:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        raise CinematicPathError("Shot file is not a regular file") from None
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise CinematicPathError("Shot file is not a regular file")
        if metadata.st_size > MAX_SHOT_JSON_BYTES:
            raise CinematicPathError("Shot file is too large")
        raw = os.read(descriptor, MAX_SHOT_JSON_BYTES + 1)
        if len(raw) > MAX_SHOT_JSON_BYTES:
            raise CinematicPathError("Shot file is too large")
    finally:
        os.close(descriptor)
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        raise CinematicPathError("Shot file is not valid UTF-8") from None


def atomic_write_shot(path: Path, contents: str) -> None:
    encoded = contents.encode("utf-8")
    if len(encoded) > MAX_SHOT_JSON_BYTES:
        raise CinematicPathError("Shot file is too large")
    path.parent.mkdir(parents=True, exist_ok=True)
    if _has_symlink_component(path.parent):
        raise CinematicPathError("Shot path is not allowed")
    try:
        current = path.lstat()
    except FileNotFoundError:
        current = None
    if current is not None and not stat.S_ISREG(current.st_mode):
        raise CinematicPathError("Shot path is not allowed")

    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(mode="wb", dir=path.parent, prefix=".shot-", delete=False) as temporary:
            temporary.write(encoded)
            temporary.flush()
            os.fsync(temporary.fileno())
            temporary_path = Path(temporary.name)
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def safe_remove_regular(path: Path) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISREG(metadata.st_mode):
        raise CinematicPathError("Render cleanup target is not safe")
    path.unlink()


def safe_remove_owned_directory(path: Path) -> None:
    try:
        root_metadata = path.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISDIR(root_metadata.st_mode) or stat.S_ISLNK(root_metadata.st_mode):
        raise CinematicPathError("Render cleanup target is not safe")
    entries = sorted(path.rglob("*"), key=lambda entry: len(entry.parts), reverse=True)
    for entry in entries:
        metadata = entry.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            raise CinematicPathError("Render cleanup target is not safe")
        if stat.S_ISDIR(metadata.st_mode):
            entry.rmdir()
        elif stat.S_ISREG(metadata.st_mode):
            entry.unlink()
        else:
            raise CinematicPathError("Render cleanup target is not safe")
    path.rmdir()


def _resolve_allowed(raw_path: str, repo_root: Path, roots: tuple[Path, ...], label: str) -> Path:
    supplied = Path(raw_path).expanduser()
    if not raw_path.strip() or ".." in supplied.parts:
        raise CinematicPathError(f"{label} path is not allowed")
    candidate = supplied if supplied.is_absolute() else repo_root / supplied
    absolute_candidate = Path(os.path.abspath(candidate))
    allowed = False
    for root in roots:
        absolute_root = Path(os.path.abspath(root.expanduser()))
        try:
            absolute_candidate.relative_to(absolute_root)
        except ValueError:
            continue
        allowed = True
        break
    if not allowed or _has_symlink_component(absolute_candidate):
        raise CinematicPathError(f"{label} path is not allowed")
    return absolute_candidate


def _has_symlink_component(path: Path) -> bool:
    absolute = Path(os.path.abspath(path))
    current = Path(absolute.anchor)
    for part in absolute.parts[1:]:
        current /= part
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(metadata.st_mode):
            return True
    return False
