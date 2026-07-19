"""Clause regressions for deterministic `render_qa_frames`."""

from __future__ import annotations

import base64
import hashlib
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from oh_my_blender import qa_render


REVISION = "1" * 64
SCENE_HASH = "2" * 64


def request(frames: list[int]) -> dict:
    return {"schema_version": 1, "revision_id": REVISION, "frames": frames}


class RenderQaFramesValidationTests(unittest.TestCase):
    def test_clause_frame_count_is_bounded_to_twelve(self):
        """Plan clause: "≤12 frames"."""
        with self.assertRaises(qa_render.RENDER_QA_FRAME_LIMIT_EXCEEDED):
            qa_render.validate_render_request(
                request(list(range(1, 14))),
                frame_start=1,
                frame_end=300,
            )

    def test_clause_frames_are_unique_sorted_and_in_range(self):
        """Task clause: "<=12 unique, in-range, deduped, sorted ascending"."""
        self.assertEqual(
            qa_render.validate_render_request(
                request([12, 3, 8, 3]),
                frame_start=1,
                frame_end=20,
            )["frames"],
            [3, 8, 12],
        )
        for frames in ([0], [21]):
            with self.subTest(frames=frames), self.assertRaises(
                qa_render.RENDER_QA_INVALID_REQUEST
            ):
                qa_render.validate_render_request(
                    request(frames),
                    frame_start=1,
                    frame_end=20,
                )

    def test_clause_request_is_closed_and_revision_is_required(self):
        """Task clause: "reject ... unknown-fields" and "requires the revision id"."""
        for request in (
            {"schema_version": 1, "frames": [1]},
            {"schema_version": 1, "revision_id": REVISION, "frames": [1], "path": "/tmp/out.png"},
        ):
            with self.subTest(request=request), self.assertRaises(
                qa_render.RENDER_QA_INVALID_REQUEST
            ):
                qa_render.validate_render_request(request, frame_start=1, frame_end=20)


class RenderQaFramesTransactionTests(unittest.TestCase):
    def test_clause_stale_revision_is_rejected_before_rendering_anything(self):
        """Task clause: "reject a stale revision ... before rendering anything"."""
        rendered = []
        with self.assertRaises(qa_render.RENDER_QA_STALE_REVISION):
            qa_render.render_qa_frames_transaction(
                request([1]),
                SCENE_HASH,
                live_scene_hash=lambda: "3" * 64,
                render_batch=lambda *_args, **_kwargs: rendered.append(True),
            )
        self.assertEqual(rendered, [])

    def test_clause_payload_metadata_binds_sha_length_profile_and_dimensions(self):
        """Task clause: "return the bound metadata" for 640x360 `omb-qa-png-v1`."""
        png = b"bounded-png"
        result = qa_render.render_qa_frames_transaction(
            request([8]),
            SCENE_HASH,
            live_scene_hash=lambda: SCENE_HASH,
            render_batch=lambda frames, **_kwargs: [(frames[0], png)],
        )
        self.assertEqual(result["revision_id"], REVISION)
        self.assertEqual(result["schema_version"], 1)
        self.assertEqual(result["profile_version"], "omb-qa-png-v1")
        self.assertEqual(result["frames"], [{
            "frame": 8,
            "width": 640,
            "height": 360,
            "profile_version": "omb-qa-png-v1",
            "byte_length": len(png),
            "sha256": hashlib.sha256(png).hexdigest(),
            "png_base64": base64.b64encode(png).decode("ascii"),
        }])

    def test_clause_frame_bytes_stream_as_bounded_existing_bridge_chunks(self):
        """Coordination clause: no unbounded image bytes appear directly in tool results."""
        png = b"0123456789"
        frame = {
            "frame": 8,
            "width": 640,
            "height": 360,
            "profile_version": "omb-qa-png-v1",
            "byte_length": len(png),
            "sha256": hashlib.sha256(png).hexdigest(),
            "png_base64": base64.b64encode(png).decode("ascii"),
        }
        with mock.patch.object(qa_render, "MAX_CHUNK_BYTES", 4):
            metadata, begin, chunks = qa_render.split_frame_for_bridge(frame)
        self.assertNotIn("png_base64", metadata)
        self.assertEqual(
            begin,
            {
                "frame": 8,
                "total_chunks": 3,
                "total_byte_length": len(png),
                "sha256": frame["sha256"],
            },
        )
        self.assertEqual([chunk["byte_offset"] for chunk in chunks], [0, 4, 8])
        self.assertEqual([chunk["chunk_index"] for chunk in chunks], [0, 1, 2])
        self.assertTrue(all(chunk["byte_length"] <= 4 for chunk in chunks))
        self.assertEqual(
            b"".join(base64.b64decode(chunk["data_base64"]) for chunk in chunks),
            png,
        )

    def test_clause_deadline_is_at_most_thirty_seconds(self):
        """Plan clause: "≤12 frames, ≤16MiB each/128MiB total/30s"."""
        with self.assertRaises(qa_render.RENDER_QA_DEADLINE_EXCEEDED):
            qa_render.render_qa_frames_transaction(
                request([1]),
                SCENE_HASH,
                live_scene_hash=lambda: SCENE_HASH,
                deadline=time.monotonic() - 0.001,
                render_batch=lambda *_args, **_kwargs: self.fail("rendered after deadline"),
            )

    def test_clause_cancelled_batch_leaves_no_partial_temp_files(self):
        """Task clause: "cancel/cleanup mid-batch ... leaving no ... temp files"."""
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory) / "frame.tmp"

            def cancelled_batch(_frames, *, cancelled, **_kwargs):
                temp.write_bytes(b"partial")
                try:
                    if cancelled():
                        raise qa_render.RENDER_QA_CANCELLED("render QA was cancelled")
                finally:
                    temp.unlink(missing_ok=True)

            with self.assertRaises(qa_render.RENDER_QA_CANCELLED):
                qa_render.render_qa_frames_transaction(
                    request([1, 2]),
                    SCENE_HASH,
                    live_scene_hash=lambda: SCENE_HASH,
                    cancelled=lambda: True,
                    render_batch=cancelled_batch,
                )
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_clause_per_frame_and_batch_byte_limits_are_enforced(self):
        """Plan clause: "≤16MiB each/128MiB total"."""
        with mock.patch.object(qa_render, "MAX_FRAME_BYTES", 4):
            with self.assertRaises(qa_render.RENDER_QA_FRAME_BYTES_EXCEEDED):
                qa_render.render_qa_frames_transaction(
                    request([1]),
                    SCENE_HASH,
                    live_scene_hash=lambda: SCENE_HASH,
                    render_batch=lambda *_args, **_kwargs: [(1, b"12345")],
                )
        with (
            mock.patch.object(qa_render, "MAX_FRAME_BYTES", 4),
            mock.patch.object(qa_render, "MAX_BATCH_BYTES", 6),
        ):
            with self.assertRaises(qa_render.RENDER_QA_BATCH_BYTES_EXCEEDED):
                qa_render.render_qa_frames_transaction(
                    request([1, 2]),
                    SCENE_HASH,
                    live_scene_hash=lambda: SCENE_HASH,
                    render_batch=lambda *_args, **_kwargs: [(1, b"1234"), (2, b"5678")],
                )


if __name__ == "__main__":
    unittest.main()
