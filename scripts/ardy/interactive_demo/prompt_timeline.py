# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: CozyClay contributors

"""Half-open frame-range helpers for prompt clips."""


def prompt_clip_end_frame(start_frame: int, clip_frames: int) -> int:
    """Return the exclusive end frame for a fixed-length prompt clip."""
    return start_frame + clip_frames


def prompt_transition_frame(current_frame: int) -> int:
    """Return the shared half-open boundary after the current frame."""
    return current_frame + 1


def prompt_starts_at_or_after_transition(prompt_start: int, transition_frame: int) -> bool:
    """Return whether a pending prompt should be replaced at a transition."""
    return prompt_start >= transition_frame
