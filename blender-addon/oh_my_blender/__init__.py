"""Blender-side bridge for Oh My Blender."""

from .identity import assign_entity_ids, new_project_id

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
            scene = context.scene
            if not scene.get("omb.project_id"):
                scene["omb.project_id"] = new_project_id()
            entities = list(scene.objects)
            existing = {f"object:{i}": obj.get("omb.entity_id") for i, obj in enumerate(entities)}
            assignments = assign_entity_ids(existing, existing)
            for key, entity_id in assignments.items():
                entities[int(key.split(":", 1)[1])]["omb.entity_id"] = entity_id
            for obj in entities:
                if obj.type == "ARMATURE":
                    bones = list(obj.data.bones)
                    keys = [f"bone:{i}" for i in range(len(bones))]
                    existing_bones = {key: bone.get("omb.entity_id") for key, bone in zip(keys, bones)}
                    for key, entity_id in assign_entity_ids(existing_bones, keys).items():
                        bones[int(key.split(":", 1)[1])]["omb.entity_id"] = entity_id
            return {"FINISHED"}

    class OMB_OT_connect(bpy.types.Operator):
        bl_idname = "omb.connect"
        bl_label = "Connect"

        def execute(self, context):
            self.report({"INFO"}, "Connection is not configured")
            return {"CANCELLED"}

    class OMB_OT_disconnect(bpy.types.Operator):
        bl_idname = "omb.disconnect"
        bl_label = "Disconnect"

        def execute(self, context):
            self.report({"INFO"}, "Disconnected")
            return {"FINISHED"}

    _CLASSES = (OMB_OT_initialize_project, OMB_OT_connect, OMB_OT_disconnect)
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
