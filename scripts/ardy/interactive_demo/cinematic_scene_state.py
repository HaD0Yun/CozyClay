"""Exact visibility snapshots for editor-only Viser scene helpers."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from typing import Protocol


class VisibleHandle(Protocol):
    visible: bool


@dataclass(frozen=True, slots=True)
class VisibleHandleState:
    handle: VisibleHandle
    visible: bool


@dataclass(frozen=True, slots=True)
class SceneHelperVisibility:
    handles: tuple[VisibleHandleState, ...]


_CHILD_FIELDS = (
    "joints_batched_mesh",
    "bones_batched_mesh",
    "root_2d_sphere",
    "velocity_arrow_mesh",
    "arrow_line",
    "arrow_cone",
    "sphere",
    "annulus",
    "arrow_base",
    "arrow_head",
    "mesh_handles",
    "_handle",
)


def _iter_visible_handles(root, seen: set[int]) -> Iterator[VisibleHandle]:
    if root is None or id(root) in seen:
        return
    seen.add(id(root))
    if isinstance(root, dict):
        for value in root.values():
            yield from _iter_visible_handles(value, seen)
        return
    if isinstance(root, (list, tuple)):
        for value in root:
            yield from _iter_visible_handles(value, seen)
        return
    if hasattr(root, "visible"):
        yield root
        return
    for field in _CHILD_FIELDS:
        if hasattr(root, field):
            yield from _iter_visible_handles(getattr(root, field), seen)


def _editor_roots(session) -> Iterator:
    frame_mask = getattr(session, "cinematic_frame_mask", None)
    if frame_mask is not None:
        yield frame_mask.root
    yield getattr(session, "render_grid_handle", None)
    yield session.client.scene.world_axes
    yield getattr(session, "start_direction_marker", None)
    yield getattr(session, "target_velocity_arrow", None)
    for constraint in getattr(session, "constraints", {}).values():
        yield constraint.scene_elements
        yield constraint.interval_labels
    for character in getattr(session, "characters", {}).values():
        yield getattr(character, "skeleton_mesh", None)
    reference = getattr(session, "ref_character", None)
    if reference is not None:
        yield getattr(reference, "skeleton_mesh", None)
        yield getattr(reference, "skinned_mesh", None)
        yield getattr(reference, "g1_mesh_rig", None)
        yield getattr(reference, "mixamo_avatar_rig", None)
    yield getattr(session, "hand_gizmos", {})


def _current_editor_handles(session) -> tuple[VisibleHandle, ...]:
    seen: set[int] = set()
    return tuple(handle for root in _editor_roots(session) for handle in _iter_visible_handles(root, seen))


def enforce_render_scene_helpers_hidden(session) -> None:
    for handle in _current_editor_handles(session):
        handle.visible = False


def hide_render_scene_helpers(session) -> SceneHelperVisibility:
    snapshot = SceneHelperVisibility(
        tuple(VisibleHandleState(handle=handle, visible=bool(handle.visible)) for handle in _current_editor_handles(session))
    )
    enforce_render_scene_helpers_hidden(session)
    return snapshot


def restore_render_scene_helpers(_session, snapshot: SceneHelperVisibility) -> None:
    for state in snapshot.handles:
        state.handle.visible = state.visible
