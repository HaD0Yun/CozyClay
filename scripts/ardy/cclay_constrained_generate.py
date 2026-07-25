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
    {"target_space": "skeleton_joint_center", "surface_contact_verified": False,
     "frames": int, "fps": int, "model": str,
     "targets": [{"frame", "joint", "requested", "base", "achieved",
                  "base_error_m", "achieved_error_m"}],
     "residual": {"max_error_m", "mean_error_m", "worst_frame", "worst_joint"},
     "continuity": {"mean_jump_m", "max_jump_m", "max_jump_frame"}}

``achieved_error_m`` is measured on the GENERATED npz, not asserted from the
request: a constraint that the sampler could not satisfy must be visible as a
number rather than silently trusted. ``base_error_m`` is the same distance on
the unconstrained pass, so the pair shows whether constraining helped.

``target_space`` is always ``"skeleton_joint_center"``: every distance in this
result (``achieved_error_m``, ``base_error_m``, and ``residual``) is the
Euclidean gap between the requested point and the named SKELETON JOINT's
center, in npz space. It is not a measurement of sole/surface contact — the
skeleton has no foot sole geometry, so a joint center landing exactly on a
target says nothing about whether a modeled shoe sole or foot mesh actually
touches the surface at that frame. ``surface_contact_verified`` is hard-coded
``False`` for that reason: zero joint-center residual cannot prove sole
contact, and no downstream consumer should treat ``achieved_error_m == 0`` as
surface-contact verification without an independent mesh/surface check.
"""

import argparse
import json
import math
import os

# torch, numpy and ardy are imported lazily inside the functions that need them.
# The validation layer above them must stay importable with plain stdlib: it is
# the only part that can carry a repo regression test, because the machine that
# edits this file has no torch, no ardy and no numpy -- only the GPU box does.

# Closed vocabulary: exactly the end effectors ARDY ships a constraint set for.
# Names only, so validation needs no ardy import; _joint_constraint_classes()
# resolves each to a class whose `joint_names` is [<effector>, "Hips"].
JOINT_TO_CONSTRAINT = ("LeftFoot", "RightFoot", "LeftHand", "RightHand")


def _joint_constraint_classes() -> dict:
    from ardy.constraints import (
        LeftFootConstraintSet,
        LeftHandConstraintSet,
        RightFootConstraintSet,
        RightHandConstraintSet,
    )

    return {
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
        default=None,
        help=(
            "Repeatable end-effector target: 0-based frame, joint name "
            f"({'|'.join(JOINT_TO_CONSTRAINT)}), and npz-space X Y Z (Y-up, meters)."
        ),
    )
    parser.add_argument(
        "--target-orient",
        action="append",
        nargs=6,
        metavar=("FRAME", "JOINT", "QW", "QX", "QY", "QZ"),
        default=None,
        help=(
            "Repeatable end-effector ORIENTATION: 0-based frame, joint name, and the "
            "joint's global rotation as a unit quaternion in npz space (Y-up). "
            "Without this the rotation is whatever --base happened to produce, so a "
            "hand reaches the right point with an arbitrary wrist axis."
        ),
    )
    parser.add_argument(
        "--pose-from",
        action="append",
        nargs=3,
        metavar=("SRC_NPZ", "SRC_FRAME", "DST_FRAME"),
        default=None,
        help=(
            "Repeatable FULL-BODY pose transfer: copy every joint's pose from "
            "SRC_NPZ at SRC_FRAME and pin it at DST_FRAME of the new clip. Whole-body "
            "poses (sitting, lying) cannot be expressed as end-effector positions."
        ),
    )
    parser.add_argument(
        "--root-2d",
        action="append",
        nargs=4,
        metavar=("FRAME", "X", "Z", "HEADING"),
        default=None,
        help=(
            "Repeatable root waypoint: 0-based frame, npz-space X and Z (the "
            "horizontal plane; Y is up and is NOT constrained here), and a heading in "
            "radians or the literal 'none' to leave facing free."
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
        default=None,
        help=(
            "Model nickname or full folder name; defaults to ardy's DEFAULT_MODEL, "
            "resolved lazily so parse_args needs no ardy import."
        ),
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
        "--num-samples",
        dest="num_samples",
        type=int,
        default=1,
        help=(
            "Draw N samples (1..8) and keep the one whose MEASURED constraint error "
            "is lowest. Sampling is stochastic, so a second draw often lands a "
            "contact the first missed; the per-sample errors and the chosen index "
            "are reported so the selection is auditable rather than hidden."
        ),
    )
    parser.add_argument(
        "--contact-threshold",
        dest="contact_threshold",
        type=float,
        default=0.5,
        help=(
            "ARDY post-processing foot-contact probability cut-off, 0 < t < 1 "
            "(default %(default)s). Raise it to trust fewer predicted contacts."
        ),
    )
    parser.add_argument(
        "--root-margin",
        dest="root_margin",
        type=float,
        default=0.04,
        help=(
            "ARDY post-processing root-correction margin in meters, 0 <= m <= 0.5 "
            "(default %(default)s). The default 0.04 is 10%% of a 0.4 m box height, "
            "so lower it when a contact has to be tight."
        ),
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
    import numpy as np

    arrays = {k: np.asarray(v) for k, v in motion_dict.items()}
    arrays["fps"] = np.asarray(fps)
    arrays["text"] = np.asarray(text)
    np.savez(path, **arrays)


def _posed_joint_accelerations(posed_joints):
    """Peak per-frame change IN joint velocity, i.e. the second difference.

    The tie-breaker used to minimize peak VELOCITY, which conflates smooth with
    slow: a draw that reaches its pinned contacts and then goes limp scores best
    on velocity while looking worse. Acceleration is what a pop or a teleport
    actually is, and sustained fast motion has near-zero acceleration, so this
    ranks discontinuity without rewarding stillness.
    """
    import numpy as np

    if len(posed_joints) < 3:
        return np.zeros(1)
    velocity = np.asarray(posed_joints[1:], dtype=np.float64) - np.asarray(
        posed_joints[:-1], dtype=np.float64
    )
    return np.linalg.norm(velocity[1:] - velocity[:-1], axis=-1).max(axis=-1)


def _posed_joint_jumps(posed_joints):
    """jump[j] = max over joints of the L2 displacement between frames j and j+1 (meters)."""
    import numpy as np

    disp = np.linalg.norm(posed_joints[1:] - posed_joints[:-1], axis=-1)
    return disp.max(axis=-1)


def parse_targets(raw_targets: list, num_frames: int) -> list:
    """Validate raw --target tuples into sorted dicts. Fails closed on bad input."""
    targets = []
    seen = set()
    for raw_frame, joint, x, y, z in raw_targets:
        frame = _parse_frame(raw_frame, num_frames, "--target")
        if joint not in JOINT_TO_CONSTRAINT:
            raise ValueError(
                f"--target joint must be one of {sorted(JOINT_TO_CONSTRAINT)}, got {joint!r}."
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


def _parse_frame(raw, num_frames: int, flag: str) -> int:
    try:
        frame = int(raw)
    except ValueError:
        raise ValueError(f"{flag} frame must be an integer, got {raw!r}.")
    if not 0 <= frame < num_frames:
        raise ValueError(
            f"{flag} frame {frame} is outside the clip (0..{num_frames - 1} for this "
            f"--duration); lengthen the clip or move the constraint."
        )
    return frame


def _parse_floats(raw_values, flag: str, names: str) -> list:
    try:
        return [float(value) for value in raw_values]
    except ValueError:
        raise ValueError(f"{flag} {names} must be numbers, got {tuple(raw_values)!r}.")


def parse_orientations(raw_orientations, num_frames: int, targets: list) -> list:
    """Validate --target-orient into dicts keyed to an existing position target.

    An ARDY end-effector constraint conditions position AND rotation on the same
    frame, so an orientation with no position would leave the joint's location to
    the sampler and the pair would not describe a pose at all. Requiring the
    matching --target keeps a proxy keyframe whole instead of half-specified.
    """
    if not raw_orientations:
        return []
    positioned = {(target["frame"], target["joint"]) for target in targets}
    orientations = []
    seen = set()
    for raw_frame, joint, *raw_quaternion in raw_orientations:
        frame = _parse_frame(raw_frame, num_frames, "--target-orient")
        if joint not in JOINT_TO_CONSTRAINT:
            raise ValueError(
                f"--target-orient joint must be one of {sorted(JOINT_TO_CONSTRAINT)}, "
                f"got {joint!r}."
            )
        if (frame, joint) in seen:
            raise ValueError(
                f"duplicate --target-orient for {joint} at frame {frame}; "
                "one orientation per joint per frame."
            )
        seen.add((frame, joint))
        if (frame, joint) not in positioned:
            raise ValueError(
                f"--target-orient {joint} at frame {frame} has no matching --target; "
                "an end-effector constraint is a pose, so give the position too."
            )
        quaternion = _parse_floats(raw_quaternion, "--target-orient", "QW QX QY QZ")
        norm = math.sqrt(sum(value * value for value in quaternion))
        if not math.isfinite(norm) or abs(norm - 1.0) > 1e-3:
            raise ValueError(
                f"--target-orient quaternion for {joint} at frame {frame} must be a "
                f"unit quaternion, got norm {norm:.6f}."
            )
        orientations.append({"frame": frame, "joint": joint, "quaternion": quaternion})
    orientations.sort(key=lambda entry: (entry["frame"], entry["joint"]))
    return orientations


def parse_poses(raw_poses, num_frames: int) -> list:
    """Validate --pose-from. Source frames are range-checked against the npz later."""
    if not raw_poses:
        return []
    poses = []
    seen = set()
    for source, raw_source_frame, raw_destination_frame in raw_poses:
        if not os.path.isfile(source):
            raise ValueError(f"--pose-from npz not found: {source}")
        try:
            source_frame = int(raw_source_frame)
        except ValueError:
            raise ValueError(
                f"--pose-from SRC_FRAME must be an integer, got {raw_source_frame!r}."
            )
        if source_frame < 0:
            raise ValueError(f"--pose-from SRC_FRAME must be >= 0, got {source_frame}.")
        frame = _parse_frame(raw_destination_frame, num_frames, "--pose-from")
        if frame in seen:
            raise ValueError(
                f"duplicate --pose-from for clip frame {frame}; a frame can hold only "
                "one full-body pose."
            )
        seen.add(frame)
        poses.append(
            {"source": source, "source_frame": source_frame, "frame": frame}
        )
    poses.sort(key=lambda entry: entry["frame"])
    return poses


def parse_root_waypoints(raw_waypoints, num_frames: int) -> list:
    """Validate --root-2d. HEADING is radians or the literal 'none'."""
    if not raw_waypoints:
        return []
    waypoints = []
    seen = set()
    for raw_frame, raw_x, raw_z, raw_heading in raw_waypoints:
        frame = _parse_frame(raw_frame, num_frames, "--root-2d")
        if frame in seen:
            raise ValueError(
                f"duplicate --root-2d for frame {frame}; one waypoint per frame."
            )
        seen.add(frame)
        x, z = _parse_floats((raw_x, raw_z), "--root-2d", "X Z")
        if str(raw_heading).lower() == "none":
            heading = None
        else:
            heading = _parse_floats((raw_heading,), "--root-2d", "HEADING")[0]
        waypoints.append({"frame": frame, "xz": [x, z], "heading": heading})
    waypoints.sort(key=lambda entry: entry["frame"])
    if len({entry["heading"] is None for entry in waypoints}) > 1:
        # ARDY conditions the whole waypoint set on one heading tensor, so a
        # partly-headed request would silently invent headings for the rest.
        raise ValueError(
            "--root-2d heading must be given for every waypoint or for none of them; "
            "ARDY conditions the whole waypoint set on one heading tensor."
        )
    return waypoints


def _quaternion_matrix_rows(quaternion) -> tuple:
    """Quaternion (w, x, y, z) -> 3x3 rotation as nested tuples, active column form.

    Normalizes first. The caller's 1e-3 unit tolerance is an input-sanity check,
    not a rigidity guarantee: a quaternion of norm 1.001 used verbatim yields a
    matrix with determinant 1.005 and orthonormality error 0.0036, which is not a
    rotation but would be handed to ARDY as one. Normalizing makes every accepted
    quaternion produce an exactly rigid matrix, so the tolerance only has to
    catch nonsense (zero, NaN, inf, wrong magnitude).

    Stdlib only, and separate from the torch wrapper below, so the convention can
    carry a repo regression test on a machine with no torch.
    """
    w, x, y, z = (float(value) for value in quaternion)
    norm = math.sqrt(w * w + x * x + y * y + z * z)
    w, x, y, z = w / norm, x / norm, y / norm, z / norm
    return (
        (1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)),
        (2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)),
        (2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)),
    )


def _quaternion_to_matrix(quaternion, device):
    """_quaternion_matrix_rows as a torch tensor on ``device``."""
    import torch

    return torch.tensor(
        _quaternion_matrix_rows(quaternion), device=device, dtype=torch.float32
    )


def rank_samples(costs) -> int:
    """Index of the winning sample given each sample's cost tuple.

    Lexicographic on the FIRST TWO terms only: worst measured constraint error,
    then peak joint acceleration. Later terms (travel) are reported for visibility
    and must NOT rank -- including travel would silently make it a third
    tie-breaker preferring whichever draw happens to move less. Ties keep the
    lowest index so a rerun with the same seed picks the same draw.

    Pure and stdlib-only so the ordering, which is load-bearing, carries a repo
    test instead of resting on a live GPU run.
    """
    if not costs:
        raise ValueError("rank_samples needs at least one sample cost.")

    def key(cost):
        # A NaN loses every comparison, so a diverged draw sitting at index 0 was
        # never displaced and won outright. Map non-finite to +inf so it can only
        # ever lose. Python's min had the same hole; this closes it.
        return tuple(
            math.inf if not math.isfinite(term) else term for term in cost[:2]
        )

    best = 0
    for index in range(1, len(costs)):
        if key(costs[index]) < key(costs[best]):
            best = index
    return best


def _geodesic_degrees(a, b) -> float:
    """Angle in degrees between two rotation matrices, as nested 3x3 sequences.

    Stdlib only so the quaternion-convention check can be a repo test. The clamp
    keeps arccos in domain for float error; it also means a NON-rotation input
    reads as a small angle, so only feed real rotation matrices.
    """
    trace = sum(
        sum(float(a[k][i]) * float(b[k][j]) for k in range(3))
        for i, j in ((0, 0), (1, 1), (2, 2))
    )
    return math.degrees(math.acos(max(-1.0, min(1.0, (trace - 1.0) / 2.0))))


def load_base_motion(path: str, num_frames: int, device: str):
    """Load the first-pass npz and return (local_rot_mats, posed_joints) tensors."""
    import numpy as np
    import torch

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


def load_poses(poses: list, skeleton, device: str) -> None:
    """Resolve every --pose-from source into full-body global positions and rotations.

    A FullBodyConstraintSet needs all 27 joints, so the pose has to come from an
    existing npz -- 27 rotations are not authorable by hand. The pose arrives with
    its own root, so pair it with --root-2d when the placement matters (a chair is
    somewhere specific); alone it pins the shape, not the spot.
    """
    import numpy as np
    import torch

    for pose in poses:
        with np.load(pose["source"]) as data:
            for key in ("local_rot_mats", "posed_joints"):
                if key not in data:
                    raise ValueError(
                        f"--pose-from npz {pose['source']} has no {key!r} array."
                    )
            source_rotations = np.asarray(data["local_rot_mats"])
            source_joints = np.asarray(data["posed_joints"])
        available = int(source_rotations.shape[0])
        if pose["source_frame"] >= available:
            raise ValueError(
                f"--pose-from SRC_FRAME {pose['source_frame']} is outside "
                f"{pose['source']} which has {available} frames (0..{available - 1})."
            )
        local = torch.from_numpy(
            source_rotations[pose["source_frame"] : pose["source_frame"] + 1]
        ).float().to(device)
        root = torch.from_numpy(
            source_joints[pose["source_frame"] : pose["source_frame"] + 1, skeleton.root_idx]
        ).float().to(device)
        rotations, positions, _ = skeleton.fk(local, root)
        pose["rotations"] = rotations
        pose["positions"] = positions
        pose["source_positions"] = positions.detach().cpu().numpy()[0].copy()


def build_constraints(
    targets: list,
    local_rot_mats,
    posed_joints,
    skeleton,
    orientations: list = (),
    poses: list = (),
    waypoints: list = (),
):
    """Build the ARDY constraint sets for every requested kind.

    Returns ``(constraint_lst, base_positions, base_rotations)``. ``base_positions[i]``
    is the unconstrained position of ``targets[i]``'s joint and ``base_rotations``
    maps ``(frame, joint)`` to the unconstrained global rotation, both for residual
    reporting -- every number we publish is measured, never asserted.
    """
    import torch

    device = skeleton.device
    root_index = skeleton.root_idx
    base_positions = []
    base_rotations = {}
    requested_rotations = {
        (entry["frame"], entry["joint"]): entry["quaternion"] for entry in orientations
    }
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

    from ardy.constraints import FullBodyConstraintSet, Root2DConstraintSet

    joint_classes = _joint_constraint_classes()
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
        joint_index = skeleton.bone_index[joint]
        for row, frame in enumerate(frames):
            base_rotations[(frame, joint)] = (
                global_rots[row, joint_index].detach().cpu().numpy().copy()
            )
            quaternion = requested_rotations.get((frame, joint))
            if quaternion is None:
                continue
            # Splice ONLY the named joint's rotation. EndEffectorConstraintSet
            # conditions rotation for the chain base alone (skeleton
            # expand_joint_names returns <effector>[:1]), so leaving the rest of
            # the FK rotations in place keeps the pose the base pass produced
            # while binding the axis the caller actually measured.
            global_rots[row, joint_index] = _quaternion_to_matrix(quaternion, device)
        constraint_lst.append(
            joint_classes[joint](
                skeleton,
                frame_indices=frame_indices,
                global_joints_positions=global_positions,
                global_joints_rots=global_rots,
                root_2d=None,
            )
        )

    for pose in poses:
        constraint_lst.append(
            FullBodyConstraintSet(
                skeleton,
                frame_indices=torch.tensor([pose["frame"]]),
                global_joints_positions=pose["positions"],
                global_joints_rots=pose["rotations"],
                root_2d=None,
            )
        )

    if waypoints:
        headings = [entry["heading"] for entry in waypoints]
        constraint_lst.append(
            Root2DConstraintSet(
                skeleton,
                frame_indices=torch.tensor([entry["frame"] for entry in waypoints]),
                root_2d=torch.tensor(
                    [entry["xz"] for entry in waypoints],
                    device=device,
                    dtype=torch.float32,
                ),
                global_root_heading=(
                    None
                    if headings[0] is None
                    else torch.tensor(headings, dtype=torch.float32)
                ),
            )
        )
    return constraint_lst, base_positions, base_rotations


def measure_orientations(
    orientations: list, base_rotations: dict, generated_rotations, skeleton
) -> list:
    """Angle between each requested wrist/ankle axis and what the clip produced.

    Reported next to the unconstrained angle so the pair shows whether binding
    the axis helped, exactly as achieved_error_m sits next to base_error_m. Both
    numbers are measured on the generated npz, never asserted.
    """
    import numpy as np

    report = []
    for entry in orientations:
        joint_index = skeleton.bone_index[entry["joint"]]
        frame = entry["frame"]
        requested = np.asarray(_quaternion_matrix_rows(entry["quaternion"]), dtype=np.float64)
        achieved = np.asarray(generated_rotations[frame, joint_index], dtype=np.float64)
        base = np.asarray(base_rotations[(frame, entry["joint"])], dtype=np.float64)
        report.append(
            {
                "frame": frame,
                "joint": entry["joint"],
                "base_error_deg": round(_geodesic_degrees(base, requested), 3),
                "achieved_error_deg": round(_geodesic_degrees(achieved, requested), 3),
            }
        )
    return report


def _shape_error(achieved, requested, root_index: int) -> tuple:
    """(mean, max) per-joint distance after removing the root offset.

    Root-relative because a FullBodyConstraintSet conditions the root too, and a
    raw world error would fold the placement miss into the shape miss. The root
    index is passed rather than assumed to be 0: every other measurement here
    goes through skeleton.root_idx, and a silent mismatch would mislabel which
    error is placement and which is shape.
    """
    import numpy as np

    if achieved.shape != requested.shape:
        # skeleton.fk gives the model's native layout while the saved arrays may
        # have gone through output_to_SOMASkeleton77. A mismatch here would either
        # raise an opaque broadcast error or, if the counts happen to line up,
        # silently measure the wrong joints.
        raise ValueError(
            f"pose shape mismatch: requested {requested.shape} vs generated "
            f"{achieved.shape}; the reference pose and the clip use different "
            f"joint layouts."
        )
    local_achieved = achieved - achieved[root_index]
    local_requested = requested - requested[root_index]
    distances = np.linalg.norm(local_achieved - local_requested, axis=-1)
    return float(distances.mean()), float(distances.max())


def measure_poses(poses: list, generated_joints, base_joints, root_index: int) -> list:
    """How close each requested full-body pose came, against the unconstrained pair.

    ``base_*`` is the same comparison against the first pass at the same frame, so
    the pair shows whether pinning the pose did anything. An exact match with no
    baseline would be indistinguishable from a tautological measurement.
    """
    import numpy as np

    report = []
    base = np.asarray(base_joints, dtype=np.float64)
    for pose in poses:
        requested = np.asarray(pose["source_positions"], dtype=np.float64)
        achieved = np.asarray(generated_joints[pose["frame"]], dtype=np.float64)
        unconstrained = base[pose["frame"]]
        mean_error, max_error = _shape_error(achieved, requested, root_index)
        base_mean, base_max = _shape_error(unconstrained, requested, root_index)
        report.append(
            {
                "frame": pose["frame"],
                "source": os.path.basename(pose["source"]),
                "source_frame": pose["source_frame"],
                "base_root_error_m": round(
                    float(np.linalg.norm(unconstrained[root_index] - requested[root_index])), 4
                ),
                "root_error_m": round(
                    float(np.linalg.norm(achieved[root_index] - requested[root_index])), 4
                ),
                "base_shape_mean_error_m": round(base_mean, 4),
                "base_shape_max_error_m": round(base_max, 4),
                "shape_mean_error_m": round(mean_error, 4),
                "shape_max_error_m": round(max_error, 4),
            }
        )
    return report


def measure_waypoints(waypoints: list, generated_joints, skeleton) -> list:
    """Horizontal distance from each requested root waypoint to the clip's root."""
    import numpy as np

    report = []
    root_index = skeleton.root_idx
    for entry in waypoints:
        root = np.asarray(generated_joints[entry["frame"], root_index], dtype=np.float64)
        achieved = [float(root[0]), float(root[2])]
        error = float(
            np.linalg.norm(np.asarray(achieved) - np.asarray(entry["xz"]))
        )
        report.append(
            {
                "frame": entry["frame"],
                "requested_xz": [round(value, 4) for value in entry["xz"]],
                "achieved_xz": [round(value, 4) for value in achieved],
                "achieved_error_m": round(error, 4),
                "heading_rad": entry["heading"],
            }
        )
    return report


