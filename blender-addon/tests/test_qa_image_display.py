"""Digest-bound QA artifact loading for Blender Image Editor spaces."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import tempfile
import types
import unittest

from cclay.qa_image_display import (
    QaImageDisplayError,
    cleanup_qa_images,
    display_latest_qa_artifact,
    display_qa_artifact,
)


PNG = b"\x89PNG\r\n\x1a\n" + b"fixture-png"


class _Images:
    def __init__(self) -> None:
        self.loaded: list[tuple[str, bool]] = []
        self.removed: list[object] = []

    def load(self, path: str, *, check_existing: bool):
        self.loaded.append((path, check_existing))
        return types.SimpleNamespace(name="payload", pack=lambda: None)

    def remove(self, image: object, *, do_unlink: bool) -> None:
        self.removed.append(image)

class _NoPackImages(_Images):
    def load(self, path: str, *, check_existing: bool):
        self.loaded.append((path, check_existing))
        return types.SimpleNamespace(name="payload")


class _FlakyImages(_Images):
    def __init__(self) -> None:
        super().__init__()
        self.remove_attempts = 0

    def remove(self, image: object, *, do_unlink: bool) -> None:
        self.remove_attempts += 1
        if self.remove_attempts == 1:
            raise RuntimeError("datablock is still busy")
        super().remove(image, do_unlink=do_unlink)

class _BlockedImages(_Images):
    def __init__(self) -> None:
        super().__init__()
        self.blocked = False

    def remove(self, image: object, *, do_unlink: bool) -> None:
        if self.blocked:
            raise RuntimeError("datablock is still busy")
        super().remove(image, do_unlink=do_unlink)


def _fake_bpy(images: _Images):
    image_space = types.SimpleNamespace(type="IMAGE_EDITOR", image=None)
    other_space = types.SimpleNamespace(type="VIEW_3D", image=None)
    screen = types.SimpleNamespace(areas=[
        types.SimpleNamespace(type="IMAGE_EDITOR", spaces=types.SimpleNamespace(active=image_space)),
        types.SimpleNamespace(type="VIEW_3D", spaces=types.SimpleNamespace(active=other_space)),
    ])
    return types.SimpleNamespace(
        data=types.SimpleNamespace(images=images, screens=[screen]),
    ), image_space


def _write_artifact(directory: str, contents: bytes) -> tuple[str, Path]:
    digest = hashlib.sha256(contents).hexdigest()
    payload = Path(directory) / ".cclay" / "artifacts" / digest / "payload"
    payload.parent.mkdir(parents=True)
    payload.write_bytes(contents)
    payload.chmod(0o600)
    return digest, payload


class QaImageDisplayTests(unittest.TestCase):
    def tearDown(self) -> None:
        cleanup_qa_images()

    def test_verified_digest_bytes_are_loaded_from_private_copy_and_packed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            digest, payload = _write_artifact(directory, PNG)
            images = _Images()
            bpy_module, image_space = _fake_bpy(images)

            displayed = display_qa_artifact(directory, digest, bpy_module=bpy_module)

            self.assertEqual(displayed, digest)
            loaded_path, check_existing = images.loaded[0]
            self.assertNotEqual(loaded_path, str(payload))
            self.assertTrue(loaded_path.endswith(".png"))
            self.assertFalse(check_existing)
            self.assertFalse(os.path.exists(loaded_path))
            self.assertEqual(image_space.image.name, f"CCLAY QA {digest[:12]}")

    def test_tool_result_digest_falls_back_to_newest_verified_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            preferred_digest, _preferred = _write_artifact(directory, b"not a png")
            digest, _payload = _write_artifact(directory, PNG)
            images = _Images()
            bpy_module, image_space = _fake_bpy(images)

            displayed = display_latest_qa_artifact(
                directory,
                preferred_digest,
                bpy_module=bpy_module,
            )

            self.assertEqual(displayed, digest)
            self.assertEqual(image_space.image.name, f"CCLAY QA {digest[:12]}")

    def test_replacement_and_cleanup_remove_owned_image_datablocks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            digest, _payload = _write_artifact(directory, PNG)
            images = _Images()
            bpy_module, image_space = _fake_bpy(images)
            display_qa_artifact(directory, digest, bpy_module=bpy_module)
            first = image_space.image

            display_qa_artifact(directory, digest, bpy_module=bpy_module)
            self.assertIn(first, images.removed)
            second = image_space.image
            cleanup_qa_images()

            self.assertIn(second, images.removed)
            self.assertIsNone(image_space.image)

    def test_missing_pack_releases_newly_loaded_datablock(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            digest, _payload = _write_artifact(directory, PNG)
            images = _NoPackImages()
            bpy_module, _space = _fake_bpy(images)

            with self.assertRaisesRegex(QaImageDisplayError, "retained safely"):
                display_qa_artifact(directory, digest, bpy_module=bpy_module)

            self.assertEqual(len(images.removed), 1)

    def test_cleanup_retries_failed_datablock_removal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            digest, _payload = _write_artifact(directory, PNG)
            images = _FlakyImages()
            bpy_module, image_space = _fake_bpy(images)
            display_qa_artifact(directory, digest, bpy_module=bpy_module)

            cleanup_qa_images()
            self.assertEqual(images.remove_attempts, 1)
            self.assertIsNone(image_space.image)
            cleanup_qa_images()

            self.assertEqual(images.remove_attempts, 2)
            self.assertEqual(len(images.removed), 1)
    def test_new_load_is_refused_while_prior_datablock_cannot_be_removed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            digest, _payload = _write_artifact(directory, PNG)
            images = _BlockedImages()
            bpy_module, _space = _fake_bpy(images)
            display_qa_artifact(directory, digest, bpy_module=bpy_module)
            images.blocked = True

            with self.assertRaisesRegex(QaImageDisplayError, "could not be released"):
                display_qa_artifact(directory, digest, bpy_module=bpy_module)

            self.assertEqual(len(images.loaded), 1)
            images.blocked = False
            self.assertTrue(cleanup_qa_images())
    def test_hash_mismatch_and_non_png_payload_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            digest = "a" * 64
            payload = Path(directory) / ".cclay" / "artifacts" / digest / "payload"
            payload.parent.mkdir(parents=True)
            payload.write_bytes(b"not a png")
            payload.chmod(0o600)
            bpy_module, _space = _fake_bpy(_Images())

            with self.assertRaisesRegex(QaImageDisplayError, "artifact payload is invalid"):
                display_qa_artifact(directory, digest, bpy_module=bpy_module)

    def test_invalid_digest_never_becomes_a_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            bpy_module, _space = _fake_bpy(_Images())
            with self.assertRaisesRegex(QaImageDisplayError, "artifact digest is invalid"):
                display_qa_artifact(directory, "../secret", bpy_module=bpy_module)


if __name__ == "__main__":
    unittest.main()
