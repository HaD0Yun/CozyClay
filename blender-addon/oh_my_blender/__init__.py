"""Blender-side bridge for Oh My Blender."""

from .identity import assign_entity_ids, new_project_id
from . import project_store

bl_info = {
    "name": "Oh My Blender",
    "author": "Oh My Blender",
    "version": (0, 1, 0),
    "blender": (5, 0, 0),
    "category": "Animation",
}

try:  # Blender is intentionally absent from host-side unit tests.
    import bpy  # type: ignore
except ImportError:  # pragma: no cover - exercised by importing this package
    bpy = None


if bpy is not None:
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
            if project_created:
                scene["omb.project_id"] = new_project_id()

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
            entities_by_key = dict(entities)
            for key, entity_id in assignments.items():
                entities_by_key[key]["omb.entity_id"] = entity_id

            directory = bpy.path.abspath("//")
            try:
                project_store.write_project_index(directory, scene["omb.project_id"])
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
                self.report({"ERROR"}, str(exc))
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
            for key, entity_id in assignments.items():
                entities_by_key[key]["omb.entity_id"] = entity_id
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
                self.report({"ERROR"}, str(exc))
                return {"CANCELLED"}
            return {"FINISHED"}

    class OMB_OT_connect(bpy.types.Operator):
        bl_idname = "omb.connect"
        bl_label = "Connect"

        def execute(self, context):
            from pathlib import Path

            from . import connection
            from .daemon_child import StartupError
            from .ws_client import WebSocketError

            project_id = context.scene.get("omb.project_id")
            if not project_id:
                self.report({"ERROR"}, "Initialize and save the project before connecting")
                return {"CANCELLED"}
            repository_root = Path(__file__).resolve().parents[2]
            try:
                connection.connect(
                    cwd=repository_root,
                    project_id=project_id,
                    addon_version=".".join(str(part) for part in bl_info["version"]),
                    blender_version=bpy.app.version_string,
                )
            except (connection.ConnectionError, StartupError, WebSocketError) as exc:
                self.report({"ERROR"}, str(exc))
                return {"CANCELLED"}
            return {"FINISHED"}

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
        OMB_OT_initialize_project,
        OMB_OT_repair_ids,
        OMB_OT_connect,
        OMB_OT_disconnect,
    )
else:
    _CLASSES = ()


def register() -> None:
    """Register operators without starting external processes."""
    if bpy is not None:
        for cls in _CLASSES:
            bpy.utils.register_class(cls)


def unregister() -> None:
    if bpy is not None:
        for cls in reversed(_CLASSES):
            bpy.utils.unregister_class(cls)
