"""Rebind the approved boxing directing evidence to the canonical Blender fixture."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
import traceback

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon/tests/fixtures"))

# The camera-free G010 substrate is the canonical directing-evidence binding scene.
from apply_camera_plan_fixture import setup_scene
from cclay.canonical import canonical_json
from cclay.manifest import extract_scene_manifest_v2

DEFAULT_EVIDENCE = (
    REPOSITORY_ROOT
    / "blender-addon/cclay/fixtures/boxing-v4-directing-evidence.json"
)


def _arguments() -> argparse.Namespace:
    blender_arguments = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", type=Path, default=DEFAULT_EVIDENCE)
    return parser.parse_args(blender_arguments)


def main() -> None:
    arguments = _arguments()
    setup_scene()
    scene_manifest = extract_scene_manifest_v2()
    evidence = json.loads(arguments.evidence.read_text(encoding="utf-8"))
    evidence["revision_id"] = scene_manifest["revisionId"]
    evidence["scene_hash"] = scene_manifest["sceneHash"]
    evidence_bytes = canonical_json(evidence).encode("utf-8")
    arguments.evidence.write_bytes(evidence_bytes)
    print(f"CCLAY_EVIDENCE_SHA256={hashlib.sha256(evidence_bytes).hexdigest()}")


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        traceback.print_exc()
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(1)
