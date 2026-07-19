"""Regressions for selecting the durable V2/V3 manifest substrate."""

from __future__ import annotations

import sys
import unittest
from types import SimpleNamespace
from unittest import mock

from oh_my_blender import camera_plan, connection, qa_render


V2_HASH = "2" * 64
V3_HASH = "3" * 64


class ManifestSubstrateCompositionTests(unittest.TestCase):
    @staticmethod
    def manifest_module(v2: dict, v3: dict) -> SimpleNamespace:
        return SimpleNamespace(
            extract_scene_manifest_v2=mock.Mock(return_value=v2),
            extract_scene_manifest_v3=mock.Mock(return_value=v3),
        )
    def test_camera_selects_v3_when_the_durable_base_is_v3(self):
        v2 = {"schemaVersion": 2, "sceneHash": V2_HASH}
        v3 = {
            "schemaVersion": 3,
            "sceneHash": V3_HASH,
            "stagePrimitives": [{"objectId": "primitive"}],
            "stageMaterials": [
                {
                    "objectId": "primitive",
                    "baseColor": [0.1, 0.2, 0.3, 1.0],
                    "useNodes": True,
                    "principledBaseColor": [0.1, 0.2, 0.3, 1.0],
                }
            ],
        }
        manifest = self.manifest_module(v2, v3)
        with mock.patch.dict(sys.modules, {"oh_my_blender.manifest": manifest}):
            self.assertIs(camera_plan._extract_live_scene_manifest(V3_HASH), v3)

    def test_camera_keeps_pure_v2_projects_on_v2(self):
        v2 = {"schemaVersion": 2, "sceneHash": V2_HASH}
        manifest = self.manifest_module(v2, {"schemaVersion": 3, "sceneHash": V3_HASH})
        with mock.patch.dict(sys.modules, {"oh_my_blender.manifest": manifest}):
            self.assertIs(camera_plan._extract_live_scene_manifest(V2_HASH), v2)
        manifest.extract_scene_manifest_v3.assert_not_called()

    def test_qa_compares_the_live_hash_on_the_durable_v3_substrate(self):
        manifest = self.manifest_module(
            {"schemaVersion": 2, "sceneHash": V2_HASH},
            {"schemaVersion": 3, "sceneHash": V3_HASH},
        )
        with mock.patch.dict(sys.modules, {"oh_my_blender.manifest": manifest}):
            self.assertEqual(qa_render._live_scene_hash(V3_HASH), V3_HASH)

    def test_reconnect_compares_the_live_hash_on_the_durable_v3_substrate(self):
        manifest = self.manifest_module(
            {"schemaVersion": 2, "sceneHash": V2_HASH},
            {"schemaVersion": 3, "sceneHash": V3_HASH},
        )
        with mock.patch.dict(sys.modules, {"oh_my_blender.manifest": manifest}):
            self.assertEqual(connection._live_scene_hash(V3_HASH), V3_HASH)

    def test_v2_only_bridge_rejects_stage_dispatch_before_blender(self):
        websocket = mock.Mock()
        active = connection.Connection(
            None,
            websocket,
            capabilities=frozenset({"mutation_bridge_v2"}),
        )
        active.dispatch_bridge_message({
            "type": "bridge_request",
            "id": "bridge-id",
            "request_id": "request-id",
            "method": "stage_scene",
        })
        websocket.send_json.assert_called_once()
        self.assertEqual(
            websocket.send_json.call_args.args[0]["code"],
            "CAPABILITY_NOT_NEGOTIATED",
        )


if __name__ == "__main__":
    unittest.main()
