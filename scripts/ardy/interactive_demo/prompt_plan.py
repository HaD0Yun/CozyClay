# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: CozyClay contributors

"""Typed rules for sequential, horizon-sized ARDY text cues."""

from dataclasses import dataclass
from enum import StrEnum
import re
from typing import Annotated, assert_never

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError

NonBlankText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class CuePhase(StrEnum):
    """Supported observable motion phases."""

    MOTION = "motion"
    HOLD = "hold"
    REACH = "reach"
    TOUCH = "touch"
    RUB = "rub"


class CueAcceptance(StrEnum):
    """Coordinate acceptance stage applied after generation."""

    NONE = "none"
    SEATED = "seated"
    BACKWARD_LEAN = "backward_lean"
    FALL_TO_GROUND = "fall_to_ground"
    BOTH_HANDS_HEAD_CONTACT = "both_hands_head_contact"
    HEAD_RUB = "head_rub"


class WarningCode(StrEnum):
    """Machine-readable prompt-plan warning codes."""

    UNSUPPORTED_PROP_EFFECT = "unsupported_prop_effect"


class PromptCue(BaseModel):
    """One neutral, observable human-motion cue from a JSON plan."""

    model_config = ConfigDict(frozen=True)

    id: NonBlankText
    phase: CuePhase
    current_state: NonBlankText
    motion: NonBlankText
    prerequisites: tuple[NonBlankText, ...] = ()
    prop_effects: tuple[NonBlankText, ...] = ()
    cfg_text_weight: float | None = Field(default=None, ge=0.0, le=10.0)
    acceptance: CueAcceptance = CueAcceptance.NONE
    max_attempts: int = Field(default=1, ge=1, le=5)


class PromptPlan(BaseModel):
    """Validated JSON boundary for sequential horizon cues."""

    model_config = ConfigDict(frozen=True)

    token_frames: int = Field(gt=0)
    horizon_frames: int = Field(gt=0)
    cues: tuple[PromptCue, ...] = Field(min_length=1)


@dataclass(frozen=True, slots=True)
class PlanWarning:
    """A non-fatal limitation attached to one cue."""

    code: WarningCode
    cue_id: str
    detail: str


@dataclass(frozen=True, slots=True)
class CompiledCue:
    """One cue placed on a half-open frame span."""

    id: str
    phase: CuePhase
    prompt_text: str
    start_frame: int
    end_frame: int
    history_end_frame: int
    prerequisite_ids: tuple[str, ...]
    cfg_text_weight: float | None
    acceptance: CueAcceptance
    max_attempts: int


@dataclass(frozen=True, slots=True)
class CompiledPromptPlan:
    """A contiguous plan ready for deterministic sequential execution."""

    token_frames: int
    horizon_frames: int
    cues: tuple[CompiledCue, ...]
    warnings: tuple[PlanWarning, ...]


@dataclass(frozen=True, slots=True)
class PromptPlanError(Exception):
    """A JSON cue plan violated an ARDY execution rule."""

    detail: str

    def __str__(self) -> str:
        return self.detail


@dataclass(frozen=True, slots=True)
class PromptPlanRunRequest:
    """Inputs for one deterministic prompt-plan generation attempt."""

    raw_json: str
    output_path: str
    base_seed: int
    attempt: int = 0


def _required_prerequisite(phase: CuePhase) -> CuePhase | None:
    match phase:
        case CuePhase.TOUCH:
            return CuePhase.REACH
        case CuePhase.RUB:
            return CuePhase.TOUCH
        case CuePhase.MOTION | CuePhase.HOLD | CuePhase.REACH:
            return None
        case unreachable:
            assert_never(unreachable)


def _parse_prompt_plan(raw_json: str) -> PromptPlan:
    try:
        return PromptPlan.model_validate_json(raw_json)
    except ValidationError as error:
        raise PromptPlanError(detail=str(error)) from None


def compile_prompt_plan_json(raw_json: str) -> CompiledPromptPlan:
    """Parse JSON and compile contiguous half-open, token-aligned cue spans."""
    plan = _parse_prompt_plan(raw_json)
    if plan.horizon_frames % plan.token_frames != 0:
        raise PromptPlanError(detail="horizon_frames must be a multiple of token_frames")

    cue_by_id: dict[str, PromptCue] = {}
    compiled: list[CompiledCue] = []
    warnings: list[PlanWarning] = []
    for cue_index, cue in enumerate(plan.cues):
        if cue.id in cue_by_id:
            raise PromptPlanError(detail=f"duplicate cue id: {cue.id}")

        prerequisite_cues: list[PromptCue] = []
        for prerequisite_id in cue.prerequisites:
            prerequisite = cue_by_id.get(prerequisite_id)
            if prerequisite is None:
                raise PromptPlanError(
                    detail=f"cue {cue.id} prerequisite must refer to an earlier cue: {prerequisite_id}"
                )
            prerequisite_cues.append(prerequisite)

        required_phase = _required_prerequisite(cue.phase)
        if required_phase is not None and not any(item.phase is required_phase for item in prerequisite_cues):
            raise PromptPlanError(detail=f"cue {cue.id} requires an earlier {required_phase.value} prerequisite")

        conditioning_text = f"{cue.current_state} {cue.motion}"
        if not re.search(r"\bperson\b", cue.current_state, re.IGNORECASE) or not re.search(
            r"\bperson\b", cue.motion, re.IGNORECASE
        ):
            raise PromptPlanError(detail=f"cue {cue.id} current_state and motion must describe the person")
        prop_terms = ("chair", "cup", "drink", "liquid", "spill", "break")
        found_terms = [term for term in prop_terms if re.search(rf"\b{term}\w*\b", conditioning_text, re.IGNORECASE)]
        if found_terms:
            raise PromptPlanError(
                detail=f"cue {cue.id} conditioning text contains scene-prop terms {found_terms}; move them to prop_effects"
            )

        start_frame = cue_index * plan.horizon_frames
        prompt_text = conditioning_text if cue_index == 0 else cue.motion
        compiled.append(
            CompiledCue(
                id=cue.id,
                phase=cue.phase,
                prompt_text=prompt_text,
                start_frame=start_frame,
                end_frame=start_frame + plan.horizon_frames,
                history_end_frame=start_frame - 1,
                prerequisite_ids=cue.prerequisites,
                cfg_text_weight=cue.cfg_text_weight,
                acceptance=cue.acceptance,
                max_attempts=cue.max_attempts,
            )
        )
        warnings.extend(
            PlanWarning(
                code=WarningCode.UNSUPPORTED_PROP_EFFECT,
                cue_id=cue.id,
                detail=effect,
            )
            for effect in cue.prop_effects
        )
        cue_by_id[cue.id] = cue

    return CompiledPromptPlan(
        token_frames=plan.token_frames,
        horizon_frames=plan.horizon_frames,
        cues=tuple(compiled),
        warnings=tuple(warnings),
    )


def attempt_seed(base_seed: int, attempt: int) -> int:
    """Return the deterministic seed assigned to one attempt."""
    if base_seed < 0 or attempt < 0:
        raise PromptPlanError(detail="base_seed and attempt must be non-negative")
    return base_seed + attempt
