# take.json -> side and front 3/4 videos at real speed, the same renderer for both tools (docs/qa/physics-bench.md,
# PR 5; plan 4.2: grey material, the same lighting, the same two cameras).
#   blender -b <built start.blend> --python render.py -- <take.json> <out dir> <view.json>
# The .blend is the set's start file (build_scene.py). view.json is { "min": [x,y,z], "max": [x,y,z] } in set axes:
# the box every take of this task moves in (render.mjs takes the union over both tools and all runs), so both tools
# get the same cameras and the framing gives no hint of the tool. Writes side.mp4 and front.mp4 (H.264, 24 fps).
import json
import math
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import take_io  # noqa: E402

ARGV = sys.argv[sys.argv.index("--") + 1:]
TAKE = json.load(open(ARGV[0], encoding="utf-8"))
OUT = ARGV[1]
VIEW = json.load(open(ARGV[2], encoding="utf-8"))
LENS, SENSOR, W, H = 35.0, 36.0, 960, 540


def grey(name, v):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (v, v, v, 1.0)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (v, v, v, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.7
    return mat


def paint(arm):
    body, props, floor = grey("bench body", 0.62), grey("bench props", 0.4), grey("bench floor", 0.85)
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        mat = floor if obj.name == "floor" else body if obj.parent == arm else props
        obj.data.materials.clear()
        obj.data.materials.append(mat)


def place(name, corners, direction):
    """A fixed camera looking along -direction at the box's centre, as close as it can be with every corner in frame."""
    cam_data = bpy.data.cameras.new(name)
    cam_data.lens, cam_data.sensor_width = LENS, SENSOR
    tan_h, tan_v = (SENSOR / 2) / LENS, (SENSOR / 2) * (H / W) / LENS
    center = sum(corners, Vector()) / len(corners)
    back = direction.normalized()
    right = Vector((0.0, 0.0, 1.0)).cross(back).normalized()
    up = back.cross(right)
    need = 0.0
    for p in corners:
        r = p - center
        depth = r.dot(back)  # toward the camera
        need = max(need, depth + abs(r.dot(right)) / tan_h, depth + abs(r.dot(up)) / tan_v)
    cam = bpy.data.objects.new(name, cam_data)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = center + back * need * 1.08
    cam.rotation_euler = (-back).to_track_quat("-Z", "Y").to_euler()
    return cam


def main():
    scene = bpy.context.scene
    (char_id,) = TAKE["characters"].keys()
    arm = bpy.data.objects[char_id]
    take_io.import_take(scene, arm, TAKE)
    paint(arm)
    for obj in [o for o in bpy.data.objects if o.type in ("CAMERA", "LIGHT")]:
        bpy.data.objects.remove(obj)
    sun = bpy.data.objects.new("bench sun", bpy.data.lights.new("bench sun", "SUN"))
    sun.data.energy, sun.data.angle = 3.0, math.radians(8)
    sun.rotation_euler = (math.radians(45), 0.0, math.radians(35))
    scene.collection.objects.link(sun)
    scene.world = scene.world or bpy.data.worlds.new("bench world")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.55, 0.57, 0.6, 1.0)
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.8
    lo, hi = take_io.A_INV @ Vector(VIEW["min"]), take_io.A_INV @ Vector(VIEW["max"])
    pad = 0.25
    box_min = Vector([min(lo[i], hi[i]) - pad for i in range(3)])
    box_max = Vector([max(lo[i], hi[i]) + pad for i in range(3)])
    corners = [Vector((x, y, z)) for x in (box_min.x, box_max.x) for y in (box_min.y, box_max.y) for z in (box_min.z, box_max.z)]
    # the character faces -Y in Blender: side = from its left (+X), front 3/4 = from ahead and to its left, both a
    # little above
    views = {"side": Vector((1.0, 0.0, 0.12)), "front": Vector((0.7, -0.7, 0.25))}
    r = scene.render
    r.engine = "BLENDER_EEVEE"
    r.resolution_x, r.resolution_y, r.resolution_percentage = W, H, 100
    r.fps, r.fps_base = 24, 1.0
    r.image_settings.media_type = "VIDEO"
    r.image_settings.file_format = "FFMPEG"
    r.ffmpeg.format, r.ffmpeg.codec, r.ffmpeg.constant_rate_factor = "MPEG4", "H264", "MEDIUM"
    scene.frame_start, scene.frame_end = 0, TAKE["frames"] - 1
    for name, direction in views.items():
        scene.camera = place("bench " + name, corners, direction)
        r.filepath = os.path.join(OUT, name + ".mp4")
        bpy.ops.render.render(animation=True)
        print("render: {:s} {:d} frames -> {:s}".format(name, TAKE["frames"], r.filepath))


main()
