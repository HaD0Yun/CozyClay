import json

import torch

from scripts.interactive_demo.prompt_plan import PromptPlanRunRequest
from tests.test_prompt_plan_execution import FakeDemo, _motion_cue


class RetrySecondCueDemo(FakeDemo):
    def __init__(self) -> None:
        super().__init__()
        self.second_attempts = 0
        self.accepted_prefix: torch.Tensor | None = None
        self.prefix_preserved = False

    def _generate_step(self, client_id: int, history_end_idx_override: int | None = None) -> None:
        assert history_end_idx_override is not None
        session = self.client_sessions[client_id]
        self.history_ends.append(history_end_idx_override)
        self.seeds_used.append(session.gui_elements.gui_seed.value)
        prefix = (
            torch.zeros((1, 0, 1))
            if session.motion_tensor is None
            else session.motion_tensor[:, : history_end_idx_override + 1]
        )
        generated = torch.full((1, 40, 1), float(session.gui_elements.gui_seed.value))
        session.motion_tensor = torch.cat((prefix, generated), dim=1)
        session.joints_pos = torch.zeros((1, session.motion_tensor.shape[1], 27, 3))
        session.max_frame_idx = session.motion_tensor.shape[1] - 1

    def accept_generated_cue(self, client_id: int, cue) -> bool:
        session = self.client_sessions[client_id]
        if cue.id == "first":
            self.accepted_prefix = session.motion_tensor[:, :40].clone()
            return True
        self.second_attempts += 1
        if self.second_attempts == 1:
            return False
        assert self.accepted_prefix is not None
        self.prefix_preserved = torch.equal(session.motion_tensor[:, :40], self.accepted_prefix)
        return True


def test_retry_restores_byte_identical_accepted_prefix_and_uses_stage_seeds() -> None:
    demo = RetrySecondCueDemo()
    cues = [_motion_cue("first"), _motion_cue("second")]
    cues[1]["max_attempts"] = 2
    request = PromptPlanRunRequest(
        raw_json=json.dumps({"token_frames": 4, "horizon_frames": 40, "cues": cues}),
        output_path="session.pkl",
        base_seed=5,
    )

    assert demo.run_prompt_plan(1, request) is True
    assert demo.seeds_used == [5, 15, 16]
    assert demo.prefix_preserved is True
    assert demo.history_ends == [-1, 39, 39]
    assert len(demo.client_sessions[1].client.timeline._prompts) == 2


def test_request_attempt_offsets_first_stage_seed() -> None:
    demo = RetrySecondCueDemo()
    request = PromptPlanRunRequest(
        raw_json=json.dumps({"token_frames": 4, "horizon_frames": 40, "cues": [_motion_cue("first")]}),
        output_path="session.pkl",
        base_seed=100,
        attempt=4,
    )

    assert demo.run_prompt_plan(1, request) is True
    assert demo.seeds_used == [104]
