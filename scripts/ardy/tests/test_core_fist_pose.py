from pathlib import Path

import numpy as np
import pytest

from ardy.viz.core_skin import FistPoseShapeError, apply_fist_pose


def test_apply_fist_pose_uses_authored_vertices_when_enabled(tmp_path: Path) -> None:
    # Given
    opened = np.zeros((4, 3), dtype=np.float32)
    fist = np.full((4, 3), 0.25, dtype=np.float32)
    pose_path = tmp_path / "fist_bind_vertices.npy"
    np.save(pose_path, fist)

    # When
    result = apply_fist_pose(opened, pose_path, enabled=True)

    # Then
    np.testing.assert_array_equal(result, fist)


def test_apply_fist_pose_preserves_open_vertices_when_disabled(tmp_path: Path) -> None:
    # Given
    opened = np.arange(12, dtype=np.float32).reshape(4, 3)

    # When
    result = apply_fist_pose(opened, tmp_path / "missing.npy", enabled=False)

    # Then
    np.testing.assert_array_equal(result, opened)


def test_apply_fist_pose_rejects_wrong_vertex_shape(tmp_path: Path) -> None:
    # Given
    opened = np.zeros((4, 3), dtype=np.float32)
    pose_path = tmp_path / "fist_bind_vertices.npy"
    np.save(pose_path, np.zeros((3, 3), dtype=np.float32))

    # When / Then
    with pytest.raises(FistPoseShapeError):
        apply_fist_pose(opened, pose_path, enabled=True)
