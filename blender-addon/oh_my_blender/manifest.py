"""Extract a small, validated scene boundary from Blender."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable, TypedDict

import bpy


class SceneDetails(TypedDict):
    name: str
    frameStart: int
    frameEnd: int
    fps: int


class SceneObject(TypedDict):
    name: str
    type: str
    location: list[float]
    rotationEuler: list[float]
    scale: list[float]
    visible: bool


class SceneSnapshot(TypedDict):
    schemaVersion: int
    scene: SceneDetails
    objects: list[SceneObject]


def _vector(values: Iterable[float]) -> list[float]:
    return [float(value) for value in values]


def _object_snapshot(scene_object: bpy.types.Object) -> SceneObject:
    return {
        "name": scene_object.name,
        "type": scene_object.type,
        "location": _vector(scene_object.location),
        "rotationEuler": _vector(scene_object.rotation_euler),
        "scale": _vector(scene_object.scale),
        "visible": scene_object.visible_get(),
    }


def extract_scene_snapshot() -> SceneSnapshot:
    scene = bpy.context.scene
    objects = sorted(scene.objects, key=lambda scene_object: scene_object.name)
    return {
        "schemaVersion": 1,
        "scene": {
            "name": scene.name,
            "frameStart": scene.frame_start,
            "frameEnd": scene.frame_end,
            "fps": scene.render.fps,
        },
        "objects": [_object_snapshot(scene_object) for scene_object in objects],
    }


def write_scene_snapshot(output_path: Path) -> None:
    output_path.write_text(json.dumps(extract_scene_snapshot(), indent=2), encoding="utf-8")
