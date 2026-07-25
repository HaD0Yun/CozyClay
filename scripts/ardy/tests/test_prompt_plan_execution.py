import json
from pathlib import Path
import threading
from types import SimpleNamespace

import torch

from scripts.interactive_demo import prompt_plan_execution
from scripts.interactive_demo.prompt_plan import PromptPlanError, PromptPlanRunRequest
from scripts.interactive_demo.prompt_plan_execution import PromptPlanExecutionMixin


def test_consume_auto_prompt_plan_path_returns_configured_path_only_once(monkeypatch) -> None:
    # Given
    monkeypatch.setenv("ARDY_AUTO_PROMPT_PLAN", "/tmp/boxing.json")

    # When
    first = prompt_plan_execution.consume_auto_prompt_plan_path()
    second = prompt_plan_execution.consume_auto_prompt_plan_path()

    # Then
    assert first == Path("/tmp/boxing.json")
    assert second is None


class FakeTextModel:
    def __init__(self) -> None:
        self.encoded_prompts: list[str] = []

    def text_encoder(self, texts: list[str]) -> tuple[torch.Tensor, list[int]]:
        self.encoded_prompts.extend(texts)
        return torch.zeros((len(texts), 1, 2)), [1] * len(texts)


class FakeTimeline:
    def __init__(self) -> None:
        self._prompts: dict[str, SimpleNamespace] = {}

    def add_prompt(self, *, text: str, start_frame: int, end_frame: int, color: tuple[int, int, int]) -> str:
        prompt_id = f"prompt-{len(self._prompts)}"
        self._prompts[prompt_id] = SimpleNamespace(
            uuid=prompt_id,
            text=text,
            start_frame=start_frame,
            end_frame=end_frame,
            color=color,
        )
        return prompt_id


class InjectedGenerationError(RuntimeError):
    pass


class FakeDemo(PromptPlanExecutionMixin):
    def __init__(self) -> None:
        timeline = FakeTimeline()
        gui = SimpleNamespace(
            gui_prompt_text=SimpleNamespace(value=""),
            gui_active_prompt_label=SimpleNamespace(content=""),
            gui_seed=SimpleNamespace(value=0),
            gui_cfg_text_weight=SimpleNamespace(value=2.0),
            gui_frame_idx_input=SimpleNamespace(max=1),
        )
        session = SimpleNamespace(
            client=SimpleNamespace(timeline=timeline),
            model=FakeTextModel(),
            gui_elements=gui,
            timeline_data={"prompt_uuid_list": [], "prompt_counter": 0},
            gen_horizon_len=40,
            num_frames_per_token=4,
            playing=False,
            frame_idx=0,
            max_frame_idx=-1,
            text_embedding=None,
            motion_tensor=torch.full((1, 2, 1), 7.0),
            joints_pos=torch.full((1, 2, 27, 3), 7.0),
            joints_rot=None,
            foot_contacts=None,
            root_velocities=None,
            motion_rep=SimpleNamespace(skeleton=object()),
            characters={},
            replan_lock=threading.Lock(),
        )
        self.client_sessions = {1: session}
        self.device = "cpu"
        self.history_ends: list[int] = []
        self.exported_path: str | None = None
        self.fail_on_generation: int | None = None
        self.accepted_cues: list[str] = []
        self.cfg_weights_used: list[float] = []
        self.seeds_used: list[int] = []

    def client_active(self, client_id: int) -> bool:
        return client_id in self.client_sessions

    def clear_motions(self, client_id: int) -> None:
        session = self.client_sessions[client_id]
        session.max_frame_idx = -1
        session.motion_tensor = None
        session.joints_pos = None

    def clear_timeline_prompts(self, client_id: int) -> None:
        session = self.client_sessions[client_id]
        session.client.timeline._prompts.clear()
        session.timeline_data["prompt_uuid_list"].clear()

    def _generate_step(self, client_id: int, history_end_idx_override: int | None = None) -> None:
        assert history_end_idx_override is not None
        self.history_ends.append(history_end_idx_override)
        self.cfg_weights_used.append(self.client_sessions[client_id].gui_elements.gui_cfg_text_weight.value)
        self.seeds_used.append(self.client_sessions[client_id].gui_elements.gui_seed.value)
        if self.fail_on_generation == len(self.history_ends):
            raise InjectedGenerationError("injected generation failure")
        session = self.client_sessions[client_id]
        session.max_frame_idx += 40
        session.motion_tensor = torch.zeros((1, session.max_frame_idx + 1, 1))
        session.joints_pos = torch.zeros((1, session.max_frame_idx + 1, 27, 3))

    def accept_generated_cue(self, client_id: int, cue) -> bool:
        self.accepted_cues.append(cue.id)
        return True

    def add_character(self, client_id: int, skeleton, index: int) -> None:
        return None

    def export_session(self, client_id: int, filepath: str) -> bool:
        self.exported_path = filepath
        return client_id in self.client_sessions

    def set_frame(self, client_id: int, frame_idx: int, trigger_by_gui_timeline: bool = False) -> None:
        self.client_sessions[client_id].frame_idx = frame_idx

    def get_prompt_color(self, prompt_index: int) -> tuple[int, int, int]:
        return (prompt_index, 0, 0)


