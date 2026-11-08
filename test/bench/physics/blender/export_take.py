# .blend -> take.json for the physical motion bench (docs/qa/physics-bench.md, PR 2); the mapping is take_io.py.
#   blender -b <run.blend> --python export_take.py -- <set.json> <take.json> [source json]
# Exports char-a over the scene's frame range and every set object by its id (an object the agent deleted gets an
# empty matrix list). The harness runs it on the .blend it saved from the agent's live session.
import json
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import take_io  # noqa: E402

ARGV = sys.argv[sys.argv.index("--") + 1:]
SET = json.load(open(ARGV[0], encoding="utf-8"))
SOURCE = json.loads(ARGV[2]) if len(ARGV) > 2 else {}
scene = bpy.context.scene
arm = bpy.data.objects.get(SET["character"]["id"])
if arm is None or arm.type != "ARMATURE":
    raise SystemExit("export_take: no armature named " + SET["character"]["id"])
take = take_io.export_take(scene, arm, SET["objects"], {"set": SET["id"], **SOURCE})
with open(ARGV[1], "w", encoding="utf-8") as f:
    json.dump(take, f)
print("export_take: {:d} frames ({:d}..{:d}) -> {:s}".format(take["frames"], scene.frame_start, scene.frame_end, ARGV[1]))
