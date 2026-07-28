"""Pure, bpy-free IK chain definitions and pole geometry for manual rigging.

``apply_motion`` bakes an ARDY clip onto the mixamo rig as forward kinematics:
every one of the 25 driven bones gets a per-frame local rotation and nothing
else. That is the correct wire format and the wrong thing to edit by hand — an
animator who wants the left hand on a handrail has to counter-rotate the
shoulder, the upper arm and the forearm to move one point.

This module holds the vocabulary for a temporary inverse-kinematics layer laid
over that FK animation, plus the geometry that keeps it faithful. It is kept
bpy-free so it is unit-testable with plain CPython; ``ik_rig`` is the single
Blender-facing consumer.

Two properties are load-bearing.

**Every chain stays inside the bones ARDY drives.** cskel27 has 27 joints, but
``Spine3`` composes into mixamo ``Spine2`` and the ``HandEnd`` leaves have no
counterpart at all, so the driven set is 25 bones. An IK chain that rotated
anything outside it would let an animator author a pose that cannot be carried
back in the motion representation. ``test_ik_chains_pure`` asserts the
containment against ``motion_retarget.MIXAMO_TARGETS`` directly.

**The pole has to survive a straight limb.** Blender's IK constraint takes a
pole target to pick the bend plane, and the bend plane is undefined when the
chain is straight. Measured on the ARDY stair clip, the knee carries a 0.265 m
bend offset while the elbow carries 0.055 m, so the arms sit close to that
singularity for most of a walk. ``pole_position`` therefore falls back to a
stable perpendicular instead of returning a near-zero direction.
"""

from __future__ import annotations

import math

# The rig this layer is built on is a mixamo armature, whose bones all carry
# this prefix. Control bones deliberately do not: they are not part of the
# character and must never be mistaken for a bone the motion drives.
BONE_PREFIX = "mixamorig:"
CONTROL_PREFIX = "CCLAY-IK-"
_TARGET_INFIX = "TGT-"
_POLE_INFIX = "POLE-"
# Constraint anchors: bones that do not belong to a limb chain. The IK handles
# above are dragged to re-pose a chain, whereas these are the targets a
# constraint pins a pose against — the Full-Body anchor is not draggable, and
# the 2D-Root anchor is dragged only across the floor plane. They share the
# control layer so teardown removes them with the handles, but they are kept on
# a distinct prefix so they never double as a chain target or pole (those carry
# CONTROL_PREFIX, whose "CCLAY-IK-" infix differs from "CCLAY-CONSTRAINT-" at
# the first character after the shared "CCLAY-" stem).
CONSTRAINT_PREFIX = "CCLAY-CONSTRAINT-"
FULLBODY_ANCHOR = "CCLAY-CONSTRAINT-FULLBODY"
ROOT2D_ANCHOR = "CCLAY-CONSTRAINT-ROOT2D"

# Below this the bend offset carries no usable direction and the perpendicular
# fallback takes over. A hair above float noise: the smallest bend offset
# measured on a real ARDY clip is 0.055 m, four orders of magnitude larger.
BEND_EPSILON = 1e-5
# A seed axis is rejected once it is this close to parallel with the chain axis,
# because the perpendicular component it yields would be numerically tiny.
_SEED_PARALLEL_LIMIT = 0.9

Vector3 = tuple[float, float, float]


class ChainSpec:
    """One IK chain: which bones rotate, and which handle drives them.

    ``constrained`` carries Blender's IK constraint and its TAIL is the point
    the solver drives, which is why it is the distal bone rather than the root.
    ``effector`` is the bone whose head coincides with that tail; it names the
    handle an animator grabs and is deliberately NOT rotated by the chain, so
    the wrist and ankle rotations the clip authored survive the edit.
    """

    __slots__ = ("effector", "constrained", "chain_root", "_bones")

    def __init__(self, effector: str, constrained: str, chain_root: str, bones: tuple[str, ...]):
        if bones[0] != chain_root:
            raise ValueError(f"{effector}: chain must start at {chain_root}")
        if bones[-1] != constrained:
            raise ValueError(f"{effector}: chain must end at {constrained}")
        if effector in bones:
            raise ValueError(f"{effector}: the effector must not be rotated by its own chain")
        self.effector = effector
        self.constrained = constrained
        self.chain_root = chain_root
        self._bones = bones

    @property
    def chain_count(self) -> int:
        """Bone count Blender's IK constraint should walk up from ``constrained``."""
        return len(self._bones)

    def bones(self) -> tuple[str, ...]:
        """Bones this chain rotates, ordered root first."""
        return self._bones

    def __repr__(self) -> str:  # pragma: no cover - diagnostics only
        return f"ChainSpec({self.effector})"


# Four limbs, each a two-bone chain, which is the configuration Blender's IK
# solves analytically with a pole vector. Head, spine and toe handles are
# deliberately absent: cskel27 has neither a ``Neck1`` nor a ``Chest`` joint to
# hang them on, and a toe chain would need three bones and a different bend
# model, so shipping them here would mean shipping a chain nobody measured.
IK_CHAINS: tuple[ChainSpec, ...] = (
    ChainSpec("LeftHand", "LeftForeArm", "LeftArm", ("LeftArm", "LeftForeArm")),
    ChainSpec("RightHand", "RightForeArm", "RightArm", ("RightArm", "RightForeArm")),
    ChainSpec("LeftFoot", "LeftLeg", "LeftUpLeg", ("LeftUpLeg", "LeftLeg")),
    ChainSpec("RightFoot", "RightLeg", "RightUpLeg", ("RightUpLeg", "RightLeg")),
)

