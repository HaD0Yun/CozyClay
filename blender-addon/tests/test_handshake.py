import base64
import unittest
import uuid

from cclay.handshake import (
    ADDON_VERSION_CAPABILITY_PREFIX,
    METHOD_CAPABILITY_PREFIX,
    OP_CAPABILITY_PREFIX,
    SUPPORTED_BRIDGE_METHODS,
    HandshakeError,
    addon_surface_capabilities,
    build_hello,
    validate_hello_ack,
)
from cclay.stage_scene import _OPERATION_KEYS


class HandshakeTests(unittest.TestCase):
    def test_protocol_v2_build_hello_negotiates_mutation_bridge(self):
        project_id = str(uuid.uuid4())
        hello = build_hello(project_id, "0.1.0", "5.1.2")
        self.assertEqual(hello["type"], "hello")
        self.assertEqual(hello["protocol"], 2)
        self.assertEqual(
            hello["capabilities"][:3],
            ["mutation_bridge_v2", "scene_manifest_v3", "transaction_commit_v2"],
        )
        self.assertEqual(len(base64.urlsafe_b64decode(hello["client_nonce"] + "==")), 16)
        self.assertNotEqual(
            hello["client_nonce"],
            build_hello(project_id, "0.1.0", "5.1.2")["client_nonce"],
        )

    def test_hello_reports_addon_version_method_and_op_surface(self):
        hello = build_hello(str(uuid.uuid4()), "0.2.0", "5.1.2")
        capabilities = set(hello["capabilities"])
        self.assertIn(f"{ADDON_VERSION_CAPABILITY_PREFIX}0.2.0", capabilities)
        for method in SUPPORTED_BRIDGE_METHODS:
            self.assertIn(f"{METHOD_CAPABILITY_PREFIX}{method}", capabilities)
        for op in _OPERATION_KEYS:
            self.assertIn(f"{OP_CAPABILITY_PREFIX}{op}", capabilities)
        # Exactly one version capability, and no unnamespaced strays beyond the
        # negotiated core triple.
        version_entries = [
            entry
            for entry in hello["capabilities"]
            if entry.startswith(ADDON_VERSION_CAPABILITY_PREFIX)
        ]
        self.assertEqual(version_entries, ["cclay.addon_version=0.2.0"])
        self.assertEqual(
            [entry for entry in hello["capabilities"] if not entry.startswith("cclay.")],
            ["mutation_bridge_v2", "scene_manifest_v3", "transaction_commit_v2"],
        )
        self.assertEqual(
            hello["capabilities"][3:],
            addon_surface_capabilities("0.2.0"),
        )

    def test_hello_reports_the_evaluated_pose_capture_method(self):
        # The capture surface is the ardy_inbetween pose bridge: the model
        # names scene frames and the add-on reads the evaluated rig, so the
        # extension must see the method advertised before it can call it.
        hello = build_hello(str(uuid.uuid4()), "0.2.0", "5.1.2")
        self.assertIn("cclay.method.capture_evaluated_pose", hello["capabilities"])

    def test_protocol_v2_hello_ack_negotiates_staging_independently(self):
        valid = {
            "type": "hello_ack",
            "protocol": 2,
            "daemon_version": "0.1.0",
            "launch_id": str(uuid.uuid4()),
            "session_id": str(uuid.uuid4()),
            "server_nonce": base64.urlsafe_b64encode(b"x" * 16).decode().rstrip("="),
            "capabilities": ["mutation_bridge_v2", "scene_manifest_v3", "transaction_commit_v2"],
        }
        self.assertIs(validate_hello_ack(valid), valid)
        v2_only = dict(valid, capabilities=["mutation_bridge_v2"])
        self.assertIs(validate_hello_ack(v2_only), v2_only)
        transaction_v2 = dict(
            valid,
            capabilities=["mutation_bridge_v2", "transaction_commit_v2"],
        )
        self.assertIs(validate_hello_ack(transaction_v2), transaction_v2)
        invalid = [
            dict(valid, protocol=1),
            dict(valid, session_id=str(uuid.uuid4()).upper()),
            dict(valid, server_nonce="x"),
            dict(valid, extra=True),
            dict(valid, capabilities=[]),
            dict(valid, capabilities=["inspect_project"]),
            dict(valid, capabilities=["scene_manifest_v3"]),
            dict(valid, capabilities=["scene_manifest_v3", "mutation_bridge_v2"]),
            dict(valid, capabilities=["mutation_bridge_v2", "extra"]),
            dict(
                valid,
                capabilities=[
                    "mutation_bridge_v2",
                    "transaction_commit_v2",
                    "scene_manifest_v3",
                ],
            ),
        ]
        for ack in invalid:
            with self.subTest(ack=ack), self.assertRaises(HandshakeError):
                validate_hello_ack(ack)

    def test_protocol_v2_hello_ack_requires_matching_semantic_daemon_version(self):
        valid = {
            "type": "hello_ack",
            "protocol": 2,
            "daemon_version": "0.1.0",
            "launch_id": str(uuid.uuid4()),
            "session_id": str(uuid.uuid4()),
            "server_nonce": base64.urlsafe_b64encode(b"x" * 16).decode().rstrip("="),
            "capabilities": ["mutation_bridge_v2", "scene_manifest_v3", "transaction_commit_v2"],
        }
        for daemon_version in ("0.2.0", "v0.1", "", "0.1.0-dev"):
            with self.subTest(daemon_version=daemon_version), self.assertRaisesRegex(
                HandshakeError, "incompatible daemon version"
            ):
                validate_hello_ack(dict(valid, daemon_version=daemon_version))


if __name__ == "__main__":
    unittest.main()
