import base64
import unittest
import uuid

from oh_my_blender.handshake import HandshakeError, build_hello, validate_hello_ack


class HandshakeTests(unittest.TestCase):
    def test_protocol_v2_build_hello_negotiates_mutation_bridge(self):
        project_id = str(uuid.uuid4())
        hello = build_hello(project_id, "0.1.0", "5.1.2")
        self.assertEqual(hello["type"], "hello")
        self.assertEqual(hello["protocol"], 2)
        self.assertEqual(hello["capabilities"], ["mutation_bridge_v2"])
        self.assertEqual(len(base64.urlsafe_b64decode(hello["client_nonce"] + "==")), 16)
        self.assertNotEqual(
            hello["client_nonce"],
            build_hello(project_id, "0.1.0", "5.1.2")["client_nonce"],
        )

    def test_protocol_v2_hello_ack_requires_exact_mutation_capability(self):
        valid = {
            "type": "hello_ack",
            "protocol": 2,
            "daemon_version": "0.1.0",
            "launch_id": str(uuid.uuid4()),
            "session_id": str(uuid.uuid4()),
            "server_nonce": base64.urlsafe_b64encode(b"x" * 16).decode().rstrip("="),
            "capabilities": ["mutation_bridge_v2"],
        }
        self.assertIs(validate_hello_ack(valid), valid)
        invalid = [
            dict(valid, protocol=1),
            dict(valid, session_id=str(uuid.uuid4()).upper()),
            dict(valid, server_nonce="x"),
            dict(valid, extra=True),
            dict(valid, capabilities=[]),
            dict(valid, capabilities=["inspect_project"]),
            dict(valid, capabilities=["mutation_bridge_v2", "extra"]),
        ]
        for ack in invalid:
            with self.subTest(ack=ack), self.assertRaises(HandshakeError):
                validate_hello_ack(ack)


if __name__ == "__main__":
    unittest.main()
