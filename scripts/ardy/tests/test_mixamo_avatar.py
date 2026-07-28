from pathlib import Path

import numpy as np

from interactive_demo.mixamo_avatar import _load_asset, compute_bone_transforms


def test_load_asset_uses_adjacent_fist_vertices_when_fist_pose_is_enabled(
    tmp_path: Path,
    monkeypatch,
) -> None:
    asset_path = tmp_path / "x-bot-tpose.npz"
    open_vertices = np.zeros((3, 3), dtype=np.float32)
    fist_vertices = np.ones((3, 3), dtype=np.float32)
    np.savez(
        asset_path,
        vertices=open_vertices,
        faces=np.array([[0, 1, 2]], dtype=np.uint32),
        skin_weights=np.ones((3, 1), dtype=np.float32),
        bone_names=np.array(["Hips"]),
        bone_positions=np.zeros((1, 3), dtype=np.float32),
    )
    np.save(tmp_path / "x-bot-tpose-fist-vertices.npy", fist_vertices)
    monkeypatch.setenv("ARDY_CORE_HAND_POSE", "fist")

    asset = _load_asset(asset_path)

    np.testing.assert_array_equal(asset.vertices, fist_vertices)


def test_compute_bone_transforms_preserves_bind_pose() -> None:
    # Given
    mixamo_bind_positions = np.array([[0.25, 1.0, -0.5]], dtype=np.float32)
    mapped_joint_indices = np.array([0], dtype=np.int64)
    ardy_bind_positions = np.array([[0.0, 0.8, 0.0]], dtype=np.float32)
    joints_pos = ardy_bind_positions.copy()
    joints_rot = np.eye(3, dtype=np.float32)[None, ...]

    # When
    bone_positions, bone_rotations = compute_bone_transforms(
        mixamo_bind_positions,
        mapped_joint_indices,
        ardy_bind_positions,
        joints_pos,
        joints_rot,
    )

    # Then
    np.testing.assert_allclose(bone_positions, mixamo_bind_positions)
    np.testing.assert_allclose(bone_rotations, joints_rot)


def test_compute_bone_transforms_rotates_offset_around_mapped_joint() -> None:
    # Given
    mixamo_bind_positions = np.array([[1.0, 0.0, 0.0]], dtype=np.float32)
    mapped_joint_indices = np.array([0], dtype=np.int64)
    ardy_bind_positions = np.array([[0.0, 0.0, 0.0]], dtype=np.float32)
    joints_pos = np.array([[2.0, 0.0, 0.0]], dtype=np.float32)
    joints_rot = np.array([[[0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]]], dtype=np.float32)

    # When
    bone_positions, _ = compute_bone_transforms(
        mixamo_bind_positions,
        mapped_joint_indices,
        ardy_bind_positions,
        joints_pos,
        joints_rot,
    )

    # Then
    np.testing.assert_allclose(bone_positions, np.array([[2.0, 1.0, 0.0]], dtype=np.float32))