def measure_residuals(targets: list, base_positions: list, posed_joints, skeleton) -> tuple:
    """Distance from each request to what the generated motion actually did."""
    if not targets:
        # A run can constrain only the root path or only a full-body pose, so
        # there may be no end-effector target to summarize. None rather than a
        # zero that would read as a perfect hit on a measurement never taken.
        return [], None

    import numpy as np

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
    if not errors:
        # A run can now constrain only the root path or only a full-body pose,
        # so there may be no end-effector target to summarize. Report None
        # rather than a zero that would read as a perfect hit.
        return reported, None
    worst = int(np.argmax(errors))
    residual = {
        "max_error_m": round(max(errors), 4),
        "mean_error_m": round(float(np.mean(errors)), 4),
        "worst_frame": reported[worst]["frame"],
        "worst_joint": reported[worst]["joint"],
    }
    return reported, residual


def main():
    import numpy as np
    import torch

    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    print(f"Using device: {device}")
    args = parse_args()

    prompt = args.prompt.strip()
    if not prompt:
        raise ValueError("--prompt must be non-empty.")
    if args.duration <= 0:
        raise ValueError(f"--duration must be > 0 seconds, got {args.duration}.")
    if not 1 <= args.num_samples <= 8:
        raise ValueError(
            f"--num-samples must be 1..8, got {args.num_samples}; each sample is a "
            "full sampling pass on a shared GPU."
        )
    if not 0.0 < args.contact_threshold < 1.0:
        raise ValueError(
            f"--contact-threshold must be strictly between 0 and 1, got "
            f"{args.contact_threshold}; it is a probability cut-off."
        )
    if not 0.0 <= args.root_margin <= 0.5:
        raise ValueError(
            f"--root-margin must be 0..0.5 meters, got {args.root_margin}; a larger "
            "margin than half a meter would move the root further than any contact."
        )
    if len(args.cfg_weight) == 1:
        cfg_weight = float(args.cfg_weight[0])
    elif len(args.cfg_weight) == 2:
        cfg_weight = (float(args.cfg_weight[0]), float(args.cfg_weight[1]))
    else:
        raise ValueError("--cfg_weight expects one float (text) or two floats (text, constraint).")

    # Load model (same path as scripts/generate.py)
    from ardy.model import DEFAULT_MODEL, load_model
    from ardy.model.loading import get_env_var
    from ardy.model.registry import resolve_model_name
    from ardy.motion_rep.tools import length_to_mask
    from ardy.postprocess import post_process_motion
    from ardy.skeleton import SOMASkeleton30
    from ardy.tools import seed_everything, to_numpy

    checkpoints_dir = args.checkpoints_dir or get_env_var("CHECKPOINTS_DIR")
    resolved_model = resolve_model_name(
        args.model or DEFAULT_MODEL, checkpoints_dir=checkpoints_dir
    )
    model = load_model(resolved_model, device=device, checkpoints_dir=checkpoints_dir)
    print(f"Loaded model: {resolved_model}")

    fps = model.motion_rep.fps
    num_frames = int(args.duration * fps)
    if num_frames < 3:
        raise ValueError(
            f"--duration {args.duration}s yields {num_frames} frame(s) at {fps} fps; "
            "a clip needs at least 3 so inter-frame continuity is defined. Raise the "
            "duration."
        )
    targets = parse_targets(args.target or [], num_frames)
    orientations = parse_orientations(args.target_orient, num_frames, targets)
    poses = parse_poses(args.pose_from, num_frames)
    waypoints = parse_root_waypoints(args.root_2d, num_frames)
    if not (targets or poses or waypoints):
        raise ValueError(
            "constrained generation needs at least one of --target, --pose-from or "
            "--root-2d; use scripts/generate.py for an unconstrained pass."
        )
    print(
        f"Will generate '{prompt}' with {num_frames} frames "
        f"({args.duration}s at {fps} fps) under {len(targets)} target(s), "
        f"{len(orientations)} orientation(s), {len(poses)} pose(s), "
        f"{len(waypoints)} waypoint(s)"
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
    load_poses(poses, skeleton, device)
    constraint_lst, base_positions, base_rotations = build_constraints(
        targets,
        local_rot_mats,
        posed_joints,
        skeleton,
        orientations=orientations,
        poses=poses,
        waypoints=waypoints,
    )
    for constraint in constraint_lst:
        print(
            f"    {type(constraint).__name__} on frames {constraint.frame_indices.tolist()}"
        )

    lengths = torch.tensor([num_frames], device=device)
    pad_mask = length_to_mask(lengths)
    observed_motion, motion_mask = model.motion_rep.create_conditions_from_constraints_batched(
        constraint_lst,
        lengths,
        to_normalize=True,
        device=device,
    )

    def sample_once(sample_index: int):
        """One full sampling pass, post-processed and converted, as motion_dict."""
        if args.seed is not None:
            # Derive a distinct seed per sample so N draws are genuinely different
            # while the whole run stays reproducible from one --seed.
            seed_everything(args.seed + sample_index)
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
            sampled = model.motion_rep.inverse(motion, is_normalized=True)
        if "g1" not in resolved_model.lower() and not args.no_postprocess:
            # Passing constraint_lst lets ARDY's own postprocess enforce the
            # contacts it was asked for instead of skating them away.
            sampled.update(
                post_process_motion(
                    sampled["local_rot_mats"],
                    sampled["root_positions"],
                    sampled["foot_contacts"],
                    skeleton,
                    constraint_lst=constraint_lst,
                    contact_threshold=args.contact_threshold,
                    root_margin=args.root_margin,
                )
            )
        if isinstance(skeleton, SOMASkeleton30):
            sampled = skeleton.output_to_SOMASkeleton77(sampled)
        sampled = to_numpy(sampled)
        return {
            key: (
                value[0]
                if hasattr(value, "shape") and len(value.shape) > 0 and value.shape[0] == 1
                else value
            )
            for key, value in sampled.items()
        }

    def sample_cost(candidate: dict) -> tuple:
        """(worst constraint error, peak joint acceleration, travel) for a sample.

        Only the first two terms rank; travel is carried for visibility. The
        constraint term is the worst MEASURED error across every kind requested.

        Measured on the candidate's own npz arrays, never asserted. Combines every
        constraint kind that carries a distance so a run with only a path or only a
        pose is still ranked; orientation is folded in as its own angular term
        rather than being ignored, and a run with no measurable constraint at all
        ranks every sample equally so the first draw wins.
        """
        joints = np.asarray(candidate["posed_joints"])
        rotations = np.asarray(candidate["global_rot_mats"])
        costs = [
            entry["achieved_error_m"]
            for entry in measure_residuals(targets, base_positions, joints, skeleton)[0]
        ]
        costs += [
            entry["achieved_error_m"]
            for entry in measure_waypoints(waypoints, joints, skeleton)
        ]
        costs += [
            entry["shape_max_error_m"]
            for entry in measure_poses(
                poses, joints, posed_joints.detach().cpu().numpy(), skeleton.root_idx
            )
        ]
        # Degrees are not meters, so convert at a stated exchange rate rather than
        # summing raw units: 1 degree of wrist error is treated as 1 mm of contact
        # error, which keeps a 170 degree miss dominant without letting a fraction
        # of a degree outrank a real positional miss.
        costs += [
            entry["achieved_error_deg"] * 0.001
            for entry in measure_orientations(
                orientations, base_rotations, rotations, skeleton
            )
        ]
        constraint_cost = max(costs) if costs else 0.0
        # Continuity is the tie-breaker, and in practice it decides almost every
        # run: ARDY lands these end-effector constraints to well under a
        # millimetre, so ranking on constraint error alone leaves every sample
        # equal and N>1 would buy nothing. Inter-frame jump varies far more
        # between draws, so a tie on contacts is broken by the smoother clip.
        accelerations = _posed_joint_accelerations(joints)
        # Travel is reported but deliberately NOT ranked. The tie-breaker rewards
        # a smaller max jump, and a clip that barely moves also has small jumps --
        # so in principle a near-static sample could win a tie. It cannot win a
        # meaningful one: the tie is on constraint error, and a static body cannot
        # reach a contact it is asked for, so it loses the primary key first. The
        # exception is a request a static clip genuinely satisfies, say a single
        # waypoint at the character's own start. There, preferring the calmer clip
        # is right. But the tie-breaker CANNOT SEE THE PROMPT, so for a motion
        # prompt that is under-constrained ("a person waves while standing", pinned
        # only at its own start) a near-static draw ties and wins over correctly
        # animated ones. The fix in that case is to constrain the motion itself
        # with --constrain-path, not to change the ranking. Travel is surfaced so
        # the situation is visible in the receipt rather than inferred.
        root = joints[:, skeleton.root_idx, :]
        travel = float(np.linalg.norm(root[-1] - root[0]))
        return (
            round(constraint_cost, 6),
            round(float(accelerations.max()), 6),
            round(travel, 4),
        )

    samples = []
    for index in range(args.num_samples):
        candidate = sample_once(index)
        cost = sample_cost(candidate)
        samples.append({"index": index, "cost": cost, "motion": candidate})
        print(
            f"    sample {index}: worst constraint error {cost[0]:.6f} m, "
            f"peak accel {cost[1]:.4f} m, travel {cost[2]:.4f} m"
        )
    chosen = samples[rank_samples([entry["cost"] for entry in samples])]
    motion_dict = chosen["motion"]
    selection = {
        "num_samples": args.num_samples,
        "chosen_index": chosen["index"],
        "sample_costs": [
            {
                "constraint_error_m": entry["cost"][0],
                "peak_acceleration_m": entry["cost"][1],
                "travel_m": entry["cost"][2],
            }
            for entry in samples
        ],
        "metric": (
            "lexicographic: worst measured constraint error first (meters, with "
            "orientation degrees weighted at 0.001 m/deg), then max inter-frame "
            "acceleration as the tie-breaker; ties beyond that keep the lowest index. "
            "travel_m is reported for visibility and is NOT ranked"
        ),
    }
    if args.num_samples > 1:
        print(
            f"    chose sample {chosen['index']} of {args.num_samples} "
            f"(constraint {chosen['cost'][0]:.6f} m, peak accel {chosen['cost'][1]:.4f} m, "
            f"travel {chosen['cost'][2]:.4f} m)"
        )

    generated_joints = np.asarray(motion_dict["posed_joints"])
    reported, residual = measure_residuals(targets, base_positions, generated_joints, skeleton)
    generated_rotations = np.asarray(motion_dict["global_rot_mats"])
    orientation_report = measure_orientations(
        orientations, base_rotations, generated_rotations, skeleton
    )
    pose_report = measure_poses(
        poses, generated_joints, posed_joints.detach().cpu().numpy(), skeleton.root_idx
    )
    waypoint_report = measure_waypoints(waypoints, generated_joints, skeleton)

    output_base = _resolve_output_base(args.output)
    npz_path = _single_file_path(output_base, ".npz")
    print(f"Saving the npz output to {npz_path}")
    save_motion_npz(npz_path, motion_dict, fps, prompt)

    jumps = _posed_joint_jumps(generated_joints)
    result = {
        "target_space": "skeleton_joint_center",
        "surface_contact_verified": False,
        "frames": int(generated_joints.shape[0]),
        "fps": int(fps),
        "model": resolved_model,
        "targets": reported,
        "residual": residual,
        "selection": selection,
        "orientations": orientation_report,
        "poses": pose_report,
        "waypoints": waypoint_report,
        "postprocess": (
            None
            if ("g1" in resolved_model.lower() or args.no_postprocess)
            else {
                "contact_threshold": args.contact_threshold,
                "root_margin": args.root_margin,
            }
        ),
        "continuity": {
            "mean_jump_m": float(jumps.mean()),
            "max_jump_m": float(jumps.max()),
            "max_jump_frame": int(jumps.argmax()) + 1,
        },
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()
