"""Clause regressions for deterministic `render_qa_frames`."""

from __future__ import annotations

import base64
import hashlib
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from cclay import qa_render


REVISION = "1" * 64
SCENE_HASH = "2" * 64


def request(frames: list[int]) -> dict:
    return {"schema_version": 1, "revision_id": REVISION, "frames": frames}


def _frame_result(png: bytes, *, frame: int = 8) -> dict:
    return {
        "frame": frame,
        "width": 640,
        "height": 360,
        "profile_version": "cclay-qa-png-v1",
        "byte_length": len(png),
        "sha256": hashlib.sha256(png).hexdigest(),
        "png_base64": base64.b64encode(png).decode("ascii"),
    }


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
                live_scene_hash=lambda _expected: "3" * 64,
                render_batch=lambda *_args, **_kwargs: rendered.append(True),
            )
        self.assertEqual(rendered, [])

    def test_clause_payload_metadata_binds_sha_length_profile_and_dimensions(self):
        """Task clause: "return the bound metadata" for 640x360 `cclay-qa-png-v1`."""
        png = b"bounded-png"
        result = qa_render.render_qa_frames_transaction(
            request([8]),
            SCENE_HASH,
            live_scene_hash=lambda _expected: SCENE_HASH,
            render_batch=lambda frames, **_kwargs: [(frames[0], png)],
        )
        self.assertEqual(result["revision_id"], REVISION)
        self.assertEqual(result["schema_version"], 1)
        self.assertEqual(result["profile_version"], "cclay-qa-png-v1")
        self.assertEqual(result["frames"], [{
            "frame": 8,
            "width": 640,
            "height": 360,
            "profile_version": "cclay-qa-png-v1",
            "byte_length": len(png),
            "sha256": hashlib.sha256(png).hexdigest(),
            "png_base64": base64.b64encode(png).decode("ascii"),
        }])

    def test_transaction_reports_real_render_phases(self):
        phases = []
        qa_render.render_qa_frames_transaction(
            request([8, 9]),
            SCENE_HASH,
            live_scene_hash=lambda _expected: SCENE_HASH,
            render_batch=lambda frames, **_kwargs: [
                (frame, f"png-{frame}".encode()) for frame in frames
            ],
            progress=lambda phase, completed, total: phases.append(
                (phase, completed, total)
            ),
        )

        self.assertEqual(phases, [
            ("validating", 0, 2),
            ("rendering", 0, 2),
            ("rendered", 2, 2),
        ])

    def test_clause_frame_bytes_stream_as_artifacts_without_restating_the_png(self):
        """QA bytes stream as G011 artifacts; the result carries no second PNG copy."""
        png = b"0123456789"
        encoded = base64.b64encode(png).decode("ascii")
        frame = {
            "frame": 8,
            "width": 640,
            "height": 360,
            "profile_version": "cclay-qa-png-v1",
            "byte_length": len(png),
            "sha256": hashlib.sha256(png).hexdigest(),
            "png_base64": encoded,
        }
        with mock.patch.object(qa_render, "MAX_CHUNK_BYTES", 4):
            metadata, begin, chunks = qa_render.split_frame_for_bridge(frame)
        self.assertNotIn("png_base64", metadata)
        self.assertNotIn("image", metadata)
        self.assertEqual(metadata["thumbnail"]["mime_type"], "image/jpeg")
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
                live_scene_hash=lambda _expected: SCENE_HASH,
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
                    live_scene_hash=lambda _expected: SCENE_HASH,
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
                    live_scene_hash=lambda _expected: SCENE_HASH,
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
                    live_scene_hash=lambda _expected: SCENE_HASH,
                    render_batch=lambda *_args, **_kwargs: [(1, b"1234"), (2, b"5678")],
                )

    def test_clause_model_image_content_has_a_distinct_size_error(self):
        """Thumbnail evidence is capped independently from the G011 artifact lane."""
        with mock.patch.object(qa_render, "MAX_IMAGE_FRAME_BYTES", 4):
            with self.assertRaises(qa_render.RENDER_QA_IMAGE_CONTENT_LIMIT):
                qa_render.split_frame_for_bridge(_frame_result(b"12345"))

    def test_clause_result_message_must_fit_the_bridge_wire_budget(self):
        """Regression: restating every PNG severed the bounded 1 MiB link."""
        metadata, _begin, _chunks = qa_render.split_frame_for_bridge(_frame_result(b"12345"))
        message = {
            "schema_version": 1,
            "revision_id": REVISION,
            "profile_version": "cclay-qa-png-v1",
            "frames": [metadata],
        }
        qa_render.ensure_bridge_result_fits(message)

        with mock.patch.object(qa_render, "MAX_RESULT_MESSAGE_BYTES", 16):
            with self.assertRaises(qa_render.RENDER_QA_IMAGE_CONTENT_LIMIT):
                qa_render.ensure_bridge_result_fits(message)

        with mock.patch.object(qa_render, "MAX_IMAGE_BATCH_BYTES", 1):
            with self.assertRaises(qa_render.RENDER_QA_IMAGE_CONTENT_LIMIT):
                qa_render.ensure_bridge_result_fits(message)

    def test_clause_thumbnail_fallback_never_passes_a_full_render_through(self):
        """Regression: the imbuf fallback must not restore the oversize payload."""
        with mock.patch.object(qa_render, "imbuf", None):
            self.assertEqual(
                base64.b64decode(qa_render._encode_thumbnail(b"tiny"), validate=True),
                b"tiny",
            )
            with mock.patch.object(qa_render, "MAX_IMAGE_FRAME_BYTES", 4):
                with self.assertRaises(qa_render.RENDER_QA_IMAGE_CONTENT_LIMIT):
                    qa_render._encode_thumbnail(b"far-too-large")

    def test_clause_full_batch_of_max_frames_fits_one_websocket_message(self):
        """A 12-frame batch must never be able to overflow one bridge message."""
        png = bytes(range(256)) * 1024
        # A real 640x360 JPEG thumbnail is a few KB; imbuf is absent off-Blender,
        # so stand in a generous one rather than the untouched render.
        thumbnail = base64.b64encode(b"j" * 32 * 1024).decode("ascii")
        with mock.patch.object(qa_render, "_encode_thumbnail", lambda _png: thumbnail):
            prepared = [
                qa_render.split_frame_for_bridge(_frame_result(png, frame=frame))
                for frame in range(1, qa_render.MAX_FRAMES + 1)
            ]
        qa_render.ensure_bridge_result_fits({
            "schema_version": 1,
            "revision_id": REVISION,
            "profile_version": "cclay-qa-png-v1",
            "frames": [metadata for metadata, _begin, _chunks in prepared],
        })


if __name__ == "__main__":
    unittest.main()
