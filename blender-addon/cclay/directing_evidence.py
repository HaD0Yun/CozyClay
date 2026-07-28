"""Runtime DirectingAnalysisEvidenceV1 production from the live Blender scene.

The add-on analyzes the current scene, writes a canonical evidence document
into a private per-project runtime directory, and registers its sha256 in the
fixture-registry runtime trust registry so apply_camera_plan can accept it.
Every analysis coordinate is expressed in the ARDY Y-up frame (see
camera_plan._ardy_to_blender for the inverse mapping).
"""

from __future__ import annotations

import hashlib
import math
import os
import re
import stat
import tempfile
import uuid
from pathlib import Path

from .canonical import canonical_json
from .fixture_registry import (
    parse_directing_analysis_evidence,
    register_runtime_evidence,
)

try:  # Blender is intentionally absent from host-side unit tests.
    import bpy  # type: ignore
    from mathutils import Vector  # type: ignore
except ImportError:  # pragma: no cover - exercised by host-side imports
    bpy = None
    Vector = None


class EVIDENCE_PRODUCTION_FAILED(RuntimeError):
    code = "EVIDENCE_PRODUCTION_FAILED"


RUNTIME_PRODUCER_ID = "cclay-addon-runtime"
_PROJECT_ID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_SPEED_EPSILON = 1e-9
_MOTION_EPSILON = 1e-6
_PEAK_THRESHOLD_RATIO = 0.5
_MAX_FRAME_COUNT = 20_000


# Evidence producer identity, deliberately pinned and independent of the add-on
# version: it is hashed into every runtime-produced evidence document, so
# bumping it invalidates every committed evidence digest and every camera plan
# authorized by one. Change it only when the evidence semantics change.
RUNTIME_PRODUCER_VERSION = "0.4.0"


def runtime_producer() -> dict:
    """The fixed identity recorded on every runtime-produced evidence doc."""
    version = RUNTIME_PRODUCER_VERSION
    digest = hashlib.sha256(
        f"{RUNTIME_PRODUCER_ID}\x00{version}".encode("utf-8")
    ).hexdigest()
    return {"id": RUNTIME_PRODUCER_ID, "version": version, "digest": digest}


def durable_project_base(project_directory: object, project_id: str) -> tuple[str, str]:
    """Read the durable (current_revision_id, sceneHash) evidence must bind.

    This is the same .cclay/project.json source the bridge dispatch consults
    for base checks (connection._durable_project_base): after any
    stage_scene/apply_camera_plan child commit the durable revision is a
    V3/V4 child revision, so binding the raw V2 substrate manifest would
    produce evidence the bridge rejects as stale.
    """
    from . import project_store

    if project_directory is None:
        raise EVIDENCE_PRODUCTION_FAILED(
            "producing directing evidence requires a durable project directory"
        )
    try:
        project = project_store.read_project_index(str(project_directory))
    except project_store.ProjectStoreError as error:
        raise EVIDENCE_PRODUCTION_FAILED(
            f"durable project index is unavailable: {error}"
        ) from error
    if project is None:
        raise EVIDENCE_PRODUCTION_FAILED(
            "no durable project exists in .cclay/project.json"
        )
    if project.get("project_id") != project_id:
        raise EVIDENCE_PRODUCTION_FAILED(
            "durable project index does not belong to the requested project"
        )
    try:
        revision_id = project["current_revision_id"]
        scene_hash = project["manifest"]["sceneHash"]
    except (KeyError, TypeError) as error:
        raise EVIDENCE_PRODUCTION_FAILED(
            f"durable project base is unavailable: {error}"
        ) from error
    for name, value in (("revision", revision_id), ("scene hash", scene_hash)):
        if not isinstance(value, str) or _HEX64.fullmatch(value) is None:
            raise EVIDENCE_PRODUCTION_FAILED(
                f"durable project {name} is invalid"
            )
    return revision_id, scene_hash


