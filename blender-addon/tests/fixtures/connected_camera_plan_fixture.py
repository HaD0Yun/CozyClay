"""Drive inspect -> apply_camera_plan -> inspect through the real v2 bridge."""

from __future__ import annotations

import copy
import json
import queue
import shutil
import sys
import tempfile
import time
import uuid
from pathlib import Path

import bpy

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import oh_my_blender
import oh_my_blender.camera_plan as camera_plan
import oh_my_blender.connection as connection_module
from apply_camera_plan_fixture import PROJECT_ID, REVISION, bound_plan, setup_scene
from oh_my_blender.canonical import canonical_revision
from oh_my_blender.connection import Connection, _resolve_daemon_argv
from oh_my_blender.manifest import extract_scene_manifest_v2, extract_scene_snapshot



def send_request(connection: Connection, method: str, params: dict, expected_revision_id: str) -> tuple[str, queue.Queue]:
    request_id = str(uuid.uuid4())
    responses = queue.Queue(maxsize=1)
    connection._response_queues[request_id] = responses
    connection._send_json({
        "type": "request",
        "id": request_id,
        "method": method,
        "params": params,
        "expected_revision_id": expected_revision_id,
        "deadline_ms": 30000,
    })
    return request_id, responses


def receive(connection: Connection, responses: queue.Queue, timeout: float = 20) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        connection.pump_bridge_messages()
        try:
            return responses.get_nowait()
        except queue.Empty:
            time.sleep(0.01)
    raise RuntimeError("daemon response timed out")


