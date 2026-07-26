# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: CozyClay contributors

"""Sequential prompt-plan execution for the interactive ARDY session."""

import os
from pathlib import Path

from .common import *  # noqa: F401,F403
from .prompt_plan import (
    CompiledCue,
    CueAcceptance,
    CuePhase,
    PromptPlanError,
    PromptPlanRunRequest,
    attempt_seed,
    compile_prompt_plan_json,
)
from .prompt_plan_acceptance import both_hands_head_contact as core_touch_accepted
from .prompt_plan_acceptance import cue_accepted


def consume_auto_prompt_plan_path() -> Path | None:
    """Consume an optional one-shot prompt plan path from the process environment."""
    configured_path = os.environ.pop("ARDY_AUTO_PROMPT_PLAN", "").strip()
    return Path(configured_path) if configured_path else None


@dataclass(frozen=True, slots=True)
class _PromptSnapshot:
    text: str
    start_frame: int
    end_frame: int
    color: tuple[int, int, int]


@dataclass(frozen=True, slots=True)
class _SessionSnapshot:
    motion_tensor: torch.Tensor | None
    joints_pos: torch.Tensor | None
    joints_rot: torch.Tensor | None
    foot_contacts: torch.Tensor | None
    root_velocities: torch.Tensor | None
    text_embedding: torch.Tensor | None
    frame_idx: int
    max_frame_idx: int
    frame_idx_input_max: int
    playing: bool
    prompt_text: str
    active_prompt_label: str
    seed: int
    cfg_text_weight: float
    prompts: tuple[_PromptSnapshot, ...]


def _clone_tensor(value: torch.Tensor | None) -> torch.Tensor | None:
    return None if value is None else value.clone()


