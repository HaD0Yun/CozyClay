"""Typed ARDY character-rig adaptation boundary."""

from __future__ import annotations

from . import motion_retarget


class CharacterRigAdapter:
    """Read-only cskel27-to-character-rig lookup and scale adapter."""

    def __init__(self, bones):
        self.bones = bones
        self.prefix = "mixamorig:" if any(b.name.startswith("mixamorig:") for b in bones) else ""

    @property
    def rig_thigh(self):
        upper = self.bones.get(f"{self.prefix}RightUpLeg")
        lower = self.bones.get(f"{self.prefix}RightLeg")
        if upper is None or lower is None:
            return None
        return (lower.head_local - upper.head_local).length

    def rest_rotations(self) -> dict[str, list[list[float]]]:
        rotations = {}
        for cskel, target in motion_retarget.MIXAMO_TARGETS.items():
            if target is None:
                continue
            bone = self.bones.get(f"{self.prefix}{target}")
            if bone is not None:
                rotations[cskel] = [list(row) for row in bone.matrix_local.to_3x3()]
        return rotations

    def hips_head(self):
        hips = self.bones.get(f"{self.prefix}Hips")
        return None if hips is None else list(hips.head_local)

    def authored_bone_names(self, rotations: dict[str, object], pose_bones) -> tuple[str, ...]:
        return tuple(
            f"{self.prefix}{motion_retarget.MIXAMO_TARGETS[cskel]}"
            for cskel in rotations
            if motion_retarget.MIXAMO_TARGETS[cskel] is not None
            and pose_bones.get(f"{self.prefix}{motion_retarget.MIXAMO_TARGETS[cskel]}") is not None
        )