def main() -> None:
    setup_scene()
    base_manifest = extract_scene_manifest_v2()
    if base_manifest["revisionId"] != REVISION:
        raise RuntimeError("connected fixture revision drifted")

    directory = Path(tempfile.mkdtemp(prefix="omb-connected-camera-"))
    connection = None
    original_load = camera_plan.load_authorized_fixture
    original_smooth = camera_plan.validate_smooth_fcurves
    evidence_mutator = [None]
    smooth_error = [None]

    def load_evidence(plan, scene_hash):
        evidence = original_load(plan, scene_hash)
        if evidence_mutator[0] is not None:
            evidence = copy.deepcopy(evidence)
            evidence_mutator[0](evidence)
        return evidence

    def validate_smooth(*args):
        if smooth_error[0] is not None:
            raise smooth_error[0]("connected smooth fault")
        return original_smooth(*args)

    camera_plan.load_authorized_fixture = load_evidence
    camera_plan.validate_smooth_fcurves = validate_smooth
    try:
        omb = directory / ".omb"
        omb.mkdir()
        (omb / "project.json").write_text(json.dumps({
            "schema_version": 1,
            "project_id": PROJECT_ID,
            "current_revision_id": REVISION,
            "manifest": base_manifest,
        }), encoding="utf-8")

        oh_my_blender.register()
        connection = Connection.start(
            _resolve_daemon_argv(("--faux",)),
            cwd=directory,
            project_id=PROJECT_ID,
            addon_version="0.1.0",
            blender_version=bpy.app.version_string,
        )
        connection_module._active_connection = connection

        before_snapshot = extract_scene_snapshot()
        before_revision = canonical_revision(before_snapshot)
        _before_id, before_responses = send_request(
            connection,
            "inspect_project",
            {"snapshot": before_snapshot},
            before_revision,
        )
        before = receive(connection, before_responses)
        if before.get("type") != "response":
            raise RuntimeError(f"initial inspect failed: {before}")

        base_plan = bound_plan()
        cases = []

        def add(code, mutate_plan=None, mutate_evidence=None, smooth=None):
            cases.append((code, mutate_plan, mutate_evidence, smooth))

        add("PLAN_FRAME_OUT_OF_EVIDENCE_RANGE", lambda p: p["keyframes"][-1].update(frame=320))
        add("EVIDENCE_SUBJECT_SAMPLE_MISSING", mutate_evidence=lambda e: e["analysis"]["subject_samples"].pop(1))
        add("EVIDENCE_ACTION_AXIS_ZERO_LENGTH", mutate_evidence=lambda e: e["analysis"]["action_axis"].update(b=[-1, 0, 0]))
        add("EVIDENCE_ACTION_AXIS_PARALLEL_TO_UP", mutate_evidence=lambda e: e["analysis"]["action_axis"].update(b=[-1, 0, 20]))
        add("PLAN_FRAME_NOT_INTEGER", lambda p: p["keyframes"][0].update(frame=0.5))
        add("PLAN_MINIMUM_TWO_KEYFRAMES", lambda p: p.update(keyframes=p["keyframes"][:1]))
        add("PLAN_FRAME_ORDER_INVALID", lambda p: p["keyframes"][1].update(frame=0))

        def row18_plan(plan):
            plan["keyframes"][0].update(frame=1, transition="cut")

        def row18_evidence(evidence):
            evidence["analysis"]["motion_valley_frames"].insert(0, 1)
            evidence["analysis"]["subject_samples"].insert(1, {"frame": 1, "center": [0, 0, 0.9], "height_m": 1.8})

        add("PLAN_FIRST_TRANSITION_NOT_SMOOTH", row18_plan, row18_evidence)
        add("UNSUPPORTED_PLAN_UP", lambda p: p["keyframes"][0]["pose"].update(up=[0, 1, 1e-8]))
        add("PLAN_ZERO_VIEW_DISTANCE", lambda p: p["keyframes"][0]["pose"].update(position=p["keyframes"][0]["pose"]["look_at"][:]))
        add("PLAN_POSE_COLLINEAR_UP", lambda p: p["keyframes"][0]["pose"].update(position=[0, 50, 0], look_at=[0, 0, 0]))
        add("SMOOTH_HANDLE_TYPE_INVALID", smooth=camera_plan.SMOOTH_HANDLE_TYPE_INVALID)
        add("SMOOTH_HANDLE_TOLERANCE_EXCEEDED", smooth=camera_plan.SMOOTH_HANDLE_TOLERANCE_EXCEEDED)
        add("SMOOTH_VALUE_NOT_FINITE", smooth=camera_plan.SMOOTH_VALUE_NOT_FINITE)
        add("SMOOTH_HANDLE_OUT_OF_RANGE", smooth=camera_plan.SMOOTH_HANDLE_OUT_OF_RANGE)
        add("SMOOTH_TANGENT_SIGN_INVALID", smooth=camera_plan.SMOOTH_TANGENT_SIGN_INVALID)
        add("FRAMING_BAND_VIOLATION", lambda p: p["keyframes"][0]["pose"].update(vertical_fov_radians=0.6))
        add("CUT_NOT_AT_MOTION_VALLEY", mutate_evidence=lambda e: e["analysis"].update(motion_valley_frames=[]))
        add("CUT_SPLITS_ACTION_PEAK", mutate_evidence=lambda e: e["analysis"].update(action_peak_ranges=[{"start": 79, "end": 79}]))
        add("CUT_SCALE_UNDEFINED", mutate_evidence=lambda e: e["analysis"]["subject_samples"][1].update(height_m=5e-324))
        add("CUT_SCALE_DISCONTINUITY", mutate_evidence=lambda e: e["analysis"]["subject_samples"][2].update(height_m=4))
        add("CAMERA_ON_ACTION_AXIS", lambda p: p["keyframes"][0]["pose"].update(position=[0, 2.15, 0], look_at=[0, 0.9, 5]))
        add("ACTION_AXIS_CROSSING", lambda p: p["keyframes"][-1]["pose"].update(position=[-0.3, 2.2, -7.2]))

        codes = []
        for expected_code, mutate_plan, mutate_evidence, injected_smooth in cases:
            time.sleep(1.01)
            plan = copy.deepcopy(base_plan)
            if mutate_plan is not None:
                mutate_plan(plan)
            evidence_mutator[0] = mutate_evidence
            smooth_error[0] = injected_smooth
            _request_id, responses = send_request(
                connection,
                "apply_camera_plan",
                plan,
                REVISION,
            )
            response = receive(connection, responses)
            codes.append(response.get("code"))
            if response.get("code") != expected_code:
                raise RuntimeError(f"expected {expected_code}, received {response}")
            evidence_mutator[0] = None
            smooth_error[0] = None

        time.sleep(1.01)

        valid_request_id = str(uuid.uuid4())
        connection._send_json({
            "type": "request",
            "id": valid_request_id,
            "method": "apply_camera_plan",
            "params": base_plan,
            "expected_revision_id": REVISION,
            "deadline_ms": 30000,
        })
        deadline = time.monotonic() + 30
        while connection.last_bridge_response is None and time.monotonic() < deadline:
            connection.pump_bridge_messages()
            time.sleep(0.01)
        if connection.last_bridge_response is None:
            raise RuntimeError("connected apply timed out")

        time.sleep(1.01)
        connection.disconnect("restart_for_final_inspect")
        connection_module._active_connection = None
        connection = Connection.start(
            _resolve_daemon_argv(("--faux",)),
            cwd=directory,
            project_id=PROJECT_ID,
            addon_version="0.1.0",
            blender_version=bpy.app.version_string,
        )
        connection_module._active_connection = connection

        after_snapshot = extract_scene_snapshot()
        after_revision = canonical_revision(after_snapshot)
        _after_id, after_responses = send_request(
            connection,
            "inspect_project",
            {"snapshot": after_snapshot},
            after_revision,
        )
        after = receive(connection, after_responses)
        if after.get("type") != "response":
            raise RuntimeError(f"final inspect failed: {after}")

        project = json.loads((omb / "project.json").read_text(encoding="utf-8"))
        live_manifest = extract_scene_manifest_v2()
        print("OMB_CONNECTED_CAMERA_RESULTS=" + json.dumps({
            "before": before["type"],
            "after": after["type"],
            "codes": codes,
            "cuts": sorted(marker.frame for marker in bpy.context.scene.timeline_markers if marker.name.startswith("CUT_")),
            "durableRevision": project["current_revision_id"],
            "liveRevision": live_manifest["revisionId"],
        }, separators=(",", ":")))
    finally:
        camera_plan.load_authorized_fixture = original_load
        camera_plan.validate_smooth_fcurves = original_smooth
        if connection is not None:
            try:
                connection.disconnect("fixture_complete")
            except BaseException:
                connection.child.kill()
        connection_module._active_connection = None
        oh_my_blender.unregister()
        shutil.rmtree(directory, ignore_errors=True)


main()
