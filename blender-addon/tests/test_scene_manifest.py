import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from cclay.scene_manifest import (
    INVALID_MANIFEST_REFERENCE,
    INVALID_SCENE_MANIFEST,
    build_scene_manifest,
    finalize_scene_manifest,
    rational_fps,
)
from cclay.snapshot import UNSUPPORTED_FPS_BASE

PROJECT = "00000000-0000-4000-8000-000000000001"
OBJECT = "00000000-0000-4000-8000-000000000002"
CAMERA_OBJECT = "00000000-0000-4000-8000-000000000003"
LIGHT_OBJECT = "00000000-0000-4000-8000-000000000005"
ARMATURE_OBJECT = "00000000-0000-4000-8000-000000000006"
BONE = "00000000-0000-4000-8000-000000000007"
BONE_CHILD = "00000000-0000-4000-8000-000000000008"
MISSING = "00000000-0000-4000-8000-000000000099"


def obj(entity_id, name, kind="MESH", parent=None):
    return {"entityId": entity_id, "name": name, "type": kind, "parentId": parent,
            "visible": True, "location": [0, 0, 0], "rotationQuaternion": [1, 0, 0, 0], "scale": [1, 1, 1]}


def parts():
    return dict(
        project_id=PROJECT,
        blender_version="4.3.0",
        scene={"name": "Scene", "frameStart": 1, "frameEnd": 250, "fpsNumerator": 24000,
               "fpsDenominator": 1001, "activeCameraId": CAMERA_OBJECT},
        render={"resolutionX": 1920, "resolutionY": 1080, "resolutionPercentage": 100},
        objects=[obj(LIGHT_OBJECT, "Light", "LIGHT"), obj(OBJECT, "Cube"), obj(CAMERA_OBJECT, "Camera", "CAMERA"),
                 obj(ARMATURE_OBJECT, "Armature", "ARMATURE")],
        bones=[{"entityId": BONE_CHILD, "name": "Child", "armatureObjectId": ARMATURE_OBJECT, "parentBoneId": BONE,
                "location": [0, 0, 0], "rotationQuaternion": [1, 0, 0, 0], "scale": [1, 1, 1]},
               {"entityId": BONE, "name": "Root", "armatureObjectId": ARMATURE_OBJECT, "parentBoneId": None,
                "location": [0, 0, 0], "rotationQuaternion": [1, 0, 0, 0], "scale": [1, 1, 1]}],
        cameras=[{"objectId": CAMERA_OBJECT, "lens": 50, "sensorFit": "AUTO",
                  "sensorWidth": 36, "sensorHeight": 24, "verticalFovRadians": 0.5, "clipStart": 0.1, "clipEnd": 1000}],
        lights=[{"objectId": LIGHT_OBJECT, "lightType": "POINT", "color": [1, 0.5, 0],
                 "energy": 1000, "spotSize": None, "spotBlend": None}],
        markers=[{"name": "B", "frame": 2, "cameraId": None}, {"name": "A", "frame": 2, "cameraId": CAMERA_OBJECT},
                 {"name": "A", "frame": 2, "cameraId": None}, {"name": "A", "frame": 1, "cameraId": CAMERA_OBJECT}],
        selected_entity_ids=[OBJECT, CAMERA_OBJECT, OBJECT],
        camera_animations=[
            {
                "objectId": CAMERA_OBJECT,
                "target": "cameraData",
                "fcurves": [{
                    "dataPath": "lens",
                    "arrayIndex": 0,
                    "keyframes": [{
                        "frame": 20.0,
                        "value": 52.0,
                        "interpolation": "BEZIER",
                        "handleLeft": [19.0, 50.0],
                        "handleRight": [21.0, 52.0],
                        "handleLeftType": "AUTO_CLAMPED",
                        "handleRightType": "AUTO_CLAMPED",
                    }],
                }],
            },
            {
                "objectId": CAMERA_OBJECT,
                "target": "object",
                "fcurves": [{
                    "dataPath": "location",
                    "arrayIndex": 2,
                    "keyframes": [
                        {
                            "frame": 20.0,
                            "value": 4.0,
                            "interpolation": "BEZIER",
                            "handleLeft": [19.0, 3.0],
                            "handleRight": [21.0, 4.0],
                            "handleLeftType": "AUTO_CLAMPED",
                            "handleRightType": "AUTO_CLAMPED",
                        },
                        {
                            "frame": 1.0,
                            "value": 3.0,
                            "interpolation": "CONSTANT",
                            "handleLeft": [1.0, 3.0],
                            "handleRight": [2.0, 3.0],
                            "handleLeftType": "FREE",
                            "handleRightType": "FREE",
                        },
                    ],
                }],
            },
        ],
    )


