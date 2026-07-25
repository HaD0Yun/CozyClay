"""Build every PRIMITIVE_TYPES member in real Blender and report its geometry.

Runs inside headless Blender because bmesh is unavailable to host-side tests.
Emits one CCLAY_PRIMITIVE_GEOMETRY= line for test_primitive_geometry.py to parse.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import bmesh

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

from cclay.scene_manifest import PRIMITIVE_TYPES  # noqa: E402
from cclay.stage_scene import _build_primitive_mesh  # noqa: E402

results = {}
for primitive_type in PRIMITIVE_TYPES:
    editable = bmesh.new()
    try:
        _build_primitive_mesh(editable, primitive_type)
        coordinates = [vertex.co.copy() for vertex in editable.verts]
        results[primitive_type] = {
            "verts": len(editable.verts),
            "faces": len(editable.faces),
            "smooth_faces": sum(1 for face in editable.faces if face.smooth),
            "loose_verts": sum(1 for vertex in editable.verts if not vertex.link_edges),
            "min": [min(c[axis] for c in coordinates) for axis in range(3)],
            "max": [max(c[axis] for c in coordinates) for axis in range(3)],
        }
    finally:
        editable.free()

unknown = None
editable = bmesh.new()
try:
    _build_primitive_mesh(editable, "NOT_A_SHAPE")
except Exception as exc:  # the builder must refuse, not silently emit a sphere
    unknown = type(exc).__name__
finally:
    editable.free()

print(f"CCLAY_PRIMITIVE_GEOMETRY={json.dumps({'shapes': results, 'unknownError': unknown})}")
