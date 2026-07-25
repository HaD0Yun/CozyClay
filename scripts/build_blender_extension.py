"""Build the allowlisted CozyClay Extension archive reproducibly."""

from __future__ import annotations

import argparse
from pathlib import Path, PurePosixPath
import stat
import zipfile


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
ADDON_ROOT = REPOSITORY_ROOT / "blender-addon" / "cclay"
PACKAGE_MANIFEST = REPOSITORY_ROOT / "blender-addon" / "package-files.txt"
_ARCHIVE_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
_ARCHIVE_MODE = stat.S_IFREG | 0o644


class PackageError(RuntimeError):
    """The explicit extension package allowlist is invalid."""


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def package_files() -> tuple[PurePosixPath, ...]:
    """Load and validate the exact archive-root file allowlist."""
    entries = []
    for raw_line in PACKAGE_MANIFEST.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        archive_path = PurePosixPath(line)
        if archive_path.is_absolute() or ".." in archive_path.parts or str(archive_path) != line:
            raise PackageError(f"invalid package path: {line}")
        entries.append(archive_path)
    if not entries or len(entries) != len(set(entries)):
        raise PackageError("package allowlist must be non-empty and contain no duplicates")
    if entries != sorted(entries):
        raise PackageError("package allowlist must use stable lexical ordering")
    if PurePosixPath("blender_manifest.toml") not in entries or PurePosixPath("__init__.py") not in entries:
        raise PackageError("package allowlist must include Blender's manifest and add-on entry point")
    return tuple(entries)


def build_archive(output: Path) -> None:
    """Write a host-path-free archive with stable ordering, timestamps, and modes."""
    files = package_files()
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for archive_path in files:
            source = ADDON_ROOT.joinpath(*archive_path.parts)
            if source.is_symlink() or not source.is_file():
                raise PackageError(f"allowlisted runtime file is missing or not regular: {archive_path}")
            info = zipfile.ZipInfo(str(archive_path), date_time=_ARCHIVE_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = _ARCHIVE_MODE << 16
            archive.writestr(info, source.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def main() -> None:
    arguments = _arguments()
    build_archive(arguments.output)
    print(arguments.output)


if __name__ == "__main__":
    main()
