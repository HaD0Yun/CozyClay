"""Viewport capture for fast, low-context visual QA.

Renders the active 3D viewport through a GPU offscreen buffer so the model
can see what the user sees without a full render. Independent of window
compositing state (works while Blender is in the background), and the JPEG
thumbnail stays small enough to send as model context on every call.
"""

from __future__ import annotations

import base64
import tempfile
from pathlib import Path

try:
    import imbuf
except ImportError:
    imbuf = None


CAPTURE_WIDTH = 480
CAPTURE_HEIGHT = 270
CAPTURE_QUALITY = 72


class ViewportCaptureError(RuntimeError):
    """A viewport capture request cannot complete."""


def capture_viewport() -> dict:
    """Capture the active 3D viewport as a small JPEG and return base64 + meta.

    Uses gpu.types.GPUOffScreen.draw_view3d so the capture is independent of
    window compositing (Blender may be in the background). Falls back to
    bpy.ops.screen.screenshot_area when no GPU context is available.
    """
    import bpy

    if bpy.app.background:
        raise ViewportCaptureError(
            "no 3D viewport is available to capture: this Blender process "
            "is running in --background (headless) mode, which has no "
            "window or viewport at all. Reattach through the normal "
            "windowed flow (scripts/blender_attach.py without --background) "
            "to use capture_viewport; render_qa_frames works headless too "
            "and is the correct fallback here."
        )

    screen = bpy.context.screen
    area = region = space = None
    for candidate in (screen.areas if screen is not None else ()):
        if candidate.type == "VIEW_3D":
            area = candidate
            space = candidate.spaces.active
            region = next((r for r in candidate.regions if r.type == "WINDOW"), None)
            break
    if area is None or region is None or space is None:
        raise ViewportCaptureError(
            "no 3D viewport is available to capture: the active screen "
            "layout has no VIEW_3D area open. Switch the Blender window to "
            "a layout with a 3D Viewport (e.g. the default Layout tab) and "
            "retry, or use render_qa_frames as a layout-independent fallback."
        )

    width = CAPTURE_WIDTH
    height = CAPTURE_HEIGHT
    method = "offscreen"
    try:
        import gpu
        import numpy as np

        r3d = space.region_3d
        offscreen = gpu.types.GPUOffScreen(width, height)
        try:
            offscreen.draw_view3d(
                bpy.context.scene,
                bpy.context.view_layer,
                space,
                region,
                r3d.view_matrix,
                r3d.window_matrix,
                do_color_management=True,
            )
            buffer = offscreen.texture_color.read()
        finally:
            offscreen.free()
        buffer.dimensions = width * height * 4
        pixels = np.asarray(buffer, dtype=np.float32) / 255.0
        image = bpy.data.images.new("cclay_viewport_capture", width, height, alpha=True)
        try:
            image.pixels.foreach_set(pixels.ravel())
            with tempfile.TemporaryDirectory(prefix="cclay-viewport-") as directory:
                png_path = Path(directory) / "capture.png"
                image.filepath_raw = png_path.as_posix()
                image.file_format = "PNG"
                image.save()
                return _encode_thumbnail_png(png_path, width, height, method)
        finally:
            bpy.data.images.remove(image)
    except Exception as offscreen_error:  # noqa: BLE001 - fall back to window grab
        method = "window_grab"
        with tempfile.TemporaryDirectory(prefix="cclay-viewport-") as directory:
            png_path = Path(directory) / "capture.png"
            try:
                with bpy.context.temp_override(area=area):
                    bpy.ops.screen.screenshot_area(filepath=png_path.as_posix())
            except Exception as grab_error:  # noqa: BLE001
                raise ViewportCaptureError(
                    f"viewport capture failed: offscreen={offscreen_error}; "
                    f"window_grab={grab_error}"
                ) from grab_error
            return _encode_thumbnail_png(png_path, width, height, method)


def _encode_thumbnail_png(png_path: Path, width: int, height: int, method: str) -> dict:
    if imbuf is None:
        data = png_path.read_bytes()
        return {
            "mime_type": "image/png",
            "data_base64": base64.b64encode(data).decode("ascii"),
            "width": width,
            "height": height,
            "method": method,
        }
    thumb = imbuf.load(png_path.as_posix())
    thumb.resize((CAPTURE_WIDTH, CAPTURE_HEIGHT))
    thumb.file_type = "JPEG"
    thumb.quality = CAPTURE_QUALITY
    with tempfile.TemporaryDirectory(prefix="cclay-viewport-thumb-") as directory:
        target = Path(directory) / "thumb.jpg"
        thumb.filepath = target.as_posix()
        imbuf.write(thumb)
        encoded = base64.b64encode(target.read_bytes()).decode("ascii")
    return {
        "mime_type": "image/jpeg",
        "data_base64": encoded,
        "width": CAPTURE_WIDTH,
        "height": CAPTURE_HEIGHT,
        "method": method,
    }
