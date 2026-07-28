import os
import unittest
from pathlib import Path


RUNNER_VALUE = os.environ.get("ARDY_CPU_RUNNER")
if not RUNNER_VALUE:
    raise unittest.SkipTest("ARDY_CPU_RUNNER is not configured")
RUNNER = Path(RUNNER_VALUE or "")


def test_normal_ui_launch_hides_all_cuda_devices() -> None:
    # Given
    source = RUNNER.read_text(encoding="utf-8")

    # When
    ui_launch = source.split('echo "Starting CPU ARDY UI..."', maxsplit=1)[1]

    # Then
    assert "CUDA_VISIBLE_DEVICES=''" in ui_launch


def test_cpu_runner_preserves_hand_pose_and_text_encoder_configuration() -> None:
    # Given / When
    source = RUNNER.read_text(encoding="utf-8")

    # Then
    assert 'ARDY_CORE_HAND_POSE="${ARDY_CORE_HAND_POSE:-open}"' in source
    assert "TEXT_ENCODER_MODE=api" in source
    assert "--device cpu" in source
