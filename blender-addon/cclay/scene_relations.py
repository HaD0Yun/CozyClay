"""Read-only scene-relations geometry for the inspect_relations bridge method.

Measures world-space AABBs, upward support planes, character rest heights, and
repeated sibling layout patterns so an agent can plan motion prompts from real
scene dimensions. The measurement math is deliberately bpy-free so it can be
unit tested with plain CPython; the single bpy-facing entry point is
``collect_relations``.
"""

from __future__ import annotations

import math
import re

try:  # Blender is intentionally absent from host-side unit tests.
    import bpy  # type: ignore
    from mathutils import Vector  # type: ignore
except ImportError:  # pragma: no cover - exercised by host-side imports
    bpy = None
    Vector = None

SCHEMA_VERSION = 1
MAX_ENTITIES = 64
MAX_SUPPORT_PLANE_POLYGONS = 20_000
SUPPORT_PLANE_TOLERANCE = 0.005
SUPPORT_PLANE_MAX = 8
SUPPORT_PLANE_MIN_NORMAL_Z = 0.85
PATTERN_FOOTPRINT_TOLERANCE = 0.02
PATTERN_MAX_DEVIATION = 0.05
PATTERN_MIN_COUNT = 3
_DIRECTION_EPSILON = 1e-6

_UUID_V4_LOWERCASE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)

# rest_heights name heuristics (case-insensitive substring match), per the
# bridge contract. Substrings are tried in listed priority order (needle-major):
# the reported height is the head_z of the first bone (input order) whose name
# contains the highest-priority matching substring; null when nothing matches.
_REST_HEIGHT_NAME_SUBSTRINGS = (
    ("pelvis", ("hips", "pelvis", "root")),
    ("hand", ("hand", "wrist")),
    ("head", ("head",)),
)


