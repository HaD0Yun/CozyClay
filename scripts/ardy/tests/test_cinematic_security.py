from __future__ import annotations

import os
import threading
from pathlib import Path

import pytest

from scripts.interactive_demo.cinematic_paths import (
    CinematicPathError,
    atomic_write_shot,
    read_shot_json,
    resolve_plan_path,
    resolve_render_path,
    safe_remove_owned_directory,
)
from scripts.interactive_demo.cinematic_limits import (
    CinematicLimitError,
    RenderBudget,
    validate_render_budget,
)
from scripts.interactive_demo.cinematic_export import RenderRequest, build_ffmpeg_argv


def test_allowed_relative_and_canonical_paths_resolve(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    plan_root = repo / ".cache"
    render_root = repo / ".cache" / "video_export"
    plan_root.mkdir(parents=True)
    render_root.mkdir(parents=True)

    assert resolve_plan_path(".cache/shot.json", repo, (plan_root,)) == plan_root / "shot.json"
    assert resolve_render_path(str(render_root / "shot.mp4"), repo, (render_root,)) == render_root / "shot.mp4"


@pytest.mark.parametrize(
    "rejected",
    ["/tmp/shot.json", "/home/alice/.ssh/id_ed25519", "../secret", ".cache/../.cache/shot.json"],
)
def test_plan_path_rejects_outside_and_traversal_without_echoing_value(tmp_path: Path, rejected: str) -> None:
    repo = tmp_path / "repo"
    root = repo / ".cache"
    root.mkdir(parents=True)

    with pytest.raises(CinematicPathError) as captured:
        resolve_plan_path(rejected, repo, (root,))

    assert rejected not in str(captured.value)
    assert str(captured.value) == "Shot path is not allowed"


def test_paths_reject_symlink_components_and_fifo_load(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    root = repo / ".cache"
    outside = tmp_path / "outside"
    root.mkdir(parents=True)
    outside.mkdir()
    (root / "jump").symlink_to(outside, target_is_directory=True)

    with pytest.raises(CinematicPathError, match="Shot path is not allowed"):
        resolve_plan_path(".cache/jump/shot.json", repo, (root,))

    fifo = root / "pipe.json"
    os.mkfifo(fifo)
    with pytest.raises(CinematicPathError, match="Shot file is not a regular file"):
        read_shot_json(fifo)


def test_shot_load_is_bounded_and_atomic_overwrite_is_allowed(tmp_path: Path) -> None:
    target = tmp_path / "shot.json"
    atomic_write_shot(target, '{"version":1}')
    atomic_write_shot(target, '{"version":2}')
    assert read_shot_json(target) == '{"version":2}'

    target.write_bytes(b"x" * (1024 * 1024 + 1))
    with pytest.raises(CinematicPathError, match="Shot file is too large"):
        read_shot_json(target)


def test_atomic_save_rejects_symlink_target(tmp_path: Path) -> None:
    secret = tmp_path / "secret"
    secret.write_text("keep", encoding="utf-8")
    target = tmp_path / "shot.json"
    target.symlink_to(secret)

    with pytest.raises(CinematicPathError, match="Shot path is not allowed"):
        atomic_write_shot(target, "replace")
    assert secret.read_text(encoding="utf-8") == "keep"


def test_cleanup_refuses_symlinks_without_touching_target(tmp_path: Path) -> None:
    owned = tmp_path / "frames"
    owned.mkdir()
    target = tmp_path / "keep.png"
    target.write_bytes(b"keep")
    (owned / "frame_000000.png").symlink_to(target)

    with pytest.raises(CinematicPathError, match="cleanup target is not safe"):
        safe_remove_owned_directory(owned)

    assert target.read_bytes() == b"keep"


def test_viser_server_is_localhost_only() -> None:
    source = (Path(__file__).parents[1] / "scripts" / "run_demo.py").read_text(encoding="utf-8")
    assert 'host="127.0.0.1"' in source
    assert 'host="0.0.0.0"' not in source


def test_ffmpeg_metacharacters_remain_one_argv_value(tmp_path: Path) -> None:
    output = tmp_path / "shot;touch-PWNED.mp4"
    request = RenderRequest(
        frames_directory=tmp_path / "frames",
        output_path=output,
        start_frame=0,
        end_frame=1,
        width=1920,
        height=1080,
        frames_per_second=20.0,
    )

    argv = build_ffmpeg_argv(request)

    assert argv[-1] == str(output)
    assert not (tmp_path / "PWNED").exists()


def test_render_budget_accepts_current_scene_and_rejects_abuse() -> None:
    validate_render_budget(RenderBudget(width=1920, height=1080, frame_count=320), free_bytes=4_000_000_000)
    validate_render_budget(RenderBudget(width=1920, height=804, frame_count=320), free_bytes=4_000_000_000)

    with pytest.raises(CinematicLimitError, match="dimensions exceed"):
        validate_render_budget(RenderBudget(width=8192, height=8192, frame_count=1), free_bytes=10**12)
    with pytest.raises(CinematicLimitError, match="total work exceeds"):
        validate_render_budget(RenderBudget(width=4096, height=2160, frame_count=320), free_bytes=10**12)
    with pytest.raises(CinematicLimitError, match="free disk space"):
        validate_render_budget(RenderBudget(width=1920, height=1080, frame_count=320), free_bytes=1000)


def test_budget_validation_is_deterministic_under_parallel_calls() -> None:
    failures: list[Exception] = []

    def validate() -> None:
        try:
            validate_render_budget(RenderBudget(width=1920, height=1080, frame_count=320), free_bytes=4_000_000_000)
        except Exception as error:  # noqa: BROAD_EXCEPT_OK - thread test records failures.
            failures.append(error)

    threads = [threading.Thread(target=validate) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert failures == []
