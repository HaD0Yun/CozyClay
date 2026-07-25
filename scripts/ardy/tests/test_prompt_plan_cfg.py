import json

from scripts.interactive_demo.prompt_plan import PromptPlanRunRequest
from tests.test_prompt_plan_execution import FakeDemo, _motion_cue


def test_per_cue_cfg_text_weight_is_applied_then_restored_after_success() -> None:
    demo = FakeDemo()
    cues = [_motion_cue("strong"), _motion_cue("default")]
    cues[0]["cfg_text_weight"] = 5.0
    request = PromptPlanRunRequest(
        raw_json=json.dumps({"token_frames": 4, "horizon_frames": 40, "cues": cues}),
        output_path="session.pkl",
        base_seed=1,
    )

    assert demo.run_prompt_plan(1, request) is True
    assert demo.cfg_weights_used == [5.0, 2.0]
    assert demo.client_sessions[1].gui_elements.gui_cfg_text_weight.value == 2.0
