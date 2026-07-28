from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from test_cinematic_render import FakeCamera, RenderHarness, _join_worker


class SceneObservingCamera(FakeCamera):
    def __init__(self, editor_handles: list[SimpleNamespace], protected_handles: list[SimpleNamespace], fail: bool) -> None:
        super().__init__(fail_at_call=1 if fail else None)
        self.editor_handles = editor_handles
        self.protected_handles = protected_handles
        self.editor_during_capture: tuple[bool, ...] | None = None
        self.protected_during_capture: tuple[bool, ...] | None = None

    def get_render(self, *, height: int, width: int, transport_format: str) -> np.ndarray:
        self.editor_during_capture = tuple(handle.visible for handle in self.editor_handles)
        self.protected_during_capture = tuple(handle.visible for handle in self.protected_handles)
        return super().get_render(height=height, width=width, transport_format=transport_format)


class ConstraintRefreshingHarness(RenderHarness):
    def __init__(self, output_path: Path, camera: FakeCamera, refreshed: list[SimpleNamespace]) -> None:
        super().__init__(output_path, camera=camera)
        self.refreshed = refreshed

    def set_frame(self, client_id: int, frame_idx: int, trigger_by_gui_timeline: bool = False) -> None:
        super().set_frame(client_id, frame_idx, trigger_by_gui_timeline)
        for handle in self.refreshed:
            handle.visible = True


def _handle(visible: bool) -> SimpleNamespace:
    return SimpleNamespace(visible=visible)


@pytest.mark.parametrize("fail", [False, True])
def test_preview_hides_all_editor_constraints_and_skeletons_then_restores_exactly(
    tmp_path: Path, fail: bool
) -> None:
    # Given: mixed prior states across EE, waypoint, interval, skeleton, reference, and gizmo helpers.
    joints, bones, axes, label = _handle(True), _handle(False), _handle(True), _handle(True)
    waypoint_sphere, waypoint_arrow, interval_label = _handle(True), _handle(False), _handle(True)
    character_joints, character_bones, character_mesh = _handle(True), _handle(False), _handle(True)
    reference_mesh, hand_gizmo = _handle(True), _handle(True)
    loaded_scene, grid, world_axes = _handle(True), _handle(True), _handle(True)
    editor_handles = [
        joints, bones, axes, label, waypoint_sphere, waypoint_arrow, interval_label,
        character_joints, character_bones, reference_mesh, hand_gizmo,
    ]
    protected_handles = [character_mesh, loaded_scene]
    original_editor = tuple(handle.visible for handle in editor_handles)
    camera = SceneObservingCamera(editor_handles, protected_handles, fail)
    demo = RenderHarness(tmp_path / f"constraints-{fail}.mp4", camera=camera)
    demo.session.render_grid_handle = grid
    demo.session.client.scene.world_axes = world_axes
    demo.session.constraints = {
        "End-Effectors": SimpleNamespace(
            scene_elements={275: {"skeleton_mesh": SimpleNamespace(
                joints_batched_mesh=joints, bones_batched_mesh=bones
            ), "ee_rotation_axes": axes, "label": label}},
            interval_labels={},
        ),
        "2D Root": SimpleNamespace(
            scene_elements={300: {"waypoint": SimpleNamespace(
                sphere=waypoint_sphere, annulus=None, arrow_base=waypoint_arrow, arrow_head=None
            )}},
            interval_labels={(280, 320): interval_label},
        ),
    }
    demo.session.characters = {"hero": SimpleNamespace(
        skeleton_mesh=SimpleNamespace(joints_batched_mesh=character_joints, bones_batched_mesh=character_bones),
        skinned_mesh=character_mesh,
    )}
    demo.session.ref_character = SimpleNamespace(
        skinned_mesh=reference_mesh, g1_mesh_rig=None, mixamo_avatar_rig=None, skeleton_mesh=None
    )
    demo.session.hand_gizmos = {"hero": {"left": hand_gizmo}}
    demo.session.loaded_scene_mesh_handle = loaded_scene

    # When
    demo.preview_cinematic_output(7)

    # Then
    assert camera.editor_during_capture == (False,) * len(editor_handles)
    assert camera.protected_during_capture == (True, True)
    assert tuple(handle.visible for handle in editor_handles) == original_editor
    assert (grid.visible, world_axes.visible) == (True, True)


def test_full_render_rehides_constraints_after_frame_refresh_and_restores_exactly(tmp_path: Path) -> None:
    # Given
    axes, label = _handle(True), _handle(False)
    camera = SceneObservingCamera([axes, label], [], fail=False)
    demo = ConstraintRefreshingHarness(tmp_path / "refresh.mp4", camera, [axes, label])
    demo.session.constraints = {
        "End-Effectors": SimpleNamespace(
            scene_elements={2: {"ee_rotation_axes": axes, "label": label}},
            interval_labels={},
        )
    }

    # When
    demo.start_cinematic_render(7)
    _join_worker(demo)

    # Then
    assert camera.editor_during_capture == (False, False)
    assert (axes.visible, label.visible) == (True, False)