def blender_to_ardy(vector) -> list[float]:
    """Inverse of camera_plan._ardy_to_blender: Blender Z-up to ARDY Y-up."""
    x, y, z = (float(component) for component in vector)
    return [x, z, -y]


def analyze_subject_motion(
    samples: list[dict], frame_start: int, frame_end: int
) -> dict:
    """Pure DirectingAnalysisEvidenceV1 analysis over ARDY subject samples.

    ``samples`` must hold one sample per frame of ``frame_start..frame_end``
    with ``{"frame", "center", "height_m"}``. For a static scene every frame
    is a motion valley, there are no action peaks, and the action axis falls
    back to a horizontal ARDY X axis through the subject so it is never
    zero-length or parallel to up ``[0, 1, 0]``.
    """
    if [sample["frame"] for sample in samples] != list(
        range(frame_start, frame_end + 1)
    ):
        raise EVIDENCE_PRODUCTION_FAILED(
            "subject samples must cover every frame of the analyzed range"
        )
    centers = [
        [float(component) for component in sample["center"]] for sample in samples
    ]
    steps = [
        math.dist(centers[index - 1], centers[index])
        for index in range(1, len(centers))
    ]
    # Speed at a frame is the displacement into it; the first frame reuses the
    # first step so a uniformly moving subject has no artificial valley there.
    speeds = [steps[0] if steps else 0.0, *steps]

    peak_speed = max(speeds)
    # In a static/unanimated scene every frame is a motion valley; once real
    # motion exists a valley must also stay below the action-peak threshold so
    # peak-speed plateaus never count as valleys.
    threshold = (
        peak_speed * _PEAK_THRESHOLD_RATIO
        if peak_speed >= _MOTION_EPSILON
        else math.inf
    )
    motion_valley_frames = [
        samples[index]["frame"]
        for index in range(len(speeds))
        if speeds[index] < threshold
        and (index == 0 or speeds[index] <= speeds[index - 1] + _SPEED_EPSILON)
        and (
            index + 1 >= len(speeds)
            or speeds[index] <= speeds[index + 1] + _SPEED_EPSILON
        )
    ]

    action_peak_ranges: list[dict] = []
    if peak_speed >= _MOTION_EPSILON:
        for index in range(len(speeds)):
            if speeds[index] < threshold:
                continue
            frame = samples[index]["frame"]
            if (
                action_peak_ranges
                and action_peak_ranges[-1]["end"] == frame - 1
            ):
                action_peak_ranges[-1]["end"] = frame
            else:
                action_peak_ranges.append({"start": frame, "end": frame})

    displacement = [centers[-1][axis] - centers[0][axis] for axis in range(3)]
    if math.hypot(displacement[0], displacement[2]) >= _MOTION_EPSILON:
        axis_a = list(centers[0])
        axis_b = list(centers[-1])
    else:
        count = len(centers)
        axis_a = [
            sum(center[axis] for center in centers) / count for axis in range(3)
        ]
        axis_b = [axis_a[0] + 1.0, axis_a[1], axis_a[2]]

    return {
        "motion_valley_frames": motion_valley_frames,
        "action_peak_ranges": action_peak_ranges,
        "action_axis": {"a": axis_a, "b": axis_b, "up": [0.0, 1.0, 0.0]},
        "subject_samples": samples,
    }


def _runtime_user_directory() -> Path:
    configured = os.environ.get("XDG_RUNTIME_DIR")
    base = (
        Path(configured)
        if configured and Path(configured).is_absolute()
        else Path(tempfile.gettempdir())
    )
    getuid = getattr(os, "getuid", None)
    uid = getuid() if callable(getuid) else "user"
    return base / f"cclay-{uid}"


