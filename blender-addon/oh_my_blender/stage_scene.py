"""Closed StageScenePlanV1 validation and transactional Blender mutation."""

from __future__ import annotations

import math
import os
import re
import time
import unicodedata
import uuid
from collections.abc import Callable

try:  # Blender is intentionally absent from host-side unit tests.
    import bpy  # type: ignore
except ImportError:  # pragma: no cover
    bpy = None

_UUID4 = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_HASH = re.compile(r"^[0-9a-f]{64}$")
_PLAN_KEYS = {"schema_version", "expected_revision_id", "operations"}
_OPERATION_KEYS = {
    "add_primitive": {
        "op", "entity_id", "primitive_type", "name", "location", "rotation", "scale",
        "parent_id",
    },
    "add_character": {
        "op", "entity_id", "character_type", "name", "location", "rotation", "scale",
    },
    "create_assembly": {"op", "name"},
    "set_parent": {"op", "entity_id", "parent_id"},
    "transform_assembly": {
        "op", "assembly_id", "translation", "rotation_euler", "scale",
    },
    "set_material_color": {"op", "entity_id", "color"},
    "upsert_area_light": {
        "op", "entity_id", "name", "location", "rotation", "scale",
        "energy", "color", "size"
    },
    "delete_entity": {"op", "entity_id"},
}
_PRIMITIVES = {"PLANE", "CUBE", "UV_SPHERE"}
_CHARACTERS = {
    "Y_BOT": "y-bot-tpose.fbx",
    "X_BOT": "x-bot-tpose.fbx",
}


class StageSceneError(RuntimeError):
    """A staged scene mutation cannot be completed safely."""


