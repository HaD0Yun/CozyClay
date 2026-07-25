"""Exercise runtime directing-evidence production and trust inside real Blender."""

from __future__ import annotations

import json
import math
import os
import stat
import sys
import tempfile
import traceback
from pathlib import Path

import bpy

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon/tests/fixtures"))

# Keep the runtime evidence directory hermetic for this Blender process.
os.environ["XDG_RUNTIME_DIR"] = tempfile.mkdtemp(prefix="cclay-evidence-test-")

from apply_camera_plan_fixture import PROJECT_ID, Connection, setup_scene
from cclay import fixture_registry, project_store
from cclay.camera_plan import apply_camera_plan_transaction
from cclay.directing_evidence import (
    produce_directing_evidence,
    runtime_producer,
)
from cclay.fixture_registry import load_authorized_fixture
from cclay.manifest import animation_fcurves, extract_scene_manifest_v2
from cclay.stage_scene import apply_stage_scene_transaction

FOV = 2 * math.atan(12 / 48)
SHA256_HEX = set("0123456789abcdef")
# The durable project index directory: produce_directing_evidence binds the
# current_revision_id + manifest sceneHash stored here, never the raw V2
# substrate manifest.
PROJECT_DIR = Path(tempfile.mkdtemp(prefix="cclay-evidence-project-"))
STAGED_CUBE_ID = "88888888-8888-4888-8888-888888888888"


def code(error: BaseException) -> str:
    return str(getattr(error, "code", type(error).__name__))


def is_hash(value: object) -> bool:
    return isinstance(value, str) and len(value) == 64 and set(value) <= SHA256_HEX


def smooth_plan(revision_id: str, digest: str) -> dict:
    def pose(position: list[float]) -> dict:
        return {
            "position": position,
            "look_at": [3.0, 5.0, -4.0],
            "up": [0.0, 1.0, 0.0],
            "vertical_fov_radians": FOV,
        }

    return {
        "schema_version": 1,
        "expected_revision_id": revision_id,
        "evidence_sha256": digest,
        "output_format": {"width": 640, "height": 360},
        "keyframes": [
            {"frame": 0, "pose": pose([0.0, 2.0, 10.0]), "transition": "smooth"},
            {"frame": 80, "pose": pose([2.0, 2.0, 9.0]), "transition": "smooth"},
        ],
    }


def registered_path(digest: str) -> Path:
    return fixture_registry._RUNTIME_EVIDENCE_REGISTRY[digest][0]


def expect_code(callable_value) -> str:
    try:
        callable_value()
    except BaseException as error:
        return code(error)
    raise AssertionError("expected an evidence trust failure")


def cross(a: list[float], b: list[float]) -> list[float]:
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]


class StageConnection:
    """Minimal stage_scene connection contract (checkpoint + recovery hooks)."""

    def __init__(self):
        self.active_checkpoint = None
        self.recovery = None

    def hold_checkpoint(self, checkpoint, recovery_fn=None):
        if self.active_checkpoint is not None:
            raise RuntimeError("checkpoint already held")
        self.active_checkpoint = checkpoint
        self.recovery = recovery_fn

    def release_checkpoint(self):
        checkpoint = self.active_checkpoint
        self.active_checkpoint = None
        self.recovery = None
        return checkpoint

    def ensure_mutation_connection(self, _phase):
        return None

    def require_recovery(self):
        raise AssertionError("fixture stage_scene must not require recovery")


def write_durable_index(manifest: dict) -> None:
    project_store.write_project_index(
        str(PROJECT_DIR),
        PROJECT_ID,
        {
            "schema_version": 1,
            "current_revision_id": manifest["revisionId"],
            "manifest": manifest,
        },
    )


def bind_durable_project() -> dict:
    """Persist the live V2 manifest as the durable project base (fresh path)."""
    manifest = extract_scene_manifest_v2()
    write_durable_index(manifest)
    return manifest


def produce(*arguments) -> dict:
    return produce_directing_evidence(*arguments, project_directory=PROJECT_DIR)


