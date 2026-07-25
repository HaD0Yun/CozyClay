# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: CozyClay contributors
#
# cclay-owned script. Source of truth lives in the CozyClay repo at
# scripts/ardy/cclay_constrained_generate.py and is deployed to the ARDY box at
# ~/ardy/scripts/cclay_constrained_generate.py. Do not edit the deployed copy.
"""Contact-constrained text-to-motion generation for the cclay ARDY pipeline.

Text alone cannot place a foot on a stair tread: ARDY is scene-blind, and a
measured number written into the prompt ("climbs a 0.18 m step") is a caption
token, not a constraint. ARDY does support real spatial constraints — this
script drives that path with end-effector targets measured in the Blender
scene, so the generated motion passes THROUGH the contact points instead of
being generated blind and corrected afterwards.

Two-pass by construction. An ARDY end-effector constraint is a *pose* at a
frame, not a bare 3D point: ``EndEffectorConstraintSet`` derives its condition
from ``(global_joints_positions, global_joints_rots)`` and keeps only the named
joint plus ``Hips``. So a pose source is required, and the natural one is an
unconstrained first pass of the same prompt:

    pass 1: cclay-ardy-generate "..."                  -> base npz
    measure: preflight_motion + inspect_relations      -> contact frames, tread coords
    pass 2: this script, --base <pass 1> --target ...  -> constrained npz

For each target frame the base pose is kept and the ROOT is translated by
``target - achieved`` for the named joint. Forward kinematics is equivariant
under root translation, so that lands the joint exactly on the target while
preserving the pose and moving ``Hips`` consistently with it. No IK, no
per-joint surgery, no npz splicing.

Only the constrained joint and ``Hips`` survive into the condition, so the rest
of the base pose is irrelevant — the model regenerates the body (stride length,
knee bend, timing) to pass through the requested contacts.

Targets are in npz space: Y-up, meters, motion-local (the base motion's own
origin). Blender is Z-up and its rig may be scaled, so callers convert with the
``scale`` (meters per npz unit) reported by ``preflight_motion``.

Usage (from ~/ardy):
    .venv/bin/python scripts/cclay_constrained_generate.py \
        --prompt "A person walks forward and climbs three steps." \
        --duration 6 --base outputs/cclay/base.npz \
        --target 24 LeftFoot 0.15 0.18 0.60 \
        --target 38 RightFoot 0.15 0.36 0.90 \
        --output outputs/cclay/constrained --seed 7

The last stdout line is a single JSON object:
    {"frames": int, "fps": int, "model": str,
     "targets": [{"frame", "joint", "requested", "base", "achieved",
                  "base_error_m", "achieved_error_m"}],
     "residual": {"max_error_m", "mean_error_m", "worst_frame", "worst_joint"},
     "continuity": {"mean_jump_m", "max_jump_m", "max_jump_frame"}}

``achieved_error_m`` is measured on the GENERATED npz, not asserted from the
request: a constraint that the sampler could not satisfy must be visible as a
number rather than silently trusted. ``base_error_m`` is the same distance on
the unconstrained pass, so the pair shows whether constraining helped.
"""

import argparse
import json
import os

import numpy as np
import torch

from ardy.constraints import (
    LeftFootConstraintSet,
    LeftHandConstraintSet,
    RightFootConstraintSet,
    RightHandConstraintSet,
)
from ardy.model import DEFAULT_MODEL, load_model
from ardy.model.loading import get_env_var
from ardy.model.registry import resolve_model_name
from ardy.motion_rep.tools import length_to_mask
from ardy.postprocess import post_process_motion
from ardy.skeleton import SOMASkeleton30
from ardy.tools import seed_everything, to_numpy

# Closed vocabulary: exactly the end effectors ARDY ships a constraint set for.
# Each maps to a class whose `joint_names` is [<effector>, "Hips"].
JOINT_TO_CONSTRAINT = {
    "LeftFoot": LeftFootConstraintSet,
    "RightFoot": RightFootConstraintSet,
    "LeftHand": LeftHandConstraintSet,
    "RightHand": RightHandConstraintSet,
}


