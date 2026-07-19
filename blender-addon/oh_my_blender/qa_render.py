"""Deterministic, read-only QA frame rendering for the protocol-v2 bridge."""

from __future__ import annotations

import base64
import hashlib
import tempfile
import time
from collections.abc import Callable
from pathlib import Path

from .checkpoint import create_checkpoint, restore, verify

try:  # Blender is intentionally absent from host-side unit tests.
    import bpy  # type: ignore
except ImportError:  # pragma: no cover
    bpy = None


PROFILE_VERSION = "omb-qa-png-v1"
PROFILE_BLENDER_VERSION = (5, 1, 2)
WIDTH = 640
HEIGHT = 360
MAX_FRAMES = 12
MAX_FRAME_BYTES = 16 * 1024 * 1024
MAX_BATCH_BYTES = 128 * 1024 * 1024
MAX_DEADLINE_SECONDS = 30.0
MAX_CHUNK_BYTES = 512 * 1024
MAX_CHUNKS_PER_FRAME = 32


class RenderQaError(RuntimeError):
    """A QA render request cannot complete without violating its contract."""


class RENDER_QA_INVALID_REQUEST(RenderQaError):
    code = "RENDER_QA_INVALID_REQUEST"


class RENDER_QA_FRAME_LIMIT_EXCEEDED(RenderQaError):
    code = "RENDER_QA_FRAME_LIMIT_EXCEEDED"


class RENDER_QA_STALE_REVISION(RenderQaError):
    code = "RENDER_QA_STALE_REVISION"


class RENDER_QA_CANCELLED(RenderQaError):
    code = "RENDER_QA_CANCELLED"


class RENDER_QA_DEADLINE_EXCEEDED(RenderQaError):
    code = "RENDER_QA_DEADLINE_EXCEEDED"


class RENDER_QA_FRAME_BYTES_EXCEEDED(RenderQaError):
    code = "RENDER_QA_FRAME_BYTES_EXCEEDED"


class RENDER_QA_BATCH_BYTES_EXCEEDED(RenderQaError):
    code = "RENDER_QA_BATCH_BYTES_EXCEEDED"


class RENDER_QA_RESTORE_FAILED(RenderQaError):
    code = "RENDER_QA_RESTORE_FAILED"