def _ensure_private_directory(directory: Path) -> None:
    try:
        directory.mkdir(mode=0o700)
    except FileExistsError:
        pass
    except OSError as error:
        raise EVIDENCE_PRODUCTION_FAILED(
            f"runtime evidence directory could not be created: {error}"
        ) from error
    try:
        metadata = directory.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise EVIDENCE_PRODUCTION_FAILED(
                "runtime evidence directory must be a nonsymlink directory"
            )
        getuid = getattr(os, "getuid", None)
        if callable(getuid) and metadata.st_uid != getuid():
            raise EVIDENCE_PRODUCTION_FAILED(
                "runtime evidence directory must be owned by the current user"
            )
        os.chmod(directory, 0o700)
    except OSError as error:
        raise EVIDENCE_PRODUCTION_FAILED(
            f"runtime evidence directory could not be secured: {error}"
        ) from error


def runtime_evidence_directory(project_id: str) -> Path:
    """Create and verify the private per-project runtime evidence directory."""
    if not isinstance(project_id, str) or _PROJECT_ID.fullmatch(project_id) is None:
        raise EVIDENCE_PRODUCTION_FAILED(
            "project_id must be a lowercase UUIDv4 string"
        )
    user_directory = _runtime_user_directory()
    _ensure_private_directory(user_directory)
    evidence_root = user_directory / "directing-evidence"
    _ensure_private_directory(evidence_root)
    project_directory = evidence_root / project_id
    _ensure_private_directory(project_directory)
    return project_directory


