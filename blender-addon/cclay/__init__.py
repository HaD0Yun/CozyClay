"""Blender-side bridge for CozyClay."""
import os

from .identity import IdentityError, assign_entity_ids, new_project_id
from . import ik_rig, project_store, qa_image_display, ui_panel

# Legacy Blender add-on metadata. The extension manifest
# (blender_manifest.toml) is the single version source of truth; the tuple here
# is not a second add-on version and must not be read as one.
bl_info = {
    "name": "CozyClay",
    "author": "CozyClay",
    "blender": (5, 0, 0),
    "category": "Animation",
}


def _manifest_addon_version() -> str:
    """Single version source of truth: blender_manifest.toml `version`."""
    try:
        import tomllib

        path = os.path.join(os.path.dirname(__file__), "blender_manifest.toml")
        with open(path, "rb") as handle:
            version = tomllib.load(handle).get("version")
        if isinstance(version, str) and version:
            return version
    except (OSError, ValueError) as error:
        raise RuntimeError(
            "cclay add-on is missing or cannot read blender_manifest.toml; "
            "the installed extension is broken"
        ) from error
    raise RuntimeError(
        "cclay blender_manifest.toml carries no version; the installed "
        "extension is broken"
    )


ADDON_VERSION = _manifest_addon_version()

try:  # Blender is intentionally absent from host-side unit tests.
    import bpy  # type: ignore
except ImportError:  # pragma: no cover - exercised by importing this package
    bpy = None


