from pathlib import Path

import numpy as np

from ..cinematic_camera import (
    CameraKeyframe,
    CameraPose,
    CinematicCameraError,
    Lens,
    LensPreset,
    OutputFormat,
    OutputFormatPreset,
    ShotPlan,
    Transition,
)
from ..cinematic_paths import CinematicPathError, atomic_write_shot, read_shot_json, resolve_plan_path

REPO_ROOT = Path(__file__).resolve().parents[3]

FORMAT_PRESETS = {
    "16:9 HD": OutputFormatPreset.HD_16_9,
    "2.39:1 Scope": OutputFormatPreset.SCOPE_2_39,
    "1.85:1 Flat": OutputFormatPreset.FLAT_1_85,
    "9:16 Vertical": OutputFormatPreset.VERTICAL_9_16, "1:1 Square": OutputFormatPreset.SQUARE_1_1,
}
LENS_PRESETS = {preset.value: preset for preset in LensPreset}


def build_cinematic_camera_controls(owner, client, client_id: int, g) -> None:
    client.camera.fov = np.radians(float(g.gui_viz_camera_fov_slider.value))
    with client.gui.add_folder("Cinematic Camera", expand_by_default=False):
        g.gui_cinematic_format = client.gui.add_dropdown(
            "Format", options=[*FORMAT_PRESETS, "Custom"], initial_value="16:9 HD"
        )
        g.gui_cinematic_width = client.gui.add_number(
            "Width", initial_value=1920, min=2, max=8192, step=2, visible=False
        )
        g.gui_cinematic_height = client.gui.add_number(
            "Height", initial_value=1080, min=2, max=8192, step=2, visible=False
        )
        g.gui_cinematic_lens = client.gui.add_dropdown(
            "Lens", options=[*LENS_PRESETS, "Custom"], initial_value="Custom"
        )
        g.gui_cinematic_custom_fov = client.gui.add_number(
            "Vertical FOV", initial_value=float(g.gui_viz_camera_fov_slider.value), min=1.0, max=179.0, step=0.1
        )
        g.gui_cinematic_transition = client.gui.add_dropdown(
            "Transition", options=["Smooth", "Cut"], initial_value="Smooth", disabled=True
        )
        g.gui_cinematic_add_key = client.gui.add_button(
            "Add / Replace Key", hint="Store the current viewer camera at this motion frame"
        )
        g.gui_cinematic_remove_key = client.gui.add_button(
            "Remove Key", disabled=True, hint="Remove the camera key at the current motion frame"
        )
        g.gui_cinematic_preview_path = client.gui.add_checkbox(
            "Preview Path", initial_value=False, hint="Drive the camera from saved keys while scrubbing"
        )
        g.gui_cinematic_frame_mask = client.gui.add_checkbox(
            "Show Output Mask", initial_value=True, hint="Hide the viewport area outside the selected output format"
        )
        g.gui_cinematic_key_summary = client.gui.add_markdown("**Camera keys**\n\n_No keys yet._")
        g.gui_cinematic_json_path = client.gui.add_text(
            "Shot JSON", initial_value=".cache/cinematic_shot.json"
        )
        g.gui_cinematic_save = client.gui.add_button("Save Shot")
        g.gui_cinematic_load = client.gui.add_button("Load Shot")
        g.gui_cinematic_output_path = client.gui.add_text(
            "Output MP4", initial_value=".cache/video_export/cinematic.mp4"
        )
        g.gui_cinematic_start_frame = client.gui.add_number("Start Frame", initial_value=0, min=0, step=1)
        g.gui_cinematic_end_frame = client.gui.add_number("End Frame", initial_value=319, min=0, step=1)
        g.gui_cinematic_preview_output = client.gui.add_button(
            "Preview Output Frame", hint="Render one still at the exact selected aspect ratio"
        )
        g.gui_cinematic_render = client.gui.add_button("Render MP4", color="green", disabled=True)
        g.gui_cinematic_cancel = client.gui.add_button(
            "Cancel Render", color="red", visible=False, disabled=True
        )
        g.gui_cinematic_status = client.gui.add_markdown("**Ready**")
        g.gui_cinematic_progress = client.gui.add_progress_bar(0.0, visible=False)
        g.gui_cinematic_preview_image = client.gui.add_image(
            np.zeros((1, 1, 3), dtype=np.uint8), label="Exact output preview", visible=False
        )

    def notify(title: str, body: str, color: str = "red") -> None:
        client.add_notification(title=title, body=body, auto_close_seconds=4.0, color=color)

    def refresh() -> None:
        if not owner.client_active(client_id):
            g.gui_cinematic_remove_key.disabled = g.gui_cinematic_render.disabled = True
            return
        session = owner.client_sessions[client_id]
        keys = session.cinematic.shot_plan.keyframes
        g.gui_cinematic_remove_key.disabled = not any(key.frame == session.frame_idx for key in keys)
        g.gui_cinematic_render.disabled = not keys
        g.gui_cinematic_transition.disabled = not keys
        lines = ["**Camera keys**", *(f"- `{key.frame:04d}` · {key.transition.value.title()}" for key in keys)]
        g.gui_cinematic_key_summary.content = "\n".join(lines) if keys else "**Camera keys**\n\n_No keys yet._"

    def replace_output(output: OutputFormat) -> None:
        session = owner.client_sessions[client_id]
        cinematic = session.cinematic
        cinematic.shot_plan = ShotPlan(
            version=1, output_format=output, keyframes=cinematic.shot_plan.keyframes
        )
        if session.cinematic_frame_mask is not None:
            session.cinematic_frame_mask.set_output_format(output.width, output.height)

    @g.gui_cinematic_format.on_update
    def _(_) -> None:
        if not owner.client_active(client_id):
            return
        selected = g.gui_cinematic_format.value
        custom = selected == "Custom"
        g.gui_cinematic_width.visible = custom
        g.gui_cinematic_height.visible = custom
        if custom:
            return
        output = OutputFormat.from_preset(FORMAT_PRESETS[selected])
        g.gui_cinematic_width.value, g.gui_cinematic_height.value = output.width, output.height
        replace_output(output)

    def update_custom_output() -> None:
        if not owner.client_active(client_id) or g.gui_cinematic_format.value != "Custom":
            return
        try:
            output = OutputFormat.custom(g.gui_cinematic_width.value, g.gui_cinematic_height.value)
        except CinematicCameraError as error:
            notify("Invalid output size", str(error))
            return
        replace_output(output)

    g.gui_cinematic_width.on_update(lambda _: update_custom_output())
    g.gui_cinematic_height.on_update(lambda _: update_custom_output())

    @g.gui_cinematic_frame_mask.on_update
    def _(_) -> None:
        if not owner.client_active(client_id):
            return
        mask = owner.client_sessions[client_id].cinematic_frame_mask
        if mask is not None:
            mask.set_enabled(bool(g.gui_cinematic_frame_mask.value))
    syncing_fov = False

    @g.gui_cinematic_lens.on_update
    def _(_) -> None:
        nonlocal syncing_fov
        if syncing_fov or not owner.client_active(client_id):
            return
        selected = g.gui_cinematic_lens.value
        g.gui_cinematic_custom_fov.visible = selected == "Custom"
        if selected == "Custom":
            g.gui_cinematic_custom_fov.value = float(np.degrees(client.camera.fov))
            return
        degrees = float(np.degrees(Lens.from_preset(LENS_PRESETS[selected]).vertical_fov_radians))
        syncing_fov = True
        try:
            client.camera.fov = np.radians(degrees)
            g.gui_viz_camera_fov_slider.value = degrees
        finally:
            syncing_fov = False

    @g.gui_cinematic_custom_fov.on_update
    def _(_) -> None:
        nonlocal syncing_fov
        if syncing_fov or not owner.client_active(client_id) or g.gui_cinematic_lens.value != "Custom":
            return
        try:
            lens = Lens.from_vertical_fov(np.radians(g.gui_cinematic_custom_fov.value))
        except CinematicCameraError as error:
            notify("Invalid lens", str(error))
            return
        syncing_fov = True
        try:
            client.camera.fov = lens.vertical_fov_radians
            g.gui_viz_camera_fov_slider.value = g.gui_cinematic_custom_fov.value
        finally:
            syncing_fov = False

    @g.gui_viz_camera_fov_slider.on_update
    def _(_) -> None:
        nonlocal syncing_fov
        if syncing_fov:
            return
        syncing_fov = True
        try:
            g.gui_cinematic_lens.value = "Custom"
            g.gui_cinematic_custom_fov.visible = True
            g.gui_cinematic_custom_fov.value = float(g.gui_viz_camera_fov_slider.value)
        finally:
            syncing_fov = False

    @g.gui_cinematic_add_key.on_click
    def _(_) -> None:
        if not owner.client_active(client_id):
            return
        session = owner.client_sessions[client_id]
        if session.frame_idx < 0:
            notify("Invalid frame", "Move to frame 0 or later before adding a camera key.")
            return
        camera = session.client.camera
        try:
            pose = CameraPose.create(
                position=tuple(float(value) for value in camera.position),
                look_at=tuple(float(value) for value in camera.look_at),
                up=tuple(float(value) for value in camera.up_direction),
                vertical_fov_radians=float(camera.fov),
            )
        except CinematicCameraError as error:
            notify("Invalid camera", str(error))
            return
        replaced = any(key.frame == session.frame_idx for key in session.cinematic.shot_plan.keyframes)
        transition = Transition.SMOOTH if g.gui_cinematic_transition.value == "Smooth" else Transition.CUT
        session.cinematic.shot_plan = session.cinematic.shot_plan.add(
            CameraKeyframe(frame=session.frame_idx, pose=pose, transition=transition)
        )
        refresh()
        action = "replaced" if replaced else "added"
        notify(f"Camera key {action}", f"Frame {session.frame_idx}", "green")

    @g.gui_cinematic_remove_key.on_click
    def _(_) -> None:
        if not owner.client_active(client_id):
            return
        session = owner.client_sessions[client_id]
        if not any(key.frame == session.frame_idx for key in session.cinematic.shot_plan.keyframes):
            notify("No camera key", f"Frame {session.frame_idx} has no key to remove.")
            return
        session.cinematic.shot_plan = session.cinematic.shot_plan.remove(session.frame_idx)
        refresh()
        notify("Camera key removed", f"Frame {session.frame_idx}", "green")

    @g.gui_cinematic_preview_path.on_update
    def _(_) -> None:
        if owner.client_active(client_id):
            session = owner.client_sessions[client_id]
            session.cinematic.preview_enabled = g.gui_cinematic_preview_path.value
            if session.cinematic.preview_enabled:
                g.gui_viz_auto_camera_checkbox.value = False
            owner.set_frame(client_id, session.frame_idx)

    @g.gui_cinematic_save.on_click
    def _(_) -> None:
        if not owner.client_active(client_id):
            return
        try:
            roots = getattr(owner, "cinematic_plan_roots", None)
            path = resolve_plan_path(str(g.gui_cinematic_json_path.value), REPO_ROOT, roots)
            atomic_write_shot(path, owner.client_sessions[client_id].cinematic.shot_plan.to_json())
        except CinematicPathError as error:
            notify("Save failed", str(error))
            return
        notify("Shot saved", path.name, "green")

    @g.gui_cinematic_load.on_click
    def _(_) -> None:
        if not owner.client_active(client_id):
            return
        try:
            roots = getattr(owner, "cinematic_plan_roots", None)
            path = resolve_plan_path(str(g.gui_cinematic_json_path.value), REPO_ROOT, roots)
            plan = ShotPlan.from_json(read_shot_json(path))
        except (CinematicPathError, CinematicCameraError) as error:
            notify("Load failed", str(error))
            return
        owner.client_sessions[client_id].cinematic.shot_plan = plan
        mask = owner.client_sessions[client_id].cinematic_frame_mask
        if mask is not None:
            mask.set_output_format(plan.output_format.width, plan.output_format.height)
        g.gui_cinematic_width.value, g.gui_cinematic_height.value = plan.output_format.width, plan.output_format.height
        label = next(
            (name for name, preset in FORMAT_PRESETS.items() if OutputFormat.from_preset(preset) == plan.output_format),
            "Custom",
        )
        g.gui_cinematic_format.value = label
        g.gui_cinematic_width.visible = g.gui_cinematic_height.visible = label == "Custom"
        refresh()
        notify("Shot loaded", path.name, "green")

    g.gui_frame_idx_input.on_update(lambda _: refresh())
    def call_when_active(callback) -> None:
        if owner.client_active(client_id):
            callback(client_id)

    g.gui_cinematic_preview_output.on_click(lambda _: call_when_active(owner.preview_cinematic_output))
    g.gui_cinematic_render.on_click(lambda _: call_when_active(owner.start_cinematic_render))
    g.gui_cinematic_cancel.on_click(lambda _: call_when_active(owner.cancel_cinematic_render))