def main() -> None:
    results = {}

    # 1. Produce evidence from the static G010 substrate scene (fresh V2
    #    project: the durable current revision IS the V2 substrate revision).
    setup_scene()
    manifest_before = bind_durable_project()
    produced = produce(PROJECT_ID)
    results["resultShape"] = (
        produced["schema_version"] == 1
        and is_hash(produced["evidence_sha256"])
        and produced["revision_id"] == manifest_before["revisionId"]
        and produced["scene_hash"] == manifest_before["sceneHash"]
        and produced["frame_range"] == {"start": 0, "end": 319}
        and produced["byte_length"] > 0
        and set(produced) == {
            "schema_version",
            "evidence_sha256",
            "revision_id",
            "scene_hash",
            "frame_range",
            "byte_length",
        }
    )

    # 2. The written document is a private, canonical, non-degenerate analysis.
    evidence_path = registered_path(produced["evidence_sha256"])
    file_mode = stat.S_IMODE(evidence_path.lstat().st_mode)
    directory_mode = stat.S_IMODE(evidence_path.parent.lstat().st_mode)
    results["privateFiles"] = file_mode == 0o600 and directory_mode == 0o700
    document = json.loads(evidence_path.read_text(encoding="utf-8"))
    results["byteLength"] = (
        evidence_path.stat().st_size == produced["byte_length"]
    )
    analysis = document["analysis"]
    axis = analysis["action_axis"]
    axis_vector = [axis["b"][index] - axis["a"][index] for index in range(3)]
    axis_cross_up = cross(axis_vector, axis["up"])
    results["staticAxisValid"] = (
        axis["up"] == [0.0, 1.0, 0.0]
        and math.hypot(*axis_vector) >= 1e-9
        and math.hypot(*axis_cross_up) >= 1e-9
    )
    samples = analysis["subject_samples"]
    results["staticAnalysis"] = (
        analysis["motion_valley_frames"] == list(range(0, 320))
        and analysis["action_peak_ranges"] == []
        and [sample["frame"] for sample in samples] == list(range(0, 320))
        and all(
            math.dist(sample["center"], [3.0, 5.0, -4.0]) <= 1e-6
            and abs(sample["height_m"] - 2.0) <= 1e-6
            for sample in samples
        )
        and document["producer"] == runtime_producer()
    )

    # 3. apply_camera_plan accepts the runtime digest and keyframes the camera.
    plan = smooth_plan(produced["revision_id"], produced["evidence_sha256"])
    apply_camera_plan_transaction(
        plan, produced["scene_hash"], Connection(), lambda _result: None
    )
    camera = bpy.data.objects.get("CCLAY Camera")
    keyed_frames = sorted({
        int(round(float(point.co.x)))
        for animation_data in (camera.animation_data, camera.data.animation_data)
        for fcurve in animation_fcurves(animation_data)
        for point in fcurve.keyframe_points
    })
    results["applySucceeded"] = (
        camera is not None
        and bpy.context.scene.camera is camera
        and keyed_frames == [0, 80]
    )

    # 4. Unknown digests remain untrusted.
    results["unknownDigest"] = expect_code(
        lambda: load_authorized_fixture(
            smooth_plan(produced["revision_id"], "0" * 64),
            produced["scene_hash"],
        )
    )

    # 5. Mutating the scene after production invalidates the evidence binding.
    setup_scene()
    bind_durable_project()
    stale = produce(PROJECT_ID)
    bpy.data.objects["Untouched Subject"].location.x += 1.0
    bpy.context.view_layer.update()
    mutated_manifest = extract_scene_manifest_v2()
    results["sceneMutated"] = mutated_manifest["sceneHash"] != stale["scene_hash"]
    results["sceneHashMismatch"] = expect_code(
        lambda: load_authorized_fixture(
            smooth_plan(stale["revision_id"], stale["evidence_sha256"]),
            mutated_manifest["sceneHash"],
        )
    )

    # 6. Tampering the runtime evidence file bytes breaks digest equality.
    setup_scene()
    bind_durable_project()
    tampered = produce(PROJECT_ID)
    tampered_path = registered_path(tampered["evidence_sha256"])
    tampered_path.write_bytes(tampered_path.read_bytes() + b" ")
    results["tamperedBytes"] = expect_code(
        lambda: load_authorized_fixture(
            smooth_plan(tampered["revision_id"], tampered["evidence_sha256"]),
            tampered["scene_hash"],
        )
    )

    # 7. A wrong project id never produces or registers evidence.
    setup_scene()
    results["projectMismatch"] = expect_code(
        lambda: produce("11111111-2222-4333-8444-555555555555")
    )

    # 7b. Without a durable project the production fails closed.
    results["missingDurableProject"] = expect_code(
        lambda: produce_directing_evidence(PROJECT_ID)
    )

    # 8. An animated subject yields a displacement axis and action peaks.
    setup_scene()
    subject = bpy.data.objects["Untouched Subject"]
    subject.keyframe_insert(data_path="location", frame=0)
    subject.location.x += 6.0
    subject.keyframe_insert(data_path="location", frame=40)
    bpy.context.view_layer.update()
    bind_durable_project()
    animated = produce(PROJECT_ID, 0, 60)
    animated_document = json.loads(
        registered_path(animated["evidence_sha256"]).read_text(encoding="utf-8")
    )
    animated_analysis = animated_document["analysis"]
    animated_axis = animated_analysis["action_axis"]
    results["animatedAnalysis"] = (
        animated["frame_range"] == {"start": 0, "end": 60}
        and len(animated_analysis["action_peak_ranges"]) > 0
        and abs(
            (animated_axis["b"][0] - animated_axis["a"][0]) - 6.0
        ) <= 1e-3
        and len(animated_analysis["motion_valley_frames"]) > 0
        and max(animated_analysis["motion_valley_frames"]) <= 60
    )

    # 9. After a stage_scene child commit the evidence binds the durable child
    #    revision (not the raw V2 substrate) and authorizes apply_camera_plan.
    setup_scene()
    base = bind_durable_project()
    staged = apply_stage_scene_transaction(
        {
            "schema_version": 1,
            "expected_revision_id": base["revisionId"],
            "operations": [{
                "op": "add_primitive",
                "entity_id": STAGED_CUBE_ID,
                "primitive_type": "CUBE",
                "name": "Staged Witness Cube",
                "location": [8.0, 8.0, 0.0],
                "rotation": [0.0, 0.0, 0.0],
                "scale": [0.2, 0.2, 0.2],
            }],
        },
        base["sceneHash"],
        StageConnection(),
        lambda candidate: write_durable_index(candidate["manifest"]),
    )
    child = produce(PROJECT_ID)
    results["childCommitBindsDurable"] = (
        child["revision_id"] == staged["manifest"]["revisionId"]
        and child["revision_id"] != extract_scene_manifest_v2()["revisionId"]
        and child["scene_hash"] == staged["scene_hash"]
        and child["scene_hash"] != base["sceneHash"]
    )
    child_plan = smooth_plan(child["revision_id"], child["evidence_sha256"])
    apply_camera_plan_transaction(
        child_plan, child["scene_hash"], Connection(), lambda _result: None
    )
    child_camera = bpy.data.objects.get("CCLAY Camera")
    child_keyed_frames = sorted({
        int(round(float(point.co.x)))
        for animation_data in (
            child_camera.animation_data,
            child_camera.data.animation_data,
        )
        for fcurve in animation_fcurves(animation_data)
        for point in fcurve.keyframe_points
    })
    results["childCommitApplySucceeded"] = (
        child_camera is not None
        and bpy.context.scene.camera is child_camera
        and child_keyed_frames == [0, 80]
    )

    print(
        "CCLAY_DIRECTING_EVIDENCE_RESULTS="
        + json.dumps(results, separators=(",", ":"), sort_keys=True)
    )


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        traceback.print_exc()
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(1)
