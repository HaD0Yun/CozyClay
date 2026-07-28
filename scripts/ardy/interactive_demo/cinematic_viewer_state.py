"""Snapshot, hide, and restore Viser state around cinematic captures."""

from __future__ import annotations

import numpy as np

from .cinematic_render_support import ViewerSnapshot


class CinematicViewerStateMixin:
    def _snapshot_cinematic_viewer(self, session) -> ViewerSnapshot:
        camera = session.client.camera
        gui = session.gui_elements
        helper_visibility = (
            bool(gui.gui_viz_skeleton_checkbox.value),
            bool(gui.gui_viz_foot_contacts_checkbox.value),
            bool(gui.gui_viz_hand_orientations_checkbox.value),
            bool(gui.gui_show_start_direction_checkbox.value),
            bool(gui.gui_show_timeline_checkbox.value),
        )
        return ViewerSnapshot(
            session.frame_idx,
            session.playing,
            session.cinematic.preview_enabled,
            tuple(float(value) for value in camera.position),
            tuple(float(value) for value in camera.look_at),
            tuple(float(value) for value in camera.up_direction),
            float(camera.fov),
            helper_visibility,
        )

    @staticmethod
    def _set_cinematic_helper_values(gui, visible: bool) -> None:
        handles = (
            gui.gui_viz_skeleton_checkbox,
            gui.gui_viz_foot_contacts_checkbox,
            gui.gui_viz_hand_orientations_checkbox,
            gui.gui_show_start_direction_checkbox,
            gui.gui_show_timeline_checkbox,
        )
        for handle in handles:
            handle.value = visible

    def _restore_cinematic_viewer(self, client_id: int, session, snapshot: ViewerSnapshot) -> None:
        gui = session.gui_elements
        (
            gui.gui_viz_skeleton_checkbox.value,
            gui.gui_viz_foot_contacts_checkbox.value,
            gui.gui_viz_hand_orientations_checkbox.value,
            gui.gui_show_start_direction_checkbox.value,
            gui.gui_show_timeline_checkbox.value,
        ) = snapshot.helper_visibility
        session.cinematic.preview_enabled = False
        self.set_frame(client_id, snapshot.frame_idx, trigger_by_gui_timeline=True)
        camera = session.client.camera
        camera.position = np.asarray(snapshot.camera_position)
        camera.look_at = np.asarray(snapshot.camera_look_at)
        camera.up_direction = np.asarray(snapshot.camera_up)
        camera.fov = snapshot.camera_fov
        if session.start_direction_marker is not None:
            self._update_start_direction_marker(client_id)
        restored_preview = snapshot.preview_enabled and bool(session.cinematic.shot_plan.keyframes)
        session.cinematic.preview_enabled = restored_preview
        preview_handle = getattr(gui, "gui_cinematic_preview_path", None)
        if preview_handle is not None:
            preview_handle.value = restored_preview
        session.playing = snapshot.playing
