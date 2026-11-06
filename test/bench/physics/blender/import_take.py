# take.json -> keys on a set's .blend for the physical motion bench (docs/qa/physics-bench.md, PR 2); see take_io.py.
#   blender -b <built.blend> --python import_take.py -- <take.json> <out.blend>
# Used for the round-trip check and to render either tool's take with the same renderer.
import json
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import take_io  # noqa: E402

ARGV = sys.argv[sys.argv.index("--") + 1:]
TAKE = json.load(open(ARGV[0], encoding="utf-8"))
(char_id,) = TAKE["characters"].keys()
stats = take_io.import_take(bpy.context.scene, bpy.data.objects[char_id], TAKE)
bpy.ops.wm.save_as_mainfile(filepath=ARGV[1], compress=True)
print("import_take: {:d} frames -> {:s}".format(TAKE["frames"], ARGV[1]))
print("import_take stats " + json.dumps(stats))
