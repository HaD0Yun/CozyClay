"""Create a deterministic Blender fixture and export its scene snapshot."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import bpy

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

from oh_my_blender.manifest import write_scene_snapshot


class FixtureCreationError(RuntimeError):
    """Raised when Blender cannot create the deterministic test scene."""


def _arguments() -> argparse.Namespace:
    blender_arguments = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args(blender_arguments)


def main() -> None:
    arguments = _arguments()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.name = "Boxing Demo"
    scene.frame_start = 1
    scene.frame_end = 384
    scene.render.fps = 24
    bpy.ops.mesh.primitive_cube_add(location=(0.0, 0.0, 1.0))
    fighter = bpy.context.active_object
    if fighter is None:
        raise FixtureCreationError("Blender did not create the fixture object")
    fighter.name = "Fighter"
    write_scene_snapshot(arguments.output)
    print(f"OMB_SNAPSHOT={arguments.output}")


main()
