from types import SimpleNamespace

import torch

from scripts.interactive_demo.generation import GenerationMixin


def test_history_override_ends_exactly_before_next_cue() -> None:
    session = SimpleNamespace(
        frame_idx=75,
        gui_elements=SimpleNamespace(
            gui_replan_buffer_size=SimpleNamespace(value=1),
            gui_history_crop_length=SimpleNamespace(value=4),
        ),
        motion_tensor=torch.zeros((1, 80, 2)),
        num_frames_per_token=4,
    )
    generation = GenerationMixin()

    history, start_frame, end_frame, history_length = generation._get_history_motion(
        session,
        history_end_idx_override=39,
    )

    assert end_frame == 39
    assert start_frame == 36
    assert history_length == 4
    assert history is not None and history.shape[1] == 4