def parse_args():
    parser = argparse.ArgumentParser(
        description="Contact-constrained text-to-motion generation (cclay)"
    )
    parser.add_argument("--prompt", type=str, required=True, help="Motion prompt.")
    parser.add_argument(
        "--duration", type=float, required=True, help="Clip duration in seconds."
    )
    parser.add_argument(
        "--base",
        type=str,
        required=True,
        help="Unconstrained first-pass npz supplying the pose at each target frame.",
    )
    parser.add_argument(
        "--target",
        action="append",
        nargs=5,
        metavar=("FRAME", "JOINT", "X", "Y", "Z"),
        required=True,
        help=(
            "Repeatable end-effector target: 0-based frame, joint name "
            f"({'|'.join(JOINT_TO_CONSTRAINT)}), and npz-space X Y Z (Y-up, meters)."
        ),
    )
    parser.add_argument(
        "--output",
        type=str,
        default="output",
        help="Output stem name; bare names are placed under outputs/.",
    )
    parser.add_argument(
        "--model",
        type=str,
        default=DEFAULT_MODEL,
        help="Model nickname or full folder name (default: %(default)s).",
    )
    parser.add_argument(
        "--seed", type=int, default=None, help="Seed for reproducible results."
    )
    parser.add_argument(
        "--diffusion_steps",
        type=int,
        default=None,
        help="Denoising steps, at most the model's num_base_steps (the default).",
    )
    parser.add_argument(
        "--cfg_weight",
        type=float,
        nargs="+",
        default=[2.0, 2.0],
        help="CFG scale(s): one float (text) or two floats (text, constraint).",
    )
    parser.add_argument(
        "--no-postprocess",
        action="store_true",
        help="Don't apply motion post-processing (foot-skate reduction).",
    )
    parser.add_argument(
        "--checkpoints_dir",
        type=str,
        default=None,
        help="Local dir holding released model folders (falls back to CHECKPOINTS_DIR env).",
    )
    return parser.parse_args()


def _resolve_output_base(path: str, default_dir: str = "outputs") -> str:
    """Place bare output names under ``default_dir``; honor explicit paths (as generate.py)."""
    if os.path.dirname(path):
        return path
    return os.path.join(default_dir, path)


def _single_file_path(path: str, ext: str) -> str:
    """Return path for a single output file; add ext if missing, create parent dirs."""
    if not path.endswith(ext):
        path = path.rstrip(os.sep) + ext
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    return path


def save_motion_npz(path: str, motion_dict: dict, fps: float, text: str) -> None:
    """Save a motion output dict to ``.npz`` along with fps and the prompt (as generate.py)."""
    arrays = {k: np.asarray(v) for k, v in motion_dict.items()}
    arrays["fps"] = np.asarray(fps)
    arrays["text"] = np.asarray(text)
    np.savez(path, **arrays)


def _posed_joint_jumps(posed_joints: np.ndarray) -> np.ndarray:
    """jump[j] = max over joints of the L2 displacement between frames j and j+1 (meters)."""
    disp = np.linalg.norm(posed_joints[1:] - posed_joints[:-1], axis=-1)
    return disp.max(axis=-1)


def parse_targets(raw_targets: list, num_frames: int) -> list:
    """Validate raw --target tuples into sorted dicts. Fails closed on bad input."""
    targets = []
    seen = set()
    for raw_frame, joint, x, y, z in raw_targets:
        try:
            frame = int(raw_frame)
        except ValueError:
            raise ValueError(f"--target frame must be an integer, got {raw_frame!r}.")
        if joint not in JOINT_TO_CONSTRAINT:
            raise ValueError(
                f"--target joint must be one of {sorted(JOINT_TO_CONSTRAINT)}, got {joint!r}."
            )
        if not 0 <= frame < num_frames:
            raise ValueError(
                f"--target frame {frame} is outside the clip (0..{num_frames - 1} for "
                f"this --duration); lengthen the clip or move the contact."
            )
        if (frame, joint) in seen:
            raise ValueError(
                f"duplicate --target for {joint} at frame {frame}; one target per joint per frame."
            )
        seen.add((frame, joint))
        try:
            position = [float(x), float(y), float(z)]
        except ValueError:
            raise ValueError(f"--target X Y Z must be numbers, got {(x, y, z)!r}.")
        targets.append({"frame": frame, "joint": joint, "requested": position})
    targets.sort(key=lambda target: (target["frame"], target["joint"]))
    return targets