def test_run_prompt_plan_uses_local_embeddings_exact_boundaries_and_exports() -> None:
    # Given
    raw_json = json.dumps(
        {
            "token_frames": 4,
            "horizon_frames": 40,
            "cues": [
                {
                    "id": cue_id,
                    "phase": "motion",
                    "current_state": "The person is still.",
                    "motion": "The person performs one visible motion.",
                }
                for cue_id in ("one", "two", "three", "four", "five", "six")
            ],
        }
    )
    demo = FakeDemo()
    request = PromptPlanRunRequest(
        raw_json=raw_json,
        output_path="session.pkl",
        base_seed=100,
        attempt=2,
    )

    # When
    exported = demo.run_prompt_plan(1, request)

    # Then
    session = demo.client_sessions[1]
    assert exported is True
    assert len(session.model.encoded_prompts) == 6
    assert demo.history_ends == [-1, 39, 79, 119, 159, 199]
    assert session.gui_elements.gui_seed.value == 152
    assert demo.exported_path == "session.pkl"
    assert [(prompt.start_frame, prompt.end_frame) for prompt in session.client.timeline._prompts.values()] == [
        (0, 40),
        (40, 80),
        (80, 120),
        (120, 160),
        (160, 200),
        (200, 240),
    ]
    assert session.max_frame_idx == 239
    assert demo.accepted_cues == ["one", "two", "three", "four", "five", "six"]
    assert demo.cfg_weights_used == [2.0] * 6


def test_touch_rejection_stops_before_rub() -> None:
    class RejectTouchDemo(FakeDemo):
        def accept_generated_cue(self, client_id: int, cue) -> bool:
            return cue.phase.value != "touch"

    raw_json = json.dumps(
        {
            "token_frames": 4,
            "horizon_frames": 40,
            "cues": [
                {"id": "reach", "phase": "reach", "current_state": "The person is still.", "motion": "The person reaches toward their head."},
                {"id": "touch", "phase": "touch", "current_state": "The person has raised hands.", "motion": "The person touches their head with both hands.", "prerequisites": ["reach"]},
                {"id": "rub", "phase": "rub", "current_state": "The person has both hands at their head.", "motion": "The person rubs their head.", "prerequisites": ["touch"]},
            ],
        }
    )
    demo = RejectTouchDemo()

    try:
        demo.run_prompt_plan(1, PromptPlanRunRequest(raw_json, "session.pkl", 1))
    except PromptPlanError:
        rejected = True
    else:
        rejected = False

    assert rejected is True
    assert demo.history_ends == [-1, 39]


def test_failure_on_second_cue_restores_session_state() -> None:
    demo = FakeDemo()
    session = demo.client_sessions[1]
    session.playing = True
    session.frame_idx = 1
    session.max_frame_idx = 1
    session.gui_elements.gui_frame_idx_input.max = 17
    original_motion = session.motion_tensor.clone()
    original_joints = session.joints_pos.clone()
    session.gui_elements.gui_prompt_text.value = "<original-prompt>"
    session.gui_elements.gui_active_prompt_label.content = "<original-active-label>"
    session.gui_elements.gui_cfg_text_weight.value = 2.0
    original_id = session.client.timeline.add_prompt(text="old", start_frame=0, end_frame=2, color=(1, 2, 3))
    session.timeline_data["prompt_uuid_list"] = [original_id]
    session.timeline_data["prompt_counter"] = 1
    demo.fail_on_generation = 2
    cues = [_motion_cue("one"), _motion_cue("two")]
    cues[0]["cfg_text_weight"] = 5.0
    raw_json = json.dumps({"token_frames": 4, "horizon_frames": 40, "cues": cues})

    try:
        demo.run_prompt_plan(1, PromptPlanRunRequest(raw_json, "session.pkl", 1))
    except InjectedGenerationError:
        failed = True
    else:
        failed = False

    assert failed is True
    assert torch.equal(session.motion_tensor, original_motion)
    assert torch.equal(session.joints_pos, original_joints)
    assert session.frame_idx == 1 and session.max_frame_idx == 1 and session.playing is True
    assert session.gui_elements.gui_frame_idx_input.max == 17
    assert session.gui_elements.gui_cfg_text_weight.value == 2.0
    assert session.gui_elements.gui_prompt_text.value == "<original-prompt>"
    assert [(p.text, p.start_frame, p.end_frame) for p in session.client.timeline._prompts.values()] == [("old", 0, 2)]


def _motion_cue(cue_id: str) -> dict[str, str | float]:
    return {"id": cue_id, "phase": "motion", "current_state": "The person is still.", "motion": "The person moves."}


def test_concurrent_prompt_plans_are_serialized_without_duplicate_prompts() -> None:
    class BarrierDemo(FakeDemo):
        def __init__(self) -> None:
            super().__init__()
            self.clear_barrier = threading.Barrier(2)
            self.activity_lock = threading.Lock()
            self.active_clears = 0
            self.max_active_clears = 0

        def clear_motions(self, client_id: int) -> None:
            with self.activity_lock:
                self.active_clears += 1
                self.max_active_clears = max(self.max_active_clears, self.active_clears)
            try:
                self.clear_barrier.wait(timeout=0.2)
            except threading.BrokenBarrierError:
                assert self.clear_barrier.broken
            super().clear_motions(client_id)
            with self.activity_lock:
                self.active_clears -= 1

    demo = BarrierDemo()
    request = PromptPlanRunRequest(
        raw_json=json.dumps({"token_frames": 4, "horizon_frames": 40, "cues": [_motion_cue("one")]}),
        output_path="session.pkl",
        base_seed=1,
    )
    start_barrier = threading.Barrier(2)
    results: list[bool] = []

    def run() -> None:
        start_barrier.wait()
        results.append(demo.run_prompt_plan(1, request))

    threads = [threading.Thread(target=run) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=3.0)

    session = demo.client_sessions[1]
    assert all(not thread.is_alive() for thread in threads)
    assert results == [True, True]
    assert demo.max_active_clears == 1
    assert len(session.client.timeline._prompts) == 1
    assert session.timeline_data["prompt_counter"] == 1
