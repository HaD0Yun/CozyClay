"""Private Mixamo mannequin support for the Viser motion viewer."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Literal

import numpy as np
import numpy.typing as npt
import viser
import viser.transforms as tf

from ardy.skeleton import CoreSkeleton27

AvatarChoice = Literal["Default", "X Bot", "Y Bot"]

AVATAR_OPTIONS: Final[tuple[AvatarChoice, ...]] = ("Default", "X Bot", "Y Bot")
_PRIVATE_AVATAR_DIR_VALUE = os.environ.get("ARDY_PRIVATE_AVATAR_DIR")
_PRIVATE_AVATAR_DIR: Final[Path | None] = (
    Path(_PRIVATE_AVATAR_DIR_VALUE).expanduser() if _PRIVATE_AVATAR_DIR_VALUE else None
)

_MIXAMO_TO_CORE: Final[dict[str, str]] = {
    "Hips": "Hips",
    "Spine": "Spine1",
    "Spine1": "Spine2",
    "Spine2": "Spine3",
    "Neck": "Neck",
    "Head": "Head",
    "HeadTop_End": "Head",
    "RightShoulder": "RightShoulder",
    "RightArm": "RightArm",
    "RightForeArm": "RightForeArm",
    "RightHand": "RightHand",
    "RightUpLeg": "RightUpLeg",
    "RightLeg": "RightLeg",
    "RightFoot": "RightFoot",
    "RightToeBase": "RightToeBase",
    "RightToe_End": "RightToeBase",
    "LeftShoulder": "LeftShoulder",
    "LeftArm": "LeftArm",
    "LeftForeArm": "LeftForeArm",
    "LeftHand": "LeftHand",
    "LeftUpLeg": "LeftUpLeg",
    "LeftLeg": "LeftLeg",
    "LeftFoot": "LeftFoot",
    "LeftToeBase": "LeftToeBase",
    "LeftToe_End": "LeftToeBase",
}


@dataclass(frozen=True, slots=True)
class AvatarConfig:
    path: Path
    color: tuple[int, int, int]


@dataclass(frozen=True, slots=True)
class AvatarAsset:
    vertices: npt.NDArray[np.float32]
    faces: npt.NDArray[np.uint32]
    skin_weights: npt.NDArray[np.float32]
    bone_names: npt.NDArray[np.str_]
    bone_positions: npt.NDArray[np.float32]


class AvatarChoiceError(ValueError):
    """Raised when a GUI value is not one of the supported avatars."""


def parse_avatar_choice(value: str) -> AvatarChoice:
    """Parse the Viser dropdown value into a supported avatar choice."""
    match value:
        case "Default" | "X Bot" | "Y Bot":
            return value
        case _:
            raise AvatarChoiceError(value)


def avatar_config(choice: AvatarChoice) -> AvatarConfig | None:
    """Return the private asset and display color for an avatar choice."""
    if choice == "Default":
        return None
    if _PRIVATE_AVATAR_DIR is None:
        raise RuntimeError(
            "ARDY_PRIVATE_AVATAR_DIR is required when selecting the X Bot or Y Bot avatar"
        )
    match choice:
        case "X Bot":
            return AvatarConfig(_PRIVATE_AVATAR_DIR / "x-bot-tpose.npz", (105, 170, 202))
        case "Y Bot":
            return AvatarConfig(_PRIVATE_AVATAR_DIR / "y-bot-tpose.npz", (213, 126, 130))
        case _:
            raise AvatarChoiceError(choice)


def _core_joint_name(bone_name: str) -> str:
    direct = _MIXAMO_TO_CORE.get(bone_name)
    if direct is not None:
        return direct
    if bone_name.startswith("RightHandThumb"):
        return "RightHandThumb1"
    if bone_name.startswith("RightHand"):
        return "RightHandEnd"
    if bone_name.startswith("LeftHandThumb"):
        return "LeftHandThumb1"
    if bone_name.startswith("LeftHand"):
        return "LeftHandEnd"
    return "Hips"


def _load_asset(path: Path) -> AvatarAsset:
    with np.load(path, allow_pickle=False) as data:
        vertices = np.asarray(data["vertices"], dtype=np.float32)
        if os.environ.get("ARDY_CORE_HAND_POSE") == "fist":
            fist_path = path.with_name(f"{path.stem}-fist-vertices.npy")
            vertices = np.asarray(np.load(fist_path, allow_pickle=False), dtype=np.float32)
        return AvatarAsset(
            vertices=vertices,
            faces=np.asarray(data["faces"], dtype=np.uint32),
            skin_weights=np.asarray(data["skin_weights"], dtype=np.float32),
            bone_names=np.asarray(data["bone_names"], dtype=np.str_),
            bone_positions=np.asarray(data["bone_positions"], dtype=np.float32),
        )


def _collapse_skin(
    asset: AvatarAsset,
    skeleton: CoreSkeleton27,
) -> tuple[npt.NDArray[np.float32], npt.NDArray[np.int64], npt.NDArray[np.float32]]:
    name_to_index = skeleton.bone_order_names_index
    mapped = np.asarray(
        [name_to_index[_core_joint_name(str(name))] for name in asset.bone_names],
        dtype=np.int64,
    )
    target_indices = np.unique(mapped)
    target_column = {int(joint_index): column for column, joint_index in enumerate(target_indices)}
    collapsed = np.zeros((asset.vertices.shape[0], target_indices.shape[0]), dtype=np.float32)
    canonical_positions = np.zeros((target_indices.shape[0], 3), dtype=np.float32)
    for mixamo_index, joint_index in enumerate(mapped):
        column = target_column[int(joint_index)]
        collapsed[:, column] += asset.skin_weights[:, mixamo_index]
        if not np.any(canonical_positions[column]):
            canonical_positions[column] = asset.bone_positions[mixamo_index]
    sums = collapsed.sum(axis=1, keepdims=True)
    collapsed /= np.where(sums > 0.0, sums, 1.0)
    return collapsed, target_indices, canonical_positions


def compute_bone_transforms(
    mixamo_bind_positions: npt.NDArray[np.float32],
    mapped_joint_indices: npt.NDArray[np.int64],
    ardy_bind_positions: npt.NDArray[np.float32],
    joints_pos: npt.NDArray[np.float32],
    joints_rot: npt.NDArray[np.float32],
) -> tuple[npt.NDArray[np.float32], npt.NDArray[np.float32]]:
    """Apply each ARDY joint delta to its corresponding Mixamo bind pivot."""
    rotations = joints_rot[mapped_joint_indices]
    offsets = mixamo_bind_positions - ardy_bind_positions[mapped_joint_indices]
    rotated_offsets = np.einsum("bij,bj->bi", rotations, offsets)
    positions = joints_pos[mapped_joint_indices] + rotated_offsets
    return positions.astype(np.float32), rotations.astype(np.float32)


class MixamoAvatarRig:
    """A private X Bot or Y Bot mesh driven by ARDY Core joint transforms."""

    def __init__(
        self,
        name: str,
        server: viser.ViserServer | viser.ClientHandle,
        skeleton: CoreSkeleton27,
        config: AvatarConfig,
        *,
        visible: bool,
        opacity: float,
    ) -> None:
        asset = _load_asset(config.path)
        skin_weights, self._joint_indices, bind_positions = _collapse_skin(asset, skeleton)
        bind_joints = skeleton.neutral_joints.detach().cpu().numpy().astype(np.float32)
        bind_joints[:, 1] -= bind_joints[:, 1].min()
        self._bind_joints = bind_joints
        self._bind_positions = bind_positions
        self._server = server
        self._color = config.color
        self._handle = server.scene.add_mesh_skinned(
            f"/{name}/mixamo_skinned",
            vertices=asset.vertices,
            faces=asset.faces,
            bone_wxyzs=tf.SO3.identity(batch_axes=(bind_positions.shape[0],)).wxyz,
            bone_positions=bind_positions,
            skin_weights=skin_weights,
            color=config.color,
            opacity=opacity,
            visible=visible,
        )

    def set_pose(
        self,
        joints_pos: npt.NDArray[np.float32],
        joints_rot: npt.NDArray[np.float32],
    ) -> None:
        positions, rotations = compute_bone_transforms(
            self._bind_positions,
            self._joint_indices,
            self._bind_joints,
            joints_pos,
            joints_rot,
        )
        quaternions = tf.SO3.from_matrix(rotations).wxyz
        for index, bone in enumerate(self._handle.bones):
            bone.position = positions[index]
            bone.wxyz = quaternions[index]

    def set_visibility(self, visible: bool) -> None:
        self._handle.visible = visible

    def set_opacity(self, opacity: float) -> None:
        self._handle.opacity = opacity

    def set_wireframe(self, wireframe: bool) -> None:
        self._handle.wireframe = wireframe

    def set_dark_mode(self, dark_mode: bool) -> None:
        self._handle.color = (
            tuple(int(channel * 0.65) for channel in self._color)
            if dark_mode
            else self._color
        )

    def clear(self) -> None:
        self._server.scene.remove_by_name(self._handle.name)
