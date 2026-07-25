import json

from scripts.interactive_demo.prompt_plan import (
    CueAcceptance,
    CuePhase,
    PromptPlanError,
    WarningCode,
    attempt_seed,
    compile_prompt_plan_json,
)


def _plan_json(cues: list[dict[str, str | float | list[str]]]) -> str:
    return json.dumps({"token_frames": 4, "horizon_frames": 40, "cues": cues})


def _cue(
    cue_id: str,
    phase: str,
    prerequisites: list[str] | None = None,
    prop_effects: list[str] | None = None,
) -> dict[str, str | float | list[str]]:
    return {
        "id": cue_id,
        "phase": phase,
        "current_state": "The person is balanced and still.",
        "motion": "The person makes one visible body movement.",
        "prerequisites": prerequisites or [],
        "prop_effects": prop_effects or [],
    }


def test_compile_prompt_plan_builds_contiguous_half_open_horizons() -> None:
    # Given
    raw = _plan_json([_cue("move", "motion"), _cue("hold", "hold")])

    # When
    compiled = compile_prompt_plan_json(raw)

    # Then
    assert [(cue.start_frame, cue.end_frame) for cue in compiled.cues] == [(0, 40), (40, 80)]


def test_compile_prompt_plan_sets_exact_history_end_before_each_cue() -> None:
    # Given
    raw = _plan_json([_cue("move", "motion"), _cue("hold", "hold")])

    # When
    compiled = compile_prompt_plan_json(raw)

    # Then
    assert [cue.history_end_frame for cue in compiled.cues] == [-1, 39]


def test_compile_prompt_plan_rejects_blank_motion() -> None:
    # Given
    cue = _cue("move", "motion")
    cue["motion"] = "   "

    # When
    try:
        compile_prompt_plan_json(_plan_json([cue]))
    except PromptPlanError:
        rejected = True
    else:
        rejected = False

    # Then
    assert rejected is True


def test_compile_prompt_plan_requires_reach_before_touch() -> None:
    # Given
    raw = _plan_json([_cue("touch", "touch")])

    # When
    try:
        compile_prompt_plan_json(raw)
    except PromptPlanError:
        rejected = True
    else:
        rejected = False

    # Then
    assert rejected is True


def test_compile_prompt_plan_requires_touch_before_rub() -> None:
    # Given
    raw = _plan_json(
        [
            _cue("reach", "reach"),
            _cue("touch", "touch", ["reach"]),
            _cue("rub", "rub", ["touch"]),
        ]
    )

    # When
    compiled = compile_prompt_plan_json(raw)

    # Then
    assert [cue.phase for cue in compiled.cues] == [CuePhase.REACH, CuePhase.TOUCH, CuePhase.RUB]


def test_compile_prompt_plan_warns_for_prop_only_effect() -> None:
    # Given
    raw = _plan_json([_cue("move", "motion", prop_effects=["liquid spills"])] )

    # When
    compiled = compile_prompt_plan_json(raw)

    # Then
    assert [warning.code for warning in compiled.warnings] == [WarningCode.UNSUPPORTED_PROP_EFFECT]


def test_compile_prompt_plan_rejects_scene_prop_conditioning_text() -> None:
    cue = _cue("drink", "motion")
    cue["motion"] = "The person lifts a cup and drinks liquid."

    try:
        compile_prompt_plan_json(_plan_json([cue]))
    except PromptPlanError as error:
        detail = str(error)
    else:
        detail = ""

    assert "prop_effects" in detail


def test_compile_prompt_plan_requires_person_focused_conditioning_text() -> None:
    cue = _cue("move", "motion")
    cue["current_state"] = "Standing upright."

    try:
        compile_prompt_plan_json(_plan_json([cue]))
    except PromptPlanError:
        rejected = True
    else:
        rejected = False

    assert rejected is True


def test_compile_prompt_plan_carries_bounded_per_cue_cfg_text_weight() -> None:
    cue = _cue("reach", "reach")
    cue["cfg_text_weight"] = 5.0

    compiled = compile_prompt_plan_json(_plan_json([cue]))

    assert compiled.cues[0].cfg_text_weight == 5.0


def test_compile_prompt_plan_rejects_cfg_text_weight_above_ten() -> None:
    cue = _cue("reach", "reach")
    cue["cfg_text_weight"] = 10.1

    try:
        compile_prompt_plan_json(_plan_json([cue]))
    except PromptPlanError:
        rejected = True
    else:
        rejected = False

    assert rejected is True


def test_compile_prompt_plan_carries_acceptance_and_bounded_attempts() -> None:
    cue = _cue("fall", "motion")
    cue["acceptance"] = "fall_to_ground"
    cue["max_attempts"] = 3

    compiled = compile_prompt_plan_json(_plan_json([cue]))

    assert compiled.cues[0].acceptance is CueAcceptance.FALL_TO_GROUND
    assert compiled.cues[0].max_attempts == 3


def test_compile_prompt_plan_rejects_more_than_five_attempts() -> None:
    cue = _cue("fall", "motion")
    cue["max_attempts"] = 6

    try:
        compile_prompt_plan_json(_plan_json([cue]))
    except PromptPlanError:
        rejected = True
    else:
        rejected = False

    assert rejected is True


def test_attempt_seed_is_deterministic_per_attempt() -> None:
    # Given
    base_seed = 100
    attempt = 3

    # When
    seed = attempt_seed(base_seed, attempt)

    # Then
    assert seed == 103
