"""Read-only frame-specific pose-contact geometry for the
``inspect_pose_contacts`` bridge method.

Issue #2: ARDY constraints target the ``LeftFoot``/``RightFoot`` skeleton
joint center, not the deformed sole surface, and the offset between the two
is not constant. A numerically exact joint constraint can therefore report
``achieved_error_m: 0.0`` while the visible foot mesh floats above or
penetrates the declared support geometry. ``inspect_relations`` cannot answer
this: it has no per-frame posed/deformed geometry and no joint-vs-surface
distinction. This module combines two already-separated halves --
``stage_scene._pose_contact_samples`` (character-side deformed-mesh/joint
geometry, one bpy-only helper this module treats as raw evidence and never
mutates) and ``scene_relations``' AABB resolution helpers (support-side
static geometry) -- into a closed gap/containment/verification payload.

``surface_contact_verified`` is derived only from the deformed sole point
against the declared support AABBs (vertical gap, XY footprint containment,
edge margin); joint position is carried through purely as audit evidence, per
issue #2, and never substitutes for the sole measurement.

The public request/response shape is the closed schema exported by
``packages/blender-protocol/src/pose-contacts.ts``: the gate
(``max_gap_m``/``min_edge_margin_m``) is fixed addon-side and is never an
accepted params override -- a caller cannot widen the gate into uselessness.

The measurement math below is deliberately bpy-free so it can be unit tested
with plain CPython; the single bpy-facing entry point is
``collect_pose_contacts``.
"""

from __future__ import annotations

import math
import re

SCHEMA_VERSION = 1
MAX_FRAMES = 32
MAX_SUPPORT_ENTITIES = 16
# Fixed gate: the public schema closes over these two values. They are never
# accepted as a params override (see ``_validated_params``'s ``allowed`` set).
DEFAULT_MAX_GAP_M = 0.03
DEFAULT_MIN_EDGE_MARGIN_M = 0.0

_UUID_V4_LOWERCASE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)



