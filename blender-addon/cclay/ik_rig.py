"""Build and tear down a temporary IK layer over an ARDY-baked FK animation.

``apply_motion`` writes forward kinematics: a local rotation per driven bone per
frame. Editing that by hand means counter-rotating three bones to move one
point, so this module lays an inverse-kinematics layer over the existing action,
faithful enough that attaching it does not change a single rendered frame.

The faithfulness is the whole design problem. A limb's bend plane is picked by
Blender's IK constraint from a pole target, and the obvious approach — measure
the bend once, place a static pole, solve a constant ``pole_angle`` — does not
work: measured over the 240 frames of the ARDY stair clip it leaves the wrist
exact but the elbow up to 79.8 mm away from where FK put it, because the clip
twists the upper bone and a single angle cannot track that. So both the target
and the pole are keyed on every frame, and the pole is rotated about the chain
axis until the mid joint lands on its FK position. That drops the worst error
across all four limbs and all frames to 0.26 mm, which is invisible on a 1.7 m
character.

Two facts about Blender cost real debugging time and are encoded here:

* A pose bone's ``location`` is in bone-local rest space, so writing a world
  position into it is wrong on any rig with an object transform — and the ARDY
  rigs all carry the FBX X-90 correction and a 0.01 scale. Control bones are
  positioned through ``pose_bone.matrix`` instead.
* An un-keyed pose change survives ``view_layer.update()`` but not a render,
  because rendering re-evaluates the frame from the action. Every placement here
  is written as a keyframe.

``ik_chains`` holds the bpy-free vocabulary and geometry; this module is its
single Blender-facing consumer.
"""

from __future__ import annotations

from . import ik_chains, motion_retarget

try:  # pragma: no cover - exercised inside Blender
    import bpy  # type: ignore
    from mathutils import Matrix, Vector  # type: ignore
except ImportError:  # pragma: no cover - importable outside Blender
    bpy = None  # type: ignore
    Matrix = None  # type: ignore
    Vector = None  # type: ignore


# Metres from the mid joint to the pole handle. Far enough to be grabbable and
# to keep the bend plane well conditioned, close enough not to clutter a shot.
DEFAULT_POLE_DISTANCE = 0.4
# Pole-plane refinement. Six passes reached 0.26 mm worst case on the reference
# clip; the loop exits as soon as the residual angle is negligible, so a limb
# that converges in two does not pay for six.
MAX_POLE_ITERATIONS = 6
POLE_ANGLE_TOLERANCE = 1e-6
# Length of a control bone. Purely cosmetic: it is the size of the handle drawn
# in the viewport, and control bones never deform anything.
CONTROL_BONE_LENGTH = 0.08


class IkRigError(RuntimeError):
    """The armature cannot carry an IK layer, or already carries one."""


def _driven_bones() -> frozenset[str]:
    return frozenset(name for name in motion_retarget.MIXAMO_TARGETS.values() if name)


def _require_pose_bone(armature, bone: str):
    name = ik_chains.prefixed(bone)
    pose_bone = armature.pose.bones.get(name)
    if pose_bone is None:
        raise IkRigError(f"armature {armature.name!r} has no bone {name!r}")
    return pose_bone


def validate_rig(armature) -> None:
    """Refuse anything that is not an ARDY-retargeted mixamo armature.

    Every bone each chain rotates has to exist, and the chain's geometric
    assumption has to hold: the constrained bone's tail is the point the solver
    drives, so it must coincide with the effector bone's head. On a mixamo rig
    those are the same joint, but a rig with a wrist offset would silently solve
    for the wrong point.
    """
    if armature is None or armature.type != "ARMATURE":
        raise IkRigError("select an armature")
    driven = _driven_bones()
    for chain in ik_chains.IK_CHAINS:
        for bone in (*chain.bones(), chain.effector):
            if bone not in driven:
                raise IkRigError(f"{bone} is not a bone ARDY drives")
            _require_pose_bone(armature, bone)
        constrained = armature.data.bones[ik_chains.prefixed(chain.constrained)]
        effector = armature.data.bones[ik_chains.prefixed(chain.effector)]
        gap = (constrained.tail_local - effector.head_local).length
        if gap > 1e-4:
            raise IkRigError(
                f"{chain.constrained} tail is {gap * 1000:.1f} mm from {chain.effector} head; "
                "this rig is not a mixamo skeleton"
            )