def load_base_motion(path: str, num_frames: int, device: str):
    """Load the first-pass npz and return (local_rot_mats, posed_joints) tensors."""
    if not os.path.isfile(path):
        raise ValueError(f"--base npz not found: {path}")
    with np.load(path) as data:
        for key in ("local_rot_mats", "posed_joints"):
            if key not in data:
                raise ValueError(f"--base npz {path} has no {key!r} array.")
        local_rot_mats = torch.from_numpy(np.asarray(data["local_rot_mats"])).to(device)
        posed_joints = torch.from_numpy(np.asarray(data["posed_joints"])).to(device)
    base_frames = int(local_rot_mats.shape[0])
    if base_frames < num_frames:
        raise ValueError(
            f"--base npz has {base_frames} frames but the requested clip is {num_frames}; "
            "a target frame would have no base pose. Generate the base pass at least as long."
        )
    return local_rot_mats.float(), posed_joints.float()


def build_constraints(targets: list, local_rot_mats, posed_joints, skeleton):
    """Build one ARDY constraint set per joint, root-shifted onto the targets.

    Returns (constraint_lst, base_positions) where base_positions[i] is the
    unconstrained position of targets[i]'s joint, for residual reporting.
    """
    device = skeleton.device
    root_index = skeleton.root_idx
    base_positions = []
    by_joint = {}
    for index, target in enumerate(targets):
        joint_index = skeleton.bone_index[target["joint"]]
        frame = target["frame"]
        requested = torch.tensor(target["requested"], device=device, dtype=torch.float32)
        achieved = posed_joints[frame, joint_index]
        base_positions.append([float(value) for value in achieved.tolist()])
        # FK is equivariant under root translation: shifting the root by
        # (requested - achieved) moves every joint by the same vector, so the
        # named joint lands exactly on the target with the pose preserved.
        shifted_root = posed_joints[frame, root_index] + (requested - achieved)
        by_joint.setdefault(target["joint"], []).append((index, frame, shifted_root))

    constraint_lst = []
    for joint, entries in by_joint.items():
        frames = [frame for _, frame, _ in entries]
        # frame_indices stays on the CPU: ARDY pairs it against its own
        # CPU-side joint index tensors inside update_constraints, so a device
        # tensor here fails in create_pairs. The interactive demo's
        # gen_constraints.py builds frame_indices the same way.
        frame_indices = torch.tensor(frames)
        roots = torch.stack([root for _, _, root in entries], dim=0)
        global_rots, global_positions, _ = skeleton.fk(local_rot_mats[frames], roots)
        constraint_lst.append(
            JOINT_TO_CONSTRAINT[joint](
                skeleton,
                frame_indices=frame_indices,
                global_joints_positions=global_positions,
                global_joints_rots=global_rots,
                root_2d=None,
            )
        )
    return constraint_lst, base_positions


def measure_residuals(targets: list, base_positions: list, posed_joints, skeleton) -> tuple:
    """Distance from each request to what the generated motion actually did."""
    reported = []
    errors = []
    for target, base_position in zip(targets, base_positions):
        joint_index = skeleton.bone_index[target["joint"]]
        achieved = [float(value) for value in posed_joints[target["frame"], joint_index]]
        requested = target["requested"]
        error = float(np.linalg.norm(np.asarray(achieved) - np.asarray(requested)))
        base_error = float(
            np.linalg.norm(np.asarray(base_position) - np.asarray(requested))
        )
        errors.append(error)
        reported.append(
            {
                "frame": target["frame"],
                "joint": target["joint"],
                "requested": [round(value, 4) for value in requested],
                "base": [round(value, 4) for value in base_position],
                "achieved": [round(value, 4) for value in achieved],
                "base_error_m": round(base_error, 4),
                "achieved_error_m": round(error, 4),
            }
        )
    worst = int(np.argmax(errors))
    residual = {
        "max_error_m": round(max(errors), 4),
        "mean_error_m": round(float(np.mean(errors)), 4),
        "worst_frame": reported[worst]["frame"],
        "worst_joint": reported[worst]["joint"],
    }
    return reported, residual