class SceneRelationsError(ValueError):
    """An inspect_relations request is invalid; ``code`` is the contract code."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code


def _invalid(message: str) -> None:
    raise SceneRelationsError("INVALID_INSPECT_RELATIONS_PARAMS", message)


def _non_finite() -> None:
    raise SceneRelationsError(
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


def world_aabb(points8):
    """Axis-aligned (min3, max3) over world-space corner points."""
    points = [[float(component) for component in point] for point in points8]
    if not points:
        raise ValueError("world_aabb requires at least one point")
    minimum = [min(point[axis] for point in points) for axis in range(3)]
    maximum = [max(point[axis] for point in points) for axis in range(3)]
    return minimum, maximum


def cluster_support_planes(
    faces,
    tol: float = SUPPORT_PLANE_TOLERANCE,
    max_planes: int = SUPPORT_PLANE_MAX,
    min_normal_z: float = SUPPORT_PLANE_MIN_NORMAL_Z,
):
    """Ascending clustered world-z heights of upward-facing faces.

    ``faces`` is an iterable of (world_z, world_normal_z) tuples. Faces whose
    normal z is below ``min_normal_z`` are ignored, as are samples with a
    non-finite z or normal z. Ascending z values join the current cluster while
    they lie within ``tol`` of the running simple mean of its members; the
    result keeps the lowest ``max_planes`` cluster means.
    """
    samples = ((float(z), float(normal_z)) for z, normal_z in faces)
    heights = sorted(
        z
        for z, normal_z in samples
        if math.isfinite(z) and math.isfinite(normal_z) and normal_z >= min_normal_z
    )
    clusters: list[float] = []
    current: list[float] = []
    for z in heights:
        if current and abs(z - sum(current) / len(current)) > tol:
            clusters.append(sum(current) / len(current))
            current = []
        current.append(z)
    if current:
        clusters.append(sum(current) / len(current))
    return clusters[:max_planes]


def character_metrics(bones, world_scale, aabb_min, aabb_max):
    """Contract ``reference.character`` block from rest-pose bone heights.

    ``bones`` is a list of {"name", "head_z", "tail_z"} dicts with world-space
    z values. Returns None when the bone list is empty.
    """
    rows = list(bones)
    if not rows:
        return None
    rest_heights = {
        "lowest": min(
            float(value) for row in rows for value in (row["head_z"], row["tail_z"])
        ),
    }
    for key, needles in _REST_HEIGHT_NAME_SUBSTRINGS:
        # Needle-major: every bone is tried for the first substring before the
        # next substring is considered, so 'hips' beats 'root' regardless of
        # bone input order.
        match = next(
            (
                row
                for needle in needles
                for row in rows
                if needle in str(row["name"]).lower()
            ),
            None,
        )
        rest_heights[key] = None if match is None else float(match["head_z"])
    return {
        "world_scale": [float(value) for value in world_scale],
        "standing_height": float(aabb_max[2]) - float(aabb_min[2]),
        "bone_count": len(rows),
        "rest_heights": rest_heights,
    }


def _aabb_center(entity) -> list[float]:
    return [
        (float(entity["aabb_min"][axis]) + float(entity["aabb_max"][axis])) / 2.0
        for axis in range(3)
    ]


def _regular_runs(samples):
    """Disjoint (start, end, pitch, max_deviation) regular consecutive runs.

    A run is a consecutive window of at least ``PATTERN_MIN_COUNT`` samples
    whose deltas all stay within ``PATTERN_MAX_DEVIATION`` of the window's mean
    pitch. The largest qualifying window is taken first (leftmost on ties),
    then the remaining prefix and suffix are searched recursively, so runs are
    disjoint and each sample lands in at most one run.
    """
    runs = []

    def visit(lo: int, hi: int) -> None:
        best = None
        for length in range(hi - lo + 1, PATTERN_MIN_COUNT - 1, -1):
            for start in range(lo, hi - length + 2):
                end = start + length - 1
                deltas = [
                    [samples[i][c] - samples[i - 1][c] for c in range(3)]
                    for i in range(start + 1, end + 1)
                ]
                pitch = [
                    sum(delta[c] for delta in deltas) / len(deltas)
                    for c in range(3)
                ]
                max_deviation = max(
                    abs(delta[c] - pitch[c]) for delta in deltas for c in range(3)
                )
                if max_deviation <= PATTERN_MAX_DEVIATION:
                    best = (start, end, pitch, max_deviation)
                    break
            if best is not None:
                break
        if best is None:
            return
        start, end, _, _ = best
        visit(lo, start - 1)
        runs.append(best)
        visit(end + 1, hi)

    visit(0, len(samples) - 1)
    runs.sort(key=lambda run: run[0])
    return runs


def detect_patterns(entities):
    """Group repeated same-footprint entities laid out on a regular pitch.

    ``entities`` are dicts with entity_id/aabb_min/aabb_max/top_height/
    footprint. Groups partition the input (an entity joins the first group
    whose representative footprint matches within the tolerance). Within a
    sorted group every disjoint regular consecutive run of at least
    ``PATTERN_MIN_COUNT`` members becomes its own pattern (largest run first),
    so off-lattice outliers no longer disqualify the regular members and an
    entity still appears in at most one pattern.
    """
    groups: list[dict] = []
    for entity in entities:
        footprint = [float(value) for value in entity["footprint"]]
        target = next(
            (
                group
                for group in groups
                if all(
                    abs(footprint[axis] - group["footprint"][axis])
                    <= PATTERN_FOOTPRINT_TOLERANCE
                    for axis in range(2)
                )
            ),
            None,
        )
        if target is None:
            groups.append({"footprint": footprint, "members": [entity]})
        else:
            target["members"].append(entity)
    patterns = []
    for group in groups:
        members = group["members"]
        if len(members) < PATTERN_MIN_COUNT:
            continue
        centers = [_aabb_center(member) for member in members]
        spreads = [
            max(center[axis] for center in centers)
            - min(center[axis] for center in centers)
            for axis in (0, 1)
        ]
        sort_axis = 1 if spreads[1] > spreads[0] else 0
        order = sorted(range(len(members)), key=lambda i: centers[i][sort_axis])
        samples = [
            [centers[i][0], centers[i][1], float(members[i]["top_height"])]
            for i in order
        ]
        for start, end, pitch, max_deviation in _regular_runs(samples):
            run = order[start:end + 1]
            patterns.append({
                "entity_ids": [members[i]["entity_id"] for i in run],
                "count": len(run),
                "pitch": pitch,
                "max_deviation": max_deviation,
                "footprint": [
                    sum(float(members[i]["footprint"][c]) for i in run)
                    / len(run)
                    for c in range(2)
                ],
            })
    return patterns


def build_relations_payload(revision, entity_rows, reference_row):
    """Assemble the closed inspect_relations result with 3-decimal rounding.

    ``entity_rows``: dicts with entity_id/name/type/aabb_min/aabb_max/
    support_planes. ``reference_row``: None or a dict with entity_id/name/
    type/origin/aabb_min/aabb_max/character (``character_metrics`` output).
    Raises ``SceneRelationsError`` (NON_FINITE_GEOMETRY) when any emitted
    numeric is non-finite.
    """
    reference = None
    if reference_row is not None:
        character = reference_row.get("character")
        reference = {
            "entity_id": reference_row["entity_id"],
            "name": reference_row["name"],
            "type": reference_row["type"],
            "origin": _round3_vec(reference_row["origin"]),
            "aabb_min": _round3_vec(reference_row["aabb_min"]),
            "aabb_max": _round3_vec(reference_row["aabb_max"]),
            "character": None if character is None else {
                "world_scale": _round3_vec(character["world_scale"]),
                "standing_height": _round3(character["standing_height"]),
                "bone_count": int(character["bone_count"]),
                "rest_heights": {
                    key: None if value is None else _round3(value)
                    for key, value in character["rest_heights"].items()
                },
            },
        }
    derived = []
    for row in entity_rows:
        aabb_min = [float(value) for value in row["aabb_min"]]
        aabb_max = [float(value) for value in row["aabb_max"]]
        size = [aabb_max[axis] - aabb_min[axis] for axis in range(3)]
        derived.append({
            "entity_id": row["entity_id"],
            "name": row["name"],
            "type": row["type"],
            "aabb_min": aabb_min,
            "aabb_max": aabb_max,
            "size": size,
            "top_height": aabb_max[2],
            "support_planes": [float(z) for z in row["support_planes"]],
            "footprint": [size[0], size[1]],
        })
    patterns = detect_patterns(derived)
    entities = []
    for row in derived:
        relative = None
        if reference_row is not None:
            origin = [float(value) for value in reference_row["origin"]]
            center = _aabb_center(row)
            offset = [center[axis] - origin[axis] for axis in range(3)]
            horizontal_distance = math.hypot(offset[0], offset[1])
            direction = (
                None
                if horizontal_distance < _DIRECTION_EPSILON
                else [
                    offset[0] / horizontal_distance,
                    offset[1] / horizontal_distance,
                ]
            )
            relative = {
                "offset": _round3_vec(offset),
                "horizontal_distance": _round3(horizontal_distance),
                "direction": None if direction is None else _round3_vec(direction),
                "top_above_reference_base": _round3(
                    row["top_height"] - float(reference_row["aabb_min"][2])
                ),
            }
        entities.append({
            "entity_id": row["entity_id"],
            "name": row["name"],
            "type": row["type"],
            "aabb_min": _round3_vec(row["aabb_min"]),
            "aabb_max": _round3_vec(row["aabb_max"]),
            "size": _round3_vec(row["size"]),
            "top_height": _round3(row["top_height"]),
            "support_planes": _round3_vec(row["support_planes"]),
            "footprint": _round3_vec(row["footprint"]),
            "relative": relative,
        })
    result = {
        "revision": revision,
        "schema_version": SCHEMA_VERSION,
        "reference": reference,
        "entities": entities,
        "patterns": [
            {
                "entity_ids": list(pattern["entity_ids"]),
                "count": int(pattern["count"]),
                "pitch": _round3_vec(pattern["pitch"]),
                "max_deviation": _round3(pattern["max_deviation"]),
                "footprint": _round3_vec(pattern["footprint"]),
            }
            for pattern in patterns
        ],
    }
    _ensure_finite_tree(result)
    return result


def _validated_params(params):
    """Return (entity_ids, reference_entity_id) or raise SceneRelationsError.

    Explicit nulls for the optional fields are rejected by key-presence checks
    (parity with the TS Type.Optional contract, which forbids ``null`` for
    absent fields).
    """
    if not isinstance(params, dict):
        _invalid("params must be an object")
    unknown = set(params) - {"entity_ids", "reference_entity_id"}
    if unknown:
        _invalid(f"unknown fields {sorted(unknown)}")
    entity_ids = None
    if "entity_ids" in params:
        entity_ids = params["entity_ids"]
        if (
            not isinstance(entity_ids, list)
            or not 1 <= len(entity_ids) <= MAX_ENTITIES
            or any(
                not isinstance(value, str)
                or _UUID_V4_LOWERCASE.fullmatch(value) is None
                for value in entity_ids
            )
        ):
            _invalid(
                "entity_ids must be a list of "
                f"1..{MAX_ENTITIES} lowercase UUIDv4 strings"
            )
        if len(set(entity_ids)) != len(entity_ids):
            _invalid("entity_ids must be unique")
    reference_entity_id = None
    if "reference_entity_id" in params:
        reference_entity_id = params["reference_entity_id"]
        if (
            not isinstance(reference_entity_id, str)
            or _UUID_V4_LOWERCASE.fullmatch(reference_entity_id) is None
        ):
            _invalid("reference_entity_id must be a lowercase UUIDv4")
    return entity_ids, reference_entity_id


def _object_for_entity(entity_id: str):
    # Same entity-id mapping manifest._entity_detail uses: the cclay.entity_id
    # custom property stamped on every staged object.
    return next(
        (obj for obj in bpy.data.objects if obj.get("cclay.entity_id") == entity_id),
        None,
    )


def _world_corners(obj):
    matrix = obj.matrix_world
    return [list(matrix @ Vector(corner)) for corner in obj.bound_box]


def _support_plane_faces(obj):
    """(world_z, world_normal_z) per upward face; [] when unbounded or empty."""
    data = obj.data
    if obj.type != "MESH" or data is None:
        return []
    polygons = data.polygons
    if len(polygons) == 0 or len(polygons) > MAX_SUPPORT_PLANE_POLYGONS:
        return []
    matrix = obj.matrix_world
    rotation = matrix.to_3x3()
    vertices = data.vertices
    faces = []
    for polygon in polygons:
        normal_z = (rotation @ polygon.normal).normalized().z
        if not math.isfinite(normal_z) or normal_z < SUPPORT_PLANE_MIN_NORMAL_Z:
            continue
        # First-vertex world-z sampling is exact only for horizontal faces.
        # normal_z >= 0.85 still admits slopes up to ~31.8 deg, where the
        # vertices of a large face can spread beyond the 0.005 m cluster
        # tolerance; accepted approximation for near-horizontal support
        # surfaces, where any member vertex is representative.
        world_z = (matrix @ vertices[polygon.vertices[0]].co).z
        if not math.isfinite(world_z):
            continue
        faces.append((world_z, normal_z))
    return faces


def _entity_row(obj) -> dict:
    aabb_min, aabb_max = world_aabb(_world_corners(obj))
    return {
        "entity_id": obj.get("cclay.entity_id"),
        "name": obj.name,
        "type": obj.type,
        "aabb_min": aabb_min,
        "aabb_max": aabb_max,
        "support_planes": cluster_support_planes(_support_plane_faces(obj)),
    }


def _reference_row(obj) -> dict:
    aabb_min, aabb_max = world_aabb(_world_corners(obj))
    character = None
    if obj.type == "ARMATURE" and obj.data is not None:
        matrix = obj.matrix_world
        bones = [
            {
                "name": bone.name,
                "head_z": (matrix @ bone.head_local).z,
                "tail_z": (matrix @ bone.tail_local).z,
            }
            for bone in obj.data.bones
        ]
        character = character_metrics(
            bones, list(matrix.to_scale()), aabb_min, aabb_max
        )
    return {
        "entity_id": obj.get("cclay.entity_id"),
        "name": obj.name,
        "type": obj.type,
        # World-space origin; equals object location for unparented objects.
        "origin": list(obj.matrix_world.translation),
        "aabb_min": aabb_min,
        "aabb_max": aabb_max,
        "character": character,
    }


def _default_objects():
    """Visible parentless MESH entities with a well-formed lowercase UUIDv4
    ``cclay.entity_id``, deterministic name order, capped."""
    def _entity_id(obj):
        entity_id = obj.get("cclay.entity_id")
        return entity_id if isinstance(entity_id, str) else ""

    candidates = [
        obj
        for obj in bpy.data.objects
        if obj.type == "MESH"
        and obj.parent is None
        and obj.visible_get()
        and _UUID_V4_LOWERCASE.fullmatch(_entity_id(obj)) is not None
    ]
    candidates.sort(key=lambda obj: obj.name)
    return candidates[:MAX_ENTITIES]


def collect_relations(revision_id: str, params) -> dict:
    """bpy-facing inspect_relations entry: validate, resolve, measure."""
    entity_ids, reference_entity_id = _validated_params(params)
    if entity_ids is None:
        objects = _default_objects()
    else:
        objects = []
        for entity_id in entity_ids:
            obj = _object_for_entity(entity_id)
            if obj is None:
                raise SceneRelationsError(
                    "ENTITY_NOT_FOUND", f"entity {entity_id} does not exist"
                )
            objects.append(obj)
    reference_row = None
    if reference_entity_id is not None:
        reference_object = _object_for_entity(reference_entity_id)
        if reference_object is None:
            raise SceneRelationsError(
                "ENTITY_NOT_FOUND",
                f"entity {reference_entity_id} does not exist",
            )
        reference_row = _reference_row(reference_object)
    return build_relations_payload(
        revision_id,
        [_entity_row(obj) for obj in objects],
        reference_row,
    )