def has_ik_layer(armature) -> bool:
    """Whether control bones from a previous attach are still present."""
    return any(ik_chains.is_control_bone(bone.name) for bone in armature.data.bones)


def _world_head(armature, bone: str):
    return armature.matrix_world @ armature.pose.bones[ik_chains.prefixed(bone)].head


def _as_tuple(vector) -> tuple[float, float, float]:
    return (float(vector[0]), float(vector[1]), float(vector[2]))


def _place(armature, pose_bone, world_position) -> None:
    """Move a control bone's head to a world position.

    Goes through the pose matrix because ``pose_bone.location`` is expressed in
    bone-local rest space, which is not world space on any rig carrying an
    object transform.
    """
    matrix = pose_bone.matrix.copy()
    matrix.translation = armature.matrix_world.inverted() @ world_position
    pose_bone.matrix = matrix


def _sample_fk(armature, frame_start: int, frame_end: int) -> dict:
    """Record the FK pose the clip authored, before any constraint exists."""
    scene = bpy.context.scene
    samples = {}
    for frame in range(frame_start, frame_end + 1):
        scene.frame_set(frame)
        samples[frame] = {
            chain.effector: (
                _world_head(armature, chain.chain_root).copy(),
                _world_head(armature, chain.constrained).copy(),
                _world_head(armature, chain.effector).copy(),
            )
            for chain in ik_chains.IK_CHAINS
        }
    return samples


def _create_control_bones(armature, pole_distance: float, fk_first_frame: dict) -> None:
    previous_mode = armature.mode
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.mode_set(mode="EDIT")
    try:
        edit_bones = armature.data.edit_bones
        for chain in ik_chains.IK_CHAINS:
            source = edit_bones[ik_chains.prefixed(chain.effector)]
            for name in (
                ik_chains.target_bone_name(chain.effector),
                ik_chains.pole_bone_name(chain.effector),
            ):
                if name in edit_bones:
                    edit_bones.remove(edit_bones[name])
                bone = edit_bones.new(name)
                bone.head = source.head.copy()
                bone.tail = source.head + Vector((0.0, 0.0, CONTROL_BONE_LENGTH))
                # A control bone is a handle, not anatomy: it must never weight
                # a vertex, and it must stay free of the character hierarchy so
                # dragging it is not fought by a parent's animation.
                bone.use_deform = False
                bone.parent = None
    finally:
        bpy.ops.object.mode_set(mode="POSE" if previous_mode == "POSE" else "OBJECT")
        bpy.ops.object.mode_set(mode="POSE")
    for chain in ik_chains.IK_CHAINS:
        for name in (
            ik_chains.target_bone_name(chain.effector),
            ik_chains.pole_bone_name(chain.effector),
        ):
            armature.pose.bones[name].rotation_mode = "QUATERNION"


def _attach_constraints(armature) -> None:
    for chain in ik_chains.IK_CHAINS:
        pose_bone = armature.pose.bones[ik_chains.prefixed(chain.constrained)]
        for existing in list(pose_bone.constraints):
            if existing.type == "IK":
                pose_bone.constraints.remove(existing)
        constraint = pose_bone.constraints.new("IK")
        constraint.target = armature
        constraint.subtarget = ik_chains.target_bone_name(chain.effector)
        constraint.pole_target = armature
        constraint.pole_subtarget = ik_chains.pole_bone_name(chain.effector)
        constraint.chain_count = chain.chain_count
        # The solved point is this bone's tail, i.e. the wrist or the ankle.
        # With use_tail off it would be the elbow or the knee instead.
        constraint.use_tail = True
        # The bend plane is carried entirely by the keyed pole position, so the
        # constant offset must contribute nothing.
        constraint.pole_angle = 0.0