def main():
    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    print(f"Using device: {device}")
    args = parse_args()

    prompt = args.prompt.strip()
    if not prompt:
        raise ValueError("--prompt must be non-empty.")
    if args.duration <= 0:
        raise ValueError(f"--duration must be > 0 seconds, got {args.duration}.")
    if len(args.cfg_weight) == 1:
        cfg_weight = float(args.cfg_weight[0])
    elif len(args.cfg_weight) == 2:
        cfg_weight = (float(args.cfg_weight[0]), float(args.cfg_weight[1]))
    else:
        raise ValueError("--cfg_weight expects one float (text) or two floats (text, constraint).")

    # Load model (same path as scripts/generate.py)
    checkpoints_dir = args.checkpoints_dir or get_env_var("CHECKPOINTS_DIR")
    resolved_model = resolve_model_name(args.model, checkpoints_dir=checkpoints_dir)
    model = load_model(resolved_model, device=device, checkpoints_dir=checkpoints_dir)
    print(f"Loaded model: {resolved_model}")

    fps = model.motion_rep.fps
    num_frames = int(args.duration * fps)
    targets = parse_targets(args.target, num_frames)
    print(
        f"Will generate '{prompt}' with {num_frames} frames "
        f"({args.duration}s at {fps} fps) under {len(targets)} target(s)"
    )

    num_base_steps = int(model.diffusion.num_base_steps)
    diffusion_steps = args.diffusion_steps if args.diffusion_steps is not None else num_base_steps
    if not 1 <= diffusion_steps <= num_base_steps:
        raise ValueError(
            f"--diffusion_steps must be between 1 and {num_base_steps} "
            f"(this model's num_base_steps); got {diffusion_steps}."
        )

    skeleton = model.skeleton
    unknown = sorted(
        {target["joint"] for target in targets} - set(skeleton.bone_index)
    )
    if unknown:
        raise ValueError(
            f"this model's skeleton has no joint(s) {unknown}; "
            f"constrained generation needs {sorted(JOINT_TO_CONSTRAINT)}."
        )

    local_rot_mats, posed_joints = load_base_motion(args.base, num_frames, device)
    constraint_lst, base_positions = build_constraints(
        targets, local_rot_mats, posed_joints, skeleton
    )
    for constraint in constraint_lst:
        print(
            f"    {type(constraint).__name__} on frames {constraint.frame_indices.tolist()}"
        )

    if args.seed is not None:
        seed_everything(args.seed)

    lengths = torch.tensor([num_frames], device=device)
    pad_mask = length_to_mask(lengths)
    observed_motion, motion_mask = model.motion_rep.create_conditions_from_constraints_batched(
        constraint_lst,
        lengths,
        to_normalize=True,
        device=device,
    )
    with torch.no_grad():
        motion = model(
            [prompt],
            num_frames,
            num_denoising_steps=diffusion_steps,
            pad_mask=pad_mask,
            first_heading_angle=torch.zeros(1, device=device),
            motion_mask=motion_mask,
            observed_motion=observed_motion,
            cfg_weight=cfg_weight,
            progress_bar=lambda iterable: iterable,
        )
        output = model.motion_rep.inverse(motion, is_normalized=True)

    use_postprocess = "g1" not in resolved_model.lower() and not args.no_postprocess
    if use_postprocess:
        # Passing constraint_lst lets ARDY's own postprocess enforce the
        # contacts it was asked for instead of skating them away.
        corrected = post_process_motion(
            output["local_rot_mats"],
            output["root_positions"],
            output["foot_contacts"],
            skeleton,
            constraint_lst=constraint_lst,
        )
        output.update(corrected)

    if isinstance(skeleton, SOMASkeleton30):
        output = skeleton.output_to_SOMASkeleton77(output)

    output = to_numpy(output)
    motion_dict = {
        key: (value[0] if hasattr(value, "shape") and len(value.shape) > 0 and value.shape[0] == 1 else value)
        for key, value in output.items()
    }

    generated_joints = np.asarray(motion_dict["posed_joints"])
    reported, residual = measure_residuals(targets, base_positions, generated_joints, skeleton)

    output_base = _resolve_output_base(args.output)
    npz_path = _single_file_path(output_base, ".npz")
    print(f"Saving the npz output to {npz_path}")
    save_motion_npz(npz_path, motion_dict, fps, prompt)

    jumps = _posed_joint_jumps(generated_joints)
    result = {
        "frames": int(generated_joints.shape[0]),
        "fps": int(fps),
        "model": resolved_model,
        "targets": reported,
        "residual": residual,
        "continuity": {
            "mean_jump_m": float(jumps.mean()),
            "max_jump_m": float(jumps.max()),
            "max_jump_frame": int(jumps.argmax()) + 1,
        },
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()