class PromptPlanExecutionMixin:
    """Generate locally embedded cue horizons and export the existing session format."""

    def run_prompt_plan(self, client_id: int, request: PromptPlanRunRequest) -> bool:
        """Generate sequential cue horizons and export a loadable session."""
        if not self.client_active(client_id):
            return False
        session = self.client_sessions[client_id]
        if session.model is None:
            return False
        with session.replan_lock:
            return self._run_prompt_plan_locked(client_id, request)

    def _run_prompt_plan_locked(self, client_id: int, request: PromptPlanRunRequest) -> bool:
        session = self.client_sessions[client_id]
        plan = compile_prompt_plan_json(request.raw_json)
        if plan.horizon_frames != session.gen_horizon_len:
            raise PromptPlanError(
                detail=f"plan horizon {plan.horizon_frames} does not match model horizon {session.gen_horizon_len}"
            )
        if plan.token_frames != session.num_frames_per_token:
            raise PromptPlanError(
                detail=f"plan token size {plan.token_frames} does not match model token size {session.num_frames_per_token}"
            )
        if not request.output_path.strip():
            raise PromptPlanError(detail="output_path must not be blank")

        snapshot = self._snapshot_prompt_plan_session(session)
        session.playing = False
        seed = attempt_seed(request.base_seed, request.attempt)

        try:
            self.clear_motions(client_id)
            self.clear_timeline_prompts(client_id)
            session.frame_idx = 0
            session.max_frame_idx = -1

            client = session.client
            prompt_uuid_list = session.timeline_data.get("prompt_uuid_list", [])
            accepted_ids: set[str] = set()
            for warning in plan.warnings:
                print(f"[Prompt Plan] {warning.code.value}: cue={warning.cue_id}, detail={warning.detail}")

            for cue_index, cue in enumerate(plan.cues):
                if cue.phase is CuePhase.RUB and not set(cue.prerequisite_ids).issubset(accepted_ids):
                    raise PromptPlanError(detail=f"cue {cue.id} requires an accepted touch prerequisite")
                prefix_snapshot = self._snapshot_prompt_plan_session(session)
                accepted = False
                for local_attempt in range(cue.max_attempts):
                    if local_attempt > 0:
                        self._restore_prompt_plan_session(client_id, prefix_snapshot)
                        prompt_uuid_list = session.timeline_data.get("prompt_uuid_list", [])
                    cue_seed = seed + cue_index * 10 + local_attempt
                    session.gui_elements.gui_seed.value = cue_seed
                    seed_everything(cue_seed)
                    session.gui_elements.gui_cfg_text_weight.value = (
                        snapshot.cfg_text_weight if cue.cfg_text_weight is None else cue.cfg_text_weight
                    )
                    session.gui_elements.gui_prompt_text.value = cue.prompt_text
                    text_feat, _ = session.model.text_encoder([cue.prompt_text])
                    session.text_embedding = text_feat.to(self.device)
                    session.gui_elements.gui_active_prompt_label.content = f"**Active Prompt:** {cue.prompt_text}"
                    prompt_uuid = client.timeline.add_prompt(
                        text=cue.prompt_text,
                        start_frame=cue.start_frame,
                        end_frame=cue.end_frame,
                        color=self.get_prompt_color(cue_index),
                    )
                    prompt_uuid_list.append(prompt_uuid)
                    self._generate_step(client_id, history_end_idx_override=cue.history_end_frame)
                    if self.accept_generated_cue(client_id, cue):
                        print(f"[Prompt Plan] accepted cue={cue.id}, attempt={local_attempt + 1}, seed={cue_seed}")
                        accepted = True
                        break
                if not accepted:
                    raise PromptPlanError(detail=f"cue {cue.id} failed the motion acceptance gate")
                accepted_ids.add(cue.id)

            session.timeline_data["prompt_counter"] = len(prompt_uuid_list)
            exported = self.export_session(client_id, request.output_path)
            if not exported:
                raise PromptPlanError(detail=f"failed to export prompt plan session: {request.output_path}")
            self.set_frame(client_id, 0, trigger_by_gui_timeline=True)
            return True
        except BaseException:  # noqa: BROAD_EXCEPT_OK - transactional boundary must roll back every failure.
            self._restore_prompt_plan_session(client_id, snapshot)
            raise
        finally:
            session.gui_elements.gui_cfg_text_weight.value = snapshot.cfg_text_weight
            session.playing = snapshot.playing

    def accept_generated_cue(self, client_id: int, cue: CompiledCue) -> bool:
        """Overridable post-generation acceptance gate."""
        if cue.acceptance is CueAcceptance.NONE:
            return True
        session = self.client_sessions[client_id]
        skeleton = getattr(session.motion_rep, "skeleton", None)
        if not isinstance(skeleton, CoreSkeleton27) or session.joints_pos is None:
            return False
        cue_joints = session.joints_pos[:, cue.start_frame : cue.end_frame]
        return cue_accepted(cue.acceptance, cue_joints)

    def _snapshot_prompt_plan_session(self, session) -> _SessionSnapshot:
        prompts = tuple(
            _PromptSnapshot(prompt.text, prompt.start_frame, prompt.end_frame, tuple(prompt.color))
            for prompt_id in session.timeline_data.get("prompt_uuid_list", [])
            if (prompt := session.client.timeline._prompts.get(prompt_id)) is not None
        )
        return _SessionSnapshot(
            motion_tensor=_clone_tensor(session.motion_tensor),
            joints_pos=_clone_tensor(session.joints_pos),
            joints_rot=_clone_tensor(session.joints_rot),
            foot_contacts=_clone_tensor(session.foot_contacts),
            root_velocities=_clone_tensor(session.root_velocities),
            text_embedding=_clone_tensor(session.text_embedding),
            frame_idx=session.frame_idx,
            max_frame_idx=session.max_frame_idx,
            frame_idx_input_max=session.gui_elements.gui_frame_idx_input.max,
            playing=session.playing,
            prompt_text=session.gui_elements.gui_prompt_text.value,
            active_prompt_label=session.gui_elements.gui_active_prompt_label.content,
            seed=session.gui_elements.gui_seed.value,
            cfg_text_weight=session.gui_elements.gui_cfg_text_weight.value,
            prompts=prompts,
        )

    def _restore_prompt_plan_session(self, client_id: int, snapshot: _SessionSnapshot) -> None:
        session = self.client_sessions[client_id]
        self.clear_motions(client_id)
        self.clear_timeline_prompts(client_id)
        session.motion_tensor = snapshot.motion_tensor
        session.joints_pos = snapshot.joints_pos
        session.joints_rot = snapshot.joints_rot
        session.foot_contacts = snapshot.foot_contacts
        session.root_velocities = snapshot.root_velocities
        session.text_embedding = snapshot.text_embedding
        session.frame_idx = snapshot.frame_idx
        session.max_frame_idx = snapshot.max_frame_idx
        session.gui_elements.gui_frame_idx_input.max = snapshot.frame_idx_input_max
        session.gui_elements.gui_prompt_text.value = snapshot.prompt_text
        session.gui_elements.gui_active_prompt_label.content = snapshot.active_prompt_label
        session.gui_elements.gui_seed.value = snapshot.seed
        session.gui_elements.gui_cfg_text_weight.value = snapshot.cfg_text_weight
        prompt_ids = session.timeline_data.get("prompt_uuid_list", [])
        for prompt in snapshot.prompts:
            prompt_ids.append(
                session.client.timeline.add_prompt(
                    text=prompt.text,
                    start_frame=prompt.start_frame,
                    end_frame=prompt.end_frame,
                    color=prompt.color,
                )
            )
        session.timeline_data["prompt_counter"] = len(prompt_ids)
        if snapshot.motion_tensor is not None and session.motion_rep is not None:
            for index in range(snapshot.motion_tensor.shape[0]):
                self.add_character(client_id, session.motion_rep.skeleton, index)
        self.set_frame(client_id, snapshot.frame_idx, trigger_by_gui_timeline=True)