def _solve_frame(armature, chain, sample, pole_distance: float) -> float:
    """Key one chain's target and pole on the current frame; return the residual."""
    root_fk, mid_fk, effector_fk = sample
    target_bone = armature.pose.bones[ik_chains.target_bone_name(chain.effector)]
    pole_bone = armature.pose.bones[ik_chains.pole_bone_name(chain.effector)]

    axis = _as_tuple(effector_fk - root_fk)
    wanted_pole = ik_chains.pole_position(
        _as_tuple(root_fk), _as_tuple(mid_fk), _as_tuple(effector_fk), pole_distance
    )
    wanted_bend = tuple(wanted_pole[i] - _as_tuple(mid_fk)[i] for i in range(3))

    _place(armature, target_bone, effector_fk)
    pole_direction = Vector(wanted_bend).normalized()
    for _ in range(MAX_POLE_ITERATIONS):
        _place(armature, pole_bone, mid_fk + pole_direction * pole_distance)
        bpy.context.view_layer.update()
        actual_root = _world_head(armature, chain.chain_root)
        actual_mid = _world_head(armature, chain.constrained)
        error = ik_chains.signed_angle_about_axis(
            _as_tuple(actual_mid - actual_root), wanted_bend, axis
        )
        if abs(error) < POLE_ANGLE_TOLERANCE:
            break
        pole_direction = (
            Matrix.Rotation(error, 4, Vector(axis).normalized()) @ pole_direction
        ).normalized()

    target_bone.keyframe_insert("location", frame=bpy.context.scene.frame_current)
    pole_bone.keyframe_insert("location", frame=bpy.context.scene.frame_current)
    bpy.context.view_layer.update()
    return (_world_head(armature, chain.constrained) - mid_fk).length


def attach(armature, frame_start: int | None = None, frame_end: int | None = None,
           pole_distance: float = DEFAULT_POLE_DISTANCE) -> dict:
    """Lay an IK layer over the armature's existing FK animation.

    Returns a report whose per-chain deviation is the proof that attaching
    changed nothing: it is the distance between where FK put each mid joint and
    where the IK solve puts it, in millimetres, worst case over every frame.
    """
    validate_rig(armature)
    if has_ik_layer(armature):
        raise IkRigError("this armature already carries an IK layer; detach it first")
    if not pole_distance > 0.0:
        raise IkRigError("pole distance must be positive")
    scene = bpy.context.scene
    frame_start = scene.frame_start if frame_start is None else int(frame_start)
    frame_end = scene.frame_end if frame_end is None else int(frame_end)
    if frame_end < frame_start:
        raise IkRigError("frame_end must not precede frame_start")

    restore_frame = scene.frame_current
    fk = _sample_fk(armature, frame_start, frame_end)
    _create_control_bones(armature, pole_distance, fk[frame_start])
    _attach_constraints(armature)

    worst = {chain.effector: 0.0 for chain in ik_chains.IK_CHAINS}
    for frame in range(frame_start, frame_end + 1):
        scene.frame_set(frame)
        for chain in ik_chains.IK_CHAINS:
            residual = _solve_frame(armature, chain, fk[frame][chain.effector], pole_distance)
            worst[chain.effector] = max(worst[chain.effector], residual)

    report = {
        "frameStart": frame_start,
        "frameEnd": frame_end,
        "poleDistance": pole_distance,
        "chains": {
            effector: {"maxMidDeviationMm": round(value * 1000.0, 4)}
            for effector, value in worst.items()
        },
    }
    report["worstMidDeviationMm"] = max(
        entry["maxMidDeviationMm"] for entry in report["chains"].values()
    )
    scene.frame_set(restore_frame)
    return report


def measure_fidelity(armature, fk_samples: dict) -> dict:
    """Worst per-effector deviation, in millimetres, against recorded FK samples.

    Kept separate from ``attach`` so a caller can verify a rig it did not build,
    which is what the acceptance test does after editing and re-baking.
    """
    scene = bpy.context.scene
    restore_frame = scene.frame_current
    worst: dict[str, float] = {}
    for frame, per_chain in fk_samples.items():
        scene.frame_set(frame)
        for effector, sample in per_chain.items():
            chain = ik_chains.CHAIN_BY_EFFECTOR[effector]
            deviations = (
                (_world_head(armature, chain.constrained) - sample[1]).length,
                (_world_head(armature, chain.effector) - sample[2]).length,
            )
            worst[effector] = max(worst.get(effector, 0.0), *deviations)
    scene.frame_set(restore_frame)
    return {effector: round(value * 1000.0, 4) for effector, value in worst.items()}