class StageSceneValidationError(StageSceneError):
    """One atomic StageScenePlanV1 contract failure."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code


class STAGE_SCENE_ENTITY_ID_EXISTS(StageSceneError):
    code = "STAGE_SCENE_ENTITY_ID_EXISTS"


class STAGE_SCENE_TARGET_NOT_FOUND(StageSceneError):
    code = "STAGE_SCENE_TARGET_NOT_FOUND"


class STAGE_SCENE_TARGET_NOT_OMB_OWNED(StageSceneError):
    code = "STAGE_SCENE_TARGET_NOT_OMB_OWNED"


class STAGE_SCENE_TARGET_TYPE_INVALID(StageSceneError):
    code = "STAGE_SCENE_TARGET_TYPE_INVALID"


class STAGE_SCENE_SHARED_DATABLOCK(StageSceneError):
    code = "STAGE_SCENE_SHARED_DATABLOCK"
class STAGE_SCENE_PARENT_CYCLE(StageSceneError):
    code = "STAGE_SCENE_PARENT_CYCLE"


class STAGE_SCENE_ASSEMBLY_NOT_FOUND(StageSceneError):
    code = "STAGE_SCENE_ASSEMBLY_NOT_FOUND"




class STAGE_SCENE_CANCELLED(StageSceneError):
    code = "STAGE_SCENE_CANCELLED"


class STAGE_SCENE_DEADLINE_EXCEEDED(StageSceneError):
    code = "STAGE_SCENE_DEADLINE_EXCEEDED"


def _invalid(message: str) -> None:
    raise StageSceneValidationError("INVALID_STAGE_SCENE_PLAN_SCHEMA", message)


def _exact(value: object, keys: set[str], label: str) -> dict:
    if not isinstance(value, dict) or set(value) != keys:
        _invalid(f"{label} must contain exactly {sorted(keys)}")
    return value


def _uuid(value: object, label: str) -> str:
    if not isinstance(value, str) or _UUID4.fullmatch(value) is None:
        _invalid(f"{label} must be a lowercase UUIDv4")
    return value


def _number(value: object, label: str, *, minimum: float | None = None, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        _invalid(f"{label} must be a finite number")
    if abs(value) >= 1e15:
        _invalid(f"{label} magnitude must be below 1e15")
    if minimum is not None and value < minimum:
        _invalid(f"{label} must be at least {minimum}")
    if positive and value <= 0:
        _invalid(f"{label} must be positive")
    return float(value)


def _vector(value: object, size: int, label: str, *, unit: bool = False, positive: bool = False) -> list[float]:
    if not isinstance(value, list) or len(value) != size:
        _invalid(f"{label} must contain exactly {size} numbers")
    result = [
        _number(component, f"{label}[{index}]", minimum=0 if unit else None, positive=positive)
        for index, component in enumerate(value)
    ]
    if unit and any(component > 1 for component in result):
        _invalid(f"{label} components must be at most 1")
    return result


def _name(value: object, label: str) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 256
        or unicodedata.normalize("NFC", value) != value
    ):
        _invalid(f"{label} must be a 1..256 character NFC string")
    return value


def parse_stage_scene_plan(value: object) -> dict:
    """Parse the closed plan and apply semantic uniqueness checks."""
    plan = _exact(value, _PLAN_KEYS, "plan")
    if plan.get("schema_version") != 1:
        _invalid("schema_version must equal 1")
    if not isinstance(plan.get("expected_revision_id"), str) or _HASH.fullmatch(
        plan["expected_revision_id"]
    ) is None:
        _invalid("expected_revision_id must be a lowercase SHA-256")
    operations = plan.get("operations")
    if not isinstance(operations, list) or not 1 <= len(operations) <= 256:
        _invalid("operations must contain 1..256 entries")

    created_ids: set[str] = set()
    stable_names: set[str] = set()
    for index, raw_operation in enumerate(operations):
        if not isinstance(raw_operation, dict):
            _invalid(f"operations[{index}] must be an object")
        operation_kind = raw_operation.get("op")
        expected_keys = _OPERATION_KEYS.get(operation_kind)
        if expected_keys is None:
            _invalid(f"operations[{index}].op is unsupported")
        raw_operation = dict(raw_operation)
        if operation_kind == "add_primitive" and "parent_id" not in raw_operation:
            expected_keys = expected_keys - {"parent_id"}
        elif operation_kind == "transform_assembly":
            required = {"op", "assembly_id"}
            if not required <= set(raw_operation) or not set(raw_operation) <= expected_keys:
                _invalid(
                    f"operations[{index}] must contain {sorted(required)} "
                    f"and only optional transform fields"
                )
            expected_keys = set(raw_operation)
            transform_fields = [
                field
                for field in ("translation", "rotation_euler", "scale")
                if field in raw_operation
            ]
            if not transform_fields:
                _invalid(
                    f"operations[{index}] transform_assembly must include at least "
                    "one transform field"
                )
            for field in transform_fields:
                if raw_operation[field] is None:
                    _invalid(
                        f"operations[{index}].{field} must be a vector, not null"
                    )
        operation = _exact(raw_operation, expected_keys, f"operations[{index}]")
        if operation_kind == "create_assembly":
            _name(operation.get("name"), f"operations[{index}].name")
            continue
        if operation_kind == "transform_assembly":
            _uuid(operation.get("assembly_id"), f"operations[{index}].assembly_id")
            for field in ("translation", "rotation_euler", "scale"):
                if field in operation:
                    _vector(
                        operation[field], 3, f"operations[{index}].{field}",
                        positive=field == "scale",
                    )
            continue
        entity_id = _uuid(operation.get("entity_id"), f"operations[{index}].entity_id")
        if operation_kind in ("add_primitive", "set_parent"):
            if operation.get("parent_id") is not None:
                _uuid(operation["parent_id"], f"operations[{index}].parent_id")
            if operation.get("parent_id") == entity_id:
                _invalid(f"operations[{index}] cannot parent an entity to itself")
        if operation_kind == "add_primitive":
            if operation.get("primitive_type") not in _PRIMITIVES:
                _invalid(f"operations[{index}].primitive_type is unsupported")
            _name(operation.get("name"), f"operations[{index}].name")
            _vector(operation.get("location"), 3, f"operations[{index}].location")
            _vector(operation.get("rotation"), 3, f"operations[{index}].rotation")
            _vector(operation.get("scale"), 3, f"operations[{index}].scale", positive=True)
        elif operation_kind == "add_character":
            if operation.get("character_type") not in _CHARACTERS:
                _invalid(f"operations[{index}].character_type is unsupported")
            _name(operation.get("name"), f"operations[{index}].name")
            _vector(operation.get("location"), 3, f"operations[{index}].location")
            _vector(operation.get("rotation"), 3, f"operations[{index}].rotation")
            _vector(operation.get("scale"), 3, f"operations[{index}].scale", positive=True)
        elif operation_kind == "set_material_color":
            _vector(operation.get("color"), 4, f"operations[{index}].color", unit=True)
        elif operation_kind == "upsert_area_light":
            _name(operation.get("name"), f"operations[{index}].name")
            _vector(operation.get("location"), 3, f"operations[{index}].location")
            _vector(operation.get("rotation"), 3, f"operations[{index}].rotation")
            _vector(operation.get("scale"), 3, f"operations[{index}].scale", positive=True)
            _number(operation.get("energy"), f"operations[{index}].energy", minimum=0)
            _vector(operation.get("color"), 3, f"operations[{index}].color", unit=True)
            _number(operation.get("size"), f"operations[{index}].size", positive=True)

        if operation_kind in ("add_primitive", "upsert_area_light", "add_character"):
            if entity_id in created_ids:
                raise StageSceneValidationError(
                    "STAGE_SCENE_ENTITY_ID_DUPLICATE",
                    f"entity_id {entity_id} is created more than once",
                )
            created_ids.add(entity_id)
            stable_name = operation["name"]
            if stable_name in stable_names:
                raise StageSceneValidationError(
                    "STAGE_SCENE_STABLE_NAME_DUPLICATE",
                    f"stable name {stable_name!r} is repeated",
                )
            stable_names.add(stable_name)
    return plan


class STAGE_SCENE_STABLE_NAME_EXISTS(StageSceneError):
    code = "STAGE_SCENE_STABLE_NAME_EXISTS"


def _entity(entity_id: str):
    return next(
        (
            scene_object
            for scene_object in bpy.data.objects
            if scene_object.get("omb.entity_id") == entity_id
        ),
        None,
    )


def _owned(scene_object: object, project_id: str) -> bool:
    return scene_object.get("omb.owned_project_id") == project_id


def _require_owned_entity(entity_id: str, project_id: str):
    scene_object = _entity(entity_id)
    if scene_object is None:
        raise STAGE_SCENE_TARGET_NOT_FOUND(f"entity {entity_id} does not exist")
    if not _owned(scene_object, project_id):
        raise STAGE_SCENE_TARGET_NOT_OMB_OWNED(
            f"entity {entity_id} was not created by OMB for this project"
        )
    return scene_object


def _require_exclusive_datablocks(scene_object: object) -> None:
    data = scene_object.data
    if data is not None and data.users > 1:
        raise STAGE_SCENE_SHARED_DATABLOCK(
            f"entity {scene_object['omb.entity_id']} data is shared by {data.users} users"
        )
    if scene_object.type != "MESH":
        return
    for material in data.materials:
        if (
            material is not None
            and isinstance(material.get("omb.generated_for_entity_id"), str)
            and material.users > 1
        ):
            raise STAGE_SCENE_SHARED_DATABLOCK(
                f"entity {scene_object['omb.entity_id']} generated material "
                f"{material.name!r} is shared by {material.users} users"
            )


def _destroy_object(scene_object: object) -> None:
    data = scene_object.data
    materials = (
        tuple(material for material in data.materials if material is not None)
        if scene_object.type == "MESH"
        else ()
    )
    object_type = scene_object.type
    bpy.data.objects.remove(scene_object, do_unlink=True)
    if data is not None and data.users == 0:
        if object_type == "MESH":
            bpy.data.meshes.remove(data)
        elif object_type == "LIGHT":
            bpy.data.lights.remove(data)
        elif object_type == "ARMATURE":
            bpy.data.armatures.remove(data)
    for material in materials:
        if material.users == 0:
            bpy.data.materials.remove(material)


class _StageTransaction:
    def __init__(self, scene: object):
        self.scene = scene
        self.created_objects: list[object] = []
        self.created_materials: list[object] = []
        self.object_states: dict[object, dict] = {}
        self.material_states: dict[object, dict] = {}
        self.quarantined: dict[object, tuple[object, ...]] = {}
        self.render_state: dict | None = None
        self.selected = tuple(
            scene_object for scene_object in scene.objects if scene_object.select_get()
        )
        self.active = bpy.context.view_layer.objects.active

    def capture_object(self, scene_object: object) -> None:
        if scene_object in self.created_objects or scene_object in self.object_states:
            return
        state = {
            "name": scene_object.name,
            "location": tuple(scene_object.location),
            "rotation_mode": scene_object.rotation_mode,
            "rotation_euler": tuple(scene_object.rotation_euler),
            "scale": tuple(scene_object.scale),
            "parent": scene_object.parent,
            "matrix_parent_inverse": scene_object.matrix_parent_inverse.copy(),
            "matrix_world": scene_object.matrix_world.copy(),
        }
        if scene_object.type == "LIGHT":
            state["light"] = {
                "type": scene_object.data.type,
                "energy": float(scene_object.data.energy),
                "color": tuple(scene_object.data.color),
                "size": float(scene_object.data.size),
            }
        elif scene_object.type == "CAMERA":
            cam = scene_object.data
            state["camera"] = {
                "lens": float(cam.lens),
                "clip_start": float(cam.clip_start),
                "clip_end": float(cam.clip_end),
                "sensor_width": float(cam.sensor_width),
                "sensor_height": float(cam.sensor_height),
                "sensor_fit": cam.sensor_fit,
            }
        self.object_states[scene_object] = state

    def capture_materials(self, scene_object: object, material: object | None) -> None:
        if scene_object not in self.created_objects:
            if scene_object not in self.object_states:
                self.capture_object(scene_object)
            state = self.object_states[scene_object]
            state.setdefault("material_slots", tuple(scene_object.data.materials))
        if (
            material is not None
            and material not in self.created_materials
            and material not in self.material_states
        ):
            principled = (
                material.node_tree.nodes.get("Principled BSDF")
                if material.use_nodes and material.node_tree is not None
                else None
            )
            base_color = (
                tuple(principled.inputs["Base Color"].default_value)
                if principled is not None
                else None
            )
            self.material_states[material] = {
                "diffuse_color": tuple(material.diffuse_color),
                "use_nodes": bool(material.use_nodes),
                "base_color": base_color,
            }

    def capture_render(self) -> None:
        if self.render_state is not None:
            return
        scene = bpy.context.scene
        render = scene.render
        self.render_state = {
            "resolution_x": render.resolution_x,
            "resolution_y": render.resolution_y,
            "resolution_percentage": render.resolution_percentage,
            "fps": render.fps,
            "fps_base": render.fps_base,
            "frame_start": scene.frame_start,
            "frame_end": scene.frame_end,
        }

    def quarantine(self, scene_object: object) -> None:
        if scene_object in self.quarantined:
            return
        collections = tuple(scene_object.users_collection)
        self.quarantined[scene_object] = collections
        for collection in collections:
            collection.objects.unlink(scene_object)

    def rollback(self) -> None:
        for scene_object, collections in self.quarantined.items():
            for collection in collections:
                if scene_object.name not in collection.objects:
                    collection.objects.link(scene_object)
        for scene_object, state in self.object_states.items():
            scene_object.name = state["name"]
            scene_object.location = state["location"]
            scene_object.rotation_mode = state["rotation_mode"]
            scene_object.rotation_euler = state["rotation_euler"]
            scene_object.scale = state["scale"]
            scene_object.parent = state["parent"]
            scene_object.matrix_parent_inverse = state["matrix_parent_inverse"]
            scene_object.matrix_world = state["matrix_world"]
            if "light" in state:
                light = state["light"]
                scene_object.data.type = light["type"]
                scene_object.data.energy = light["energy"]
                scene_object.data.color = light["color"]
                scene_object.data.size = light["size"]
            if "camera" in state:
                cam = state["camera"]
                scene_object.data.lens = cam["lens"]
                scene_object.data.clip_start = cam["clip_start"]
                scene_object.data.clip_end = cam["clip_end"]
                scene_object.data.sensor_width = cam["sensor_width"]
                scene_object.data.sensor_height = cam["sensor_height"]
                scene_object.data.sensor_fit = cam["sensor_fit"]
            if "material_slots" in state:
                scene_object.data.materials.clear()
                for material in state["material_slots"]:
                    scene_object.data.materials.append(material)
        for material, state in self.material_states.items():
            material.diffuse_color = state["diffuse_color"]
            material.use_nodes = state["use_nodes"]
            if state["base_color"] is not None:
                material.node_tree.nodes["Principled BSDF"].inputs[
                    "Base Color"
                ].default_value = state["base_color"]
        if self.render_state is not None:
            scene = bpy.context.scene
            render = scene.render
            render.resolution_x = self.render_state["resolution_x"]
            render.resolution_y = self.render_state["resolution_y"]
            render.resolution_percentage = self.render_state["resolution_percentage"]
            render.fps = self.render_state["fps"]
            render.fps_base = self.render_state["fps_base"]
            scene.frame_start = self.render_state["frame_start"]
            scene.frame_end = self.render_state["frame_end"]
        for scene_object in reversed(self.created_objects):
            if scene_object.name in bpy.data.objects:
                _destroy_object(scene_object)
        for material in tuple(self.created_materials):
            if material.name in bpy.data.materials and material.users == 0:
                bpy.data.materials.remove(material)
        for scene_object in self.scene.objects:
            scene_object.select_set(scene_object in self.selected)
        if self.active is not None and self.active.name in bpy.data.objects:
            bpy.context.view_layer.objects.active = self.active

    def finalize_deletions(self) -> None:
        for scene_object in tuple(self.quarantined):
            if scene_object.name in bpy.data.objects:
                _destroy_object(scene_object)


def _create_primitive(operation: dict, transaction: _StageTransaction, project_id: str):
    import bmesh

    if _entity(operation["entity_id"]) is not None:
        raise STAGE_SCENE_ENTITY_ID_EXISTS(
            f"entity_id {operation['entity_id']} already exists"
        )
    if bpy.data.objects.get(operation["name"]) is not None:
        raise STAGE_SCENE_STABLE_NAME_EXISTS(
            f"stable name {operation['name']!r} already exists"
        )
    mesh = bpy.data.meshes.new(f"{operation['name']} Mesh")
    editable = bmesh.new()
    try:
        if operation["primitive_type"] == "CUBE":
            bmesh.ops.create_cube(editable, size=2)
        elif operation["primitive_type"] == "PLANE":
            bmesh.ops.create_grid(
                editable, x_segments=1, y_segments=1, size=1
            )
        else:
            bmesh.ops.create_uvsphere(
                editable, u_segments=32, v_segments=16, radius=1
            )
        editable.to_mesh(mesh)
    finally:
        editable.free()
    scene_object = bpy.data.objects.new(operation["name"], mesh)
    scene_object["omb.entity_id"] = operation["entity_id"]
    scene_object["omb.owned_project_id"] = project_id
    scene_object["omb.stage_primitive_type"] = operation["primitive_type"]
    scene_object.location = operation["location"]
    scene_object.rotation_mode = "XYZ"
    scene_object.rotation_euler = operation["rotation"]
    scene_object.scale = operation["scale"]
    transaction.scene.collection.objects.link(scene_object)
    transaction.created_objects.append(scene_object)
    if operation.get("parent_id") is not None:
        parent = _require_owned_entity(operation["parent_id"], project_id)
        scene_object.parent = parent
        scene_object.matrix_parent_inverse = parent.matrix_world.inverted()
    return scene_object

def _derived_child_entity_id(root_entity_id: str, child_name: str) -> str:
    """Deterministic UUIDv4-shaped id for a datablock imported under a character root."""
    import hashlib

    digest = hashlib.sha256(
        f"{root_entity_id}\0{child_name}".encode("utf-8")
    ).hexdigest()
    variant = "89ab"[int(digest[16], 16) % 4]
    return (
        f"{digest[:8]}-{digest[8:12]}-4{digest[13:16]}-"
        f"{variant}{digest[17:20]}-{digest[20:32]}"
    )


def _create_character(operation: dict, transaction: _StageTransaction, project_id: str):
    """Append one bundled rigged character (armature + skinned meshes) as OMB-owned."""
    from pathlib import Path

    from mathutils import Euler

    if _entity(operation["entity_id"]) is not None:
        raise STAGE_SCENE_ENTITY_ID_EXISTS(
            f"entity_id {operation['entity_id']} already exists"
        )
    if bpy.data.objects.get(operation["name"]) is not None:
        raise STAGE_SCENE_STABLE_NAME_EXISTS(
            f"stable name {operation['name']!r} already exists"
        )
    asset = (
        Path(__file__).resolve().parent
        / "assets" / "characters" / _CHARACTERS[operation["character_type"]]
    )
    if not asset.is_file():
        raise StageSceneError(
            f"CHARACTER_ASSET_MISSING: {asset.name} is not bundled with the add-on"
        )
    objects_before = set(bpy.data.objects)
    materials_before = set(bpy.data.materials)
    bpy.ops.wm.fbx_import(filepath=str(asset))
    imported = [
        scene_object
        for scene_object in bpy.data.objects
        if scene_object not in objects_before
    ]
    roots = [
        scene_object
        for scene_object in imported
        if scene_object.parent is None or scene_object.parent in objects_before
    ]
    if len(roots) != 1 or roots[0].type != "ARMATURE":
        for scene_object in imported:
            _destroy_object(scene_object)
        raise StageSceneError(
            "CHARACTER_IMPORT_INVALID: bundled character must import exactly one armature root"
        )
    for material in bpy.data.materials:
        if material not in materials_before:
            transaction.created_materials.append(material)
    root = roots[0]
    transaction.created_objects.extend(imported)
    root["omb.entity_id"] = operation["entity_id"]
    root["omb.owned_project_id"] = project_id
    root["omb.character_type"] = operation["character_type"]
    root.name = operation["name"]
    for child in imported:
        if child is root:
            continue
        child["omb.entity_id"] = _derived_child_entity_id(
            operation["entity_id"], child.name
        )
        child["omb.owned_project_id"] = project_id
        child.name = f"{operation['name']} {child.name}"
    # The bones manifest track requires every bone to carry an entity id;
    # derive them from the root id so re-applying the same plan (rollback,
    # replay) yields identical identities.
    for bone in root.data.bones:
        bone["omb.entity_id"] = _derived_child_entity_id(
            operation["entity_id"], f"bone:{bone.name}"
        )
    # The FBX importer bakes unit conversion into the armature object
    # (X+90deg rotation, 0.01 scale), so the requested transform composes
    # with - never replaces - the imported base transform.
    root.location = operation["location"]
    root.rotation_mode = "XYZ"
    base_rotation = root.rotation_euler.to_matrix()
    extra_rotation = Euler(operation["rotation"], "XYZ").to_matrix()
    root.rotation_euler = (extra_rotation @ base_rotation).to_euler("XYZ")
    root.scale = [
        float(root.scale[axis]) * operation["scale"][axis] for axis in range(3)
    ]
    return root



def _create_assembly(operation: dict, transaction: _StageTransaction, project_id: str):
    if bpy.data.objects.get(operation["name"]) is not None:
        raise STAGE_SCENE_STABLE_NAME_EXISTS(
            f"stable name {operation['name']!r} already exists"
        )
    root = bpy.data.objects.new(operation["name"], None)
    root["omb.entity_id"] = str(uuid.uuid4())
    root["omb.owned_project_id"] = project_id
    root["omb.assembly_id"] = str(uuid.uuid4())
    root["omb.assembly_name"] = operation["name"]
    transaction.scene.collection.objects.link(root)
    transaction.created_objects.append(root)
    return root


def _set_parent(operation: dict, transaction: _StageTransaction, project_id: str) -> None:
    child = _require_owned_entity(operation["entity_id"], project_id)
    parent = (
        _require_owned_entity(operation["parent_id"], project_id)
        if operation["parent_id"] is not None
        else None
    )
    ancestor = parent
    while ancestor is not None:
        if ancestor == child:
            raise STAGE_SCENE_PARENT_CYCLE(
                f"parenting entity {operation['entity_id']} would create a cycle"
            )
        ancestor = ancestor.parent
    transaction.capture_object(child)
    world = child.matrix_world.copy()
    child.parent = parent
    if parent is not None:
        child.matrix_parent_inverse = parent.matrix_world.inverted()
    child.matrix_world = world


def _transform_assembly(operation: dict, transaction: _StageTransaction, project_id: str) -> None:
    root = next(
        (
            scene_object
            for scene_object in bpy.data.objects
            if scene_object.get("omb.assembly_id") == operation["assembly_id"]
        ),
        None,
    )
    if root is None:
        raise STAGE_SCENE_ASSEMBLY_NOT_FOUND(
            f"assembly {operation['assembly_id']} does not exist"
        )
    if not _owned(root, project_id):
        raise STAGE_SCENE_TARGET_NOT_OMB_OWNED(
            f"assembly {operation['assembly_id']} was not created by OMB for this project"
        )
    transaction.capture_object(root)
    if operation.get("translation") is not None:
        root.location = operation["translation"]
    if operation.get("rotation_euler") is not None:
        root.rotation_mode = "XYZ"
        root.rotation_euler = operation["rotation_euler"]
    if operation.get("scale") is not None:
        root.scale = operation["scale"]


def _generated_material(scene_object: object, transaction: _StageTransaction):
    entity_id = scene_object["omb.entity_id"]
    generated = [
        material
        for material in scene_object.data.materials
        if material is not None
        and material.get("omb.generated_for_entity_id") == entity_id
    ]
    if len(generated) > 1:
        raise STAGE_SCENE_TARGET_TYPE_INVALID(
            f"entity {entity_id} has more than one generated material"
        )
    material = generated[0] if generated else None
    transaction.capture_materials(scene_object, material)
    if material is None:
        material = bpy.data.materials.new(f"OMB Material {entity_id[:8]}")
        material["omb.generated_for_entity_id"] = entity_id
        transaction.created_materials.append(material)
    scene_object.data.materials.clear()
    scene_object.data.materials.append(material)
    return material


def _set_material_color(operation: dict, transaction: _StageTransaction, project_id: str) -> None:
    scene_object = _require_owned_entity(operation["entity_id"], project_id)
    if scene_object.type != "MESH":
        raise STAGE_SCENE_TARGET_TYPE_INVALID(
            f"entity {operation['entity_id']} must be a MESH"
        )
    material = _generated_material(scene_object, transaction)
    material.use_nodes = True
    material.diffuse_color = operation["color"]
    principled = material.node_tree.nodes.get("Principled BSDF")
    if principled is None:
        raise STAGE_SCENE_TARGET_TYPE_INVALID(
            "generated material has no Principled BSDF node"
        )
    principled.inputs["Base Color"].default_value = operation["color"]


def _upsert_area_light(operation: dict, transaction: _StageTransaction, project_id: str):
    scene_object = _entity(operation["entity_id"])
    if scene_object is None:
        if bpy.data.objects.get(operation["name"]) is not None:
            raise STAGE_SCENE_STABLE_NAME_EXISTS(
                f"stable name {operation['name']!r} already exists"
            )
        light = bpy.data.lights.new(f"{operation['name']} Data", "AREA")
        scene_object = bpy.data.objects.new(operation["name"], light)
        scene_object["omb.entity_id"] = operation["entity_id"]
        scene_object["omb.owned_project_id"] = project_id
        transaction.scene.collection.objects.link(scene_object)
        transaction.created_objects.append(scene_object)
    else:
        if not _owned(scene_object, project_id):
            raise STAGE_SCENE_TARGET_NOT_OMB_OWNED(
                f"entity {operation['entity_id']} was not created by OMB for this project"
            )
        if scene_object.type != "LIGHT":
            raise STAGE_SCENE_TARGET_TYPE_INVALID(
                f"entity {operation['entity_id']} must be a LIGHT"
            )
        transaction.capture_object(scene_object)
    scene_object.name = operation["name"]
    scene_object.location = operation["location"]
    scene_object.rotation_mode = "XYZ"
    scene_object.rotation_euler = operation["rotation"]
    scene_object.scale = operation["scale"]
    scene_object.data.type = "AREA"
    scene_object.data.energy = operation["energy"]
    scene_object.data.color = operation["color"]
    scene_object.data.size = operation["size"]
    return scene_object


def _transform_entity(operation: dict, transaction: _StageTransaction, project_id: str) -> None:
    scene_object = _require_owned_entity(operation["entity_id"], project_id)
    _require_exclusive_datablocks(scene_object)
    transaction.capture_object(scene_object)
    if "location" in operation:
        scene_object.location = operation["location"]
    if "rotation_euler" in operation:
        scene_object.rotation_mode = "XYZ"
        scene_object.rotation_euler = operation["rotation_euler"]
    if "scale" in operation:
        scene_object.scale = operation["scale"]


def _set_light_property(operation: dict, transaction: _StageTransaction, project_id: str) -> None:
    scene_object = _require_owned_entity(operation["entity_id"], project_id)
    if scene_object.type != "LIGHT":
        raise STAGE_SCENE_TARGET_TYPE_INVALID(
            f"entity {operation['entity_id']} must be a LIGHT"
        )
    _require_exclusive_datablocks(scene_object)
    transaction.capture_object(scene_object)
    light = scene_object.data
    if "energy" in operation:
        light.energy = operation["energy"]
    if "color" in operation:
        light.color = operation["color"]
    if "size" in operation:
        if light.type == "AREA":
            light.size = operation["size"]
        elif light.type == "SPOT":
            light.spot_size = operation["size"]
        else:
            raise STAGE_SCENE_TARGET_TYPE_INVALID(
                f"entity {operation['entity_id']} light type {light.type} has no size"
            )


def _set_camera_property(operation: dict, transaction: _StageTransaction, project_id: str) -> None:
    scene_object = _require_owned_entity(operation["entity_id"], project_id)
    if scene_object.type != "CAMERA":
        raise STAGE_SCENE_TARGET_TYPE_INVALID(
            f"entity {operation['entity_id']} must be a CAMERA"
        )
    _require_exclusive_datablocks(scene_object)
    transaction.capture_object(scene_object)
    camera = scene_object.data
    if "lens" in operation:
        camera.lens = operation["lens"]
    if "clip_start" in operation:
        camera.clip_start = operation["clip_start"]
    if "clip_end" in operation:
        camera.clip_end = operation["clip_end"]
    if "sensor_width" in operation:
        camera.sensor_width = operation["sensor_width"]
    if "sensor_height" in operation:
        camera.sensor_height = operation["sensor_height"]
    if "sensor_fit" in operation:
        fit_map = {"AUTO": "AUTO", "HORIZONTAL": "HORIZONTAL", "VERTICAL": "VERTICAL", "SQUARE": "SQUARE"}
        camera.sensor_fit = fit_map[operation["sensor_fit"]]


def _set_render_settings(operation: dict, transaction: _StageTransaction, project_id: str) -> None:
    render = bpy.context.scene.render
    scene = bpy.context.scene
    transaction.capture_render()
    if "resolution_x" in operation:
        render.resolution_x = operation["resolution_x"]
    if "resolution_y" in operation:
        render.resolution_y = operation["resolution_y"]
    if "resolution_percentage" in operation:
        render.resolution_percentage = operation["resolution_percentage"]
    if "fps" in operation:
        render.fps = operation["fps"]
        render.fps_base = 1.0
    if "frame_start" in operation:
        scene.frame_start = operation["frame_start"]
    if "frame_end" in operation:
        scene.frame_end = operation["frame_end"]


def _rename_entity(operation: dict, transaction: _StageTransaction, project_id: str) -> None:
    scene_object = _require_owned_entity(operation["entity_id"], project_id)
    _require_exclusive_datablocks(scene_object)
    transaction.capture_object(scene_object)
    scene_object.name = operation["name"]


def _live_base_manifest(current_scene_hash: str) -> dict:
    from .manifest import (
        extract_scene_manifest_v2,
        extract_scene_manifest_v3,
        extract_scene_manifest_v4,
    )

    v2 = extract_scene_manifest_v2()
    if v2["sceneHash"] == current_scene_hash:
        return v2
    v3 = extract_scene_manifest_v3()
    if v3["sceneHash"] == current_scene_hash:
        return v3
    v4 = extract_scene_manifest_v4()
    if v4["sceneHash"] == current_scene_hash:
        return v4
    raise StageSceneError(
        "STALE_BASE: live main-thread manifest hash differs from the durable expected base"
    )


def _check_abort(deadline: float | None, cancelled: Callable[[], bool]) -> None:
    if cancelled():
        raise STAGE_SCENE_CANCELLED("stage_scene was cancelled")
    if deadline is not None and time.monotonic() >= deadline:
        raise STAGE_SCENE_DEADLINE_EXCEEDED("stage_scene deadline elapsed")

def _watch_pace_ms() -> int:
    """Visual watch-mode pacing per applied operation, in milliseconds.

    Purely presentational: paces viewport redraws while a plan is applied so
    the scene builds up visibly. The durable commit stays atomic - a crash
    mid-application rolls back to the base revision exactly as before.
    Disabled headless, host-side, and unless OMB_WATCH_MS is set (the omb
    launcher sets it for interactive sessions; tests run unpaced).
    """
    if bpy is None or bpy.app.background:
        return 0
    try:
        value = int(os.environ.get("OMB_WATCH_MS", "0"))
    except ValueError:
        return 0
    return min(max(value, 0), 1000)


def _watch_step() -> None:
    pace = _watch_pace_ms()
    if pace == 0:
        return
    try:
        bpy.context.view_layer.update()
        bpy.ops.wm.redraw_timer(type="DRAW_WIN_SWAP", iterations=1)
    except Exception:
        return
    time.sleep(pace / 1000.0)



def apply_stage_scene_transaction(
    plan_value: object,
    current_scene_hash: str,
    connection: object,
    commit_fn: Callable[[dict], object],
    *,
    cancelled: Callable[[], bool] = lambda: False,
    deadline: float | None = None,
) -> dict:
    """Apply one staged mutation and defer destruction until durable commit ack."""
    if bpy is None:
        raise StageSceneError("stage_scene requires Blender")
    from .checkpoint import create_checkpoint
    from .connection import DurableCommitReconciliationRequired
    from .manifest import extract_scene_manifest_v3, extract_scene_manifest_v4
    from .scene_manifest import finalize_scene_manifest_child

    plan = parse_stage_scene_plan(plan_value)
    uses_v4 = any(
        operation["op"] in ("create_assembly", "set_parent", "transform_assembly")
        or (
            operation["op"] == "add_primitive"
            and operation.get("parent_id") is not None
        )
        for operation in plan["operations"]
    )
    before_manifest = _live_base_manifest(current_scene_hash)
    _check_abort(deadline, cancelled)
    scene = bpy.context.scene
    project_id = scene.get("omb.project_id")
    if not isinstance(project_id, str):
        raise StageSceneError("scene is missing omb.project_id")
    transaction = _StageTransaction(scene)
    checkpoint = create_checkpoint({
        "stage_scene_scope": {"scene_hash": before_manifest["sceneHash"]}
    })

    def recover() -> bool:
        transaction.rollback()
        return _live_base_manifest(before_manifest["sceneHash"])[
            "sceneHash"
        ] == before_manifest["sceneHash"]

    connection.hold_checkpoint(checkpoint, recover)
    try:
        connection.ensure_mutation_connection("after_checkpoint")
        for operation in plan["operations"]:
            _check_abort(deadline, cancelled)
            if operation["op"] == "add_primitive":
                _create_primitive(operation, transaction, project_id)
            elif operation["op"] == "add_character":
                _create_character(operation, transaction, project_id)
            elif operation["op"] == "create_assembly":
                _create_assembly(operation, transaction, project_id)
            elif operation["op"] == "set_parent":
                _set_parent(operation, transaction, project_id)
            elif operation["op"] == "transform_assembly":
                _transform_assembly(operation, transaction, project_id)
            elif operation["op"] == "set_material_color":
                _set_material_color(operation, transaction, project_id)
            elif operation["op"] == "upsert_area_light":
                _upsert_area_light(operation, transaction, project_id)
            elif operation["op"] == "transform_entity":
                _transform_entity(operation, transaction, project_id)
            elif operation["op"] == "set_light_property":
                _set_light_property(operation, transaction, project_id)
            elif operation["op"] == "set_camera_property":
                _set_camera_property(operation, transaction, project_id)
            elif operation["op"] == "set_render_settings":
                _set_render_settings(operation, transaction, project_id)
            elif operation["op"] == "rename_entity":
                _rename_entity(operation, transaction, project_id)
            else:
                scene_object = _require_owned_entity(
                    operation["entity_id"], project_id
                )
                _require_exclusive_datablocks(scene_object)
                transaction.quarantine(scene_object)
            connection.ensure_mutation_connection(operation["op"])
            _watch_step()
        bpy.context.view_layer.update()
        _check_abort(deadline, cancelled)
        connection.ensure_mutation_connection("before_verify")
        extracted = (
            extract_scene_manifest_v4()
            if uses_v4
            else extract_scene_manifest_v3()
        )
        candidate_manifest = finalize_scene_manifest_child(
            extracted,
            plan["expected_revision_id"],
            plan,
        )
        objects_by_id = {
            scene_object["entityId"]: scene_object
            for scene_object in candidate_manifest["objects"]
        }
        entity_identities = [
            {
                "entity_id": operation["entity_id"],
                "requested_name": operation["name"],
                "actual_name": objects_by_id[operation["entity_id"]]["name"],
            }
            for operation in plan["operations"]
            if operation["op"] in ("add_primitive", "upsert_area_light", "add_character")
        ]
        result = {
            "expected_revision_id": plan["expected_revision_id"],
            "scene_hash": candidate_manifest["sceneHash"],
            "manifest": candidate_manifest,
            "entity_identities": entity_identities,
        }
        commit_fn(result)
        transaction.finalize_deletions()
        connection.release_checkpoint()
        return result
    except DurableCommitReconciliationRequired:
        raise
    except BaseException:
        recovered = False
        try:
            transaction.rollback()
            recovered = (
                _live_base_manifest(before_manifest["sceneHash"])["sceneHash"]
                == before_manifest["sceneHash"]
            )
        finally:
            if not recovered:
                connection.require_recovery()
            connection.release_checkpoint()
        raise


def schedule_stage_scene_transaction(
    plan_value: object,
    current_scene_hash: str,
    connection: object,
    commit_fn: Callable[[dict], object],
    result_fn: Callable[[dict | None, BaseException | None], None],
    *,
    cancelled: Callable[[], bool] = lambda: False,
    deadline: float | None = None,
) -> None:
    """Register stage_scene as a one-shot Blender main-thread timer."""
    if bpy is None:
        raise StageSceneError("stage_scene scheduling requires Blender")

    def run() -> None:
        try:
            result_fn(
                apply_stage_scene_transaction(
                    plan_value,
                    current_scene_hash,
                    connection,
                    commit_fn,
                    cancelled=cancelled,
                    deadline=deadline,
                ),
                None,
            )
        except BaseException as error:
            result_fn(None, error)
        return None

    bpy.app.timers.register(run, first_interval=0.0)
