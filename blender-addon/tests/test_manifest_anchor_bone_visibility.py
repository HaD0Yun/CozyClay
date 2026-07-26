"""Anchor bones (IK/constraint control layer) stay out of the scene manifest.

The IK rig and constraint anchors (``CCLAY-IK-*`` handles, ``CCLAY-CONSTRAINT-*``
full-body and 2D-root anchors) are added to an armature as control-layer bones.
``cclay.manifest._manifest_bones`` skips any bone without ``cclay.entity_id``,
and the control layer never stamps one, so those bones never enter the bones
list and therefore never enter the canonical scene hash preimage.

Why this matters: the canonical revision is what the protocol authorizes
mutations against and what stored fixtures/snapshots pin. If an anchor leaked
into the hash, attaching or detaching the IK layer would flip the revision,
invalidating every existing fixture and snapshot even though the character the
director sees is unchanged. This test locks that contract at both the
``_manifest_bones`` unit level and the end-to-end scene-hash level.
"""

from __future__ import annotations

import importlib
import sys
import types
import unittest

import cclay

# cclay.manifest hard-imports bpy/mathutils. Install stubs only for the
# duration of that import and remove any we inserted afterwards: leaving a
# bare importable "bpy" module behind flips other modules' try-import-else-None
# guards (e.g. qa_render) from None to a broken stub for the whole test run.
_inserted = []
for _name, _module in (
    ("bpy", types.ModuleType("bpy")),
    ("mathutils", None),
):
    if _name not in sys.modules:
        if _module is None:
            _module = types.ModuleType("mathutils")
            _module.Quaternion = object
        sys.modules[_name] = _module
        _inserted.append(_name)
try:
    manifest = importlib.import_module("cclay.manifest")
    scene_manifest = importlib.import_module("cclay.scene_manifest")
finally:
    for _name in _inserted:
        sys.modules.pop(_name, None)

from cclay import ik_chains  # noqa: E402

PROJECT = "00000000-0000-4000-8000-000000000001"
ARMATURE_OBJECT = "00000000-0000-4000-8000-000000000006"
TRACKED_BONE = "00000000-0000-4000-8000-000000000007"


class FakeMatrix:
    def decompose(self):
        return ((0.0, 0.0, 0.0), (1.0, 0.0, 0.0, 0.0), (1.0, 1.0, 1.0))


class FakeBone(dict):
    def __init__(self, name: str, entity_id: str | None = None, parent=None) -> None:
        super().__init__()
        if entity_id is not None:
            self["cclay.entity_id"] = entity_id
        self.name = name
        self.parent = parent
        self.matrix_local = FakeMatrix()

    __hash__ = object.__hash__


class FakeArmatureData:
    def __init__(self, bones: list[FakeBone]) -> None:
        self.bones = bones


class FakeArmatureObject(dict):
    def __init__(self, name: str, entity_id: str | None, bones: list[FakeBone]) -> None:
        super().__init__()
        if entity_id is not None:
            self["cclay.entity_id"] = entity_id
        self.name = name
        self.type = "ARMATURE"
        self.data = FakeArmatureData(bones)

    __hash__ = object.__hash__


def _minimal_manifest_parts(bones: list[dict]) -> dict:
    return dict(
        project_id=PROJECT,
        blender_version="4.3.0",
        scene={"name": "Scene", "frameStart": 1, "frameEnd": 250,
               "fpsNumerator": 24, "fpsDenominator": 1, "activeCameraId": None},
        render={"resolutionX": 1920, "resolutionY": 1080, "resolutionPercentage": 100},
        objects=[{"entityId": ARMATURE_OBJECT, "name": "Armature", "type": "ARMATURE",
                  "parentId": None, "visible": True, "location": [0, 0, 0],
                  "rotationQuaternion": [1, 0, 0, 0], "scale": [1, 1, 1]}],
        bones=bones,
        cameras=[],
        lights=[],
        markers=[],
        selected_entity_ids=[],
        camera_animations=[],
    )


class AnchorBoneManifestVisibilityTests(unittest.TestCase):
    def test_anchor_bones_recognized_as_control_bones(self) -> None:
        # Sanity: the names this test relies on are actually on the control
        # layer. If ik_chains ever renames them, this fails loudly instead of
        # silently testing the wrong bones.
        for name in (ik_chains.FULLBODY_ANCHOR, ik_chains.ROOT2D_ANCHOR):
            self.assertTrue(ik_chains.is_control_bone(name), name)
        self.assertTrue(ik_chains.is_control_bone("CCLAY-IK-TGT-Leg.L"))

    def test_manifest_bones_omits_anchor_bones_without_entity_id(self) -> None:
        # A control-layer bone carries no cclay.entity_id, so _manifest_bones
        # must drop it: the bones list carries only the tracked character bone.
        hips = FakeBone("Hips", TRACKED_BONE)
        anchors = [
            FakeBone(ik_chains.FULLBODY_ANCHOR),
            FakeBone(ik_chains.ROOT2D_ANCHOR),
            FakeBone("CCLAY-IK-TGT-Leg.L"),
        ]
        armature = FakeArmatureObject("Person", ARMATURE_OBJECT, [hips, *anchors])
        bones = manifest._manifest_bones([armature])
        self.assertEqual(len(bones), 1)
        self.assertEqual(bones[0]["entityId"], TRACKED_BONE)
        names = {entry["name"] for entry in bones}
        for anchor in anchors:
            self.assertNotIn(anchor.name, names, anchor.name)

    def test_adding_anchor_bones_leaves_manifest_bones_byte_identical(self) -> None:
        # The control layer is attached and detached over the life of a rig.
        # Whichever state _manifest_bones runs against, the bones list it
        # returns is the same, because anchors are invisible to it.
        hips = FakeBone("Hips", TRACKED_BONE)
        without_anchors = manifest._manifest_bones(
            [FakeArmatureObject("Person", ARMATURE_OBJECT, [hips])]
        )
        with_anchors = manifest._manifest_bones(
            [FakeArmatureObject(
                "Person",
                ARMATURE_OBJECT,
                [hips, FakeBone(ik_chains.FULLBODY_ANCHOR),
                 FakeBone(ik_chains.ROOT2D_ANCHOR)],
            )]
        )
        self.assertEqual(without_anchors, with_anchors)

    def test_adding_anchor_bones_does_not_change_canonical_scene_hash(self) -> None:
        # End-to-end: the bones list _manifest_bones produces feeds straight
        # into build_scene_manifest, whose bones list is part of the scene-hash
        # preimage. Anchors must not perturb that hash.
        hips = FakeBone("Hips", TRACKED_BONE)
        baseline_bones = manifest._manifest_bones(
            [FakeArmatureObject("Person", ARMATURE_OBJECT, [hips])]
        )
        anchored_bones = manifest._manifest_bones(
            [FakeArmatureObject(
                "Person",
                ARMATURE_OBJECT,
                [hips, FakeBone(ik_chains.FULLBODY_ANCHOR),
                 FakeBone(ik_chains.ROOT2D_ANCHOR)],
            )]
        )
        baseline = scene_manifest.finalize_scene_manifest(
            scene_manifest.build_scene_manifest(**_minimal_manifest_parts(baseline_bones))
        )
        anchored = scene_manifest.finalize_scene_manifest(
            scene_manifest.build_scene_manifest(**_minimal_manifest_parts(anchored_bones))
        )
        self.assertEqual(baseline["sceneHash"], anchored["sceneHash"])
        self.assertEqual(baseline["revisionId"], anchored["revisionId"])


if __name__ == "__main__":
    unittest.main()