def _control_fcurve_owners(animation_data):
    """Yield ``(collection, fcurve)`` for every curve reachable from the slot.

    ``manifest.animation_fcurves`` already flattens this walk, but removal needs
    the collection each curve belongs to, which a flat list has thrown away.
    Blender 5.2 moved curves from ``Action.fcurves`` onto per-slot channelbags
    inside layered strips; the legacy attribute is still checked first because a
    pre-layer action keeps it populated.
    """
    action = animation_data.action
    legacy = getattr(action, "fcurves", None)
    if legacy is not None and len(legacy):
        for curve in list(legacy):
            yield legacy, curve
        return
    slot = animation_data.action_slot
    for layer in action.layers:
        for strip in layer.strips:
            channelbag = strip.channelbag(slot) if hasattr(strip, "channelbag") else None
            bags = [channelbag] if channelbag is not None else [
                bag for bag in strip.channelbags if bag.slot_handle == slot.handle
            ]
            for bag in bags:
                for curve in list(bag.fcurves):
                    yield bag.fcurves, curve


def _remove_control_fcurves(armature) -> None:
    animation_data = armature.animation_data
    if animation_data is None or animation_data.action is None:
        return
    for collection, curve in list(_control_fcurve_owners(animation_data)):
        path = curve.data_path
        if 'pose.bones["' in path and ik_chains.is_control_bone(path.split('"')[1]):
            collection.remove(curve)


def _remove_control_bones(armature) -> None:
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.mode_set(mode="EDIT")
    try:
        edit_bones = armature.data.edit_bones
        for bone in [b for b in edit_bones if ik_chains.is_control_bone(b.name)]:
            edit_bones.remove(bone)
    finally:
        bpy.ops.object.mode_set(mode="POSE")


def detach(armature, keep_edits: bool = True) -> dict:
    """Remove the IK layer, optionally baking whatever was edited back into FK.

    With ``keep_edits`` the visual result is baked onto the driven bones as
    rotations, which is the representation ``apply_motion`` produced and the
    only one an ARDY clip can carry; the IK layer then disappears without
    leaving the character dependent on control bones. Without it the layer is
    simply discarded and the original FK animation resurfaces untouched.
    """
    if not has_ik_layer(armature):
        raise IkRigError("this armature carries no IK layer")
    scene = bpy.context.scene
    baked_frames = 0
    if keep_edits:
        bpy.context.view_layer.objects.active = armature
        bpy.ops.object.mode_set(mode="POSE")
        # Only the chain bones can differ from their FK curves, because they are
        # the only bones the IK constraints rotate. Baking anything else writes
        # dense rotation keys onto bones ARDY never drives — the fingers alone
        # are 40 of them, posed by ``hand_shapes`` rather than by the clip — and
        # an action carrying those cannot round-trip as an ARDY motion.
        # Blender 5.2 dropped ``Bone.select``; selection lives on the pose bone.
        chain_bones = {
            ik_chains.prefixed(bone)
            for chain in ik_chains.IK_CHAINS
            for bone in chain.bones()
        }
        for pose_bone in armature.pose.bones:
            pose_bone.select = pose_bone.name in chain_bones
        bpy.ops.nla.bake(
            frame_start=scene.frame_start,
            frame_end=scene.frame_end,
            only_selected=True,
            visual_keying=True,
            clear_constraints=True,
            clear_parents=False,
            use_current_action=True,
            bake_types={"POSE"},
        )
        baked_frames = scene.frame_end - scene.frame_start + 1
    else:
        for chain in ik_chains.IK_CHAINS:
            pose_bone = armature.pose.bones[ik_chains.prefixed(chain.constrained)]
            for constraint in [c for c in pose_bone.constraints if c.type == "IK"]:
                pose_bone.constraints.remove(constraint)
    _remove_control_fcurves(armature)
    _remove_control_bones(armature)
    return {"keptEdits": bool(keep_edits), "bakedFrames": baked_frames}