def _write_evidence_file(directory: Path, digest: str, payload: bytes) -> Path:
    destination = directory / f"{digest}.json"
    temporary = directory / f".{digest}.{uuid.uuid4()}.tmp"
    descriptor = -1
    try:
        descriptor = os.open(
            temporary,
            os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
        view = memoryview(payload)
        while view:
            view = view[os.write(descriptor, view) :]
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        os.chmod(temporary, 0o600)
        os.replace(temporary, destination)
    except OSError as error:
        raise EVIDENCE_PRODUCTION_FAILED(
            f"runtime evidence file could not be written: {error}"
        ) from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            temporary.unlink()
        except OSError:
            pass
    return destination


def _frame_range(scene, frame_start, frame_end) -> tuple[int, int]:
    start = scene.frame_start if frame_start is None else frame_start
    end = scene.frame_end if frame_end is None else frame_end
    for name, value in (("frame_start", start), ("frame_end", end)):
        if isinstance(value, bool) or not isinstance(value, int):
            raise EVIDENCE_PRODUCTION_FAILED(f"{name} must be an integer or null")
    if start < 0 or end < start:
        raise EVIDENCE_PRODUCTION_FAILED(
            "frame range must satisfy 0 <= start <= end"
        )
    if end - start + 1 > _MAX_FRAME_COUNT:
        raise EVIDENCE_PRODUCTION_FAILED(
            f"frame range exceeds {_MAX_FRAME_COUNT} analyzable frames"
        )
    return int(start), int(end)


def _world_bounds(evaluated) -> tuple[list[float], list[float]]:
    corners = [
        evaluated.matrix_world @ Vector(corner) for corner in evaluated.bound_box
    ]
    minimum = [min(corner[axis] for corner in corners) for axis in range(3)]
    maximum = [max(corner[axis] for corner in corners) for axis in range(3)]
    return minimum, maximum


def _select_subject(scene):
    """Prefer an CCLAY-owned armature (character rig), else the largest mesh."""
    armatures = [
        scene_object
        for scene_object in scene.objects
        if scene_object.type == "ARMATURE"
        and isinstance(scene_object.get("cclay.entity_id"), str)
    ]
    if armatures:
        return min(armatures, key=lambda scene_object: str(scene_object.name))
    meshes = [
        scene_object
        for scene_object in scene.objects
        if scene_object.type == "MESH"
    ]
    if not meshes:
        raise EVIDENCE_PRODUCTION_FAILED(
            "scene has no armature or mesh subject to analyze"
        )

    def bounding_volume(scene_object) -> float:
        minimum, maximum = _world_bounds(scene_object)
        return math.prod(maximum[axis] - minimum[axis] for axis in range(3))

    return max(
        meshes,
        key=lambda scene_object: (bounding_volume(scene_object), str(scene_object.name)),
    )


def _sample_subject(scene, subject, start: int, end: int) -> list[dict]:
    original_frame = int(scene.frame_current)
    samples = []
    try:
        for frame in range(start, end + 1):
            scene.frame_set(frame)
            depsgraph = bpy.context.evaluated_depsgraph_get()
            evaluated = subject.evaluated_get(depsgraph)
            minimum, maximum = _world_bounds(evaluated)
            center = [(minimum[axis] + maximum[axis]) / 2 for axis in range(3)]
            height = maximum[2] - minimum[2]
            if not all(math.isfinite(value) for value in (*center, height)):
                raise EVIDENCE_PRODUCTION_FAILED(
                    f"subject bounds are nonfinite at frame {frame}"
                )
            if height <= 0:
                raise EVIDENCE_PRODUCTION_FAILED(
                    f"subject has zero bounding height at frame {frame}"
                )
            samples.append({
                "frame": frame,
                "center": blender_to_ardy(center),
                "height_m": float(height),
            })
    finally:
        scene.frame_set(original_frame)
    return samples


def produce_directing_evidence(
    project_id: object,
    frame_start: object = None,
    frame_end: object = None,
    *,
    project_directory: object = None,
) -> dict:
    """Analyze the live scene and register one trusted evidence digest."""
    if bpy is None:
        raise EVIDENCE_PRODUCTION_FAILED(
            "producing directing evidence requires Blender"
        )
    directory = runtime_evidence_directory(project_id)
    scene = bpy.context.scene
    if scene.get("cclay.project_id") != project_id:
        raise EVIDENCE_PRODUCTION_FAILED(
            "project_id does not match the live scene project"
        )
    start, end = _frame_range(scene, frame_start, frame_end)

    revision_id, scene_hash = durable_project_base(project_directory, project_id)

    from .manifest import resolve_manifest_for_expected_hash

    try:
        live_manifest = resolve_manifest_for_expected_hash(scene_hash)
    except Exception as error:
        raise EVIDENCE_PRODUCTION_FAILED(
            f"scene manifest extraction failed: {error}"
        ) from error
    if live_manifest is None:
        raise EVIDENCE_PRODUCTION_FAILED(
            "live scene does not match the durable project base - the .blend "
            "was likely mutated outside a tracked stage_scene commit (direct "
            "script write, manual edit, or a headless bypass of the attached "
            "bridge process). Call inspect_project first: it self-heals by "
            "rebinding the durable base to the live scene, then retry "
            "produce_directing_evidence."
        )

    subject = _select_subject(scene)
    samples = _sample_subject(scene, subject, start, end)
    analysis = analyze_subject_motion(samples, start, end)
    producer = runtime_producer()
    evidence = {
        "schema_version": 1,
        "revision_id": revision_id,
        "scene_hash": scene_hash,
        "frame_range": {"start": start, "end": end},
        "producer": producer,
        "analysis": analysis,
    }
    try:
        parse_directing_analysis_evidence(evidence)
        payload = canonical_json(evidence).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise EVIDENCE_PRODUCTION_FAILED(
            f"produced evidence is not a canonical DirectingAnalysisEvidenceV1: {error}"
        ) from error

    digest = hashlib.sha256(payload).hexdigest()
    resource = _write_evidence_file(directory, digest, payload)
    register_runtime_evidence(
        digest,
        resource,
        directory,
        (producer["id"], producer["version"], producer["digest"]),
        revision_id,
        scene_hash,
    )
    return {
        "schema_version": 1,
        "evidence_sha256": digest,
        "revision_id": revision_id,
        "scene_hash": scene_hash,
        "frame_range": {"start": start, "end": end},
        "byte_length": len(payload),
    }
