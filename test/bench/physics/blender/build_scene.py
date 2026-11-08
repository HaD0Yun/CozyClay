# Set -> .blend for the physical motion bench (docs/qa/physics-bench.md, PR 1).
#   blender -b --factory-startup --python build_scene.py -- <set.json> <y-bot-tpose.fbx> <out.blend> [bounds.json]
# The Y Bot FBX is loaded from the local file at build time (it is a Mixamo file, so the .blend is never committed).
# Set points are CozyClay axes (+Y up, the character faces +Z); Blender is +Z up, so (x, y, z) -> (x, -z, y), and the
# imported Y Bot already faces -Y. Objects are built with identity rotation and unit scale (transforms applied), named
# by their set id, with custom properties "mass" (kg) and "fixed". bounds.json, when asked for, lists each object's
# world bounds and the character root in set axes, for check-sets.mjs. The armature keeps its build-time bone rests
# (take_io.store_rest) for the take exporter.
import json
import math
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import take_io  # noqa: E402

ARGV = sys.argv[sys.argv.index("--") + 1:]
SET_PATH, FBX_PATH, OUT_BLEND = ARGV[:3]
BOUNDS_PATH = ARGV[3] if len(ARGV) > 3 else None
SET = json.load(open(SET_PATH, encoding="utf-8"))
FRAMES = 240  # the same start length as the CozyClay document (shotDocument.frameCount)


def to_blender(p):
    x, y, z = p
    return Vector((x, -z, y))


def to_set(v):
    return [v.x, v.z, -v.y]


def material(color):
    name = "bench " + color
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name)
        rgb = [int(color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
        mat.diffuse_color = (*rgb, 1.0)
        mat.use_nodes = True
        mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*rgb, 1.0)
    return mat


def finish(obj, spec):
    obj.name = spec["id"]
    if obj.data is not None:
        obj.data.name = spec["id"]
        obj.data.materials.append(material(spec.get("color", "#b0bec5")))
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    obj["fixed"] = bool(spec.get("fixed", False))
    if spec.get("mass") is not None:
        obj["mass"] = float(spec["mass"])
    return obj


def build_object(spec):
    loc = to_blender(spec["center"])
    if spec["shape"] == "group":
        bpy.ops.object.empty_add(type="PLAIN_AXES", radius=0.25, location=loc)
        obj = bpy.context.active_object
        obj.name = spec["id"]
        obj["fixed"] = bool(spec.get("fixed", False))
        if spec.get("mass") is not None:
            obj["mass"] = float(spec["mass"])
        return obj
    sx, sy, sz = spec["size"]
    if spec["shape"] == "box":
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc)
        obj = bpy.context.active_object
        obj.scale = (sx, sz, sy)
        return finish(obj, spec)
    axis = spec["axis"]
    length = {"x": sx, "y": sy, "z": sz}[axis]
    diameter = sy if axis == "x" else sx
    rotation = {"x": (0.0, math.pi / 2, 0.0), "y": (0.0, 0.0, 0.0), "z": (math.pi / 2, 0.0, 0.0)}[axis]
    bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=diameter / 2, depth=length, location=loc, rotation=rotation)
    return finish(bpy.context.active_object, spec)


def build_character(spec):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=FBX_PATH)
    new = [o for o in bpy.data.objects if o not in before]
    arm = next(o for o in new if o.type == "ARMATURE")
    arm.name = spec["id"]
    arm.data.name = spec["id"]
    arm.location = to_blender(spec["position"])
    if arm.animation_data is not None:
        arm.animation_data_clear()
    bpy.context.view_layer.update()
    basis = arm.matrix_world.copy()
    basis.translation = (0.0, 0.0, 0.0)
    if max(abs(basis[i][j] - take_io.BASIS[i][j]) for i in range(4) for j in range(4)) > 1e-6:
        raise RuntimeError("the Y Bot import is not turned 90 deg about X and scaled 0.01; take_io.BASIS no longer holds")
    take_io.store_rest(arm)
    return arm


def add_view(target):
    cam_data = bpy.data.cameras.new("Camera")
    cam = bpy.data.objects.new("Camera", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = target + Vector((7.0, 0.0, 0.6))
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    cam_data.lens = 35
    bpy.context.scene.camera = cam
    sun_data = bpy.data.lights.new("Sun", "SUN")
    sun_data.energy = 3.0
    sun = bpy.data.objects.new("Sun", sun_data)
    sun.rotation_euler = (math.radians(50), 0.0, math.radians(30))
    bpy.context.scene.collection.objects.link(sun)


def bounds_of(obj):
    """World bounds in set axes; a group (an Empty) is the union of its children, as the Studio reports it."""
    if obj.type != "MESH":
        kids = [bounds_of(k) for k in obj.children]
        if not kids:
            p = to_set(obj.matrix_world.translation)
            return {"min": p, "max": p}
        return {"min": [min(k["min"][i] for k in kids) for i in range(3)], "max": [max(k["max"][i] for k in kids) for i in range(3)]}
    pts = [to_set(obj.matrix_world @ v.co) for v in obj.data.vertices]
    return {"min": [min(p[i] for p in pts) for i in range(3)], "max": [max(p[i] for p in pts) for i in range(3)]}


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    arm = build_character(SET["character"])
    scene.render.fps = SET["fps"]
    scene.render.fps_base = 1.0
    scene.frame_start = 0
    scene.frame_end = FRAMES - 1
    scene.frame_set(0)
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    bpy.ops.mesh.primitive_plane_add(size=40.0, location=(0.0, 0.0, 0.0))
    finish(bpy.context.active_object, {"id": "floor", "fixed": True, "color": "#cfd8dc"})
    built = {o["id"]: build_object(o) for o in SET["objects"]}
    for o in SET["objects"]:
        if o.get("parent"):
            child, parent = built[o["id"]], built[o["parent"]]
            child.parent = parent
            child.matrix_parent_inverse = parent.matrix_world.inverted()
    add_view(arm.location + Vector((0.0, 0.0, 1.0)))
    bpy.ops.object.select_all(action="DESELECT")
    bpy.ops.wm.save_as_mainfile(filepath=OUT_BLEND, compress=True)
    if BOUNDS_PATH:
        bpy.context.view_layer.update()
        hips = arm.pose.bones["mixamorig:Hips"]
        out = {
            "objects": {o["id"]: bounds_of(built[o["id"]]) for o in SET["objects"]},
            "character": {"position": to_set(arm.matrix_world.translation), "hips": to_set(arm.matrix_world @ hips.head),
                          "bones": len(arm.data.bones)},
            "fps": scene.render.fps,
        }
        with open(BOUNDS_PATH, "w", encoding="utf-8") as f:
            json.dump(out, f, indent=1)


main()