class PoseContactsError(ValueError):
    """An inspect_pose_contacts request is invalid; ``code`` is the contract code."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code


def _invalid(message: str) -> None:
    raise PoseContactsError("INVALID_INSPECT_POSE_CONTACTS_PARAMS", message)


def _non_finite() -> None:
    raise PoseContactsError(
        "NON_FINITE_GEOMETRY", "measured geometry produced a non-finite number"
    )


def _ensure_finite_tree(value) -> None:
    """Reject any non-finite float anywhere in an emitted payload tree."""
    if isinstance(value, float):
        if not math.isfinite(value):
            _non_finite()
    elif isinstance(value, dict):
        for item in value.values():
            _ensure_finite_tree(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            _ensure_finite_tree(item)


def _round3(value: float) -> float:
    """Round to exactly 3 decimals, normalizing -0.0 to 0.0."""
    rounded = round(float(value), 3)
    return 0.0 if rounded == 0.0 else rounded


def _round3_vec(values) -> list[float]:
    return [_round3(value) for value in values]


def _round3_vec_or_none(values):
    return None if values is None else _round3_vec(values)


def _xy_footprint_margin(x: float, y: float, aabb_min, aabb_max) -> float:
    """Signed distance (m) from (x, y) to the nearest AABB-XY edge.

    Positive and increasing toward the footprint center; zero exactly on an
    edge; negative outside. Only the X/Y extents are considered (the
    declared-acceptable AABB-XY footprint basis), so a point outside on both
    axes reports the less-negative of the two axis distances rather than a
    true corner distance -- a conservative approximation, not an exact
    Euclidean distance to the box.
    """
    dx = min(x - aabb_min[0], aabb_max[0] - x)
    dy = min(y - aabb_min[1], aabb_max[1] - y)
    return min(dx, dy)


def _nearest_support(sole_z: float, supports):
    """The declared support whose top AABB-Z is closest to ``sole_z``.

    Ties (and the empty-``supports`` case, which validation already forbids)
    resolve to the first candidate in declaration order, keeping selection
    deterministic.
    """
    best = None
    best_abs_gap = None
    for support in supports:
        gap = abs(sole_z - support["aabb_max"][2])
        if best is None or gap < best_abs_gap:
            best = support
            best_abs_gap = gap
    return best


def _side_contact(sample: dict, supports, max_gap_m: float, min_edge_margin_m: float):
    """One side's closed public contact-evidence entry for one frame, or
    ``None`` when the side has no resolvable joint evidence at all.

    ``sample`` is the raw ``stage_scene._pose_contact_samples`` per-side dict
    (foot_joint_co/toe_joint_co/heel_co/toe_co/sole_co/sole_source/
    heel_to_toe), treated as character-side evidence only. The public schema
    requires ``foot_joint_position``/``toe_joint_position``/``contact_basis``
    whenever a side is present at all, so a side with no resolvable raw joint
    evidence is reported as ``None`` (the whole side absent) rather than as a
    record padded with a guessed value.

    Contact fields derive solely from ``sole_co`` against ``supports``; when
    the deformed sole did not resolve (no weighted vertex group), ``support``
    is ``None`` and no ``surface_contact_verified`` claim is made -- a
    joint-only sample is never treated as contact evidence.
    """
    foot_joint_co = sample.get("foot_joint_co")
    toe_joint_co = sample.get("toe_joint_co")
    if foot_joint_co is None or toe_joint_co is None:
        return None

    sole_co = sample.get("sole_co")
    entry = {
        "foot_joint_position": _round3_vec(foot_joint_co),
        "toe_joint_position": _round3_vec(toe_joint_co),
        "heel_point": _round3_vec_or_none(sample.get("heel_co")),
        "toe_point": _round3_vec_or_none(sample.get("toe_co")),
        "sole_point": _round3_vec_or_none(sole_co),
        "sole_source": sample.get("sole_source"),
        "heel_to_toe_m": _round3_vec_or_none(sample.get("heel_to_toe")),
        "joint_to_sole_offset_m": None,
        "contact_basis": "deformed_mesh",
        "support": None,
    }
    if sole_co is None:
        return entry

    entry["joint_to_sole_offset_m"] = _round3_vec(
        [sole_co[axis] - foot_joint_co[axis] for axis in range(3)]
    )

    support = _nearest_support(sole_co[2], supports)
    support_height_m = support["aabb_max"][2]
    support_gap_m = sole_co[2] - support_height_m
    edge_margin_m = _xy_footprint_margin(
        sole_co[0], sole_co[1], support["aabb_min"], support["aabb_max"]
    )
    inside_support_footprint = edge_margin_m >= 0.0
    surface_contact_verified = (
        abs(support_gap_m) <= max_gap_m
        and inside_support_footprint
        and edge_margin_m >= min_edge_margin_m
    )
    entry["support"] = {
        "support_entity_id": support["entity_id"],
        "support_height_m": _round3(support_height_m),
        "support_gap_m": _round3(support_gap_m),
        "inside_support_footprint": inside_support_footprint,
        "edge_margin_m": _round3(edge_margin_m),
        "footprint_basis": "aabb_xy",
        "surface_contact_verified": surface_contact_verified,
    }
    return entry


def build_pose_contacts_payload(
    revision: str,
    character_entity_id: str,
    supports,
    samples,
) -> dict:
    """Assemble the closed public inspect_pose_contacts result with 3-decimal
    rounding, matching ``PoseContactsResultV1Schema`` exactly.

    ``supports``: dicts with entity_id/name/aabb_min/aabb_max (world-space
    AABBs already resolved by the caller); used only to measure each side's
    nearest support, never echoed in the output (the public schema has no
    ``supports`` field). ``samples``: the exact list returned by
    ``stage_scene._pose_contact_samples`` (one
    ``{"frame": int, "sides": {...}}`` dict per requested frame). The gate is
    always the fixed ``DEFAULT_MAX_GAP_M``/``DEFAULT_MIN_EDGE_MARGIN_M`` pair.
    Raises ``PoseContactsError`` (NON_FINITE_GEOMETRY) when any emitted
    numeric is non-finite.
    """
    frames_out = []
    for sample in samples:
        sides_out = {
            side: _side_contact(side_sample, supports, DEFAULT_MAX_GAP_M, DEFAULT_MIN_EDGE_MARGIN_M)
            for side, side_sample in sample["sides"].items()
        }
        frames_out.append({"frame": int(sample["frame"]), "sides": sides_out})
    result = {
        "revision": revision,
        "schema_version": SCHEMA_VERSION,
        "character_entity_id": character_entity_id,
        "gate": {
            "max_gap_m": DEFAULT_MAX_GAP_M,
            "min_edge_margin_m": DEFAULT_MIN_EDGE_MARGIN_M,
        },
        "frames": frames_out,
    }
    _ensure_finite_tree(result)
    return result


def _validated_params(params):
    """Return (character_entity_id, frames, support_entity_ids) or raise
    PoseContactsError.

    ``frames`` are SCENE frames (never clip-local frames); the caller/
    ``stage_scene`` layer rejects any frame outside the scene's configured
    range. The gate is fixed addon-side (``DEFAULT_MAX_GAP_M``/
    ``DEFAULT_MIN_EDGE_MARGIN_M``) and is intentionally absent from
    ``allowed``: the public params schema is closed over exactly
    character_entity_id/frames/support_entity_ids, so any attempt to pass a
    gate override is rejected as an unknown field rather than silently
    accepted and widened.
    """
    if not isinstance(params, dict):
        _invalid("params must be an object")
    allowed = {
        "character_entity_id",
        "frames",
        "support_entity_ids",
    }
    unknown = set(params) - allowed
    if unknown:
        _invalid(f"unknown fields {sorted(unknown)}")

    character_entity_id = params.get("character_entity_id")
    if (
        not isinstance(character_entity_id, str)
        or _UUID_V4_LOWERCASE.fullmatch(character_entity_id) is None
    ):
        _invalid("character_entity_id must be a lowercase UUIDv4")

    frames = params.get("frames")
    if (
        not isinstance(frames, list)
        or not 1 <= len(frames) <= MAX_FRAMES
        or any(
            isinstance(value, bool) or not isinstance(value, int) or value < 0
            for value in frames
        )
    ):
        _invalid(f"frames must be a list of 1..{MAX_FRAMES} non-negative integers")
    if len(set(frames)) != len(frames):
        _invalid("frames must be unique")

    support_entity_ids = params.get("support_entity_ids")
    if (
        not isinstance(support_entity_ids, list)
        or not 1 <= len(support_entity_ids) <= MAX_SUPPORT_ENTITIES
        or any(
            not isinstance(value, str) or _UUID_V4_LOWERCASE.fullmatch(value) is None
            for value in support_entity_ids
        )
    ):
        _invalid(
            "support_entity_ids must be a list of "
            f"1..{MAX_SUPPORT_ENTITIES} lowercase UUIDv4 strings"
        )
    if len(set(support_entity_ids)) != len(support_entity_ids):
        _invalid("support_entity_ids must be unique")

    return character_entity_id, frames, support_entity_ids


def collect_pose_contacts(revision_id: str, params) -> dict:
    """bpy-facing inspect_pose_contacts entry: validate, resolve, measure.

    Resolves support geometry via ``scene_relations``' existing world-AABB
    helpers (the same static/evaluated-bound-box resolution
    ``inspect_relations`` reports) and character-side geometry via
    ``stage_scene._pose_contact_samples``.

    Every requested SCENE frame is validated against
    ``scene.frame_start``/``scene.frame_end`` here, before
    ``_pose_contact_samples`` ever calls ``frame_set`` -- ``frame_set``
    itself does not reject an out-of-range frame, it silently clamps/holds,
    which would let a caller "measure" a frame that was never actually
    evaluated. The character entity is also pre-resolved and type-checked
    here (mirroring the support-entity resolution below) so a missing
    entity or a non-armature entity always raises this module's own
    ``PoseContactsError`` with the exact public contract code
    (``ENTITY_NOT_FOUND``/``NOT_AN_ARMATURE``) rather than falling through
    to ``stage_scene``'s internal ``PoseContactError``, whose single fixed
    ``INVALID_POSE_CONTACT_REQUEST`` code is not a member of the public
    ``INSPECT_POSE_CONTACTS_ERROR_CODES`` contract and must never leak to a
    caller.
    """
    character_entity_id, frames, support_entity_ids = _validated_params(params)

    import bpy

    from .scene_relations import _object_for_entity, _world_corners, world_aabb
    from .stage_scene import _pose_contact_samples

    scene = bpy.context.scene
    frame_start = scene.frame_start
    frame_end = scene.frame_end
    out_of_range = sorted({
        frame for frame in frames if not (frame_start <= frame <= frame_end)
    })
    if out_of_range:
        raise PoseContactsError(
            "SCENE_FRAME_OUT_OF_RANGE",
            f"frames {out_of_range} are outside the scene frame range "
            f"[{frame_start}, {frame_end}]",
        )

    character_object = _object_for_entity(character_entity_id)
    if character_object is None:
        raise PoseContactsError(
            "ENTITY_NOT_FOUND",
            f"entity {character_entity_id} does not exist",
        )
    if character_object.type != "ARMATURE":
        raise PoseContactsError(
            "NOT_AN_ARMATURE",
            f"entity {character_entity_id} is a {character_object.type}, not an ARMATURE",
        )

    supports = []
    for support_entity_id in support_entity_ids:
        support_object = _object_for_entity(support_entity_id)
        if support_object is None:
            raise PoseContactsError(
                "ENTITY_NOT_FOUND",
                f"support entity {support_entity_id} does not exist",
            )
        aabb_min, aabb_max = world_aabb(_world_corners(support_object))
        supports.append({
            "entity_id": support_entity_id,
            "name": support_object.name,
            "aabb_min": aabb_min,
            "aabb_max": aabb_max,
        })

    samples = _pose_contact_samples(character_entity_id, frames)

    return build_pose_contacts_payload(
        revision_id,
        character_entity_id,
        supports,
        samples,
    )
