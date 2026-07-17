"""Blender-side bridge for Oh My Blender."""

bl_info = {
    "name": "Oh My Blender",
    "author": "Oh My Blender",
    "version": (0, 1, 0),
    "blender": (5, 0, 0),
    "category": "Animation",
}


def register() -> None:
    """Register the add-on. The first vertical slice exposes read-only helpers."""


def unregister() -> None:
    """Unregister the add-on."""
