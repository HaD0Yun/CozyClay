"""Blender-side bridge for CozyClay."""
import os

from .identity import IdentityError, assign_entity_ids, new_project_id
from . import character_target, ik_rig, project_store, qa_image_display, ui_panel

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
            if "cclay.allow_execute_blender_python" not in scene:
                scene["cclay.allow_execute_blender_python"] = True
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
                        manifest.extract_scene_manifest_v4(),
                        scene["cclay.allow_execute_blender_python"],
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
            from . import connection

            project_id = context.scene.get("cclay.project_id")
            if not project_id:
                self.report({"ERROR"}, "Initialize and save the project before connecting")
                return {"CANCELLED"}
            project_directory = bpy.path.abspath("//")
            try:
                project_store.verify_connect_precondition(
                    project_directory, project_id, bpy.data.is_dirty
                )
                connection.start_blender_server(project_directory, ADDON_VERSION)
            except (
                project_store.ProjectStoreError,
                IdentityError,
                connection.ConnectionError,
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
                or not active.bridge_requests_allowed
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

        def execute(self, context):
            import json
            import time
            import uuid

            from . import connection, stage_scene

            active = connection._active_connection
            if (
                active is None
                or active.state != connection.LifecycleState.ACTIVE
                or not active.bridge_requests_allowed
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
            else:
                # A staged motion the animator cannot see reads as a motion that
                # was never applied: Only Show Selected leaves every animation
                # editor blank until a bone is picked, and nothing selects one.
                # This is editor state, so it stays out of stage_scene's
                # transaction and runs here, after the commit, where it cannot
                # roll anything back. Gated on a motion actually landing: a
                # light or material plan has no keys to reveal and no business
                # touching the animator's filters.
                if any(
                    operation.get("op") == "apply_motion"
                    for operation in plan.get("operations", ())
                ):
                    _show_all_keys()
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
                or not active.bridge_requests_allowed
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

    # Every surface below acts on an armature, but clicking a character in the
    # viewport selects one of its skinned meshes. Resolving through the mesh is
    # what makes "select the character, press the button" work; reading
    # active_object directly made the panels refuse the most natural selection
    # a character has. The reason comes back with it so a refusal names the
    # actual problem instead of repeating one generic sentence.
    def _character_of(context):
        return character_target.resolve_character(
            getattr(context, "active_object", None)
        )

    # Not an operator poll(): poll makes bpy.ops raise for a caller that is not
    # the panel, and every one of these has to answer a script with a status
    # and a message the same way it answers a button.
    def _require_character(operator, context):
        armature, reason = _character_of(context)
        if armature is None:
            operator.report({"ERROR"}, reason)
        return armature

    # Attaching, detaching and grabbing a handle all make the armature active
    # and switch its mode, and Blender refuses that for an object outside the
    # view layer -- select_set raises outright rather than returning False, so
    # without this the operator dies as a traceback instead of a report. An
    # excluded collection is the ordinary way to get there. Marking and
    # clearing touch only pose data and keep working, so they use the plain
    # gate above rather than this one.
    def _require_editable_character(operator, context):
        armature = _require_character(operator, context)
        if armature is None:
            return None
        if context.view_layer.objects.get(armature.name) is not armature:
            operator.report(
                {"ERROR"},
                f"{armature.name} is not in this view layer; "
                "re-enable its collection first",
            )
            return None
        return armature

    # Blender ships the Timeline with Only Show Selected enabled, and in Pose
    # Mode that filter draws keys for the selected bones only. An animator who
    # has just staged a motion has no bone selected yet, so the timeline is
    # blank even though the armature holds every key of the clip -- the motion
    # reads as lost. Clearing the filter is what puts the whole body's keys on
    # screen, and the whole body is what an IK adjustment is aimed at.
    def _key_hiding_filters():
        """Animation-editor filters currently hiding unselected keys.

        Matched on the filter itself rather than on an allowlist of editor
        types. Measured in Blender 5.2, the Dope Sheet, Graph Editor and NLA
        editor all carry this same filter and nothing else does; the Graph
        Editor is where curves get tuned after an IK edit, so listing editor
        types leaves the identical blank-editor symptom reachable one tab over.

        Walks ``bpy.data.screens`` rather than the open windows. A window only
        ever exposes the ONE screen it is currently showing, and a stock .blend
        carries five animation editors spread across the Animation,
        Compositing, Geometry Nodes, Layout and Rendering workspaces. Clearing
        only the visible one left the Animation tab -- the tab an animator
        opens to work on keys -- still blank, which is exactly how this was
        reported.
        """
        for screen in bpy.data.screens:
            for area in screen.areas:
                dopesheet = getattr(area.spaces.active, "dopesheet", None)
                if getattr(dopesheet, "show_only_selected", False):
                    yield dopesheet

    def _show_all_keys():
        """Clear that filter everywhere. Returns the number of editors changed."""
        # Materialised before assigning: the generator's own predicate is the
        # attribute being written, so a lazy walk would skip editors.
        hidden = tuple(_key_hiding_filters())
        for dopesheet in hidden:
            dopesheet.show_only_selected = False
        return len(hidden)

    class CCLAY_OT_show_character_keys(bpy.types.Operator):
        bl_idname = "cclay.show_character_keys"
        bl_label = "Show All Character Keys"
        bl_description = (
            "Clear the timeline's Only Show Selected filter so the whole "
            "character's keyframes are drawn, not just the selected bone's"
        )
        # No UNDO: this writes editor filter state, which Blender's undo stack
        # does not carry, so registering an undo step would offer the animator
        # a step back that does nothing.
        bl_options = {"REGISTER"}

        def execute(self, context):
            cleared = _show_all_keys()
            # FINISHED either way: this asks for a state, not for a change, and
            # the state holds when nothing needed clearing. Reporting CANCELLED
            # would tell a bpy.ops caller the keys are still hidden when they
            # are not.
            if cleared == 0:
                self.report({"INFO"}, "Every key was already drawn")
            else:
                self.report(
                    {"INFO"}, f"Every key is now drawn ({cleared} editors)"
                )
            return {"FINISHED"}

    # ARDY shows constraints as one named lane per kind. So does the Dope Sheet,
    # once the marker curves sit in groups carrying those names -- and it does
    # it with real keyframes, so selection, G, X, copy/paste, channel locking
    # and undo all work without this add-on implementing any of them.
    # The animator's own channel search, borrowed while the lanes are shown.
    # Keyed by the area's runtime pointer rather than by its index in
    # screen.areas: splitting, joining or reordering editors renumbers that
    # index, and the memo would then be handed to a DIFFERENT Dope Sheet -- or
    # to none, silently discarding what they were searching for. In memory
    # rather than on the Screen, because a pointer means nothing after a
    # reload; hide_constraint_lanes handles a missing memo without destroying
    # anything.
    _lane_filter_memo: dict = {}
    def _prune_lane_memo(context):
        """Forget memos for editors that no longer exist.

        A pointer identifies an area only while that area is alive; once it is
        closed or joined the entry is unreachable, and a later area can be
        allocated at the same address and inherit a search that was never its
        own.
        """
        live = {
            area.as_pointer()
            for screen in bpy.data.screens
            for area in screen.areas
        }
        for pointer in tuple(_lane_filter_memo):
            if pointer not in live:
                del _lane_filter_memo[pointer]

    def _lane_editors(context):
        """Dope Sheet editors that can show channels.

        A DOPESHEET_EDITOR in TIMELINE mode draws no channel list at all, so
        the lanes would be invisible there and Blender's own delete operator
        cancels rather than removing a mark. Editors are matched on the mode
        they are in, not merely on their type.
        """
        for screen in bpy.data.screens:
            for area_index, area in enumerate(screen.areas):
                if area.type != "DOPESHEET_EDITOR":
                    continue
                space = area.spaces.active
                if getattr(space, "mode", None) != "DOPESHEET":
                    continue
                if getattr(space, "dopesheet", None) is None:
                    continue
                yield screen, area, space, area.as_pointer(), area_index

    def _filter_to_constraint_lanes(context, armature):
        """Show only the six ARDY marker lanes in every open Dope Sheet.

        IK target, pole and Mixamo curves remain in the action because they
        drive the pose; this is a view filter, not destructive curve deletion.
        Returning the lane labels and editor count lets both the explicit Show
        operator and the one-click IK setup report the state they produced.
        """
        from . import constraint_timeline

        shown = constraint_timeline.lane_labels(armature)
        _prune_lane_memo(context)
        editors = tuple(_lane_editors(context))
        if not editors:
            # A stock workspace carries a Timeline, not a Dope Sheet, so a
            # one-click setup would otherwise finish with no visible lanes and
            # ask the animator to reconfigure an editor manually. Promote the
            # Timeline on every workspace; only Attach calls this helper
            # automatically, while the explicit Show operator keeps its
            # non-invasive legacy behaviour. Converting every screen matters:
            # otherwise Layout looks correct and switching to Animation brings
            # the full unfiltered hierarchy back.
            for screen in bpy.data.screens:
                for area in screen.areas:
                    if area.type != "DOPESHEET_EDITOR":
                        continue
                    space = area.spaces.active
                    if getattr(space, "mode", None) == "TIMELINE":
                        space.mode = "DOPESHEET"
            editors = tuple(_lane_editors(context))
        for _screen, area, space, memo, _index in editors:
            dopesheet = space.dopesheet
            if dopesheet.filter_text != constraint_timeline.CHANNEL_FILTER:
                _lane_filter_memo[memo] = (
                    dopesheet.filter_text,
                    dopesheet.show_only_selected,
                )
            dopesheet.filter_text = constraint_timeline.CHANNEL_FILTER
            dopesheet.show_only_selected = False
            area.tag_redraw()
        return shown, len(editors)

    class CCLAY_OT_show_constraint_lanes(bpy.types.Operator):
        bl_idname = "cclay.show_constraint_lanes"
        bl_label = "Show Constraint Lanes"
        bl_description = (
            "Name the constraint marks as Dope Sheet channels, one lane per "
            "kind, and filter the editor down to them"
        )
        # No UNDO: like show_character_keys this writes editor filter state,
        # which Blender's undo stack does not carry. The grouping it also does
        # IS on the undo stack, so an undo would half-revert it; the operator
        # is its own inverse instead, via hide_constraint_lanes.
        #
        # No UNDO, and deliberately no data mutation either. An earlier
        # revision backfilled marker curves here and declared UNDO to cover
        # them, which made one operator span both Blender's undo stack (the
        # curves) and editor state it does not carry (the filter): a Ctrl+Z
        # could remove the lanes and leave the editor filtered to nothing.
        # Backfilling is now its own operator, and this one only filters.
        bl_options = {"REGISTER"}

        def execute(self, context):
            from . import constraint_capture, constraint_timeline

            armature = _require_character(self, context)
            if armature is None:
                return {"CANCELLED"}
            try:
                # Read-only: grouping is a persistent action change and belongs
                # to attach and to the backfill operator, both of which are
                # undoable. This operator only filters an editor.
                shown = constraint_timeline.lane_labels(armature)
            except (
                constraint_timeline.ConstraintTimelineError,
                constraint_capture.ConstraintCaptureError,
            ) as error:
                self.report({"ERROR"}, str(error))
                return {"CANCELLED"}

            # Pruned here too, not only in Hide: Show is what grows the map,
            # and an area closed after a Show that was never hidden would
            # otherwise leave an entry a reused pointer could inherit.
            _prune_lane_memo(context)
            editors = tuple(_lane_editors(context))
            if not editors:
                # Naming the lanes still happened and is worth keeping, but the
                # animator would see nothing, so say where to look rather than
                # silently succeeding.
                self.report(
                    {"WARNING"},
                    "Lanes named, but no Dope Sheet is open - switch an editor "
                    "to Dope Sheet (the Animation workspace has one)",
                )
                return {"FINISHED"}

            # context.window is empty when the operator is driven from a
            # script rather than clicked, and the expansion below needs a real
            # window to override onto.
            window = getattr(context, "window", None)
            if window is None:
                windows = getattr(context.window_manager, "windows", ())
                window = windows[0] if len(windows) else None
            for screen, area, space, memo, index in editors:
                dopesheet = space.dopesheet
                # Remember whatever the animator was searching for, so turning
                # the lanes off gives it back instead of clearing their work.
                # Only on the first run: a second run must not remember the
                # filter this operator itself installed.
                # Remember whatever is there whenever it is not already our
                # own filter. Keying this on "no memo yet" instead meant that
                # an animator who typed a new search while the lanes were up
                # and pressed Show again had it silently dropped, and Hide
                # later restored the OLDER text over it.
                if dopesheet.filter_text != constraint_timeline.CHANNEL_FILTER:
                    _lane_filter_memo[memo] = (
                        dopesheet.filter_text,
                        dopesheet.show_only_selected,
                    )
                dopesheet.filter_text = constraint_timeline.CHANNEL_FILTER
                # Only Show Selected is on by default and hides every lane
                # until an anchor bone happens to be selected -- which it never
                # is right after attach, so the animator is shown an empty
                # editor and concludes the feature is broken. Measured: with it
                # on, the filter matched and only the Summary row drew; with it
                # off, all six lanes appeared. It is borrowed, not commandeered:
                # the memo above carries it back.
                dopesheet.show_only_selected = False
                area.tag_redraw()

            if not shown:
                # Lanes exist from the moment the rig is attached, so an empty
                # list here means the rig predates them, not that nothing is
                # marked. Say the thing that leads somewhere.
                self.report(
                    {"INFO"},
                    "No lanes on this rig yet - press Add Missing Lanes",
                )
            else:
                self.report({"INFO"}, "Lanes: " + ", ".join(shown))
            return {"FINISHED"}

    # Ghosts: how many marks are worth standing up at once. Each one is a real
    # object the depsgraph evaluates every frame, and a rig with fifty marks
    # would otherwise turn Show into a stall the animator cannot interrupt.
    GHOST_LIMIT = 12
    # Whether Show had to borrow the scene's object-mode lock, and what it was.
    # Runtime only: it describes a viewing session, not the document.
    _GHOST_MODE_LOCK: dict = {}

    class CCLAY_OT_show_constraint_ghosts(bpy.types.Operator):
        bl_idname = "cclay.show_constraint_ghosts"
        bl_label = "Show Marked Poses"
        bl_description = (
            "Stand up an editable copy of the rig at every marked frame, so a "
            "constrained pose can be edited with its IK handles from here"
        )
        # Creates real objects, so it is undoable.
        bl_options = {"REGISTER", "UNDO"}

        def execute(self, context):
            from . import constraint_capture, constraint_ghost

            armature = _require_editable_character(self, context)
            if armature is None:
                return {"CANCELLED"}
            # A mark deleted with Blender's own X leaves a ghost behind that
            # stands for nothing. Clear those before counting, or the limit is
            # spent on poses that are no longer constrained.
            constraint_ghost.prune_stale_ghosts(armature)
            wanted = [
                (kind, frame)
                for kind, frames in constraint_capture.marked_frames_by_anchor(
                    armature
                ).items()
                for frame in frames
            ]
            if not wanted:
                self.report(
                    {"INFO"},
                    "No marks yet - mark a frame first, then its pose can be shown",
                )
                return {"CANCELLED"}
            capped = sorted(wanted)[:GHOST_LIMIT]
            made = []
            try:
                for kind, frame in capped:
                    made.append(constraint_ghost.create_ghost(armature, kind, frame).name)
            except constraint_ghost.ConstraintGhostError as error:
                self.report({"ERROR"}, str(error))
                return {"CANCELLED"}
            # Blender locks interaction to the object whose mode you are in,
            # and it defaults to ON -- measured. In Pose Mode on the live rig
            # that makes every ghost unclickable, which is the whole feature.
            # Borrowed, not commandeered: Hide gives it back.
            tool_settings = context.scene.tool_settings
            if tool_settings.lock_object_mode:
                _GHOST_MODE_LOCK[context.scene.name] = True
                tool_settings.lock_object_mode = False
            if len(wanted) > len(capped):
                self.report(
                    {"WARNING"},
                    f"Showing the first {len(capped)} of {len(wanted)} marks",
                )
            else:
                self.report(
                    {"INFO"},
                    f"Showing {len(made)} marked poses - click one, then pose it",
                )
            return {"FINISHED"}

    class CCLAY_OT_dismiss_constraint_ghosts(bpy.types.Operator):
        bl_idname = "cclay.dismiss_constraint_ghosts"
        bl_label = "Hide Marked Poses"
        bl_description = "Remove every editable copy of a marked frame"
        bl_options = {"REGISTER", "UNDO"}

        def execute(self, context):
            from . import constraint_ghost

            armature = _require_editable_character(self, context)
            if armature is None:
                return {"CANCELLED"}
            removed = constraint_ghost.remove_all_ghosts(armature)
            # Give the mode lock back, but only if Show is what turned it off.
            # An animator who cleared it themselves keeps it cleared.
            if _GHOST_MODE_LOCK.pop(context.scene.name, False):
                context.scene.tool_settings.lock_object_mode = True
            # FINISHED either way: this asks for a state, and a scene with no
            # ghosts is already in it.
            self.report({"INFO"}, f"Removed {len(removed)} marked poses")
            return {"FINISHED"}

    class CCLAY_OT_edit_constraint_ghost(bpy.types.Operator):
        bl_idname = "cclay.edit_constraint_ghost"
        bl_label = "Edit"
        bl_description = (
            "Select this marked pose and enter Pose Mode on it, ready to drag "
            "its IK handles"
        )
        bl_options = {"REGISTER", "UNDO"}

        kind: bpy.props.StringProperty(name="Kind", default="")
        frame: bpy.props.IntProperty(name="Frame", default=0)

        def execute(self, context):
            from . import constraint_ghost

            armature = _require_editable_character(self, context)
            if armature is None:
                return {"CANCELLED"}
            ghost = constraint_ghost._find_ghost(armature, self.kind, self.frame)
            if ghost is None:
                self.report(
                    {"ERROR"},
                    f"no {self.kind} pose is shown for frame {self.frame}",
                )
                return {"CANCELLED"}
            # Ghosts look exactly like the rig, so picking one out of the
            # viewport by eye is the hunt this whole feature exists to remove.
            # Getting from "that frame" to "posing that frame" is one click.
            if context.mode != "OBJECT":
                bpy.ops.object.mode_set(mode="OBJECT")
            for other in context.view_layer.objects:
                other.select_set(other is ghost)
            context.view_layer.objects.active = ghost
            bpy.ops.object.mode_set(mode="POSE")
            self.report(
                {"INFO"},
                f"Posing {self.kind} at frame {self.frame} - drag a handle, "
                "then Apply Pose To Its Frame",
            )
            return {"FINISHED"}

    class CCLAY_OT_commit_constraint_ghost(bpy.types.Operator):
        bl_idname = "cclay.commit_constraint_ghost"
        bl_label = "Apply Pose To Its Frame"
        bl_description = (
            "Write the selected marked pose back onto its own frame, without "
            "moving the playhead or touching any other frame"
        )
        bl_options = {"REGISTER", "UNDO"}

        def execute(self, context):
            from . import constraint_ghost

            ghost = context.active_object
            if not constraint_ghost.is_ghost(ghost):
                # Naming the thing to select beats "invalid selection": the
                # ghosts are on screen and look exactly like the rig.
                self.report(
                    {"ERROR"},
                    "Select a marked pose first - they are named CCLAY-GHOST-<kind>-<frame>",
                )
                return {"CANCELLED"}
            try:
                written = constraint_ghost.commit_ghost(ghost)
            except constraint_ghost.ConstraintGhostError as error:
                self.report({"ERROR"}, str(error))
                return {"CANCELLED"}
            self.report(
                {"INFO"},
                f"Wrote the {written['kind']} pose onto frame {written['frame']}",
            )
            return {"FINISHED"}

    class CCLAY_OT_marks_checked(bpy.types.Operator):
        bl_idname = "cclay.marks_checked"
        bl_label = "Marks Checked"
        bl_description = (
            "Confirm the constraint marks still carry the poses you intended, "
            "after a period with Auto Keying off"
        )
        bl_options = {"REGISTER", "UNDO"}

        def execute(self, context):
            if _auto_key_is_off(context):
                # Acknowledging while it is still off would be cleared again by
                # the next timer tick, which would read as the button not
                # working. Say what to do instead.
                self.report(
                    {"ERROR"},
                    "Turn Auto Keying on first, or the lapse is still running",
                )
                return {"CANCELLED"}
            if context.scene.get(AUTOKEY_LAPSED):
                del context.scene[AUTOKEY_LAPSED]
            # FINISHED either way: this asks for a state, and a scene that never
            # lapsed is already in it.
            self.report({"INFO"}, "Marks accepted; regeneration is unblocked")
            return {"FINISHED"}

    class CCLAY_OT_backfill_constraint_lanes(bpy.types.Operator):
        bl_idname = "cclay.backfill_constraint_lanes"
        bl_label = "Add Missing Lanes"
        bl_description = (
            "Give every constraint kind a Dope Sheet lane on a rig attached "
            "before lanes existed, without rebuilding the rig"
        )
        # A real data change on the rig, so it is undoable -- and separate from
        # Show, which only filters an editor and cannot be undone. Splitting
        # them is what keeps either one from half-reverting the other.
        bl_options = {"REGISTER", "UNDO"}

        def execute(self, context):
            from . import constraint_capture, constraint_timeline

            armature = _require_editable_character(self, context)
            if armature is None:
                return {"CANCELLED"}
            try:
                created = constraint_capture.ensure_marker_curves(armature)
                constraint_timeline.ensure_lanes(armature)
            except (
                constraint_capture.ConstraintCaptureError,
                constraint_timeline.ConstraintTimelineError,
            ) as error:
                self.report({"ERROR"}, str(error))
                return {"CANCELLED"}
            # FINISHED either way: this asks for a state, and a rig that
            # already has all six lanes is already in it.
            if created:
                self.report({"INFO"}, "Added lanes: " + ", ".join(created))
            else:
                self.report({"INFO"}, "Every constraint already has a lane")
            return {"FINISHED"}

    class CCLAY_OT_hide_constraint_lanes(bpy.types.Operator):
        bl_idname = "cclay.hide_constraint_lanes"
        bl_label = "Show All Channels"
        bl_description = (
            "Stop filtering the Dope Sheet down to the constraint lanes and "
            "restore whatever channel search was there before"
        )
        bl_options = {"REGISTER"}

        def execute(self, context):
            from . import constraint_timeline

            restored = 0
            for _screen, area, space, memo, _index in _lane_editors(context):
                if space.dopesheet.filter_text != constraint_timeline.CHANNEL_FILTER:
                    # The animator has typed something since the lanes went up.
                    # It is theirs now: restoring the memo over it would delete
                    # what they just wrote, which is what an earlier revision
                    # did. Drop the memo and leave the editor alone.
                    _lane_filter_memo.pop(memo, None)
                    continue
                if memo in _lane_filter_memo:
                    text, only_selected = _lane_filter_memo.pop(memo)
                    space.dopesheet.filter_text = text
                    # Show borrowed this too. Leaving it off would quietly
                    # change how every OTHER animation this editor shows is
                    # filtered, long after the lanes were dismissed.
                    space.dopesheet.show_only_selected = only_selected
                else:
                    # No memo, and the filter is unmistakably the one this
                    # add-on installs. Clearing it is the only way it does not
                    # strand across a reload, which is when the memo is gone.
                    space.dopesheet.filter_text = ""
                restored += 1
                area.tag_redraw()
            _prune_lane_memo(context)
            # FINISHED either way, for the reason show_character_keys is: this
            # asks for a state, and the state holds when there was nothing to
            # restore.
            self.report({"INFO"}, f"Channel filter restored ({restored} editors)")
            return {"FINISHED"}

    # Blender keys a posed bone when Auto Keying is on, and does not when it is
    # off. This add-on shipped with it untouched, so dragging an IK handle keyed
    # nothing and the drag was discarded the moment the frame was re-evaluated
    # -- behaviour no other bone in Blender has. The panel papered over it with
    # a warning telling the animator to hurry. Turning Blender's own switch on
    # is what makes a handle behave like a bone.
    def _auto_key_is_off(context):
        tool_settings = getattr(context.scene, "tool_settings", None)
        return tool_settings is not None and not tool_settings.use_keyframe_insert_auto

    def _enable_auto_key(context):
        """Turn on Blender's Auto Keying. Returns whether it had been off."""
        tool_settings = getattr(context.scene, "tool_settings", None)
        if tool_settings is None or tool_settings.use_keyframe_insert_auto:
            return False
        tool_settings.use_keyframe_insert_auto = True
        return True

    class CCLAY_OT_enable_auto_key(bpy.types.Operator):
        bl_idname = "cclay.enable_auto_key"
        bl_label = "Keep My Edits (Auto Key)"
        bl_description = (
            "Turn on Blender's Auto Keying so moving an IK handle keys it, "
            "instead of the move being discarded on the next frame change"
        )
        # UNDO is right here, unlike the timeline filter: this is a scene tool
        # setting, which Blender's undo stack does carry.
        bl_options = {"REGISTER", "UNDO"}

        def execute(self, context):
            # FINISHED either way: this asks for a state, and the state holding
            # already is not a failure.
            if _enable_auto_key(context):
                self.report({"INFO"}, "Auto Keying on: handle moves are kept")
            else:
                self.report({"INFO"}, "Auto Keying was already on")
            return {"FINISHED"}

    class CCLAY_OT_attach_ik_rig(bpy.types.Operator):
        bl_idname = "cclay.attach_ik_rig"
        bl_label = "Enable Constraint Editing"
        bl_description = (
            "Set up Full-Body, 2D Root, left/right hand and left/right foot "
            "constraint lanes in one step; the underlying motion stays unchanged"
        )
        bl_options = {"REGISTER", "UNDO"}

        def execute(self, context):
            armature = _require_editable_character(self, context)
            if armature is None:
                return {"CANCELLED"}
            try:
                report = ik_rig.attach(armature)
            except ik_rig.IkRigError as error:
                self.report({"ERROR"}, str(error))
                return {"CANCELLED"}
            # The generated FK curves and the dense IK target/pole keys are
            # implementation detail. They must stay in the action to drive the
            # pose, but the animator only needs the six marker lanes: Full-Body,
            # 2D Root, and the four limb effectors. Attach therefore installs
            # that filter immediately instead of first revealing thousands of
            # curves and requiring a second Show Constraint Lanes click.
            filtered_lanes = ()
            filtered_editors = 0
            filter_error = None
            try:
                filtered_lanes, filtered_editors = _filter_to_constraint_lanes(
                    context, armature
                )
            except Exception as error:  # a view failure must not undo the rig
                filter_error = str(error)
            # Handles are for dragging, and in Blender a dragged bone is only
            # kept when Auto Keying is on. Attaching without it hands the
            # animator a control whose edits vanish on the next frame change.
            keyed = _enable_auto_key(context)
            # attach() creates one empty Dope Sheet channel per constraint kind
            # so all six ARDY lanes exist immediately; the count is reported
            # because a lane the animator cannot see is one they will not use.
            lanes = report.get("constraintLanes", ())
            lane_error = report.get("constraintLaneError")
            if lane_error:
                # The rig is attached and usable; only the lanes failed. Saying
                # so beats a silent absence, and Add Missing Lanes can fix it.
                self.report(
                    {"WARNING"},
                    f"IK layer attached, but constraint lanes failed: {lane_error}",
                )
            # The deviation is the proof that attaching changed nothing, so it
            # belongs in front of the animator rather than in a log.
            if filter_error:
                self.report(
                    {"WARNING"},
                    f"IK layer attached, but the lane-only view failed: {filter_error}",
                )
            extra = "".join(
                (
                    f"; {len(filtered_lanes)} lanes shown"
                    if filtered_editors
                    else "; open a Dope Sheet to see the six lanes",
                    "; Auto Keying on" if keyed else "",
                    f"; {len(lanes)} constraint lanes" if lanes else "",
                )
            )
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
            armature = _require_editable_character(self, context)
            if armature is None:
                return {"CANCELLED"}
            try:
                report = ik_rig.detach(armature, keep_edits=True)
            except ik_rig.IkRigError as error:
                self.report({"ERROR"}, str(error))
                return {"CANCELLED"}
            self.report({"INFO"}, f"Baked {report['bakedFrames']} frames back to FK")
            return {"FINISHED"}

    # Marking is deliberately its own step rather than a side effect of moving a
    # handle: attach() keys every handle on every frame, so "the animator moved
    # this" and "the animator meant this" are different facts and only the
    # second one belongs in a generation request.
    # The IK handles carry object scale 0.01, so a Blender unit here is a
    # centimetre of character. A tenth of a unit is a millimetre -- far below
    # anything an animator moves on purpose, and far above float noise from
    # evaluating a curve at a frame it already has a key on.
    _UNKEYED_TOLERANCE = 0.1

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
            from . import constraint_capture, motion_constraints

            armature = _require_character(self, context)
            if armature is None:
                return {"CANCELLED"}
            frame = context.scene.frame_current
            try:
                # Refused here rather than inside the capture: the clip range is
                # already knowable, and a mark outside it otherwise survives
                # until Regenerate, which detaches the rig and publishes a
                # request before the conversion rejects the frame.
                clip = constraint_capture.base_clip_of(armature, backfill=False)
                motion_constraints.scene_frame_to_clip_frame(
                    frame, clip["start_frame"], clip["frame_count"]
                )
                # A handle dragged but never keyed is not in the curves, and the
                # request is built by scrubbing to the frame and reading what
                # the curves give back -- so marking now would commit the pose
                # the animator can see they replaced. Marking used to re-key the
                # handle here to cover this, which made placing a dot silently
                # edit the pose and left clearing the dot unable to undo it.
                drifted = constraint_capture.unkeyed_pose(
                    armature, frame, _UNKEYED_TOLERANCE
                )
                if drifted:
                    self.report(
                        {"ERROR"},
                        f"{', '.join(drifted)} moved but not keyed; press I to key "
                        "the pose, or turn Auto Keying on",
                    )
                    return {"CANCELLED"}
                constraint_capture.mark_constraint(armature, self.kind, frame)
            except (
                constraint_capture.ConstraintCaptureError,
                motion_constraints.MotionConstraintError,
            ) as error:
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

            armature = _require_character(self, context)
            if armature is None:
                return {"CANCELLED"}
            frame = context.scene.frame_current
            # Deliberately unguarded by the clip range that gates marking: a
            # mark left outside the range by an earlier clip must stay
            # removable, or the rig is stuck with a constraint it cannot use
            # and cannot drop.
            try:
                constraint_capture.clear_constraint(armature, self.kind, frame)
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

            from . import (
                constraint_capture,
                constraint_ghost,
                motion_constraints,
                project_store,
            )

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
            armature = _require_editable_character(self, context)
            if armature is None:
                return {"CANCELLED"}
            # Ownership is a separate failure from selection, and saying so is
            # the difference between "click the character" and "this rig was
            # never staged into the project".
            #
            # The project id, not merely the presence of an entity id: this
            # request ends in an apply_motion against a revision of THIS
            # project, and an entity id travels with a rig appended from
            # another .blend. add_character stamps both, so a staged character
            # satisfies this and a foreign one does not.
            entity_id = armature.get("cclay.entity_id")
            owner = armature.get("cclay.owned_project_id")
            if not entity_id or owner != stored.get("project_id"):
                self.report(
                    {"ERROR"},
                    f"{armature.name} is not a character this project owns",
                )
                return {"CANCELLED"}
            # Checked here, before any scrubbing, because the capture below
            # calls scene.frame_set and reads back whatever the curves say --
            # which silently discards a handle the animator dragged but never
            # keyed, and commits the OLD pose under a mark that looks correct.
            # The mark operator refuses this too, but Blender's own I places a
            # mark without going near that operator, and the Dope Sheet lanes
            # exist so that I is the normal way to work. This is the boundary
            # both paths share.
            # Auto Keying is what makes a mark trustworthy. With it on, every
            # drag is keyed as it happens, so the pose under a mark is by
            # construction the pose the animator saw. With it off there is a
            # sequence this add-on cannot detect afterwards: drag a handle
            # without keying, place a mark with Blender's own I -- which never
            # touches the mark operator or its guard -- then change frame. The
            # drag is discarded by that frame change, the drift check below
            # finds a clean scene, and capture scrubs back and serialises the
            # OLD pose under a mark that looks perfectly correct. Nothing
            # survives at request time to detect it with, so the honest answer
            # is to refuse while the guarantee is absent rather than publish
            # something that may not be what is on screen.
            if _auto_key_is_off(context) or context.scene.get(AUTOKEY_LAPSED):
                self.report(
                    {"ERROR"},
                    "Auto Keying has been off, so a mark may not carry the "
                    "pose you saw when you placed it; turn it on, check your "
                    "marks, then press Marks Checked",
                )
                return {"CANCELLED"}
            # A pose dragged on a ghost and never applied is invisible to the
            # capture below, which reads the rig's curves and nothing else. The
            # request would carry the OLD pose at that frame and the animator
            # would get back a clip that ignores the edit in front of them --
            # the same shape of silent loss as the Auto Keying lapse above.
            unapplied = constraint_ghost.uncommitted_ghosts(armature)
            if unapplied:
                self.report(
                    {"ERROR"},
                    f"{', '.join(unapplied)} has edits that are not on the rig "
                    "yet; select the pose and press Apply Pose To Its Frame, "
                    "or Hide Marked Poses to discard them",
                )
                return {"CANCELLED"}
            drifted = constraint_capture.unkeyed_pose(
                armature, context.scene.frame_current, _UNKEYED_TOLERANCE
            )
            if drifted:
                self.report(
                    {"ERROR"},
                    f"{', '.join(drifted)} moved but not keyed; press I in the "
                    "viewport to key the pose, or turn Auto Keying on",
                )
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
                # A mark placed while a longer clip was applied is out of range
                # for the current one. The conversion raises it, and without
                # this it escaped execute() as a traceback instead of a report
                # the animator can act on.
                motion_constraints.MotionConstraintError,
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

            armature = _require_editable_character(self, context)
            if armature is None:
                return {"CANCELLED"}
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
            armature = _require_editable_character(self, context)
            if armature is None:
                return {"CANCELLED"}
            try:
                ik_rig.detach(armature, keep_edits=False)
            except ik_rig.IkRigError as error:
                self.report({"ERROR"}, str(error))
                return {"CANCELLED"}
            self.report({"INFO"}, "Discarded the IK edits")
            return {"FINISHED"}

    # The handles are four bones among sixty-five, drawn inside the character's
    # silhouette. Clicking one in the viewport means finding it first, and the
    # outliner route costs two expansions and a scroll, so the tool's whole
    # premise -- drag the hand where you want it -- started with a search.
    class CCLAY_OT_select_ik_handle(bpy.types.Operator):
        bl_idname = "cclay.select_ik_handle"
        bl_label = "Select IK Handle"
        bl_description = (
            "Make this handle the active pose bone, ready to drag, without "
            "finding it in the viewport or the outliner first"
        )
        bl_options = {"REGISTER", "UNDO"}

        bone: bpy.props.StringProperty(name="Bone", default="")

        def execute(self, context):
            from . import constraint_ghost

            armature = _require_editable_character(self, context)
            if armature is None:
                return {"CANCELLED"}
            # If the animator is working on a ghost, the handle they want is
            # the GHOST's. Resolution deliberately maps a ghost to its owner so
            # every clip question is answered by the real rig, but a grab is
            # not a clip question -- following it here would reach past the
            # pose they are editing and select the live rig's handle instead.
            active = context.active_object
            if constraint_ghost.is_ghost(active):
                armature = active
            pose_bone = armature.pose.bones.get(self.bone)
            if pose_bone is None:
                self.report(
                    {"ERROR"},
                    f"{self.bone} is missing; attach the IK layer first",
                )
                return {"CANCELLED"}
            armature.select_set(True)
            context.view_layer.objects.active = armature
            if armature.mode != "POSE":
                bpy.ops.object.mode_set(mode="POSE")
            # Everything else has to let go: the transform operators act on the
            # whole pose selection, so leaving a previous handle selected would
            # drag two chains at once.
            # Blender 5.2 dropped Bone.select; selection lives on the pose bone,
            # while the active bone still lives on the armature data.
            for other in armature.pose.bones:
                other.select = False
            pose_bone.select = True
            armature.data.bones.active = pose_bone.bone
            return {"FINISHED"}

    class CCLAY_PT_ik_rig(bpy.types.Panel):
        """Manual IK handles over a generated motion clip."""

        bl_idname = "CCLAY_PT_ik_rig"
        bl_label = "IK Rig"
        bl_space_type = "VIEW_3D"
        bl_region_type = "UI"
        bl_category = "CozyClay"

        def draw(self, context):
            from . import ik_chains

            layout = self.layout
            armature, reason = _character_of(context)
            if armature is None:
                layout.label(text=reason, icon="INFO")
                return
            # Named, because the panel now answers for a character the animator
            # may have selected by clicking its mesh: which rig these buttons
            # are about stops being obvious the moment it is not the active
            # object.
            layout.label(text=armature.name, icon="ARMATURE_DATA")
            # Drawn only while the filter is actually hiding keys, so the row
            # names the cause of an empty timeline exactly when the animator is
            # staring at one, and stops taking up space once it is cleared.
            if next(_key_hiding_filters(), None) is not None:
                layout.label(text="Timeline hides unselected bones' keys", icon="ERROR")
                layout.operator("cclay.show_character_keys", icon="KEYFRAME_HLT")
            if not ik_rig.has_ik_layer(armature):
                layout.operator("cclay.attach_ik_rig", icon="CON_KINEMATIC")
                return
            layout.label(text="IK handles attached", icon="CHECKMARK")
            # Handle and pole are the two things an animator grabs on a chain,
            # so they get the same treatment: a button each, one row per limb.
            # The pole used to be a sentence telling the animator to go find a
            # bone by name, which is the outliner hunt the handle buttons exist
            # to abolish.
            layout.label(text="Grab a control:")
            grid = layout.grid_flow(columns=2, align=True)
            for chain in ik_chains.IK_CHAINS:
                row = grid.row(align=True)
                row.operator(
                    "cclay.select_ik_handle", text=chain.effector, icon="BONE_DATA"
                ).bone = ik_chains.target_bone_name(chain.effector)
                row.operator(
                    "cclay.select_ik_handle", text="Bend", icon="CON_KINEMATIC"
                ).bone = ik_chains.pole_bone_name(chain.effector)
            # Only true while Auto Keying is off. With it on, a handle behaves
            # like every other bone in Blender -- the drag is keyed as it
            # happens -- so the warning would be a lie and the instruction
            # unnecessary. A standing warning the animator learns to ignore is
            # worse than none.
            if _auto_key_is_off(context):
                layout.label(
                    text="Auto Keying is off: a handle move is discarded",
                    icon="ERROR",
                )
                layout.operator("cclay.enable_auto_key", icon="REC")
            column = layout.column(align=True)
            column.operator(
                "cclay.detach_ik_rig", text="Detach, Keep Edits", icon="KEYFRAME_HLT"
            )
            column.operator(
                "cclay.discard_ik_rig", text="Detach, Discard Edits", icon="TRASH"
            )

    class CCLAY_PT_ardy_constraints(bpy.types.Panel):
        """Frames the animator has committed as ARDY generation constraints."""

        bl_idname = "CCLAY_PT_ardy_constraints"
        bl_label = "ARDY Constraints"
        bl_space_type = "VIEW_3D"
        bl_region_type = "UI"
        bl_category = "CozyClay"
        bl_parent_id = "CCLAY_PT_ik_rig"

        def draw(self, context):
            from . import constraint_capture, constraint_ghost

            layout = self.layout
            armature, reason = _character_of(context)
            if armature is None:
                layout.label(text=reason, icon="INFO")
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
            # The clip is not the timeline. apply_motion only ever extends the
            # scene range, so a 120-frame clip commonly sits inside a 250-frame
            # scene and most of the frames an animator can scrub to cannot
            # carry a constraint at all. Showing the clip's own bounds here is
            # what makes that visible before a mark is placed; the operator
            # holds the enforcing check.
            try:
                clip = constraint_capture.base_clip_of(armature, backfill=False)
            except constraint_capture.ConstraintCaptureError as error:
                layout.label(text=str(error), icon="ERROR")
                return
            first_frame = clip["start_frame"]
            last_frame = first_frame + clip["frame_count"] - 1
            # A clip that records no frames renders as "1-0" if the range is
            # printed unconditionally, which reads as a bug in the panel rather
            # than as a broken clip. Marking is already impossible either way.
            layout.label(
                text=f"Clip: frames {first_frame}-{last_frame}"
                if clip["frame_count"] > 0
                else "Clip: no frames recorded"
            )
            in_clip = first_frame <= frame <= last_frame
            if not in_clip:
                layout.label(
                    text=f"Frame {frame} is outside the clip - nothing to mark",
                    icon="ERROR",
                )
            # The Dope Sheet shows these marks as ARDY does, one named lane per
            # kind, made of the real keyframes -- so it, not this column of
            # buttons, is where the work happens: select a lane, I to place a
            # mark, X to remove one, G to move one, all Blender's own.
            state = constraint_capture.lane_state(armature)
            marks = state["frames"]
            lane_row = layout.row(align=True)
            lane_row.operator("cclay.show_constraint_lanes", icon="ACTION")
            lane_row.operator("cclay.hide_constraint_lanes", text="", icon="X")
            # Only while some kind has no lane, which on a rig attached by this
            # version is never. A standing button for a one-off migration is a
            # button an animator learns to ignore. Read off the same single
            # walk as the rows below rather than rescanning the action: a
            # visible panel redraws constantly.
            if len(state["kindsWithLanes"]) < len(constraint_capture.ANCHOR_BY_KIND):
                layout.operator("cclay.backfill_constraint_lanes", icon="ADD")
            # Say what the keys DO, not what would be convenient. Measured:
            # action.keyframe_insert defaults to ALL, and Show filters the
            # editor down to exactly these six lanes, so one I marks all six.
            # "Click a lane, then I / X / G" was the instruction here and it
            # was wrong about I. X and G act on selected KEYS, not channels, so
            # they need no such warning.
            layout.label(text="Dope Sheet: X removes a mark, G moves one")
            layout.label(text="I marks every lane shown at once")
            layout.label(text="One lane: click it, then Key > Insert >")
            layout.label(text="Only Selected Channels")
            # Blender has no pose ghost -- armature ghosting was removed in 2.8
            # and armatures have no onion skinning, both measured empty -- so
            # the way to work on a marked frame is to go to it. With the lanes
            # filtered, keyframe_jump walks marks and skips the pose keys under
            # them: measured [1, 2, 7, 9] marked, Up walked 2, 7, 9.
            layout.label(text="Up / Down jumps between marks")
            # And the thing Blender cannot do at all: work on a marked frame
            # without going to it. Each ghost is a real object sharing this
            # armature's data, so it carries the same IK handles and edits the
            # same way -- that is why it is offered here rather than described.
            ghosts = constraint_ghost.ghosts_of(armature)
            poses = layout.column(align=True)
            if ghosts:
                poses.label(text=f"Marked poses shown: {len(ghosts)}")
                active = context.active_object
                for ghost in ghosts:
                    kind = ghost.get(constraint_ghost.GHOST_KIND)
                    frame = ghost.get(constraint_ghost.GHOST_FRAME)
                    row = poses.row(align=True)
                    # Marked while it is the one being posed, because every
                    # ghost is the same silhouette as the rig and as each other.
                    row.label(
                        text=f"{kind} @ {frame}",
                        icon="RADIOBUT_ON" if ghost is active else "RADIOBUT_OFF",
                    )
                    jump = row.operator("cclay.edit_constraint_ghost", text="Edit")
                    jump.kind = kind
                    jump.frame = int(frame)
                poses.operator("cclay.commit_constraint_ghost", icon="KEYFRAME_HLT")
                poses.operator("cclay.dismiss_constraint_ghosts", icon="GHOST_DISABLED")
            elif state["frames"]:
                poses.operator("cclay.show_constraint_ghosts", icon="GHOST_ENABLED")
            if context.scene.get(AUTOKEY_LAPSED):
                lapse = layout.column(align=True)
                lapse.label(
                    text="Auto Keying was off - marks may not match", icon="ERROR"
                )
                lapse.operator("cclay.marks_checked", icon="CHECKMARK")

            # One scan of the action for all six kinds. Asking per kind
            # rescanned every F-curve six times per redraw, and Blender redraws
            # a visible panel constantly.
            for kind, frames in marks.items():
                row = layout.row(align=True)
                row.label(text=kind)
                if frame in frames:
                    # Clearing stays reachable off the clip: a mark stranded by
                    # a shorter regenerated clip has to be removable.
                    row.operator(
                        "cclay.clear_constraint", text="", icon="KEYFRAME_HLT"
                    ).kind = kind
                else:
                    marker = row.row(align=True)
                    marker.enabled = in_clip
                    marker.operator(
                        "cclay.mark_constraint", text="", icon="KEYFRAME"
                    ).kind = kind
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
        CCLAY_OT_show_character_keys,
        CCLAY_OT_show_constraint_lanes,
        CCLAY_OT_backfill_constraint_lanes,
        CCLAY_OT_marks_checked,
        CCLAY_OT_show_constraint_ghosts,
        CCLAY_OT_dismiss_constraint_ghosts,
        CCLAY_OT_edit_constraint_ghost,
        CCLAY_OT_commit_constraint_ghost,
        CCLAY_OT_hide_constraint_lanes,
        CCLAY_OT_enable_auto_key,
        CCLAY_OT_attach_ik_rig,
        CCLAY_OT_detach_ik_rig,
        CCLAY_OT_discard_ik_rig,
        CCLAY_OT_select_ik_handle,
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


# A mark is only as trustworthy as the pose under it, and Auto Keying is what
# makes that pose survive. Checking the setting at request time is not enough:
# an animator can turn it off, drag a handle, place a mark with Blender's own
# I -- which never touches this add-on's operators -- change frame so the drag
# is discarded, then turn Auto Keying back on before regenerating. Everything
# looks clean by then and the OLD pose gets published.
#
# So the lapse is recorded when it happens, by the lifecycle timer, which
# native editing cannot bypass. It is cleared only by someone saying they have
# checked their marks, because nothing in the file can distinguish a mark made
# during the lapse from one made before it.
AUTOKEY_LAPSED = "cclay.autokey_lapsed"


def _note_autokey_lapse() -> None:
    """Record on every scene whose Auto Keying is currently off."""
    for scene in bpy.data.scenes:
        tool_settings = getattr(scene, "tool_settings", None)
        if tool_settings is None or tool_settings.use_keyframe_insert_auto:
            continue
        if not scene.get(AUTOKEY_LAPSED):
            scene[AUTOKEY_LAPSED] = True


def _persistent(handler):
    """``bpy.app.handlers.persistent``, or a no-op outside Blender.

    Handlers registered without it are cleared when a .blend is loaded while
    the add-on stays enabled, so both ghost guarantees would silently stop
    holding after the animator opened a second file.
    """
    handlers = getattr(bpy, "app", None) and getattr(bpy.app, "handlers", None)
    marker = getattr(handlers, "persistent", None) if handlers else None
    return marker(handler) if marker else handler
@_persistent
def _recover_execution_after_load(_unused=None) -> None:
    """Rebuild the Blender-owned listener after a durable script rollback."""
    from . import connection

    connection.recover_pending_execution_after_load(ADDON_VERSION)




# What was on screen when the file was written, so it can be put back. A ghost
# is scaffolding and must not enter the document, but an animator who presses
# Ctrl+S mid-edit must not be punished for it by losing the pose they were
# working on -- which is what removing them without this did.
_GHOSTS_TAKEN_FOR_SAVE: list = []


def _ghost_pose(ghost) -> dict:
    return {
        bone.name: (tuple(bone.location), tuple(bone.rotation_quaternion))
        for bone in ghost.pose.bones
    }


@_persistent
def _drop_ghosts_before_save(_unused=None) -> None:
    """Take every ghost out of the file just before it is written, and remember it.

    A ghost is a real linked object, so saving with one on screen writes it
    into the .blend -- confirmed by saving and reopening. That is scaffolding
    surviving into the document, and from there into anything built from it.

    Removing them alone was worse than the leak: it destroyed whatever pose the
    animator had not committed yet. So what is on screen is recorded here and
    put back in ``_restore_ghosts_after_save``.
    """
    from . import constraint_ghost

    _GHOSTS_TAKEN_FOR_SAVE.clear()
    for obj in list(bpy.data.objects):
        if not constraint_ghost.is_ghost(obj):
            continue
        owner = obj.get(constraint_ghost.GHOST_OF)
        if owner is not None:
            _GHOSTS_TAKEN_FOR_SAVE.append(
                {
                    "owner": owner.name,
                    "kind": obj.get(constraint_ghost.GHOST_KIND),
                    "frame": obj.get(constraint_ghost.GHOST_FRAME),
                    "pose": _ghost_pose(obj),
                }
            )
        bpy.data.objects.remove(obj, do_unlink=True)
    collection = bpy.data.collections.get(constraint_ghost.GHOST_COLLECTION)
    if collection is not None and not collection.objects:
        bpy.data.collections.remove(collection)


@_persistent
def _restore_ghosts_after_save(_unused=None) -> None:
    """Put back what the save took away, pose and all."""
    from . import constraint_ghost

    taken, _GHOSTS_TAKEN_FOR_SAVE[:] = list(_GHOSTS_TAKEN_FOR_SAVE), []
    for record in taken:
        armature = bpy.data.objects.get(record["owner"])
        if armature is None:
            continue
        try:
            ghost = constraint_ghost.create_ghost(
                armature, record["kind"], int(record["frame"])
            )
        except constraint_ghost.ConstraintGhostError:
            # The mark went away between the two handlers, or the rig was
            # detached. Nothing to restore onto, and a save is the wrong moment
            # to raise.
            continue
        # create_ghost rebuilds the pose from the live curves, which is the
        # COMMITTED pose. Whatever was uncommitted lives only in this record.
        for bone_name, (location, rotation) in record["pose"].items():
            pose_bone = ghost.pose.bones.get(bone_name)
            if pose_bone is None:
                continue
            pose_bone.location = location
            pose_bone.rotation_quaternion = rotation


# Removing an object from inside a depsgraph handler triggers another
# depsgraph update, so the handler would call itself. One flag, because the
# alternative is a crash the animator cannot explain.
_PRUNING_GHOSTS = [False]


@_persistent
def _drop_ghosts_whose_mark_is_gone(_scene=None, _depsgraph=None) -> None:
    """Take down any pose whose mark has been deleted.

    Marks are removed with Blender's own X in the Dope Sheet, which reaches
    none of this add-on's operators. Until this ran here, deleting a mark left
    its ghost standing: a pose still offering to be edited and committed onto a
    frame that is no longer constrained. Pruning only when Show was pressed
    again meant the wrong thing sat on screen for as long as the animator did
    not happen to press it.

    On depsgraph rather than on frame change, because deleting a mark is a data
    change and need not be followed by a scrub.
    """
    from . import constraint_ghost

    if _PRUNING_GHOSTS[0]:
        return
    collection = bpy.data.collections.get(constraint_ghost.GHOST_COLLECTION)
    if collection is None or not collection.objects:
        return
    owners = []
    for obj in collection.objects:
        owner = obj.get(constraint_ghost.GHOST_OF)
        if owner is not None and owner not in owners:
            owners.append(owner)
    _PRUNING_GHOSTS[0] = True
    try:
        for owner in owners:
            constraint_ghost.prune_stale_ghosts(owner)
    finally:
        _PRUNING_GHOSTS[0] = False


@_persistent
def _keep_ghosts_still(_unused=None) -> None:
    """Strip any animation a ghost picked up, before it can drift.

    A ghost holds one frame; that stillness is the whole feature. But this
    workflow REQUIRES Auto Keying, so dragging a ghost handle keys the ghost --
    measured: the ghost gained animation data from a single transform. An
    animated ghost starts following the playhead and stops being a view of its
    own frame.

    Runs on frame change, which is the exact moment that drift would happen and
    a moment no drag can be in progress. An earlier version ran on the
    lifecycle timer, which could fire mid-transform and clear an action out
    from under it. Clearing animation data leaves the posed values where they
    are, so the edit survives; only its dependence on the playhead goes away.

    Iterates the ghost collection rather than every object in the file: this
    runs on every frame of playback.
    """
    from . import constraint_ghost

    collection = bpy.data.collections.get(constraint_ghost.GHOST_COLLECTION)
    if collection is None:
        return
    for obj in collection.objects:
        if constraint_ghost.is_ghost(obj) and obj.animation_data is not None:
            obj.animation_data_clear()


def _pump_lifecycle() -> float:
    from . import controller_connection

    _note_autokey_lapse()
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
        # Ghost upkeep hangs off the two moments it is actually needed, not off
        # the lifecycle timer. A timer would fire in the middle of a modal drag
        # and clear an action out from under it, and its mutations would sit
        # outside any undo step. A ghost that picked up an action only does
        # harm when the frame changes -- that is when it would start following
        # the playhead -- and a ghost only pollutes a document when one is
        # written. So: one handler each, at exactly those points.
        # Fetched the way the timer below is, because the add-on is imported
        # against a stand-in bpy outside Blender and neither attribute exists
        # there.
        handlers = getattr(bpy.app, "handlers", None)
        if handlers is not None:
            for handler, slot in (
                (_keep_ghosts_still, handlers.frame_change_pre),
                (_drop_ghosts_before_save, handlers.save_pre),
                (_restore_ghosts_after_save, handlers.save_post),
                (_drop_ghosts_whose_mark_is_gone, handlers.depsgraph_update_post),
                (_recover_execution_after_load, handlers.load_post),
            ):
                if handler not in slot:
                    slot.append(handler)
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

        handlers = getattr(bpy.app, "handlers", None)
        if handlers is not None:
            for handler, slot in (
                (_keep_ghosts_still, handlers.frame_change_pre),
                (_drop_ghosts_before_save, handlers.save_pre),
                (_restore_ghosts_after_save, handlers.save_post),
                (_drop_ghosts_whose_mark_is_gone, handlers.depsgraph_update_post),
                (_recover_execution_after_load, handlers.load_post),
            ):
                if handler in slot:
                    slot.remove(handler)

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
        connection.stop_blender_server()
        connection.disconnect_active("addon_unload")
        while _registered_classes:
            bpy.utils.unregister_class(_registered_classes.pop())