if bpy is not None:
    try:
        from . import manifest
    except ImportError as exc:  # Host-side UI tests omit Blender's mathutils.
        if exc.name != "mathutils":
            raise
        manifest = None
    class CCLAY_OT_initialize_project(bpy.types.Operator):
        bl_idname = "cclay.initialize_project"
        bl_label = "Initialize Project"
        bl_options = {"REGISTER", "UNDO"}

        def execute(self, context):
            if not bpy.data.filepath:
                self.report({"ERROR"}, "Save the .blend before initializing the project")
                return {"CANCELLED"}

            scene = context.scene
            project_created = not scene.get("cclay.project_id")
            directory = bpy.path.abspath("//")
            try:
                stored = project_store.read_project_index(directory)
                if project_created and stored is not None:
                    raise project_store.ProjectStoreError(
                        ".cclay/project.json already exists; use an explicit recovery "
                        "step, not Initialize Project"
                    )
                if stored is not None:
                    project_store.verify_project_ids_match(
                        scene["cclay.project_id"], stored.get("project_id")
                    )
            except (project_store.ProjectStoreError, IdentityError) as exc:
                message = (
                    "Scene project_id does not match .cclay/project.json; "
                    "use an explicit recovery step, not Initialize Project"
                    if isinstance(exc, IdentityError)
                    else str(exc)
                )
                self.report({"ERROR"}, message)
                return {"CANCELLED"}

            if project_created:
                scene["cclay.project_id"] = new_project_id()
                # Adopt pre-existing scene objects (Blender's startup Cube/Camera/Light
                # and anything the user added before initialization) as CCLAY-owned so the
                # director can modify/delete them through stage_scene. entity_ids are
                # assigned below; ownership is independent of id assignment order.
                # Objects created by later stage_scene ops set cclay.owned_project_id themselves.
                project_id = scene["cclay.project_id"]
                for obj in scene.objects:
                    if not obj.get("cclay.owned_project_id"):
                        obj["cclay.owned_project_id"] = project_id

            entities = []
            ordered = []
            for object_index, obj in enumerate(scene.objects):
                key = f"object:{object_index}"
                entities.append((key, obj))
                ordered.append((key, obj.get("cclay.entity_id")))
                if obj.type == "ARMATURE":
                    for bone_index, bone in enumerate(obj.data.bones):
                        key = f"bone:{object_index}:{bone_index}"
                        entities.append((key, bone))
                        ordered.append((key, bone.get("cclay.entity_id")))

            assignments = project_store.repair_entity_ids(ordered)
            originals = project_store.apply_property_assignments(
                dict(entities), assignments
            )
            index_published = False
            try:
                if stored is None or "current_revision_id" not in stored:
                    if manifest is None:
                        raise project_store.ProjectStoreError(
                            "Scene manifest extraction is unavailable"
                        )
                    index_published = project_store.prepare_project_index(
                        directory,
                        scene["cclay.project_id"],
                        project_created,
                        manifest.extract_scene_manifest_v2(),
                    )
            except (project_store.ProjectStoreError, IdentityError) as exc:
                project_store.restore_property_assignments(originals)
                if project_created:
                    del scene["cclay.project_id"]
                self.report({"ERROR"}, str(exc))
                return {"CANCELLED"}
            try:
                if project_created or assignments:
                    project_store.append_journal(
                        directory,
                        {
                            "type": "initialize_project",
                            "project_id": scene["cclay.project_id"],
                            "assigned_entity_count": len(assignments),
                        },
                    )
            except project_store.ProjectStoreError as exc:
                if not index_published:
                    project_store.restore_property_assignments(originals)
                    if project_created:
                        del scene["cclay.project_id"]
                    self.report({"ERROR"}, str(exc))
                else:
                    self.report(
                        {"WARNING"},
                        f"{exc}; project document was committed and remains initialized",
                    )
                return {"CANCELLED"}
            if not project_created and not assignments:
                self.report({"INFO"}, "Project already initialized; no new IDs assigned")
            return {"FINISHED"}

    class CCLAY_OT_repair_ids(bpy.types.Operator):
        bl_idname = "cclay.repair_ids"
        bl_label = "Repair IDs"
        bl_options = {"REGISTER", "UNDO"}

        def execute(self, context):
            scene = context.scene
            if not scene.get("cclay.project_id"):
                self.report({"ERROR"}, "Initialize the project before repairing IDs")
                return {"CANCELLED"}
            if not bpy.data.filepath:
                self.report({"ERROR"}, "Save the .blend before repairing IDs")
                return {"CANCELLED"}
            directory = bpy.path.abspath("//")
            try:
                stored = project_store.read_project_index(directory)
                if stored is None:
                    raise project_store.ProjectStoreError(
                        "Initialize the project before repairing IDs"
                    )
                project_store.verify_project_ids_match(
                    scene["cclay.project_id"], stored.get("project_id")
                )
            except ValueError as exc:
                self.report({"ERROR"}, str(exc))
                return {"CANCELLED"}
            entities = []
            ordered = []
            for object_index, obj in enumerate(scene.objects):
                key = f"object:{object_index}"
                entities.append((key, obj))
                ordered.append((key, obj.get("cclay.entity_id")))
                if obj.type == "ARMATURE":
                    for bone_index, bone in enumerate(obj.data.bones):
                        key = f"bone:{object_index}:{bone_index}"
                        entities.append((key, bone))
                        ordered.append((key, bone.get("cclay.entity_id")))

            assignments = project_store.repair_entity_ids(ordered)
            if not assignments:
                self.report({"INFO"}, "No entity IDs need repair")
                return {"CANCELLED"}

            entities_by_key = dict(entities)
            originals = project_store.apply_property_assignments(
                entities_by_key, assignments
            )
            try:
                project_store.append_journal(
                    directory,
                    {
                        "type": "repair_ids",
                        "project_id": scene["cclay.project_id"],
                        "reassigned": list(assignments),
                    },
                )
            except project_store.ProjectStoreError as exc:
                project_store.restore_property_assignments(originals)
                self.report({"ERROR"}, str(exc))
                return {"CANCELLED"}
            return {"FINISHED"}

    class CCLAY_OT_connect(bpy.types.Operator):
        bl_idname = "cclay.connect"
        bl_label = "Connect"

        def execute(self, context):
            from . import connection, controller_connection
            from .daemon_child import StartupError
            from .ws_client import WebSocketError

            project_id = context.scene.get("cclay.project_id")
            if not project_id:
                self.report({"ERROR"}, "Initialize and save the project before connecting")
                return {"CANCELLED"}
            project_directory = bpy.path.abspath("//")
            try:
                active = connection._active_connection
                if active is not None and active.state in connection.RECONNECTABLE_STATES:
                    stored = project_store.read_project_index(project_directory)
                    if stored is None:
                        raise project_store.ProjectStoreError(
                            "Project is not initialized in .cclay/project.json"
                        )
                    project_store.verify_project_ids_match(
                        project_id, stored.get("project_id")
                    )
                else:
                    project_store.verify_connect_precondition(
                        project_directory, project_id, bpy.data.is_dirty
                    )
                connect_options = {
                    "cwd": project_directory,
                    "project_id": project_id,
                    "addon_version": ADDON_VERSION,
                    "blender_version": bpy.app.version_string,
                }
                pi_endpoint = os.path.join(
                    project_directory, ".cclay", "pi-bridge.json"
                )
                if os.path.isfile(pi_endpoint):
                    connection.connect_pi_extension(**connect_options)
                else:
                    raise connection.ConnectionError(
                        "No Pi bridge endpoint found at .cclay/pi-bridge.json; "
                        "run `cclay` in this project so the Pi extension can host the bridge"
                    )
            except (
                project_store.ProjectStoreError,
                IdentityError,
                connection.ConnectionError,
                StartupError,
                controller_connection.ControllerConnectionError,
                WebSocketError,
            ) as exc:
                self.report({"ERROR"}, str(exc))
                return {"CANCELLED"}
            return {"FINISHED"}

    class CCLAY_OT_apply_camera_plan(bpy.types.Operator):
        """Internal protocol-v2 bridge operator; never accepts arbitrary Python."""

        bl_idname = "cclay.apply_camera_plan"
        bl_label = "Apply Camera Plan"
        bl_options = {"INTERNAL"}

        plan_json: bpy.props.StringProperty(options={"HIDDEN"})
        current_scene_hash: bpy.props.StringProperty(options={"HIDDEN"})
        bridge_id: bpy.props.StringProperty(options={"HIDDEN"})
        request_id: bpy.props.StringProperty(options={"HIDDEN"})
        deadline_ms: bpy.props.IntProperty(default=30_000, min=1, options={"HIDDEN"})

        def execute(self, _context):
            import json
            import time
            import uuid

            from . import camera_plan, connection

            active = connection._active_connection
            if (
                active is None
                or active.state != connection.LifecycleState.ACTIVE
                or not active.tools_exposed
            ):
                self.report({"ERROR"}, "No verified active daemon connection")
                return {"CANCELLED"}
            try:
                plan = json.loads(self.plan_json)
            except (TypeError, ValueError) as exc:
                self.report({"ERROR"}, f"Invalid camera plan JSON: {exc}")
                return {"CANCELLED"}

            deadline = time.monotonic() + self.deadline_ms / 1000
            active.update_task_progress("mutating", 0, 1)
            active._send_json({
                "type": "bridge_progress",
                "id": self.bridge_id,
                "request_id": self.request_id,
                "phase": "mutating",
                "completed": 0,
                "total": 1,
            })

            def commit(result):
                active.update_task_progress("durable_commit", 1, 1)
                active._send_json({
                    "type": "bridge_progress",
                    "id": self.bridge_id,
                    "request_id": self.request_id,
                    "phase": "durable_commit",
                    "completed": 1,
                    "total": 1,
                })
                if (
                    connection.TRANSACTION_COMMIT_CAPABILITY
                    not in active.capabilities
                    or not bpy.data.filepath
                ):
                    return active.await_durable_bridge_commit(
                        self.bridge_id,
                        self.request_id,
                        result,
                        deadline,
                    )
                project_id = bpy.context.scene.get("cclay.project_id")
                if not isinstance(project_id, str):
                    raise connection.ConnectionError(
                        "prepared transaction requires a saved project-bound blend"
                    )
                transaction_id = str(uuid.uuid4())

                def save_blend(path):
                    outcome = bpy.ops.wm.save_as_mainfile(
                        filepath=str(path), check_existing=False
                    )
                    if "FINISHED" not in outcome:
                        raise connection.ConnectionError(
                            "candidate blend save did not finish"
                        )

                return active.commit_prepared_transaction(
                    bridge_id=self.bridge_id,
                    request_id=self.request_id,
                    transaction_id=transaction_id,
                    operation="apply_camera_plan",
                    project_id=project_id,
                    base_revision_id=plan["expected_revision_id"],
                    base_scene_hash=self.current_scene_hash,
                    candidate_revision_id=result["manifest"]["revisionId"],
                    candidate_scene_hash=result["scene_hash"],
                    canonical_blend_path=bpy.data.filepath,
                    result=result,
                    save_blend=save_blend,
                    read_blend_project_id=lambda _path: project_id,
                    deadline=deadline,
                )

            def complete(result, error):
                active.finish_bridge(self.bridge_id)
                if error is None:
                    revision_id = (
                        result.get("manifest", {}).get("revisionId")
                        if isinstance(result, dict)
                        else None
                    )
                    active.finish_task("success", revision_id=revision_id)
                    return
                code = getattr(error, "code", type(error).__name__)
                if code == "CAMERA_PLAN_CANCELLED":
                    active.finish_task("cancelled")
                elif isinstance(
                    error, connection.DurableCommitReconciliationRequired
                ):
                    active.finish_task("recovery_required")
                else:
                    active.finish_task("error", code=code)
                if (
                    active.websocket.closed
                    or isinstance(error, connection.ConnectionError)
                ):
                    return
                active._send_json({
                    "type": "bridge_error",
                    "id": self.bridge_id,
                    "request_id": self.request_id,
                    "code": code,
                    "message": str(error),
                    "retryable": False,
                })

            try:
                result = camera_plan.apply_camera_plan_transaction(
                    plan,
                    self.current_scene_hash,
                    active,
                    commit,
                    deadline=deadline,
                    cancelled=lambda: active.is_bridge_cancelled(self.bridge_id),
                )
                complete(result, None)
            except BaseException as error:
                complete(None, error)
            return {"FINISHED"}

    class CCLAY_OT_stage_scene(bpy.types.Operator):
        """Internal Pi-driven stage_scene operator; never exposed as a UI button."""

        bl_idname = "cclay.stage_scene"
        bl_label = "Stage Scene"
        bl_options = {"INTERNAL"}

        plan_json: bpy.props.StringProperty(options={"HIDDEN"})
        current_scene_hash: bpy.props.StringProperty(options={"HIDDEN"})
        bridge_id: bpy.props.StringProperty(options={"HIDDEN"})
        request_id: bpy.props.StringProperty(options={"HIDDEN"})
        deadline_ms: bpy.props.IntProperty(
            default=30_000, min=1, max=30_000, options={"HIDDEN"}
        )

        def execute(self, _context):
            import json
            import time
            import uuid

            from . import connection, stage_scene

            active = connection._active_connection
            if (
                active is None
                or active.state != connection.LifecycleState.ACTIVE
                or not active.tools_exposed
            ):
                self.report({"ERROR"}, "No verified active daemon connection")
                return {"CANCELLED"}
            try:
                plan = json.loads(self.plan_json)
            except (TypeError, ValueError) as exc:
                self.report({"ERROR"}, f"Invalid stage scene JSON: {exc}")
                return {"CANCELLED"}

            deadline = time.monotonic() + min(self.deadline_ms, 30_000) / 1000
            operation_count = len(plan.get("operations", ()))
            active.update_task_progress("mutating", 0, operation_count)
            active._send_json({
                "type": "bridge_progress",
                "id": self.bridge_id,
                "request_id": self.request_id,
                "phase": "mutating",
                "completed": 0,
                "total": operation_count,
            })

            def commit(result):
                active.update_task_progress("durable_commit", 1, 1)
                active._send_json({
                    "type": "bridge_progress",
                    "id": self.bridge_id,
                    "request_id": self.request_id,
                    "phase": "durable_commit",
                    "completed": 1,
                    "total": 1,
                })
                if (
                    connection.TRANSACTION_COMMIT_CAPABILITY
                    not in active.capabilities
                    or not bpy.data.filepath
                ):
                    return active.await_durable_bridge_commit(
                        self.bridge_id,
                        self.request_id,
                        result,
                        deadline,
                    )
                project_id = bpy.context.scene.get("cclay.project_id")
                if not isinstance(project_id, str):
                    raise connection.ConnectionError(
                        "prepared transaction requires a saved project-bound blend"
                    )
                transaction_id = str(uuid.uuid4())

                def save_blend(path):
                    outcome = bpy.ops.wm.save_as_mainfile(
                        filepath=str(path), check_existing=False
                    )
                    if "FINISHED" not in outcome:
                        raise connection.ConnectionError(
                            "candidate blend save did not finish"
                        )

                return active.commit_prepared_transaction(
                    bridge_id=self.bridge_id,
                    request_id=self.request_id,
                    transaction_id=transaction_id,
                    operation="stage_scene",
                    project_id=project_id,
                    base_revision_id=plan["expected_revision_id"],
                    base_scene_hash=self.current_scene_hash,
                    candidate_revision_id=result["manifest"]["revisionId"],
                    candidate_scene_hash=result["scene_hash"],
                    canonical_blend_path=bpy.data.filepath,
                    result=result,
                    save_blend=save_blend,
                    read_blend_project_id=lambda _path: project_id,
                    deadline=deadline,
                )

            def complete(result, error):
                active.finish_bridge(self.bridge_id)
                if error is None:
                    revision_id = (
                        result.get("manifest", {}).get("revisionId")
                        if isinstance(result, dict)
                        else None
                    )
                    active.finish_task("success", revision_id=revision_id)
                    return
                code = getattr(error, "code", type(error).__name__)
                if code == "STAGE_SCENE_CANCELLED":
                    active.finish_task("cancelled")
                elif isinstance(
                    error, connection.DurableCommitReconciliationRequired
                ):
                    active.finish_task("recovery_required")
                else:
                    active.finish_task("error", code=code)
                if (
                    active.websocket.closed
                    or isinstance(error, connection.ConnectionError)
                ):
                    return
                active._send_json({
                    "type": "bridge_error",
                    "id": self.bridge_id,
                    "request_id": self.request_id,
                    "code": code,
                    "message": str(error),
                    "retryable": False,
                })

            try:
                result = stage_scene.apply_stage_scene_transaction(
                    plan,
                    self.current_scene_hash,
                    active,
                    commit,
                    deadline=deadline,
                    cancelled=lambda: active.is_bridge_cancelled(self.bridge_id),
                )
                complete(result, None)
            except BaseException as error:
                complete(None, error)
            return {"FINISHED"}

    class CCLAY_OT_render_qa_frames(bpy.types.Operator):
        """Internal protocol-v2 QA renderer; never accepts arbitrary paths."""

        bl_idname = "cclay.render_qa_frames"
        bl_label = "Render QA Frames"
        bl_options = {"INTERNAL"}

        request_json: bpy.props.StringProperty(options={"HIDDEN"})
        current_scene_hash: bpy.props.StringProperty(options={"HIDDEN"})
        bridge_id: bpy.props.StringProperty(options={"HIDDEN"})
        request_id: bpy.props.StringProperty(options={"HIDDEN"})
        deadline_ms: bpy.props.IntProperty(default=30_000, min=1, max=30_000, options={"HIDDEN"})

        def execute(self, _context):
            import json
            import time

            from . import connection, qa_render

            active = connection._active_connection
            if (
                active is None
                or active.state != connection.LifecycleState.ACTIVE
                or not active.tools_exposed
            ):
                self.report({"ERROR"}, "No verified active daemon connection")
                return {"CANCELLED"}
            try:
                request = json.loads(self.request_json)
            except (TypeError, ValueError) as exc:
                self.report({"ERROR"}, f"Invalid QA render request JSON: {exc}")
                return {"CANCELLED"}

            deadline = time.monotonic() + min(self.deadline_ms, 30_000) / 1000
            active.update_task_progress(
                "rendering",
                0,
                len(request.get("frames", ())),
            )
            active._send_json({
                "type": "bridge_progress",
                "id": self.bridge_id,
                "request_id": self.request_id,
                "phase": "rendering",
                "completed": 0,
                "total": len(request.get("frames", ())),
            })
            try:
                result = qa_render.render_qa_frames_transaction(
                    request,
                    self.current_scene_hash,
                    deadline=deadline,
                    cancelled=lambda: active.is_bridge_cancelled(self.bridge_id),
                    progress=active.update_task_progress,
                )
                prepared_frames = [
                    qa_render.split_frame_for_bridge(frame_result)
                    for frame_result in result["frames"]
                ]
                # Fail before streaming a single chunk when the result message
                # cannot cross the bounded WebSocket link.
                qa_render.ensure_bridge_result_fits({
                    **result,
                    "frames": [metadata for metadata, _begin, _chunks in prepared_frames],
                })
                metadata_frames = []
                total = len(prepared_frames)
                active._send_json({
                    "type": "bridge_artifact_batch_begin",
                    "id": self.bridge_id,
                    "request_id": self.request_id,
                    "frames": [begin for _metadata, begin, _chunks in prepared_frames],
                })
                for completed, (metadata, _begin, chunks) in enumerate(
                    prepared_frames, start=1
                ):
                    for chunk in chunks:
                        if active.is_bridge_cancelled(self.bridge_id):
                            raise qa_render.RENDER_QA_CANCELLED(
                                "render QA was cancelled during artifact streaming"
                            )
                        active._send_json({
                            "type": "bridge_artifact_chunk",
                            "id": self.bridge_id,
                            "request_id": self.request_id,
                            **chunk,
                        })
                    metadata_frames.append(metadata)
                    active._send_json({
                        "type": "bridge_progress",
                        "id": self.bridge_id,
                        "request_id": self.request_id,
                        "phase": "publishing",
                        "completed": completed,
                        "total": total,
                    })
                    active.update_task_progress("publishing", completed, total)
                active._send_json({
                    "type": "bridge_result",
                    "id": self.bridge_id,
                    "request_id": self.request_id,
                    "result": {**result, "frames": metadata_frames},
                })
                active.finish_task("success", frames=metadata_frames)
            except BaseException as error:
                code = getattr(error, "code", type(error).__name__)
                if code == "RENDER_QA_CANCELLED":
                    active.finish_task("cancelled")
                else:
                    active.finish_task("error", code=code)
                if not active.websocket.closed:
                    active._send_json({
                        "type": "bridge_error",
                        "id": self.bridge_id,
                        "request_id": self.request_id,
                        "code": getattr(error, "code", type(error).__name__),
                        "message": str(error),
                        "retryable": False,
                    })
            finally:
                active.finish_bridge(self.bridge_id)
            return {"FINISHED"}

    class CCLAY_PG_panel_chat(bpy.types.PropertyGroup):
        prompt: bpy.props.StringProperty(
            name="Prompt",
            description="Message for the connected Pi director",
            default="",
            maxlen=8192,
        )

    class CCLAY_OT_send_prompt(bpy.types.Operator):
        bl_idname = "cclay.send_prompt"
        bl_label = "Send"
        bl_description = "Send this prompt to the connected Pi director"

        def execute(self, context):
            properties = getattr(context.scene, "cclay_panel_chat", None)
            prompt = "" if properties is None else properties.prompt
            try:
                ui_panel.submit_prompt(prompt, bpy.path.abspath("//"))
            except (
                project_store.ProjectStoreError,
                ui_panel.PanelActionError,
            ) as error:
                self.report({"ERROR"}, str(error))
                return {"CANCELLED"}
            properties.prompt = ""
            return {"FINISHED"}

    class CCLAY_OT_cancel_turn(bpy.types.Operator):
        bl_idname = "cclay.cancel_turn"
        bl_label = "Cancel"
        bl_description = "Request cancellation of the active panel turn"

        def execute(self, _context):
            try:
                ui_panel.cancel_active_turn()
            except ui_panel.PanelActionError as error:
                self.report({"ERROR"}, str(error))
                return {"CANCELLED"}
            return {"FINISHED"}

    class CCLAY_OT_reconnect_controller(bpy.types.Operator):
        bl_idname = "cclay.reconnect_controller"
        bl_label = "Reconnect"
        bl_description = "Retry the Blender controller connection now"

        def execute(self, _context):
            if not ui_panel.reconnect_controller():
                self.report({"WARNING"}, "Controller reconnect is still pending")
                return {"CANCELLED"}
            return {"FINISHED"}

    class CCLAY_PT_pi_status(bpy.types.Panel):
        """Bridge status and connected Pi conversation controls."""

        bl_idname = "CCLAY_PT_pi_status"
        bl_label = "Pi Status"
        bl_space_type = "VIEW_3D"
        bl_region_type = "UI"
        bl_category = "CozyClay"

        def draw(self, context):
            from . import connection, controller_connection

            ui_panel.draw_panel(
                self.layout,
                context,
                connection._active_connection,
                controller_connection._active_controller,
            )

    def _filter_to_constraint_lanes(context, armature):
        """Show only the six ARDY constraint marker lanes.

        Mixamo FK and dense IK target/pole curves remain in the action because
        they drive the pose; this only simplifies the editor view. A stock
        workspace starts in Timeline mode, so promote those editors to Dope
        Sheet mode instead of asking for another manual setup step.
        """
        from . import constraint_timeline

        shown = constraint_timeline.lane_labels(armature)
        editors = []
        for screen in bpy.data.screens:
            for area in screen.areas:
                if area.type != "DOPESHEET_EDITOR":
                    continue
                space = area.spaces.active
                if getattr(space, "mode", None) == "TIMELINE":
                    space.mode = "DOPESHEET"
                if (
                    getattr(space, "mode", None) == "DOPESHEET"
                    and getattr(space, "dopesheet", None) is not None
                ):
                    editors.append((area, space.dopesheet))
        for area, dopesheet in editors:
            dopesheet.filter_text = constraint_timeline.CHANNEL_FILTER
            dopesheet.show_only_selected = False
            area.tag_redraw()
        return shown, len(editors)

    def _enable_auto_key(context):
        settings = getattr(context.scene, "tool_settings", None)
        if settings is None or settings.use_keyframe_insert_auto:
            return False
        settings.use_keyframe_insert_auto = True
        return True

    class CCLAY_OT_attach_ik_rig(bpy.types.Operator):
        bl_idname = "cclay.attach_ik_rig"
        bl_label = "Enable Constraint Editing"
        bl_description = (
            "Set up Full-Body, 2D Root, left/right hand and left/right foot "
            "constraint lanes in one step; the underlying motion stays unchanged"
        )
        bl_options = {"REGISTER", "UNDO"}

        def execute(self, context):
            armature = context.active_object
            try:
                report = ik_rig.attach(armature)
            except ik_rig.IkRigError as error:
                self.report({"ERROR"}, str(error))
                return {"CANCELLED"}

            filtered_lanes = ()
            filtered_editors = 0
            try:
                filtered_lanes, filtered_editors = _filter_to_constraint_lanes(
                    context, armature
                )
            except Exception as error:  # view setup must not undo a valid rig
                self.report(
                    {"WARNING"},
                    f"IK layer attached, but the lane-only view failed: {error}",
                )
            keyed = _enable_auto_key(context)
            lane_error = report.get("constraintLaneError")
            if lane_error:
                self.report(
                    {"WARNING"},
                    f"IK layer attached, but constraint lanes failed: {lane_error}",
                )

            extra = "".join(
                (
                    f"; {len(filtered_lanes)} lanes shown"
                    if filtered_editors
                    else "; open a Dope Sheet to see the six lanes",
                    "; Auto Keying on" if keyed else "",
                )
            )
            # The deviation is the proof that attaching changed nothing, so it
            # belongs in front of the animator rather than in a log.
            self.report(
                {"INFO"},
                f"IK handles on {report['frameEnd'] - report['frameStart'] + 1} frames, "
                f"worst deviation {report['worstMidDeviationMm']:.3f} mm" + extra,
            )
            return {"FINISHED"}

    # Keeping and discarding are separate operators rather than one carrying a
    # boolean: discarding throws away work, so it must be its own named action
    # an animator cannot reach by leaving a checkbox in the wrong state.
    class CCLAY_OT_detach_ik_rig(bpy.types.Operator):
        bl_idname = "cclay.detach_ik_rig"
        bl_label = "Detach IK Rig, Keep Edits"
        bl_description = (
            "Remove the IK handles, baking whatever was posed back onto the bones "
            "the motion drives"
        )
        bl_options = {"REGISTER", "UNDO"}

        def execute(self, context):
            try:
                report = ik_rig.detach(context.active_object, keep_edits=True)
            except ik_rig.IkRigError as error:
                self.report({"ERROR"}, str(error))
                return {"CANCELLED"}
            self.report({"INFO"}, f"Baked {report['bakedFrames']} frames back to FK")
            return {"FINISHED"}

    # Marking is deliberately its own step rather than a side effect of moving a
    # handle: attach() keys every handle on every frame, so "the animator moved
    # this" and "the animator meant this" are different facts and only the
    # second one belongs in a generation request.
    class CCLAY_OT_mark_constraint(bpy.types.Operator):
        bl_idname = "cclay.mark_constraint"
        bl_label = "Mark ARDY Constraint"
        bl_description = (
            "Commit the current frame as an ARDY constraint of the chosen kind, so "
            "regeneration is asked to honour this pose here"
        )
        bl_options = {"REGISTER", "UNDO"}

        # A plain string, not an enum: the panel draws one button per kind and
        # sets this explicitly, so an enum would only duplicate that list, and
        # constraint_capture already refuses a kind it does not know.
        kind: bpy.props.StringProperty(name="Kind", default="RightHand")

        def execute(self, context):
            from . import constraint_capture

            frame = context.scene.frame_current
            try:
                constraint_capture.mark_constraint(context.active_object, self.kind, frame)
            except constraint_capture.ConstraintCaptureError as error:
                self.report({"ERROR"}, str(error))
                return {"CANCELLED"}
            self.report({"INFO"}, f"Marked {self.kind} at frame {frame}")
            return {"FINISHED"}

    class CCLAY_OT_clear_constraint(bpy.types.Operator):
        bl_idname = "cclay.clear_constraint"
        bl_label = "Clear ARDY Constraint"
        bl_description = "Drop the constraint of this kind on the current frame"
        bl_options = {"REGISTER", "UNDO"}

        kind: bpy.props.StringProperty(name="Kind", default="RightHand")

        def execute(self, context):
            from . import constraint_capture

            frame = context.scene.frame_current
            try:
                constraint_capture.clear_constraint(context.active_object, self.kind, frame)
            except constraint_capture.ConstraintCaptureError as error:
                self.report({"ERROR"}, str(error))
                return {"CANCELLED"}
            self.report({"INFO"}, f"Cleared {self.kind} at frame {frame}")
            return {"FINISHED"}

    class CCLAY_OT_request_constraint_regeneration(bpy.types.Operator):
        bl_idname = "cclay.request_constraint_regeneration"
        bl_label = "Regenerate From Constraints"
        bl_description = (
            "Hand the committed constraints to the host so ARDY regenerates "
            "the clip. The IK handles are removed and the whole action is "
            "replaced by the result"
        )
        bl_options = {"REGISTER"}

        def execute(self, context):
            import time

            from . import constraint_capture, project_store

            armature = context.active_object
            project_directory = bpy.path.abspath("//")
            try:
                stored = project_store.read_project_index(project_directory)
            except project_store.ProjectStoreError as error:
                self.report({"ERROR"}, str(error))
                return {"CANCELLED"}
            if stored is None or not stored.get("current_revision_id"):
                self.report(
                    {"ERROR"},
                    "Project is not initialized in .cclay/project.json",
                )
                return {"CANCELLED"}
            entity_id = None if armature is None else armature.get("cclay.entity_id")
            if not entity_id:
                self.report({"ERROR"}, "Select a character owned by this project")
                return {"CANCELLED"}
            request_id = constraint_capture.new_request_id()
            try:
                # Capture first: the constraints live on the IK handles, so
                # they have to be read before detach removes them. Only once
                # the payload is complete is the rig collapsed and the request
                # published, which is why the host never sees a request whose
                # scene state is still mid-change.
                payload = constraint_capture.capture_regeneration_request(
                    armature,
                    context.scene,
                    project_directory=project_directory,
                    entity_id=str(entity_id),
                    expected_revision_id=str(stored["current_revision_id"]),
                    request_id=request_id,
                    requested_at_ms=int(time.time() * 1000),
                )
                if not (
                    payload["effectors"] or payload["full_body"] or payload["root_2d"]
                ):
                    self.report({"ERROR"}, "Mark at least one constraint first")
                    return {"CANCELLED"}
                # Remembered before detach, because detach removes the anchor
                # bones the marker curves live on. Without it the constraints
                # disappear the moment the new clip replaces the action, and a
                # second pass would have to be marked from scratch.
                marks = constraint_capture.marked_frames_by_kind(armature)
                ik_rig.detach(armature, keep_edits=True)
                constraint_capture.write_request(project_directory, payload)
                constraint_capture.record_pending_request(armature, request_id, marks)
            except (
                constraint_capture.ConstraintCaptureError,
                ik_rig.IkRigError,
                OSError,
            ) as error:
                self.report({"ERROR"}, str(error))
                return {"CANCELLED"}
            self.report(
                {"INFO"},
                f"Requested regeneration from {len(payload['effectors'])} effector, "
                f"{len(payload['full_body'])} pose and {len(payload['root_2d'])} path "
                "constraints",
            )
            return {"FINISHED"}

    class CCLAY_OT_apply_regeneration_outcome(bpy.types.Operator):
        bl_idname = "cclay.apply_regeneration_outcome"
        bl_label = "Apply Regeneration Result"
        bl_description = (
            "Read the host's answer for the pending request, then put the IK "
            "handles and the constraints back on the regenerated clip"
        )
        bl_options = {"REGISTER", "UNDO"}

        def execute(self, context):
            from . import constraint_capture

            armature = context.active_object
            project_directory = bpy.path.abspath("//")
            try:
                pending = constraint_capture.read_pending_request(armature)
                if pending is None:
                    self.report({"ERROR"}, "No regeneration is pending on this object")
                    return {"CANCELLED"}
                outcome = constraint_capture.read_outcome(
                    project_directory, pending["request_id"]
                )
                if outcome is None:
                    self.report({"INFO"}, "The host has not answered yet")
                    return {"CANCELLED"}
                scene = context.scene
                failed = outcome["status"] == "failed"
                # Both paths put the rig back the way the animator left it.
                # Returning early on failure used to strand them: the panel
                # keys off the pending record, so it showed only this button,
                # and this button kept hitting the same permanent failure --
                # no handles, no way to edit, no way to ask again.
                if not ik_rig.has_ik_layer(armature):
                    ik_rig.attach(armature, scene.frame_start, scene.frame_end)
                restored = constraint_capture.restore_constraints(
                    armature, scene, pending["marks"]
                )
                constraint_capture.clear_pending_request(armature)
                # The answer has been acted on; leaving it would make the next
                # request with a recycled id read a stale verdict.
                constraint_capture.discard_outcome(
                    project_directory, pending["request_id"]
                )
                if failed:
                    # WARNING, not ERROR: the regeneration failed but this
                    # operator did its own job, which was to hand the rig back
                    # intact. Reporting ERROR alongside FINISHED also makes
                    # bpy.ops raise, which misreports a successful recovery.
                    self.report(
                        {"WARNING"},
                        f"Regeneration failed ({outcome['error_code']}): "
                        f"{outcome['message']}. Handles and "
                        f"{restored} constraints restored; edit and try again",
                    )
                    return {"FINISHED"}
            except (
                constraint_capture.ConstraintCaptureError,
                ik_rig.IkRigError,
            ) as error:
                self.report({"ERROR"}, str(error))
                return {"CANCELLED"}
            result = outcome["result"]
            achieved = result.get("achieved_error_m")
            # Both numbers are reported and neither gates: the plan is explicit
            # that the regenerated clip is always accepted and the animator
            # judges it. Continuity is compared against the clip immediately
            # before this one, because each regeneration becomes the next
            # one's base and that is where drift accumulates.
            jump = (result.get("continuity") or {}).get("max_jump_m")
            warning = constraint_capture.continuity_warning(
                constraint_capture.previous_continuity(armature), jump
            )
            constraint_capture.record_continuity(armature, jump)
            if warning is not None:
                self.report({"WARNING"}, warning)
            self.report(
                {"INFO"},
                f"Applied {result['motion_id']} ({result['frames']} frames, "
                f"achieved error {achieved}); restored {restored} constraints",
            )
            return {"FINISHED"}

    class CCLAY_OT_discard_ik_rig(bpy.types.Operator):
        bl_idname = "cclay.discard_ik_rig"
        bl_label = "Detach IK Rig, Discard Edits"
        bl_description = (
            "Remove the IK handles and throw away every IK edit, restoring the "
            "motion exactly as it was generated"
        )
        bl_options = {"REGISTER", "UNDO"}

        def execute(self, context):
            try:
                ik_rig.detach(context.active_object, keep_edits=False)
            except ik_rig.IkRigError as error:
                self.report({"ERROR"}, str(error))
                return {"CANCELLED"}
            self.report({"INFO"}, "Discarded the IK edits")
            return {"FINISHED"}

    class CCLAY_PT_ik_rig(bpy.types.Panel):
        """Manual IK handles over a generated motion clip."""

        bl_idname = "CCLAY_PT_ik_rig"
        bl_label = "IK Rig"
        bl_space_type = "VIEW_3D"
        bl_region_type = "UI"
        bl_category = "CozyClay"

        def draw(self, context):
            layout = self.layout
            armature = context.active_object
            if armature is None or armature.type != "ARMATURE":
                layout.label(text="Select a character armature", icon="INFO")
                return
            if ik_rig.has_ik_layer(armature):
                layout.label(text="IK handles attached", icon="CHECKMARK")
                column = layout.column(align=True)
                column.operator(
                    "cclay.detach_ik_rig", text="Detach, Keep Edits", icon="KEYFRAME_HLT"
                )
                column.operator(
                    "cclay.discard_ik_rig", text="Detach, Discard Edits", icon="TRASH"
                )
                layout.label(text="Drag CCLAY-IK-TGT-* to pose, POLE-* to set bend")
                # An un-keyed pose is discarded the moment the frame is
                # re-evaluated, which looks exactly like the tool not working.
                layout.label(text="Key the handle (I) or the edit is lost", icon="ERROR")
            else:
                layout.operator("cclay.attach_ik_rig", icon="CON_KINEMATIC")

    class CCLAY_PT_ardy_constraints(bpy.types.Panel):
        """Frames the animator has committed as ARDY generation constraints."""

        bl_idname = "CCLAY_PT_ardy_constraints"
        bl_label = "ARDY Constraints"
        bl_space_type = "VIEW_3D"
        bl_region_type = "UI"
        bl_category = "CozyClay"
        bl_parent_id = "CCLAY_PT_ik_rig"

        def draw(self, context):
            from . import constraint_capture

            layout = self.layout
            armature = context.active_object
            if armature is None or armature.type != "ARMATURE":
                layout.label(text="Select a character armature", icon="INFO")
                return
            # Checked before the IK-layer gate: publishing a request detaches
            # the layer, so the animator is looking at a rig with no handles
            # exactly when they need the button that puts them back.
            try:
                pending = constraint_capture.read_pending_request(armature)
            except constraint_capture.ConstraintCaptureError as error:
                layout.label(text=str(error), icon="ERROR")
                pending = None
            if pending is not None:
                layout.label(text="Regeneration requested", icon="SORTTIME")
                layout.operator(
                    "cclay.apply_regeneration_outcome", icon="IMPORT"
                )
                return
            if not ik_rig.has_ik_layer(armature):
                layout.label(text="Attach the IK layer first", icon="INFO")
                return

            frame = context.scene.frame_current
            for kind in constraint_capture.ANCHOR_BY_KIND:
                try:
                    frames = constraint_capture.marked_frames(armature, kind)
                except constraint_capture.ConstraintCaptureError:
                    continue
                row = layout.row(align=True)
                row.label(text=kind)
                if frame in frames:
                    row.operator(
                        "cclay.clear_constraint", text="", icon="KEYFRAME_HLT"
                    ).kind = kind
                else:
                    row.operator("cclay.mark_constraint", text="", icon="KEYFRAME").kind = kind
                # The frame list is the constraint list; showing it is the only
                # way to see what regeneration will actually be asked for.
                row.label(text=", ".join(str(value) for value in frames) or "-")
            layout.separator()
            layout.operator(
                "cclay.request_constraint_regeneration", icon="FILE_REFRESH"
            )
            # Regeneration replaces the action outright, so the handles and any
            # unconstrained hand-tuning between them do not survive it.
            layout.label(text="Replaces the whole clip and detaches IK", icon="ERROR")

    class CCLAY_OT_disconnect(bpy.types.Operator):
        bl_idname = "cclay.disconnect"
        bl_label = "Disconnect"

        def execute(self, context):
            from . import connection

            if not connection.disconnect_active("addon_unload"):
                self.report({"INFO"}, "No active connection")
                return {"CANCELLED"}
            return {"FINISHED"}

    _CLASSES = (
        CCLAY_PG_panel_chat,
        CCLAY_OT_initialize_project,
        CCLAY_OT_repair_ids,
        CCLAY_OT_connect,
        CCLAY_OT_apply_camera_plan,
        CCLAY_OT_stage_scene,
        CCLAY_OT_render_qa_frames,
        CCLAY_OT_send_prompt,
        CCLAY_OT_cancel_turn,
        CCLAY_OT_reconnect_controller,
        CCLAY_OT_attach_ik_rig,
        CCLAY_OT_detach_ik_rig,
        CCLAY_OT_discard_ik_rig,
        CCLAY_OT_mark_constraint,
        CCLAY_OT_clear_constraint,
        CCLAY_OT_request_constraint_regeneration,
        CCLAY_OT_apply_regeneration_outcome,
        CCLAY_OT_disconnect,
        CCLAY_PT_pi_status,
        CCLAY_PT_ik_rig,
        CCLAY_PT_ardy_constraints,
    )