def _is_digest(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def validate_render_request(
    value: object, *, frame_start: int, frame_end: int
) -> dict:
    """Validate and canonicalize the closed Blender-side request."""
    if not isinstance(value, dict) or set(value) != {
        "schema_version",
        "revision_id",
        "frames",
    }:
        raise RENDER_QA_INVALID_REQUEST(
            "render_qa_frames requires only schema_version, revision_id, and frames"
        )
    if value["schema_version"] != 1:
        raise RENDER_QA_INVALID_REQUEST("schema_version must equal 1")
    if not _is_digest(value["revision_id"]):
        raise RENDER_QA_INVALID_REQUEST("revision_id must be a lowercase SHA-256 digest")
    frames = value["frames"]
    if not isinstance(frames, list) or not frames:
        raise RENDER_QA_INVALID_REQUEST("frames must be a non-empty array")
    if any(isinstance(frame, bool) or not isinstance(frame, int) for frame in frames):
        raise RENDER_QA_INVALID_REQUEST("frame numbers must be integers")
    canonical_frames = sorted(set(frames))
    if len(canonical_frames) > MAX_FRAMES:
        raise RENDER_QA_FRAME_LIMIT_EXCEEDED(
            f"render_qa_frames accepts at most {MAX_FRAMES} unique frames"
        )
    if any(frame < frame_start or frame > frame_end for frame in canonical_frames):
        raise RENDER_QA_INVALID_REQUEST("frame number lies outside the scene range")
    return {
        "schema_version": 1,
        "revision_id": value["revision_id"],
        "frames": canonical_frames,
    }


def _check_abort(deadline: float, cancelled: Callable[[], bool]) -> None:
    if cancelled():
        raise RENDER_QA_CANCELLED("render QA was cancelled")
    if time.monotonic() >= deadline:
        raise RENDER_QA_DEADLINE_EXCEEDED("render QA deadline elapsed")


def _scope_state(scene: object) -> dict[str, dict]:
    render = scene.render
    image = render.image_settings
    cycles = scene.cycles
    view = scene.view_settings
    display = scene.display_settings
    return {
        "scene": {
            "frame_current": scene.frame_current,
            "world_name": scene.world.name if scene.world is not None else None,
        },
        "render": {
            "engine": render.engine,
            "resolution_x": render.resolution_x,
            "resolution_y": render.resolution_y,
            "resolution_percentage": render.resolution_percentage,
            "filepath": render.filepath,
            "use_file_extension": render.use_file_extension,
            "use_motion_blur": render.use_motion_blur,
            "film_transparent": render.film_transparent,
            "use_stamp": render.use_stamp,
        },
        "cycles": {
            "device": cycles.device,
            "samples": cycles.samples,
            "use_denoising": cycles.use_denoising,
            "use_preview_denoising": cycles.use_preview_denoising,
        },
        "image": {
            "file_format": image.file_format,
            "color_mode": image.color_mode,
            "color_depth": image.color_depth,
            "compression": image.compression,
        },
        "color": {
            "display_device": display.display_device,
            "view_transform": view.view_transform,
            "look": view.look,
            "exposure": view.exposure,
            "gamma": view.gamma,
        },
    }


def _restore_scope(scene: object, worlds: dict[str, object], key: str, values: dict) -> None:
    if key == "scene":
        scene.world = worlds.get(values["world_name"])
        scene.frame_set(values["frame_current"])
        return
    target = {
        "render": scene.render,
        "cycles": scene.cycles,
        "image": scene.render.image_settings,
    }.get(key)
    if target is not None:
        for name, value in values.items():
            setattr(target, name, value)
        return
    if key == "color":
        scene.display_settings.display_device = values["display_device"]
        scene.view_settings.view_transform = values["view_transform"]
        scene.view_settings.look = values["look"]
        scene.view_settings.exposure = values["exposure"]
        scene.view_settings.gamma = values["gamma"]
        return
    raise RENDER_QA_RESTORE_FAILED(f"unknown QA checkpoint scope: {key}")


def _configure_profile(scene: object, output_path: Path) -> object:
    if tuple(bpy.app.version) != PROFILE_BLENDER_VERSION:
        raise RenderQaError(
            "omb-qa-png-v1 requires Blender 5.1.2; "
            f"running {bpy.app.version_string}"
        )
    render = scene.render
    render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 64
    scene.cycles.use_denoising = False
    scene.cycles.use_preview_denoising = False
    render.use_motion_blur = False
    render.film_transparent = False
    render.resolution_x = WIDTH
    render.resolution_y = HEIGHT
    render.resolution_percentage = 100
    render.filepath = str(output_path)
    render.use_file_extension = False
    render.use_stamp = False
    image = render.image_settings
    image.file_format = "PNG"
    image.color_mode = "RGBA"
    image.color_depth = "8"
    image.compression = 15
    scene.display_settings.display_device = "sRGB"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "Medium High Contrast"
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0

    world = bpy.data.worlds.new("OMB QA World")
    world.use_nodes = True
    nodes = world.node_tree.nodes
    nodes.clear()
    background = nodes.new("ShaderNodeBackground")
    background.inputs["Color"].default_value = (
        0.050876,
        0.050876,
        0.050876,
        1.0,
    )
    background.inputs["Strength"].default_value = 1.0
    output = nodes.new("ShaderNodeOutputWorld")
    world.node_tree.links.new(background.outputs["Background"], output.inputs["Surface"])
    scene.world = world
    return world


def _render_batch(
    frames: list[int], *, deadline: float, cancelled: Callable[[], bool]
) -> list[tuple[int, bytes]]:
    if bpy is None:
        raise RenderQaError("render_qa_frames requires Blender")
    scene = bpy.context.scene
    checkpoint = create_checkpoint(_scope_state(scene))
    worlds = {world.name: world for world in bpy.data.worlds}
    temporary_world = None
    rendered: list[tuple[int, bytes]] = []
    try:
        with tempfile.TemporaryDirectory(prefix="omb-qa-render-") as directory:
            output_path = Path(directory) / "frame.png"
            temporary_world = _configure_profile(scene, output_path)
            for frame in frames:
                _check_abort(deadline, cancelled)
                scene.frame_set(frame)
                bpy.context.view_layer.update()
                bpy.ops.render.render(write_still=True)
                _check_abort(deadline, cancelled)
                frame_bytes = output_path.read_bytes()
                rendered.append((frame, frame_bytes))
                output_path.unlink(missing_ok=True)
        return rendered
    finally:
        try:
            restore(
                checkpoint,
                lambda key, values: _restore_scope(scene, worlds, key, values),
            )
            bpy.context.view_layer.update()
            if not verify(checkpoint, lambda key: _scope_state(scene)[key]):
                raise RENDER_QA_RESTORE_FAILED(
                    "QA render settings did not restore to the checkpoint"
                )
        finally:
            if temporary_world is not None:
                bpy.data.worlds.remove(temporary_world)


def _live_scene_hash() -> str:
    from .manifest import extract_scene_manifest_v2

    return extract_scene_manifest_v2()["sceneHash"]


def split_frame_for_bridge(frame_result: dict) -> tuple[dict, dict, list[dict]]:
    """Split one verified PNG into bounded protocol-v2 artifact chunks."""
    encoded = frame_result.get("png_base64")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (TypeError, ValueError) as error:
        raise RenderQaError(f"renderer returned invalid base64: {error}") from error
    if len(data) != frame_result.get("byte_length"):
        raise RenderQaError("renderer byte length changed before bridge streaming")
    if hashlib.sha256(data).hexdigest() != frame_result.get("sha256"):
        raise RenderQaError("renderer digest changed before bridge streaming")
    chunks_data = [
        data[offset : offset + MAX_CHUNK_BYTES]
        for offset in range(0, len(data), MAX_CHUNK_BYTES)
    ]
    if not chunks_data or len(chunks_data) > MAX_CHUNKS_PER_FRAME:
        raise RENDER_QA_FRAME_BYTES_EXCEEDED(
            "frame cannot be represented by the bounded bridge chunk protocol"
        )
    total_chunks = len(chunks_data)
    chunks = [
        {
            "frame": frame_result["frame"],
            "chunk_index": index,
            "total_chunks": total_chunks,
            "byte_offset": index * MAX_CHUNK_BYTES,
            "byte_length": len(chunk),
            "data_base64": base64.b64encode(chunk).decode("ascii"),
        }
        for index, chunk in enumerate(chunks_data)
    ]
    metadata = {
        key: value
        for key, value in frame_result.items()
        if key != "png_base64"
    }
    begin = {
        "frame": frame_result["frame"],
        "total_chunks": total_chunks,
        "total_byte_length": frame_result["byte_length"],
        "sha256": frame_result["sha256"],
    }
    return metadata, begin, chunks


def render_qa_frames_transaction(
    request_value: object,
    current_scene_hash: str,
    *,
    cancelled: Callable[[], bool] = lambda: False,
    deadline: float | None = None,
    live_scene_hash: Callable[[], str] = _live_scene_hash,
    render_batch: Callable[..., list[tuple[int, bytes]]] = _render_batch,
    progress: Callable[[str, int, int], None] = lambda _phase, _completed, _total: None,
) -> dict:
    """Render a bounded batch and return internal bytes for daemon-side publication."""
    if bpy is None and render_batch is _render_batch:
        raise RenderQaError("render_qa_frames requires Blender")
    if bpy is not None:
        scene = bpy.context.scene
        frame_start = scene.frame_start
        frame_end = scene.frame_end
    else:
        frame_start = -(2**31)
        frame_end = 2**31 - 1
    request = validate_render_request(
        request_value,
        frame_start=frame_start,
        frame_end=frame_end,
    )
    progress("validating", 0, len(request["frames"]))
    effective_deadline = min(
        deadline if deadline is not None else float("inf"),
        time.monotonic() + MAX_DEADLINE_SECONDS,
    )
    _check_abort(effective_deadline, cancelled)
    if live_scene_hash() != current_scene_hash:
        raise RENDER_QA_STALE_REVISION(
            "live main-thread SceneManifestV2 hash differs from the durable expected base"
        )
    progress("rendering", 0, len(request["frames"]))
    rendered = render_batch(
        request["frames"],
        deadline=effective_deadline,
        cancelled=cancelled,
    )
    progress("rendered", len(rendered), len(request["frames"]))
    if [frame for frame, _data in rendered] != request["frames"]:
        raise RenderQaError("renderer returned frames out of contract order")

    total_bytes = 0
    results = []
    for frame, data in rendered:
        if len(data) > MAX_FRAME_BYTES:
            raise RENDER_QA_FRAME_BYTES_EXCEEDED(
                f"frame {frame} exceeds the {MAX_FRAME_BYTES}-byte limit"
            )
        total_bytes += len(data)
        if total_bytes > MAX_BATCH_BYTES:
            raise RENDER_QA_BATCH_BYTES_EXCEEDED(
                f"render batch exceeds the {MAX_BATCH_BYTES}-byte limit"
            )
        results.append({
            "frame": frame,
            "width": WIDTH,
            "height": HEIGHT,
            "profile_version": PROFILE_VERSION,
            "byte_length": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "png_base64": base64.b64encode(data).decode("ascii"),
        })
    return {
        "schema_version": 1,
        "revision_id": request["revision_id"],
        "profile_version": PROFILE_VERSION,
        "frames": results,
    }
