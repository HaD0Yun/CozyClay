import torch

from ardy.skeleton import CoreSkeleton27
from scripts.interactive_demo.prompt_plan_execution import core_touch_accepted


JOINT_NAMES = [name for name, _ in CoreSkeleton27.bone_order_names_with_parents]


def _approaching_hands() -> torch.Tensor:
    joints = torch.zeros((1, 40, 27, 3))
    joints[:, :, JOINT_NAMES.index("Head"), 1] = 1.0
    joints[:, :, JOINT_NAMES.index("RightHand"), 0] = 1.0
    joints[:, :, JOINT_NAMES.index("LeftHand"), 0] = -1.0
    joints[:, -5:, JOINT_NAMES.index("RightHand"), 0] = 0.1
    joints[:, -5:, JOINT_NAMES.index("LeftHand"), 0] = -0.1
    joints[:, -5:, JOINT_NAMES.index("RightHand"), 1] = 1.0
    joints[:, -5:, JOINT_NAMES.index("LeftHand"), 1] = 1.0
    return joints


def test_core_touch_acceptance_requires_both_hands_near_head_at_body_scale() -> None:
    joints = _approaching_hands()

    assert core_touch_accepted(joints) is True
    joints[:, :, JOINT_NAMES.index("LeftHand"), 0] = 2.0
    assert core_touch_accepted(joints) is False


def test_core_touch_acceptance_rejects_last_frame_only_contact() -> None:
    joints = _approaching_hands()
    joints[:, -5:-1, JOINT_NAMES.index("RightHand"), 0] = 1.0
    joints[:, -5:-1, JOINT_NAMES.index("LeftHand"), 0] = -1.0

    assert core_touch_accepted(joints) is False


def test_core_touch_acceptance_allows_prior_reach_inside_near_contact_band() -> None:
    joints = _approaching_hands()
    joints[:, 0, JOINT_NAMES.index("RightHand"), 0] = 0.15
    joints[:, 0, JOINT_NAMES.index("RightHand"), 1] = 1.0
    joints[:, 0, JOINT_NAMES.index("LeftHand"), 0] = -0.15
    joints[:, 0, JOINT_NAMES.index("LeftHand"), 1] = 1.0

    assert core_touch_accepted(joints) is True


def test_core_touch_acceptance_rejects_forty_centimeter_final_distance() -> None:
    joints = _approaching_hands()
    joints[:, -5:, JOINT_NAMES.index("RightHand"), 0] = 0.40
    joints[:, -5:, JOINT_NAMES.index("LeftHand"), 0] = -0.40

    assert core_touch_accepted(joints) is False


def test_core_touch_acceptance_fails_closed_for_degenerate_pose() -> None:
    assert core_touch_accepted(torch.zeros((1, 40, 27, 3))) is False
