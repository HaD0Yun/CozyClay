"""Blender-side bridge for Oh My Blender."""
import os

from .identity import IdentityError, assign_entity_ids, new_project_id
from . import project_store, qa_image_display, ui_panel

bl_info = {
    "name": "Oh My Blender",
    "author": "Oh My Blender",
    "version": (0, 4, 0),
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
    except (OSError, ValueError):
        pass
    return ".".join(str(part) for part in bl_info["version"])


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
    class OMB_OT_initialize_project(bpy.types.Operator):
        bl_idname = "omb.initialize_project"
        bl_label = "Initialize Project"
        bl_options = {"REGISTER", "UNDO"}

        def execute(self, context):
            if not bpy.data.filepath:
                self.report({"ERROR"}, "Save the .blend before initializing the project")
                return {"CANCELLED"}

            scene = context.scene
            project_created = not scene.get("omb.project_id")
            directory = bpy.path.abspath("//")
            try:
                stored = project_store.read_project_index(directory)
                if project_created and stored is not None:
                    raise project_store.ProjectStoreError(
                        ".omb/project.json already exists; use an explicit recovery "
                        "step, not Initialize Project"
                    )
                if stored is not None:
                    project_store.verify_project_ids_match(
                        scene["omb.project_id"], stored.get("project_id")
                    )
            except (project_store.ProjectStoreError, IdentityError) as exc:
                message = (
                    "Scene project_id does not match .omb/project.json; "
                    "use an explicit recovery step, not Initialize Project"
                    if isinstance(exc, IdentityError)
                    else str(exc)
                )
                self.report({"ERROR"}, message)
                return {"CANCELLED"}

            if project_created:
                scene["omb.project_id"] = new_project_id()
                # Adopt pre-existing scene objects (Blender's startup Cube/Camera/Light
                # and anything the user added before initialization) as OMB-owned so the
                # director can modify/delete them through stage_scene. entity_ids are
                # assigned below; ownership is independent of id assignment order.
                # Objects created by later stage_scene ops set omb.owned_project_id themselves.
                project_id = scene["omb.project_id"]
                for obj in scene.objects:
                    if not obj.get("omb.owned_project_id"):
                        obj["omb.owned_project_id"] = project_id

            entities = []
            ordered = []
            for object_index, obj in enumerate(scene.objects):
                key = f"object:{object_index}"
                entities.append((key, obj))
                ordered.append((key, obj.get("omb.entity_id")))
                if obj.type == "ARMATURE":
                    for bone_index, bone in enumerate(obj.data.bones):
                        key = f"bone:{object_index}:{bone_index}"
                        entities.append((key, bone))
                        ordered.append((key, bone.get("omb.entity_id")))

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
                        scene["omb.project_id"],
                        project_created,
                        manifest.extract_scene_manifest_v2(),
                    )
            except (project_store.ProjectStoreError, IdentityError) as exc:
                project_store.restore_property_assignments(originals)
                if project_created:
                    del scene["omb.project_id"]
                self.report({"ERROR"}, str(exc))
                return {"CANCELLED"}
            try:
                if project_created or assignments:
                    project_store.append_journal(
                        directory,
                        {
                            "type": "initialize_project",
                            "project_id": scene["omb.project_id"],
                            "assigned_entity_count": len(assignments),
                        },
                    )
            except project_store.ProjectStoreError as exc:
                if not index_published:
                    project_store.restore_property_assignments(originals)
                    if project_created:
                        del scene["omb.project_id"]
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

    class OMB_OT_repair_ids(bpy.types.Operator):
        bl_idname = "omb.repair_ids"
        bl_label = "Repair IDs"
        bl_options = {"REGISTER", "UNDO"}

        def execute(self, context):
            scene = context.scene
            if not scene.get("omb.project_id"):
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
                    scene["omb.project_id"], stored.get("project_id")
                )
            except ValueError as exc:
                self.report({"ERROR"}, str(exc))
                return {"CANCELLED"}
            entities = []
            ordered = []
            for object_index, obj in enumerate(scene.objects):
                key = f"object:{object_index}"
                entities.append((key, obj))
                ordered.append((key, obj.get("omb.entity_id")))
                if obj.type == "ARMATURE":
                    for bone_index, bone in enumerate(obj.data.bones):
                        key = f"bone:{object_index}:{bone_index}"
                        entities.append((key, bone))
                        ordered.append((key, bone.get("omb.entity_id")))

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
                        "project_id": scene["omb.project_id"],
                        "reassigned": list(assignments),
                    },
                )
            except project_store.ProjectStoreError as exc:
                project_store.restore_property_assignments(originals)
                self.report({"ERROR"}, str(exc))
                return {"CANCELLED"}
            return {"FINISHED"}

    class OMB_OT_connect(bpy.types.Operator):
        bl_idname = "omb.connect"
        bl_label = "Connect"

        def execute(self, context):
            from . import connection, controller_connection
            from .daemon_child import StartupError
            from .ws_client import WebSocketError

            project_id = context.scene.get("omb.project_id")
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
                            "Project is not initialized in .omb/project.json"
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
                    project_directory, ".omb", "pi-bridge.json"
                )
                if os.path.isfile(pi_endpoint):
                    connection.connect_pi_extension(**connect_options)
                else:
                    raise connection.ConnectionError(
                        "No Pi bridge endpoint found at .omb/pi-bridge.json; "
                        "run `omb` in this project so the Pi extension can host the bridge"
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

    class OMB_OT_apply_camera_plan(bpy.types.Operator):
        """Internal protocol-v2 bridge operator; never accepts arbitrary Python."""

        bl_idname = "omb.apply_camera_plan"
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
                project_id = bpy.context.scene.get("omb.project_id")
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

    class OMB_OT_stage_scene(bpy.types.Operator):
        """Internal Pi-driven stage_scene operator; never exposed as a UI button."""

        bl_idname = "omb.stage_scene"
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
                project_id = bpy.context.scene.get("omb.project_id")
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

    class OMB_OT_render_qa_frames(bpy.types.Operator):
        """Internal protocol-v2 QA renderer; never accepts arbitrary paths."""

        bl_idname = "omb.render_qa_frames"
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

    class OMB_PG_panel_chat(bpy.types.PropertyGroup):
        prompt: bpy.props.StringProperty(
            name="Prompt",
            description="Message for the connected Pi director",
            default="",
            maxlen=8192,
        )

    class OMB_OT_send_prompt(bpy.types.Operator):
        bl_idname = "omb.send_prompt"
        bl_label = "Send"
        bl_description = "Send this prompt to the connected Pi director"

        def execute(self, context):
            properties = getattr(context.scene, "omb_panel_chat", None)
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

    class OMB_OT_cancel_turn(bpy.types.Operator):
        bl_idname = "omb.cancel_turn"
        bl_label = "Cancel"
        bl_description = "Request cancellation of the active panel turn"

        def execute(self, _context):
            try:
                ui_panel.cancel_active_turn()
            except ui_panel.PanelActionError as error:
                self.report({"ERROR"}, str(error))
                return {"CANCELLED"}
            return {"FINISHED"}

    class OMB_OT_reconnect_controller(bpy.types.Operator):
        bl_idname = "omb.reconnect_controller"
        bl_label = "Reconnect"
        bl_description = "Retry the Blender controller connection now"

        def execute(self, _context):
            if not ui_panel.reconnect_controller():
                self.report({"WARNING"}, "Controller reconnect is still pending")
                return {"CANCELLED"}
            return {"FINISHED"}

    class OMB_PT_pi_status(bpy.types.Panel):
        """Bridge status and connected Pi conversation controls."""

        bl_idname = "OMB_PT_pi_status"
        bl_label = "Pi Status"
        bl_space_type = "VIEW_3D"
        bl_region_type = "UI"
        bl_category = "Oh My Blender"

        def draw(self, context):
            from . import connection, controller_connection

            ui_panel.draw_panel(
                self.layout,
                context,
                connection._active_connection,
                controller_connection._active_controller,
            )

    class OMB_OT_disconnect(bpy.types.Operator):
        bl_idname = "omb.disconnect"
        bl_label = "Disconnect"

        def execute(self, context):
            from . import connection

            if not connection.disconnect_active("addon_unload"):
                self.report({"INFO"}, "No active connection")
                return {"CANCELLED"}
            return {"FINISHED"}

    _CLASSES = (
        OMB_PG_panel_chat,
        OMB_OT_initialize_project,
        OMB_OT_repair_ids,
        OMB_OT_connect,
        OMB_OT_apply_camera_plan,
        OMB_OT_stage_scene,
        OMB_OT_render_qa_frames,
        OMB_OT_send_prompt,
        OMB_OT_cancel_turn,
        OMB_OT_reconnect_controller,
        OMB_OT_disconnect,
        OMB_PT_pi_status,
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
        if not hasattr(bpy.types.Scene, "omb_panel_chat"):
            bpy.types.Scene.omb_panel_chat = bpy.props.PointerProperty(
                type=OMB_PG_panel_chat
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
        if hasattr(bpy.types.Scene, "omb_panel_chat"):
            del bpy.types.Scene.omb_panel_chat
        connection.disconnect_active("addon_unload")
        while _registered_classes:
            bpy.utils.unregister_class(_registered_classes.pop())
