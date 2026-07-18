"""Exercise the pinned QA profile and full checkpoint restoration in real Blender."""

from __future__ import annotations

import base64
import json
import sys
import tempfile
from pathlib import Path

import bpy

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from apply_camera_plan_fixture import SCENE_HASH, bound_plan, setup_scene
from oh_my_blender.camera_plan import apply_camera_plan_transaction
from oh_my_blender.manifest import extract_scene_manifest_v2
from oh_my_blender.qa_render import _scope_state, render_qa_frames_transaction


class Connection:
    def __init__(self):
        self.active_checkpoint = None

    def hold_checkpoint(self, checkpoint):
        self.active_checkpoint = checkpoint

    def release_checkpoint(self):
        checkpoint = self.active_checkpoint
        self.active_checkpoint = None
        return checkpoint


def main() -> None:
    setup_scene()
    apply_camera_plan_transaction(
        bound_plan(),
        SCENE_HASH,
        Connection(),
        lambda _result: None,
    )
    before_manifest = extract_scene_manifest_v2()
    before_scope = _scope_state(bpy.context.scene)
    result = render_qa_frames_transaction(
        {
            "schema_version": 1,
            "revision_id": before_manifest["revisionId"],
            "frames": [80],
        },
        before_manifest["sceneHash"],
    )
    frame = result["frames"][0]
    png = base64.b64decode(frame["png_base64"], validate=True)
    with tempfile.TemporaryDirectory(prefix="omb-qa-verify-") as directory:
        path = Path(directory) / "frame.png"
        path.write_bytes(png)
        image = bpy.data.images.load(str(path), check_existing=False)
        dimensions = list(image.size)
        bpy.data.images.remove(image)
    after_manifest = extract_scene_manifest_v2()
    output = {
        "dimensions": dimensions,
        "profile": result["profile_version"],
        "scopeRestored": _scope_state(bpy.context.scene) == before_scope,
        "sceneHashRestored": after_manifest["sceneHash"] == before_manifest["sceneHash"],
        "revisionRestored": after_manifest["revisionId"] == before_manifest["revisionId"],
        "temporaryWorlds": [world.name for world in bpy.data.worlds if world.name.startswith("OMB QA World")],
        "pngSignature": list(png[:8]),
    }
    print("OMB_QA_RENDER_RESULTS=" + json.dumps(output, separators=(",", ":")))


if __name__ == "__main__":
    main()
