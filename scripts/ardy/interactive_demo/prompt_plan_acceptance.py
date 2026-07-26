# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: CozyClay contributors

"""Coordinate acceptance metrics for CoreSkeleton27 prompt stages."""

from itertools import pairwise
from typing import assert_never

import torch

from ardy.skeleton import CoreSkeleton27

from .prompt_plan import CueAcceptance

JOINT_NAMES = [name for name, _ in CoreSkeleton27.bone_order_names_with_parents]


def _chain_length(joints: torch.Tensor, chain: tuple[str, ...]) -> torch.Tensor:
    segments = [
        torch.linalg.vector_norm(
            joints[:, :, JOINT_NAMES.index(child)] - joints[:, :, JOINT_NAMES.index(parent)], dim=-1
        )
        for parent, child in pairwise(chain)
    ]
    return torch.stack(segments, dim=-1).sum(dim=-1)


def posed_body_scale(joints: torch.Tensor) -> torch.Tensor:
    """Return torso-chain plus median leg-chain length per frame."""
    torso = _chain_length(joints, ("Head", "Neck", "Spine3", "Spine2", "Spine1", "Spine", "Hips"))
    legs = torch.stack(
        [
            _chain_length(joints, ("Hips", f"{side}UpLeg", f"{side}Leg", f"{side}Foot"))
            for side in ("Left", "Right")
        ],
        dim=-1,
    )
    return torso + torch.median(legs, dim=-1).values


def _torso_verticality(joints: torch.Tensor) -> torch.Tensor:
    torso = joints[:, :, JOINT_NAMES.index("Head")] - joints[:, :, JOINT_NAMES.index("Hips")]
    return torso[..., 1].abs() / torch.linalg.vector_norm(torso, dim=-1).clamp_min(1e-6)


def both_hands_head_contact(joints: torch.Tensor) -> bool:
    if joints.shape[1] < 5:
        return False
    scale = posed_body_scale(joints)
    if bool(torch.any(scale <= 1e-6).item()):
        return False
    head = joints[:, :, JOINT_NAMES.index("Head")]
    distances = torch.stack(
        [torch.linalg.vector_norm(joints[:, :, JOINT_NAMES.index(hand)] - head, dim=-1) for hand in ("LeftHand", "RightHand")],
        dim=-1,
    )
    final = distances[:, -5:]
    contact = torch.all(final <= scale[:, -5:, None] * 0.22)
    near = distances[:, 0] <= scale[:, 0, None] * 0.27
    approached = distances[:, 0] - final.mean(dim=1) >= scale[:, 0, None] * 0.10
    return bool((contact & torch.all(near | approached)).item())


def cue_accepted(acceptance: CueAcceptance, joints: torch.Tensor) -> bool:
    """Evaluate one compiled cue against its coordinate acceptance stage."""
    match acceptance:
        case CueAcceptance.NONE:
            return True
        case (
            CueAcceptance.SEATED
            | CueAcceptance.BACKWARD_LEAN
            | CueAcceptance.FALL_TO_GROUND
            | CueAcceptance.BOTH_HANDS_HEAD_CONTACT
            | CueAcceptance.HEAD_RUB
        ):
            pass
        case unreachable:
            assert_never(unreachable)
    if joints.ndim != 4 or joints.shape[-2] != 27 or joints.shape[1] < 5:
        return False
    scale = posed_body_scale(joints)
    if bool(torch.any(scale <= 1e-6).item()):
        return False
    hips = joints[:, :, JOINT_NAMES.index("Hips")]
    head = joints[:, :, JOINT_NAMES.index("Head")]
    match acceptance:
        case CueAcceptance.SEATED:
            feet_y = torch.stack(
                [joints[:, -5:, JOINT_NAMES.index(foot), 1] for foot in ("LeftFoot", "RightFoot")], dim=-1
            ).median(dim=-1).values
            clearance = hips[:, -5:, 1] - feet_y
            upright = _torso_verticality(joints)[:, -5:] >= 0.90
            return bool(torch.all(upright & (clearance >= 0.20 * scale[:, -5:]) & (clearance <= 0.40 * scale[:, -5:])).item())
        case CueAcceptance.BACKWARD_LEAN:
            verticality = _torso_verticality(joints).clamp(0.0, 1.0)
            tilt = torch.rad2deg(torch.acos(verticality))
            toe_y = torch.stack(
                [joints[:, :, JOINT_NAMES.index(toe), 1] for toe in ("LeftToeBase", "RightToeBase")], dim=-1
            )
            lifted = toe_y[:, -5:].mean(dim=(1, 2)) - toe_y[:, 0].mean(dim=1) >= 0.03 * scale[:, 0]
            leaned = (tilt[:, -5:].mean(dim=1) >= 25.0) & (tilt[:, -5:].mean(dim=1) - tilt[:, 0] >= 15.0)
            return bool(torch.all(lifted & leaned).item())
        case CueAcceptance.FALL_TO_GROUND:
            hips_drop = hips[:, 0, 1] - hips[:, -5:, 1].mean(dim=1)
            head_drop = head[:, 0, 1] - head[:, -5:, 1].mean(dim=1)
            horizontal = _torso_verticality(joints)[:, -5:] <= 0.35
            both_dropped = (hips_drop >= 0.25 * scale[:, 0]) & (head_drop >= 0.25 * scale[:, 0])
            return bool(torch.all(both_dropped & torch.all(horizontal, dim=1)).item())
        case CueAcceptance.BOTH_HANDS_HEAD_CONTACT:
            return both_hands_head_contact(joints)
        case CueAcceptance.HEAD_RUB:
            head_relative = torch.stack(
                [joints[:, :, JOINT_NAMES.index(hand)] - head for hand in ("LeftHand", "RightHand")], dim=2
            )
            distances = torch.linalg.vector_norm(head_relative, dim=-1)
            contact_ratio = (distances <= scale[:, :, None] * 0.22).all(dim=-1).float().mean(dim=1)
            paths = torch.linalg.vector_norm(head_relative[:, 1:] - head_relative[:, :-1], dim=-1).sum(dim=1)
            return bool(torch.all((contact_ratio >= 0.50) & torch.all(paths >= 0.12 * scale[:, 0, None], dim=-1)).item())
        case CueAcceptance.NONE:
            return True
        case unreachable:
            assert_never(unreachable)
