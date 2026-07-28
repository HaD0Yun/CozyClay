import torch

from scripts.interactive_demo.prompt_plan import CueAcceptance
from scripts.interactive_demo.prompt_plan_acceptance import JOINT_NAMES, cue_accepted


TORSO_HEIGHTS = {
    "Hips": 0.60,
    "Spine": 0.75,
    "Spine1": 0.90,
    "Spine2": 1.10,
    "Spine3": 1.30,
    "Neck": 1.50,
    "Head": 1.60,
}


def _upright_pose() -> torch.Tensor:
    joints = torch.zeros((1, 40, 27, 3))
    for name, height in TORSO_HEIGHTS.items():
        joints[:, :, JOINT_NAMES.index(name), 1] = height
    for side in ("Left", "Right"):
        joints[:, :, JOINT_NAMES.index(f"{side}UpLeg"), 1] = 0.40
        joints[:, :, JOINT_NAMES.index(f"{side}Leg"), 1] = 0.20
    return joints


def test_seated_stage_accepts_upright_pose_with_calibrated_pelvis_clearance() -> None:
    assert cue_accepted(CueAcceptance.SEATED, _upright_pose()) is True


def test_backward_lean_stage_requires_tilt_and_toe_lift() -> None:
    joints = _upright_pose()
    for name, height in TORSO_HEIGHTS.items():
        offset = height - TORSO_HEIGHTS["Hips"]
        joints[:, -5:, JOINT_NAMES.index(name), 1] = 0.60 + 0.866 * offset
        joints[:, -5:, JOINT_NAMES.index(name), 2] = 0.50 * offset
    for side in ("Left", "Right"):
        joints[:, -5:, JOINT_NAMES.index(f"{side}ToeBase"), 1] = 0.06

    assert cue_accepted(CueAcceptance.BACKWARD_LEAN, joints) is True


def test_fall_stage_rejects_rising_vertical_motion_and_accepts_flat_drop() -> None:
    rising = _upright_pose()
    rising[:, -5:, :, 1] += 0.80
    assert cue_accepted(CueAcceptance.FALL_TO_GROUND, rising) is False

    fallen = _upright_pose()
    for name, height in TORSO_HEIGHTS.items():
        fallen[:, -5:, JOINT_NAMES.index(name), 1] = 0.0
        fallen[:, -5:, JOINT_NAMES.index(name), 2] = height - TORSO_HEIGHTS["Hips"]
    assert cue_accepted(CueAcceptance.FALL_TO_GROUND, fallen) is True


def test_fall_stage_rejects_head_drop_when_hips_rise() -> None:
    joints = _upright_pose()
    for name, height in TORSO_HEIGHTS.items():
        joints[:, -5:, JOINT_NAMES.index(name), 1] = 0.80
        joints[:, -5:, JOINT_NAMES.index(name), 2] = height - TORSO_HEIGHTS["Hips"]

    assert cue_accepted(CueAcceptance.FALL_TO_GROUND, joints) is False


def test_head_rub_stage_requires_contact_and_head_relative_path() -> None:
    joints = _upright_pose()
    head = joints[:, :, JOINT_NAMES.index("Head")]
    oscillation = torch.where(torch.arange(40) % 2 == 0, 0.10, -0.10)
    for hand in ("LeftHand", "RightHand"):
        joints[:, :, JOINT_NAMES.index(hand)] = head
        joints[:, :, JOINT_NAMES.index(hand), 0] = oscillation

    assert cue_accepted(CueAcceptance.HEAD_RUB, joints) is True
