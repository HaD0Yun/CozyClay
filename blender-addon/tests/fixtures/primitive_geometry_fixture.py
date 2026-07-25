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

def _component_count(mesh: bmesh.types.BMesh) -> int:
    """Connected components over faces joined by shared edges.

    A builder that emitted two detached halves would pass every vertex/face count
    and bounding-box check, so "connected" has to be measured rather than asserted
    in a docstring.
    """
    unvisited = set(mesh.faces)
    components = 0
    while unvisited:
        components += 1
        frontier = [unvisited.pop()]
        while frontier:
            face = frontier.pop()
            for edge in face.edges:
                for neighbour in edge.link_faces:
                    if neighbour in unvisited:
                        unvisited.discard(neighbour)
                        frontier.append(neighbour)
    return components


results = {}
for primitive_type in PRIMITIVE_TYPES:
    editable = bmesh.new()
    try:
        _build_primitive_mesh(editable, primitive_type)
        coordinates = [vertex.co.copy() for vertex in editable.verts]
        results[primitive_type] = {
            "verts": len(editable.verts),
            "edges": len(editable.edges),
            "faces": len(editable.faces),
            "smooth_faces": sum(1 for face in editable.faces if face.smooth),
            "loose_verts": sum(1 for vertex in editable.verts if not vertex.link_edges),
            # bmesh reports a boundary edge as non-manifold too, so separate them:
            # an open surface is legitimate for PLANE and CIRCLE, an edge shared by
            # three or more faces never is.
            "boundary_edges": sum(1 for edge in editable.edges if edge.is_boundary),
            "overshared_edges": sum(
                1 for edge in editable.edges if len(edge.link_faces) > 2
            ),
            "wire_edges": sum(1 for edge in editable.edges if not edge.link_faces),
            "zero_area_faces": sum(
                1 for face in editable.faces if face.calc_area() <= 1e-9
            ),
            "components": _component_count(editable),
            "min": [min(c[axis] for c in coordinates) for axis in range(3)],
            "max": [max(c[axis] for c in coordinates) for axis in range(3)],
            # Cap/side smoothing is decided by abs(face.normal.z) < 0.9, so record
            # the worst normal on each side of that line. A shrinking margin is the
            # early warning that the threshold has stopped being safe.
            "max_smooth_abs_normal_z": max(
                (abs(face.normal.z) for face in editable.faces if face.smooth),
                default=None,
            ),
            "min_flat_abs_normal_z": min(
                (abs(face.normal.z) for face in editable.faces if not face.smooth),
                default=None,
            ),
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


print(
    "CCLAY_PRIMITIVE_GEOMETRY="
    + json.dumps({
        "shapes": results,
        "unknownError": unknown,
        "declared": list(PRIMITIVE_TYPES),
    })
)