else:
    _CLASSES = ()
_registered_classes: list[type] = []
_lifecycle_timer_registered = False


def _pump_lifecycle() -> float:
    from . import connection, controller_connection

    connection.poll_active_bridge_reconnect()
    lifecycle_interval = controller_connection.poll_controller_lifecycle()
    panel_interval = ui_panel.pump_controller_panel()
    return min(lifecycle_interval, panel_interval)


def register() -> None:
    """Register operators and the add-on connection lifecycle timer."""
    global _lifecycle_timer_registered
    if bpy is not None:
        for cls in _CLASSES:
            if cls not in _registered_classes:
                bpy.utils.register_class(cls)
                _registered_classes.append(cls)
        if not hasattr(bpy.types.Scene, "cclay_panel_chat"):
            bpy.types.Scene.cclay_panel_chat = bpy.props.PointerProperty(
                type=CCLAY_PG_panel_chat
            )
        timers = getattr(bpy.app, "timers", None)
        if (
            timers is not None
            and not _lifecycle_timer_registered
            and not timers.is_registered(_pump_lifecycle)
        ):
            timers.register(_pump_lifecycle, first_interval=0.0)
            _lifecycle_timer_registered = True


def unregister() -> None:
    global _lifecycle_timer_registered
    if bpy is not None:
        from . import connection

        timers = getattr(bpy.app, "timers", None)
        if (
            timers is not None
            and _lifecycle_timer_registered
            and timers.is_registered(_pump_lifecycle)
        ):
            timers.unregister(_pump_lifecycle)
        _lifecycle_timer_registered = False
        ui_panel.reset_panel_state()
        qa_image_display.cleanup_qa_images()
        if hasattr(bpy.types.Scene, "cclay_panel_chat"):
            del bpy.types.Scene.cclay_panel_chat
        connection.disconnect_active("addon_unload")
        while _registered_classes:
            bpy.utils.unregister_class(_registered_classes.pop())
