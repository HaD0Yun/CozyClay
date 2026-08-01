"""Exercise the pinned QA profile and full checkpoint restoration in real Blender."""

from __future__ import annotations

import base64
import hashlib
import json
import sys
import tempfile
from pathlib import Path

import bpy

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from apply_camera_plan_fixture import SCENE_HASH, bound_plan, setup_scene
from cclay.camera_plan import apply_camera_plan_transaction
from cclay.manifest import extract_scene_manifest_v4
from cclay.qa_render import _scope_state, render_qa_frames_transaction, split_frame_for_bridge


class Connection:
    def __init__(self):
        self.active_checkpoint = None
    def ensure_mutation_connection(self, _phase):
        return None

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
    bpy.context.scene.render.film_transparent = True
    before_manifest = extract_scene_manifest_v4()
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
    metadata, begin, chunks = split_frame_for_bridge(frame)
    # The PNG now crosses the bridge only as artifact chunks, so verify the
    # reassembled stream rather than a restated copy inside the metadata.
    streamed_png = b"".join(
        base64.b64decode(chunk["data_base64"], validate=True) for chunk in chunks
    )
    with tempfile.TemporaryDirectory(prefix="cclay-qa-verify-") as directory:
        path = Path(directory) / "frame.png"
        path.write_bytes(png)
        image = bpy.data.images.load(str(path), check_existing=False)
        dimensions = list(image.size)
        opaque_background = all(
            image.pixels[index] == 1.0
            for index in range(3, len(image.pixels), 4)
        )
        bpy.data.images.remove(image)
    after_manifest = extract_scene_manifest_v4()
    output = {
        "dimensions": dimensions,
        "profile": result["profile_version"],
        "thumbnailMimeType": metadata["thumbnail"]["mime_type"],
        "restatesPng": "image" in metadata,
        "streamedChunks": len(chunks),
        "declaredChunks": begin["total_chunks"],
        "decodedByteLength": len(streamed_png),
        "declaredByteLength": metadata["byte_length"],
        "payloadDigest": hashlib.sha256(streamed_png).hexdigest(),
        "declaredDigest": metadata["sha256"],
        "opaqueBackground": opaque_background,
        "scopeRestored": _scope_state(bpy.context.scene) == before_scope,
        "sceneHashRestored": after_manifest["sceneHash"] == before_manifest["sceneHash"],
        "revisionRestored": after_manifest["revisionId"] == before_manifest["revisionId"],
        "temporaryWorlds": [world.name for world in bpy.data.worlds if world.name.startswith("CCLAY QA World")],
        "pngSignature": list(png[:8]),
    }
    print("CCLAY_QA_RENDER_RESULTS=" + json.dumps(output, separators=(",", ":")))


if __name__ == "__main__":
    main()
