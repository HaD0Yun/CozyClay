# take.json <-> Blender for the physical motion bench (docs/qa/physics-bench.md, PR 2); see take.mjs for the format.
# Set axes are +Y up with the character facing +Z; Blender is +Z up: A maps a Blender world point to set axes.
# A take bone matrix uses the CozyClay rig's bone frame (src/motion3/rigs/y-bot-tpose.json). A Blender pose bone has
# its own frame (+Y along the bone) under an armature turned 90 deg about X and scaled 0.01 (the FBX import), so each
# bone gets one constant correction C_b, measured at rest:
#   M_set(t) = A @ W(t) @ P_b(t) @ C_b,   C_b = (A @ BASIS @ L_b)^-1 @ M_rest_b
# W is the armature's world matrix, P_b its pose matrix (armature space), L_b its rest (armature space), BASIS the
# armature's import rotation and scale, M_rest_b the rig's rest frame. C_b does not depend on where the character
# stands. L_b is read from what build_scene.py stored at build time (bench_rest), so an agent that edits the rest
# pose still maps through the bind it was given. An object matrix is A @ world @ A^-1 (its rest axes are the set's).
import json
import math
import os

import bpy
from mathutils import Matrix, Quaternion, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
RIG_JSON = os.path.normpath(os.path.join(HERE, "..", "..", "..", "..", "src", "motion3", "rigs", "y-bot-tpose.json"))
A = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, -1, 0, 0), (0, 0, 0, 1)))
A_INV = A.inverted()
BASIS = Matrix.Rotation(math.radians(90), 4, "X") @ Matrix.Diagonal((0.01, 0.01, 0.01, 1.0))


def rig_rest():
    """[(bone name, rest frame as a 4x4 in set axes, metres)] in rig order."""
    rig = json.load(open(RIG_JSON, encoding="utf-8"))
    out = []
    for b in rig["bones"]:
        x, y, z, w = b["worldQuat"]
        m = Quaternion((w, x, y, z)).to_matrix().to_4x4()
        m.translation = Vector(b["worldPos"]) * 0.01
        out.append(("mixamorig:" + b["name"], m))
    return out


def flat(m):
    return [round(m[i][j], 7) for i in range(4) for j in range(4)]


def unflat(v):
    return Matrix([v[0:4], v[4:8], v[8:12], v[12:16]])


def store_rest(arm):
    """Keep each bone's build-time rest (armature space) on the armature data."""
    arm.data["bench_rest"] = {b.name: flat(b.matrix_local) for b in arm.data.bones}


def corrections(arm):
    stored = arm.data.get("bench_rest")
    out = {}
    for name, rest in rig_rest():
        local = unflat(list(stored[name])) if stored else arm.data.bones[name].matrix_local
        out[name] = (A @ BASIS @ local).inverted() @ rest
    return out


def rest_head_error(arm):
    """Largest distance (m) between the Blender rest bone heads and the rig's, both relative to the character."""
    return max(((A @ BASIS @ arm.data.bones[name].matrix_local).translation - rest.translation).length for name, rest in rig_rest())


def export_take(scene, arm, objects, source):
    names = [n for n, _ in rig_rest()]
    corr = corrections(arm)
    frames, bones, tracks = list(range(scene.frame_start, scene.frame_end + 1)), [], {o["id"]: [] for o in objects}
    for f in frames:
        scene.frame_set(f)
        w = arm.matrix_world
        bones.append([flat(A @ w @ arm.pose.bones[n].matrix @ corr[n]) for n in names])
        for o in objects:
            obj = bpy.data.objects.get(o["id"])
            tracks[o["id"]].append(flat(A @ obj.matrix_world @ A_INV) if obj else None)
    out_objects = {}
    for o in objects:
        ms = tracks[o["id"]]
        if any(m is None for m in ms):
            ms = []
        elif all(m == ms[0] for m in ms):
            ms = [ms[0]]
        out_objects[o["id"]] = {"shape": o["shape"], "size": o.get("size"), "fixed": bool(o.get("fixed", False)),
                                "mass": o.get("mass"), "parent": o.get("parent"), "matrix": ms}
    return {"version": 0, "fps": scene.render.fps, "frames": len(frames),
            "rig": {"name": "y-bot-tpose", "bones": names}, "characters": {arm.name: {"bones": bones}},
            "objects": out_objects, "source": {"tool": "blender", "frameStart": scene.frame_start,
                                               "restHeadError": rest_head_error(arm), **source}}


def _key_bone(pb, f):
    for path in ("location", "rotation_quaternion", "scale"):
        pb.keyframe_insert(data_path=path, frame=f)


def _key_object(obj, f):
    for path in ("location", "rotation_quaternion", "scale"):
        obj.keyframe_insert(data_path=path, frame=f)


def import_take(scene, arm, take):
    """Key the take onto the armature (and the moving objects that have no parent), frames 0 .. F-1."""
    names = take["rig"]["bones"]
    corr = corrections(arm)
    w_inv = arm.matrix_world.inverted()
    rest = {b.name: b.matrix_local for b in arm.data.bones}
    parent = {b.name: (b.parent.name if b.parent else None) for b in arm.data.bones}
    for pb in arm.pose.bones:
        pb.rotation_mode = "QUATERNION"
    frames = take["characters"][arm.name]["bones"]
    # a rigid take needs no bone translation below the hips: stretch is the largest one (m), an independent check
    # that the bone frames map onto Blender's bind (a wrong C_b would show up here, not in a round trip)
    stats = {"stretch": 0.0, "scale": 0.0}
    for f, row in enumerate(frames):
        pose = {}
        for name, m in zip(names, row):
            pose[name] = w_inv @ A_INV @ unflat(m) @ corr[name].inverted()
            p = parent[name]
            rel = rest[name] if p is None else rest[p].inverted() @ rest[name]
            basis = rel.inverted() @ (pose[name] if p is None else pose[p].inverted() @ pose[name])
            pb = arm.pose.bones[name]
            pb.matrix_basis = basis
            if p is not None:
                stats["stretch"] = max(stats["stretch"], (arm.matrix_world.to_3x3() @ rest[name].to_3x3() @ basis.translation).length)
            stats["scale"] = max(stats["scale"], *(abs(v - 1.0) for v in basis.to_scale()))
            _key_bone(pb, f)
    for oid, o in take["objects"].items():
        obj = bpy.data.objects.get(oid)
        if obj is not None and not o["matrix"]:
            # an empty track: the take deleted this object, so the built scene drops it too
            bpy.data.objects.remove(obj, do_unlink=True)
            continue
        if obj is None or o.get("parent") or len(o["matrix"]) < 2:
            continue
        obj.rotation_mode = "QUATERNION"
        for f, m in enumerate(o["matrix"]):
            obj.matrix_world = A_INV @ unflat(m) @ A
            _key_object(obj, f)
    scene.frame_start = 0
    scene.frame_end = len(frames) - 1
    return stats
