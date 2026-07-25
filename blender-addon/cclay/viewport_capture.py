"""Viewport capture for fast, low-context visual QA.

Renders the active 3D viewport through a GPU offscreen buffer so the model
can see what the user sees without a full render. Independent of window
compositing state (works while Blender is in the background), and the JPEG
thumbnail stays small enough to send as model context on every call.

With a ``subject`` entity id the capture instead returns SEVERAL images of
that named subject from purposeful angles (three-quarter, side, contact_low,
...), synthesized from the subject's evaluated world bounds with no scene
mutation: the camera, viewport, and no object are moved, and no datablocks
outlive the call. The view and window matrices are built by
``cclay.view_matrices`` (bpy-free, unit-tested) and passed straight to
``GPUOffScreen.draw_view3d``, which accepts them as explicit arguments.
"""

from __future__ import annotations

import base64
import math
import tempfile
from pathlib import Path

try:
    import imbuf
except ImportError:
    imbuf = None


CAPTURE_WIDTH = 480
CAPTURE_HEIGHT = 270
CAPTURE_QUALITY = 72
# The no-argument view name, kept stable so callers can tell a human-viewport
# capture from a synthesized multi-angle view.
VIEWPORT_VIEW_NAME = "viewport"
# Exact keys every returned view carries. The TypeScript side parses this wire
# shape with a closed schema, so a missing or extra key is a hard error there;
# checking it here keeps the failure inside Blender where the cause is visible.
VIEWPORT_VIEW_KEYS = frozenset(
    {"name", "mime_type", "data_base64", "width", "height", "method"}
)


class ViewportCaptureError(RuntimeError):
    """A viewport capture request cannot complete."""


def capture_viewport(
    subject: str | None = None,
    views: list[str] | None = None,
    project_id: str | None = None,
) -> dict:
    """Capture the active 3D viewport as one or more small JPEGs plus meta.

    With no ``subject`` this captures the human's active viewport exactly as
    before — the fast iterative path — and returns a single view named
    ``"viewport"``. With a ``subject`` entity id it resolves the project-owned
    entity, frames on its EVALUATED world bounds, and returns one image per
    requested (or default) named view, synthesized with no scene mutation: the
    camera, viewport, and no object move, and no datablocks outlive the call.

    Returns ``{"views": [{"name", "mime_type", "data_base64", "width",
    "height", "method"}, ...]}`` in capture order.
    """
    import bpy

    space, region = _resolve_viewport_space(bpy)
    if subject is None:
        # No-argument path: the human's viewport, unchanged. Still returned
        # inside the ``views`` list so the wire shape is uniform.
        r3d = space.region_3d
        capture = _capture_with_matrices(
            bpy, space, region, r3d.view_matrix, r3d.window_matrix,
            allow_window_grab=True,
        )
        capture["name"] = VIEWPORT_VIEW_NAME
        return {"views": [capture]}

    # Multi-angle path: synthesize matrices from the subject's evaluated bounds.
    resolved_project_id = project_id or bpy.context.scene.get("cclay.project_id")
    if not isinstance(resolved_project_id, str) or not resolved_project_id:
        raise ViewportCaptureError(
            "capture_viewport with a subject requires a project_id: the bridge "
            "must forward the active project id (or the scene must carry "
            "cclay.project_id) so the subject can be resolved as project-owned"
        )
    from .stage_scene import _require_owned_entity
    from .view_matrices import ViewMatrixError, build_views, resolve_views

    try:
        names = resolve_views(views, subject_given=True)
    except ViewMatrixError as error:
        raise ViewportCaptureError(str(error)) from error
    if not names:
        raise ViewportCaptureError(
            "capture_viewport with a subject resolved no views; pass a list of "
            "view names or omit views to use the default set"
        )
    scene_object = _require_owned_entity(subject, resolved_project_id)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = scene_object.evaluated_get(depsgraph)
    from .directing_evidence import _world_bounds

    minimum, maximum = _world_bounds(evaluated)
    if not all(math.isfinite(v) for v in (*minimum, *maximum)):
        raise ViewportCaptureError(
            f"subject {subject} has non-finite world bounds; cannot frame it"
        )
    aspect = CAPTURE_WIDTH / CAPTURE_HEIGHT
    built = build_views(
        names,
        (float(minimum[0]), float(minimum[1]), float(minimum[2])),
        (float(maximum[0]), float(maximum[1]), float(maximum[2])),
        aspect,
    )
    from mathutils import Matrix

    captured: list[dict] = []
    for view in built:
        view_matrix = Matrix(view["view_matrix"])
        window_matrix = Matrix(view["window_matrix"])
        capture = _capture_with_matrices(
            bpy, space, region, view_matrix, window_matrix,
            allow_window_grab=False,
        )
        capture["name"] = view["name"]
        captured.append(capture)
    return {"views": captured}


def _resolve_viewport_space(bpy):
    """Locate the active VIEW_3D space and WINDOW region, or raise clearly."""
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
    space = region = None
    for candidate in (screen.areas if screen is not None else ()):
        if candidate.type == "VIEW_3D":
            space = candidate.spaces.active
            region = next((r for r in candidate.regions if r.type == "WINDOW"), None)
            break
    if space is None or region is None:
        raise ViewportCaptureError(
            "no 3D viewport is available to capture: the active screen "
            "layout has no VIEW_3D area open. Switch the Blender window to "
            "a layout with a 3D Viewport (e.g. the default Layout tab) and "
            "retry, or use render_qa_frames as a layout-independent fallback."
        )
    return space, region


def _capture_with_matrices(
    bpy, space, region, view_matrix, window_matrix, *, allow_window_grab: bool
) -> dict:
    """Render one offscreen frame with explicit view/window matrices.

    ``allow_window_grab`` is true only for the human-viewport capture, whose
    matrices are the ones the window already shows. The window-grab fallback
    ignores the matrices it is handed, so a synthesized view must never use it:
    it would return the human's angle labelled as a named view. The caller
    states which mode it is in; the mode is not inferred from the matrices,
    because Blender RNA hands back a fresh object on every property read and an
    identity comparison against it is always false.
    """
    width = CAPTURE_WIDTH
    height = CAPTURE_HEIGHT
    method = "offscreen"
    try:
        import gpu
        import numpy as np

        offscreen = gpu.types.GPUOffScreen(width, height)
        try:
            offscreen.draw_view3d(
                bpy.context.scene,
                bpy.context.view_layer,
                space,
                region,
                view_matrix,
                window_matrix,
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
        # The window-grab fallback ignores the supplied matrices, so it can only
        # reproduce the human's viewport; refuse it for synthesized views rather
        # than silently returning the same angle for every named view.
        if not allow_window_grab:
            raise ViewportCaptureError(
                f"synthesized view capture failed and the window-grab fallback "
                f"ignores the supplied matrices, so the view cannot be produced: "
                f"{offscreen_error}"
            ) from offscreen_error
        method = "window_grab"
        with tempfile.TemporaryDirectory(prefix="cclay-viewport-") as directory:
            png_path = Path(directory) / "capture.png"
            area = next((a for a in bpy.context.screen.areas if a.type == "VIEW_3D"), None)
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
    if (thumb.size[0], thumb.size[1]) != (CAPTURE_WIDTH, CAPTURE_HEIGHT):
        # Identity for the offscreen path, which already renders at these
        # dimensions; this only bites the window_grab fallback, whose source is
        # the full window. BILINEAR because imbuf defaults to FAST, which
        # point-samples and aliases a reduction instead of averaging it.
        thumb.resize((CAPTURE_WIDTH, CAPTURE_HEIGHT), method="BILINEAR")
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
