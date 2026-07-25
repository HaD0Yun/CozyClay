"""Closed camera/evidence schemas and the release's digest-pinned fixture registry."""

from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import stat
import re
from pathlib import Path
from types import MappingProxyType

from .canonical import canonical_json

_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_CAMERA_PLAN_KEYS = {
    "schema_version", "expected_revision_id", "evidence_sha256", "output_format", "keyframes",
}
_OUTPUT_FORMAT_KEYS = {"width", "height"}
_PLAN_KEYFRAME_KEYS = {"frame", "pose", "transition"}
_POSE_KEYS = {"position", "look_at", "up", "vertical_fov_radians"}
_EVIDENCE_KEYS = {
    "schema_version", "revision_id", "scene_hash", "frame_range", "producer", "analysis",
}
_FRAME_RANGE_KEYS = {"start", "end"}
_PRODUCER_KEYS = {"id", "version", "digest"}
_ANALYSIS_KEYS = {
    "motion_valley_frames", "action_peak_ranges", "action_axis", "subject_samples",
}
_RANGE_KEYS = {"start", "end"}
_AXIS_KEYS = {"a", "b", "up"}
_SUBJECT_SAMPLE_KEYS = {"frame", "center", "height_m"}

BOXING_V4_EVIDENCE_SHA256 = "9b389972e9dd77d84919ce82ee688caeedc02ee62c3b1314d4e6982efd04e597"
_PRODUCER_DIGEST = "f31de2b9d7232e5fdf56c8de4a1ecc80f7cbc4fb6c5743d6eef644d4caeacb59"
_FIXTURE_REGISTRY = MappingProxyType({
    BOXING_V4_EVIDENCE_SHA256: (
        "boxing-v4",
        "boxing-v4-directing-evidence.json",
        ("cclay.approved_fixture", "boxing-v4", _PRODUCER_DIGEST),
    ),
})

# Runtime-produced evidence trusted for this Blender session only. Maps a
# sha256 digest to (resource path, resolved trusted directory, expected
# producer triple, revision_id, scene_hash) exactly as recorded at production
# time by directing_evidence. The trusted directory is recorded independently
# of the resource path so the containment row cannot degrade to a tautology.
_RUNTIME_EVIDENCE_REGISTRY: dict[
    str, tuple[Path, Path, tuple[str, str, str], str, str]
] = {}


class INVALID_CAMERA_PLAN_SCHEMA(ValueError):
    code = "INVALID_CAMERA_PLAN_SCHEMA"


# Compatibility name retained for callers which catch the former broad class.
INVALID_CAMERA_PLAN = INVALID_CAMERA_PLAN_SCHEMA


class UNTRUSTED_DIRECTING_EVIDENCE(ValueError):
    code = "UNTRUSTED_DIRECTING_EVIDENCE"


class UNTRUSTED_EVIDENCE_DIGEST(UNTRUSTED_DIRECTING_EVIDENCE):
    code = "UNTRUSTED_EVIDENCE_DIGEST"


class TRUSTED_FIXTURE_NOT_FOUND(UNTRUSTED_DIRECTING_EVIDENCE):
    code = "TRUSTED_FIXTURE_NOT_FOUND"


class TRUSTED_FIXTURE_PATH_UNSAFE(UNTRUSTED_DIRECTING_EVIDENCE):
    code = "TRUSTED_FIXTURE_PATH_UNSAFE"


class EVIDENCE_DIGEST_MISMATCH(UNTRUSTED_DIRECTING_EVIDENCE):
    code = "EVIDENCE_DIGEST_MISMATCH"


class EVIDENCE_DOCUMENT_MALFORMED(UNTRUSTED_DIRECTING_EVIDENCE):
    code = "EVIDENCE_DOCUMENT_MALFORMED"


class EVIDENCE_DOCUMENT_SCHEMA_INVALID(UNTRUSTED_DIRECTING_EVIDENCE):
    code = "EVIDENCE_DOCUMENT_SCHEMA_INVALID"