class SceneManifestTests(unittest.TestCase):
    def test_section_6_manifest_assembles_and_sorts_full_shape(self):
        manifest = build_scene_manifest(**parts())
        self.assertEqual([x["entityId"] for x in manifest["objects"]], sorted([OBJECT, CAMERA_OBJECT, LIGHT_OBJECT, ARMATURE_OBJECT]))
        self.assertEqual([x["entityId"] for x in manifest["bones"]], [BONE, BONE_CHILD])
        self.assertEqual([(x["name"], x["frame"], x["cameraId"]) for x in manifest["markers"]],
                         [("A", 1, CAMERA_OBJECT), ("A", 2, None), ("A", 2, CAMERA_OBJECT), ("B", 2, None)])
        self.assertEqual(manifest["selectedEntityIds"], [OBJECT, CAMERA_OBJECT])
        self.assertNotIn("sceneHash", manifest)
        self.assertNotIn("entityId", manifest["cameras"][0])
        self.assertNotIn("entityId", manifest["lights"][0])

    def test_snapshot_v2_section_2_6_camera_animations_are_additive_and_semantically_sorted(self):
        manifest = build_scene_manifest(**parts())
        self.assertEqual(manifest["schemaVersion"], 2)
        self.assertEqual(
            [(item["objectId"], item["target"]) for item in manifest["cameraAnimations"]],
            [(CAMERA_OBJECT, "cameraData"), (CAMERA_OBJECT, "object")],
        )
        self.assertEqual(
            [keyframe["frame"] for keyframe in manifest["cameraAnimations"][1]["fcurves"][0]["keyframes"]],
            [1.0, 20.0],
        )

    def test_architecture_section_6_full_v2_is_the_sole_hash_preimage(self):
        baseline = finalize_scene_manifest(build_scene_manifest(**parts()))
        changed_parts = parts()
        changed_parts["camera_animations"][0]["fcurves"][0]["keyframes"][0]["value"] = 51.0
        changed = finalize_scene_manifest(build_scene_manifest(**changed_parts))
        self.assertNotEqual(changed["sceneHash"], baseline["sceneHash"])

    def test_selection_is_reported_but_excluded_from_scene_hash(self):
        baseline_parts = parts()
        baseline_parts["selected_entity_ids"] = []
        selected_parts = parts()
        selected_parts["selected_entity_ids"] = [OBJECT]
        baseline = finalize_scene_manifest(build_scene_manifest(**baseline_parts))
        selected = finalize_scene_manifest(build_scene_manifest(**selected_parts))
        self.assertEqual(baseline["sceneHash"], selected["sceneHash"])
        self.assertEqual(baseline["revisionId"], selected["revisionId"])
        self.assertEqual(baseline["selectedEntityIds"], [])
        self.assertEqual(selected["selectedEntityIds"], [OBJECT])

    def test_object_transform_remains_in_scene_hash(self):
        baseline = finalize_scene_manifest(build_scene_manifest(**parts()))
        moved_parts = parts()
        moved_parts["objects"][1]["location"][0] = 1
        moved = finalize_scene_manifest(build_scene_manifest(**moved_parts))
        self.assertNotEqual(baseline["sceneHash"], moved["sceneHash"])

    def test_snapshot_v2_section_2_6_camera_animations_are_closed_and_correlated(self):
        data = parts()
        data["camera_animations"][0]["unknown"] = True
        with self.assertRaises(INVALID_SCENE_MANIFEST):
            build_scene_manifest(**data)
        data = parts()
        data["camera_animations"][0]["objectId"] = OBJECT
        with self.assertRaises(INVALID_MANIFEST_REFERENCE):
            build_scene_manifest(**data)

    def test_architecture_section_6_v1_manifest_cannot_be_used_for_mutation(self):
        manifest = build_scene_manifest(**parts())
        manifest["schemaVersion"] = 1
        with self.assertRaises(INVALID_SCENE_MANIFEST):
            finalize_scene_manifest(manifest)

    def test_section_6_minimal_manifest(self):
        data = parts()
        data.update(scene={**data["scene"], "activeCameraId": None}, objects=[], bones=[], cameras=[], lights=[], markers=[], selected_entity_ids=[])
        data["camera_animations"] = []
        self.assertEqual(build_scene_manifest(**data)["objects"], [])

    def test_section_8_rational_fps_has_only_supported_exact_rules(self):
        self.assertEqual(rational_fps(24, 1.0), (24, 1))
        self.assertEqual(rational_fps(24, 1.001), (24000, 1001))
        with self.assertRaises(UNSUPPORTED_FPS_BASE) as raised:
            rational_fps(24, 1.5)
        self.assertEqual(raised.exception.code, "UNSUPPORTED_FPS_BASE")

    def test_section_8_rejects_non_reduced_fps_rational(self):
        data = parts()
        data["scene"] = {**data["scene"], "fpsNumerator": 48000, "fpsDenominator": 2002}
        with self.assertRaises(INVALID_SCENE_MANIFEST):
            build_scene_manifest(**data)

    def test_section_6_hash_preimage_excludes_hash_fields(self):
        manifest = build_scene_manifest(**parts())
        baseline = finalize_scene_manifest(manifest)
        polluted = {**manifest, "sceneHash": "garbage", "revisionId": "placeholder"}
        self.assertEqual(finalize_scene_manifest(polluted), baseline)
        self.assertRegex(baseline["sceneHash"], r"^[0-9a-f]{64}$")
        self.assertRegex(baseline["revisionId"], r"^[0-9a-f]{64}$")

    def test_section_6_finalize_rejects_out_of_order_input(self):
        manifest = build_scene_manifest(**parts())
        manifest["objects"] = list(reversed(manifest["objects"]))
        with self.assertRaises(INVALID_SCENE_MANIFEST):
            finalize_scene_manifest(manifest)

    def test_section_6_rejects_unknown_top_level_and_nested_fields(self):
        manifest = build_scene_manifest(**parts())
        with self.assertRaises(INVALID_SCENE_MANIFEST):
            finalize_scene_manifest({**manifest, "unknown": True})
        polluted = {**manifest, "scene": {**manifest["scene"], "unknown": True}}
        with self.assertRaises(INVALID_SCENE_MANIFEST):
            finalize_scene_manifest(polluted)

    def assert_reference_rejected(self, mutate):
        data = parts()
        mutate(data)
        with self.assertRaises(INVALID_MANIFEST_REFERENCE):
            build_scene_manifest(**data)

    def test_section_6_rejects_every_invalid_cross_reference(self):
        cases = [
            lambda d: d["objects"][2].update(parentId=MISSING),
            lambda d: d["bones"][0].update(armatureObjectId=MISSING),
            lambda d: d["bones"][0].update(parentBoneId=MISSING),
            lambda d: d["bones"][0].update(armatureObjectId=d["objects"][1]["entityId"]),  # OBJECT is type MESH
            lambda d: d["cameras"][0].update(objectId=OBJECT),
            lambda d: d.update(cameras=[]),
            lambda d: d["lights"][0].update(objectId=OBJECT),
            lambda d: d.update(lights=[]),
            lambda d: d["scene"].update(activeCameraId=MISSING),
            lambda d: d["markers"][0].update(cameraId=MISSING),
        ]
        for mutate in cases:
            with self.subTest(mutate=mutate):
                self.assert_reference_rejected(mutate)

    def test_section_6_rejects_duplicate_camera_and_light_object_entries(self):
        data = parts()
        data["cameras"] = data["cameras"] + [dict(data["cameras"][0])]
        with self.assertRaises(INVALID_SCENE_MANIFEST):
            build_scene_manifest(**data)
        data = parts()
        data["lights"] = data["lights"] + [dict(data["lights"][0])]
        with self.assertRaises(INVALID_SCENE_MANIFEST):
            build_scene_manifest(**data)

    def test_section_6_spot_fields_are_iff_spot(self):
        data = parts()
        data["lights"][0]["spotSize"] = 1.0
        with self.assertRaises(INVALID_SCENE_MANIFEST):
            build_scene_manifest(**data)
        data = parts()
        data["lights"][0].update(lightType="SPOT", spotSize=None, spotBlend=0.5)
        with self.assertRaises(INVALID_SCENE_MANIFEST):
            build_scene_manifest(**data)

    def test_section_6_rejects_noncanonical_quaternion_and_uuid(self):
        data = parts()
        data["objects"][0]["rotationQuaternion"] = [-1, 0, 0, 0]
        with self.assertRaises(INVALID_SCENE_MANIFEST):
            build_scene_manifest(**data)
        data = parts()
        data["project_id"] = "abcdefab-cdef-4abc-8abc-abcdefabcdef".upper()
        with self.assertRaises(INVALID_SCENE_MANIFEST):
            build_scene_manifest(**data)


if __name__ == "__main__":
    unittest.main()