CHAIN_BY_EFFECTOR: dict[str, ChainSpec] = {chain.effector: chain for chain in IK_CHAINS}


def target_bone_name(effector: str) -> str:
    """Name of the control bone an animator drags to move ``effector``."""
    return f"{CONTROL_PREFIX}{_TARGET_INFIX}{effector}"


def pole_bone_name(effector: str) -> str:
    """Name of the control bone that sets the bend plane of ``effector``'s chain."""
    return f"{CONTROL_PREFIX}{_POLE_INFIX}{effector}"


def is_control_bone(name: str) -> bool:
    """Whether ``name`` belongs to the rig's control layer, not the character.

    Two kinds of bone live on this layer, and both must never be mistaken for a
    bone the motion drives. ``CONTROL_PREFIX`` marks the IK handles an animator
    drags to re-pose a limb chain (its target and pole). ``CONSTRAINT_PREFIX``
    marks the constraint anchors a pose is pinned against — the Full-Body anchor
    and the 2D-Root anchor — which sit outside every limb chain and are not
    part of the character either.

    Teardown deletes every bone this returns true for, so the two prefixes must
    be disjoint from each other and from ``BONE_PREFIX`` (every mixamo bone
    carries that, which neither ``CCLAY-IK-`` nor ``CCLAY-CONSTRAINT-`` can
    collide with). The chain name builders ``target_bone_name`` and
    ``pole_bone_name`` only ever emit ``CONTROL_PREFIX``, so the anchors on
    ``CONSTRAINT_PREFIX`` can never collide with a chain target or pole.
    """
    return name.startswith(CONTROL_PREFIX) or name.startswith(CONSTRAINT_PREFIX)


def prefixed(bone: str) -> str:
    """Armature-space name of a cskel27 bone on a mixamo rig."""
    return f"{BONE_PREFIX}{bone}"


def _sub(a: Vector3, b: Vector3) -> Vector3:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _dot(a: Vector3, b: Vector3) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a: Vector3, b: Vector3) -> Vector3:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def _length(a: Vector3) -> float:
    return math.sqrt(_dot(a, a))


def _scaled(a: Vector3, factor: float) -> Vector3:
    return (a[0] * factor, a[1] * factor, a[2] * factor)


def _normalized(a: Vector3, fallback: Vector3) -> Vector3:
    length = _length(a)
    if length < BEND_EPSILON:
        return fallback
    return _scaled(a, 1.0 / length)


def _reject(vector: Vector3, axis: Vector3) -> Vector3:
    """Component of ``vector`` perpendicular to unit ``axis``."""
    return _sub(vector, _scaled(axis, _dot(vector, axis)))


def _perpendicular_seed(axis: Vector3) -> Vector3:
    """A unit vector perpendicular to ``axis``, chosen to stay well conditioned."""
    seed: Vector3 = (1.0, 0.0, 0.0)
    if abs(_dot(axis, seed)) > _SEED_PARALLEL_LIMIT:
        seed = (0.0, 0.0, 1.0)
    return _normalized(_reject(seed, axis), (0.0, 0.0, 1.0))


def pole_position(
    chain_root: Vector3,
    mid: Vector3,
    effector: Vector3,
    distance: float,
) -> Vector3:
    """Where to put the pole so the chain keeps the bend it currently has.

    The bend direction is the component of ``mid - chain_root`` perpendicular to
    the chain axis ``effector - chain_root``. The pole is that direction pushed
    ``distance`` out from ``mid``, which puts it on the same plane the limb is
    already bent in, so attaching the constraint does not move the limb.

    A straight limb has no bend direction and a collapsed one has no axis
    either; both fall back to a stable perpendicular rather than a near-zero
    vector, because a pole on the chain axis is the singular configuration that
    makes Blender's solver snap the limb.
    """
    if not distance > 0.0:
        raise ValueError("pole distance must be positive")
    axis = _normalized(_sub(effector, chain_root), (0.0, 0.0, 1.0))
    bend = _reject(_sub(mid, chain_root), axis)
    if _length(bend) < BEND_EPSILON:
        bend = _perpendicular_seed(axis)
    else:
        bend = _scaled(bend, 1.0 / _length(bend))
    offset = _scaled(bend, distance)
    return (mid[0] + offset[0], mid[1] + offset[1], mid[2] + offset[2])


def signed_angle_about_axis(from_vector: Vector3, to_vector: Vector3, axis: Vector3) -> float:
    """Rotation about unit ``axis`` that carries ``from_vector`` onto ``to_vector``.

    Only the components perpendicular to ``axis`` matter, so the caller may pass
    raw bend vectors without projecting them first. The refinement loop in
    ``ik_rig`` feeds the result straight back as a correction, so the sign has
    to follow ``axis`` by the right-hand rule.
    """
    unit_axis = _normalized(axis, (0.0, 0.0, 1.0))
    a = _reject(from_vector, unit_axis)
    b = _reject(to_vector, unit_axis)
    if _length(a) < BEND_EPSILON or _length(b) < BEND_EPSILON:
        return 0.0
    a = _scaled(a, 1.0 / _length(a))
    b = _scaled(b, 1.0 / _length(b))
    sine = _dot(_cross(a, b), unit_axis)
    cosine = max(-1.0, min(1.0, _dot(a, b)))
    return math.atan2(sine, cosine)