class EVIDENCE_RANGE_INVALID(UNTRUSTED_DIRECTING_EVIDENCE):
    code = "EVIDENCE_RANGE_INVALID"


class EVIDENCE_REVISION_MISMATCH(UNTRUSTED_DIRECTING_EVIDENCE):
    code = "EVIDENCE_REVISION_MISMATCH"


class EVIDENCE_SCENE_HASH_MISMATCH(UNTRUSTED_DIRECTING_EVIDENCE):
    code = "EVIDENCE_SCENE_HASH_MISMATCH"


def _fail(error_type: type[ValueError], path: str, requirement: str) -> None:
    raise error_type(f"{path} {requirement}")


def _exact_keys(value: object, expected: set[str], path: str, error_type: type[ValueError]) -> dict:
    if not isinstance(value, dict):
        _fail(error_type, path, "must be an object")
    missing = expected - set(value)
    extra = set(value) - expected
    if missing or extra:
        _fail(error_type, path, f"must have exactly {sorted(expected)}")
    return value


def _integer(value: object, path: str, error_type: type[ValueError], minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        _fail(error_type, path, f"must be an integer >= {minimum}")
    return value


def _number(value: object, path: str, error_type: type[ValueError]) -> float | int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        _fail(error_type, path, "must be a finite number")
    if abs(value) >= 1e15:
        _fail(error_type, path, "must have magnitude < 1e15")
    return value


def _string(value: object, path: str, error_type: type[ValueError]) -> str:
    if not isinstance(value, str) or not value:
        _fail(error_type, path, "must be a non-empty string")
    return value


def _hash(value: object, path: str, error_type: type[ValueError]) -> str:
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
        _fail(error_type, path, "must be lowercase hexadecimal SHA-256")
    return value


def _vector(value: object, path: str, error_type: type[ValueError]) -> list[float | int]:
    if not isinstance(value, list) or len(value) != 3:
        _fail(error_type, path, "must contain exactly three numbers")
    for index, component in enumerate(value):
        _number(component, f"{path}[{index}]", error_type)
    return value


def convert_ardy_plan_pose_to_blender(pose_value: object) -> dict:
    """Convert one validated ARDY Y-up camera pose at the ingestion boundary."""
    pose = _exact_keys(pose_value, _POSE_KEYS, "pose", INVALID_CAMERA_PLAN)
    position = _vector(pose["position"], "pose.position", INVALID_CAMERA_PLAN)
    look_at = _vector(pose["look_at"], "pose.look_at", INVALID_CAMERA_PLAN)
    up = _vector(pose["up"], "pose.up", INVALID_CAMERA_PLAN)
    if up != [0.0, 1.0, 0.0]:
        _fail(INVALID_CAMERA_PLAN, "pose.up", "must equal ARDY [0, 1, 0]")
    fov = _number(pose["vertical_fov_radians"], "pose.vertical_fov_radians", INVALID_CAMERA_PLAN)
    if not 0 < fov < math.pi:
        _fail(INVALID_CAMERA_PLAN, "pose.vertical_fov_radians", "must be between 0 and pi")

    def convert(vector: list[float | int]) -> list[float | int]:
        x, y, z = vector
        return [x, -z, y]

    return {
        "position": convert(position),
        "look_at": convert(look_at),
        "up": convert(up),
        "vertical_fov_radians": fov,
    }


def parse_camera_plan(value: object) -> dict:
    """Validate only the closed CameraPlanV1 schema (precedence row 1)."""
    error = INVALID_CAMERA_PLAN_SCHEMA
    plan = _exact_keys(value, _CAMERA_PLAN_KEYS, "plan", error)
    if plan["schema_version"] != 1:
        _fail(error, "plan.schema_version", "must equal 1")
    _hash(plan["expected_revision_id"], "plan.expected_revision_id", error)
    _hash(plan["evidence_sha256"], "plan.evidence_sha256", error)
    output = _exact_keys(plan["output_format"], _OUTPUT_FORMAT_KEYS, "plan.output_format", error)
    _integer(output["width"], "plan.output_format.width", error, 1)
    _integer(output["height"], "plan.output_format.height", error, 1)
    keyframes = plan["keyframes"]
    if not isinstance(keyframes, list) or not keyframes:
        _fail(error, "plan.keyframes", "must be a non-empty array")
    for index, keyframe in enumerate(keyframes):
        path = f"plan.keyframes[{index}]"
        item = _exact_keys(keyframe, _PLAN_KEYFRAME_KEYS, path, error)
        _number(item["frame"], f"{path}.frame", error)
        pose = _exact_keys(item["pose"], _POSE_KEYS, f"{path}.pose", error)
        _vector(pose["position"], f"{path}.pose.position", error)
        _vector(pose["look_at"], f"{path}.pose.look_at", error)
        _vector(pose["up"], f"{path}.pose.up", error)
        fov = _number(
            pose["vertical_fov_radians"],
            f"{path}.pose.vertical_fov_radians",
            error,
        )
        if not 0 < fov < math.pi:
            _fail(error, f"{path}.pose.vertical_fov_radians", "must be between 0 and pi")
        if item["transition"] not in ("smooth", "cut"):
            _fail(error, f"{path}.transition", "must be smooth or cut")
    return copy.deepcopy(plan)


def parse_directing_analysis_evidence(value: object) -> dict:
    """Validate and copy a closed DirectingAnalysisEvidenceV1 payload."""
    error = EVIDENCE_DOCUMENT_SCHEMA_INVALID
    evidence = _exact_keys(value, _EVIDENCE_KEYS, "evidence", error)
    if evidence["schema_version"] != 1:
        _fail(error, "evidence.schema_version", "must equal 1")
    _hash(evidence["revision_id"], "evidence.revision_id", error)
    _hash(evidence["scene_hash"], "evidence.scene_hash", error)
    frame_range = _exact_keys(evidence["frame_range"], _FRAME_RANGE_KEYS, "evidence.frame_range", error)
    start = _number(frame_range["start"], "evidence.frame_range.start", error)
    end = _number(frame_range["end"], "evidence.frame_range.end", error)
    producer = _exact_keys(evidence["producer"], _PRODUCER_KEYS, "evidence.producer", error)
    _string(producer["id"], "evidence.producer.id", error)
    _string(producer["version"], "evidence.producer.version", error)
    _hash(producer["digest"], "evidence.producer.digest", error)
    analysis = _exact_keys(evidence["analysis"], _ANALYSIS_KEYS, "evidence.analysis", error)
    valleys = analysis["motion_valley_frames"]
    if not isinstance(valleys, list):
        _fail(error, "evidence.analysis.motion_valley_frames", "must be an array")
    previous = start - 1
    for index, frame in enumerate(valleys):
        frame = _integer(frame, f"evidence.analysis.motion_valley_frames[{index}]", error)
        if frame <= previous or frame > end:
            _fail(error, "evidence.analysis.motion_valley_frames", "must be unique, sorted, and in range")
        previous = frame
    ranges = analysis["action_peak_ranges"]
    if not isinstance(ranges, list):
        _fail(error, "evidence.analysis.action_peak_ranges", "must be an array")
    previous_end = start - 1
    for index, value_range in enumerate(ranges):
        path = f"evidence.analysis.action_peak_ranges[{index}]"
        item = _exact_keys(value_range, _RANGE_KEYS, path, error)
        range_start = _integer(item["start"], f"{path}.start", error)
        range_end = _integer(item["end"], f"{path}.end", error)
        if range_start <= previous_end or range_end < range_start or range_end > end:
            _fail(error, "evidence.analysis.action_peak_ranges", "must be disjoint, sorted, and in range")
        previous_end = range_end
    axis = _exact_keys(analysis["action_axis"], _AXIS_KEYS, "evidence.analysis.action_axis", error)
    for name in ("a", "b", "up"):
        _vector(axis[name], f"evidence.analysis.action_axis.{name}", error)
    samples = analysis["subject_samples"]
    if not isinstance(samples, list):
        _fail(error, "evidence.analysis.subject_samples", "must be an array")
    previous = start - 1
    for index, sample in enumerate(samples):
        path = f"evidence.analysis.subject_samples[{index}]"
        item = _exact_keys(sample, _SUBJECT_SAMPLE_KEYS, path, error)
        frame = _integer(item["frame"], f"{path}.frame", error)
        if frame <= previous or frame > end:
            _fail(error, "evidence.analysis.subject_samples", "must be unique, sorted, and in range")
        previous = frame
        _vector(item["center"], f"{path}.center", error)
        if _number(item["height_m"], f"{path}.height_m", error) <= 0:
            _fail(error, f"{path}.height_m", "must be > 0")
    return copy.deepcopy(evidence)


def register_runtime_evidence(
    evidence_sha256: str,
    resource_path: "Path | str",
    trusted_directory: "Path | str",
    expected_producer: tuple[str, str, str],
    revision_id: str,
    scene_hash: str,
) -> None:
    """Trust one runtime-produced evidence digest for the current session.

    The evidence file MUST be an owned, non-symlink regular file that resolves
    directly inside ``trusted_directory``, and ``trusted_directory`` MUST itself
    be an owned, non-symlink, 0700 directory. Binding trust to a separately
    recorded private directory (rather than deriving it from ``resource_path``)
    keeps the containment row in ``_verify_evidence_resource`` meaningful: a
    file registered from a world-writable or attacker-chosen location can never
    be authorized.
    """
    for name, value in (
        ("evidence_sha256", evidence_sha256),
        ("revision_id", revision_id),
        ("scene_hash", scene_hash),
    ):
        _hash(value, f"runtime evidence {name}", ValueError)
    if (
        not isinstance(expected_producer, tuple)
        or len(expected_producer) != 3
        or not all(isinstance(part, str) and part for part in expected_producer)
    ):
        raise ValueError("runtime evidence producer identity is invalid")
    resource = Path(resource_path)
    directory = Path(trusted_directory)
    try:
        directory_stat = directory.lstat()
        resolved_directory = directory.resolve(strict=True)
        resolved_resource = resource.resolve(strict=True)
    except OSError as error:
        raise TRUSTED_FIXTURE_PATH_UNSAFE(
            "runtime evidence directory could not be safely resolved"
        ) from error
    current_uid = getattr(os, "getuid", lambda: directory_stat.st_uid)()
    if (
        stat.S_ISLNK(directory_stat.st_mode)
        or not stat.S_ISDIR(directory_stat.st_mode)
        or directory_stat.st_uid != current_uid
        or (directory_stat.st_mode & 0o077) != 0
    ):
        raise TRUSTED_FIXTURE_PATH_UNSAFE(
            "runtime evidence directory must be an owned nonsymlink 0700 directory"
        )
    if resolved_resource.parent != resolved_directory:
        raise TRUSTED_FIXTURE_PATH_UNSAFE(
            "runtime evidence file must live inside its private evidence directory"
        )
    _RUNTIME_EVIDENCE_REGISTRY[evidence_sha256] = (
        resource,
        resolved_directory,
        expected_producer,
        revision_id,
        scene_hash,
    )


def load_authorized_fixture(plan_value: object, current_scene_hash: str) -> dict:
    """Apply evidence trust rows 1-10 in their exact atomic precedence."""
    plan = parse_camera_plan(plan_value)
    digest = plan["evidence_sha256"]
    registered = _FIXTURE_REGISTRY.get(digest)
    if registered is not None:
        _fixture_identity, resource_name, expected_producer = registered
        fixture_directory = Path(__file__).resolve().parent / "fixtures"
        return _verify_evidence_resource(
            fixture_directory / resource_name,
            fixture_directory,
            plan,
            current_scene_hash,
            expected_producer,
        )

    runtime_entry = _RUNTIME_EVIDENCE_REGISTRY.get(digest)
    if runtime_entry is None:
        raise UNTRUSTED_EVIDENCE_DIGEST("evidence digest is not authorized")
    resource, trusted_directory, expected_producer, revision_id, scene_hash = runtime_entry
    evidence = _verify_evidence_resource(
        resource,
        trusted_directory,
        plan,
        current_scene_hash,
        expected_producer,
    )
    if evidence["revision_id"] != revision_id:
        raise EVIDENCE_REVISION_MISMATCH(
            "runtime evidence revision does not match its registration"
        )
    if evidence["scene_hash"] != scene_hash:
        raise EVIDENCE_SCENE_HASH_MISMATCH(
            "runtime evidence scene hash does not match its registration"
        )
    return evidence


def _verify_evidence_resource(
    resource: Path,
    trusted_directory: Path,
    plan: dict,
    current_scene_hash: str,
    expected_producer: tuple[str, str, str],
) -> dict:
    """Shared trust rows 3-10 for packaged fixtures and runtime evidence."""
    if not resource.exists():
        raise TRUSTED_FIXTURE_NOT_FOUND("configured fixture resource does not exist")

    try:
        resource_stat = resource.lstat()
        resolved_directory = trusted_directory.resolve(strict=True)
        resolved_resource = resource.resolve(strict=True)
    except OSError as error:
        raise TRUSTED_FIXTURE_PATH_UNSAFE("fixture resource could not be safely resolved") from error
    if (
        stat.S_ISLNK(resource_stat.st_mode)
        or not stat.S_ISREG(resource_stat.st_mode)
        or resource_stat.st_uid != os.getuid()
        or resolved_resource.parent != resolved_directory
    ):
        raise TRUSTED_FIXTURE_PATH_UNSAFE(
            "fixture resource must be an owned regular nonsymlink file inside its package directory"
        )

    try:
        evidence_bytes = resource.read_bytes()
    except OSError as error:
        raise TRUSTED_FIXTURE_PATH_UNSAFE("fixture resource could not be safely read") from error
    actual_digest = hashlib.sha256(evidence_bytes).hexdigest()
    if actual_digest != plan["evidence_sha256"]:
        raise EVIDENCE_DIGEST_MISMATCH("fixture digest differs from its plan and core table")

    try:
        parsed_value = json.loads(evidence_bytes.decode("utf-8"))
        if canonical_json(parsed_value).encode("utf-8") != evidence_bytes:
            raise EVIDENCE_DOCUMENT_MALFORMED("fixture bytes are not canonical JSON")
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError) as error:
        if isinstance(error, EVIDENCE_DOCUMENT_MALFORMED):
            raise
        raise EVIDENCE_DOCUMENT_MALFORMED("fixture is not canonical JSON") from error

    evidence = parse_directing_analysis_evidence(parsed_value)
    producer = evidence["producer"]
    producer_tuple = (producer["id"], producer["version"], producer["digest"])
    if producer_tuple != expected_producer:
        raise EVIDENCE_DOCUMENT_SCHEMA_INVALID(
            "fixture producer does not match its core-owned identity"
        )

    frame_range = evidence["frame_range"]
    start = frame_range["start"]
    end = frame_range["end"]
    if (
        isinstance(start, bool)
        or not isinstance(start, int)
        or isinstance(end, bool)
        or not isinstance(end, int)
        or start < 0
        or end < start
    ):
        raise EVIDENCE_RANGE_INVALID(
            "evidence range bounds must be nonnegative integers with start <= end"
        )
    if evidence["revision_id"] != plan["expected_revision_id"]:
        raise EVIDENCE_REVISION_MISMATCH("fixture revision does not match the plan base")
    if evidence["scene_hash"] != current_scene_hash:
        raise EVIDENCE_SCENE_HASH_MISMATCH(
            "fixture scene hash does not match the current revision"
        )
    return evidence
