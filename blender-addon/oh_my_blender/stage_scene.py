"""Closed StageScenePlanV1 validation and transactional Blender mutation."""

from __future__ import annotations

import math
import re
import time
import unicodedata
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
        "op", "entity_id", "primitive_type", "name", "location", "rotation", "scale"
    },
    "set_material_color": {"op", "entity_id", "color"},
    "upsert_area_light": {
        "op", "entity_id", "name", "location", "rotation", "scale",
        "energy", "color", "size"
    },
    "delete_entity": {"op", "entity_id"},
}
_PRIMITIVES = {"PLANE", "CUBE", "UV_SPHERE"}


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
        operation = _exact(raw_operation, expected_keys, f"operations[{index}]")
        entity_id = _uuid(operation.get("entity_id"), f"operations[{index}].entity_id")
        if operation_kind == "add_primitive":
            if operation.get("primitive_type") not in _PRIMITIVES:
                _invalid(f"operations[{index}].primitive_type is unsupported")
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

        if operation_kind in ("add_primitive", "upsert_area_light"):
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
        }
        if scene_object.type == "LIGHT":
            state["light"] = {
                "type": scene_object.data.type,
                "energy": float(scene_object.data.energy),
                "color": tuple(scene_object.data.color),
                "size": float(scene_object.data.size),
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
            if "light" in state:
                light = state["light"]
                scene_object.data.type = light["type"]
                scene_object.data.energy = light["energy"]
                scene_object.data.color = light["color"]
                scene_object.data.size = light["size"]
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
    return scene_object


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


def _live_base_manifest(current_scene_hash: str) -> dict:
    from .manifest import extract_scene_manifest_v2, extract_scene_manifest_v3

    v2 = extract_scene_manifest_v2()
    if v2["sceneHash"] == current_scene_hash:
        return v2
    v3 = extract_scene_manifest_v3()
    if v3["sceneHash"] == current_scene_hash:
        return v3
    raise StageSceneError(
        "STALE_BASE: live main-thread manifest hash differs from the durable expected base"
    )


def _check_abort(deadline: float | None, cancelled: Callable[[], bool]) -> None:
    if cancelled():
        raise STAGE_SCENE_CANCELLED("stage_scene was cancelled")
    if deadline is not None and time.monotonic() >= deadline:
        raise STAGE_SCENE_DEADLINE_EXCEEDED("stage_scene deadline elapsed")


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
    from .manifest import extract_scene_manifest_v3
    from .scene_manifest import finalize_scene_manifest_child

    plan = parse_stage_scene_plan(plan_value)
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
            elif operation["op"] == "set_material_color":
                _set_material_color(operation, transaction, project_id)
            elif operation["op"] == "upsert_area_light":
                _upsert_area_light(operation, transaction, project_id)
            else:
                transaction.quarantine(
                    _require_owned_entity(operation["entity_id"], project_id)
                )
            connection.ensure_mutation_connection(operation["op"])
        bpy.context.view_layer.update()
        _check_abort(deadline, cancelled)
        connection.ensure_mutation_connection("before_verify")
        extracted = extract_scene_manifest_v3()
        candidate_manifest = finalize_scene_manifest_child(
            extracted,
            plan["expected_revision_id"],
            plan,
        )
        result = {
            "expected_revision_id": plan["expected_revision_id"],
            "scene_hash": candidate_manifest["sceneHash"],
            "manifest": candidate_manifest,
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
