from scripts.interactive_demo.prompt_timeline import (
    prompt_clip_end_frame,
    prompt_starts_at_or_after_transition,
    prompt_transition_frame,
)


def test_prompt_clip_end_frame_is_exclusive_when_clip_has_fixed_length() -> None:
    # Given
    start_frame = 40
    clip_frames = 40

    # When
    end_frame = prompt_clip_end_frame(start_frame, clip_frames)

    # Then
    assert end_frame == 80


def test_prompt_transition_uses_one_shared_half_open_boundary() -> None:
    # Given
    current_frame = 39

    # When
    boundary = prompt_transition_frame(current_frame)

    # Then
    assert boundary == 40


def test_prompt_at_same_transition_is_replaced_instead_of_zero_length() -> None:
    # Given
    prompt_start = 40
    transition = 40

    # When
    replace_prompt = prompt_starts_at_or_after_transition(prompt_start, transition)

    # Then
    assert replace_prompt is True
