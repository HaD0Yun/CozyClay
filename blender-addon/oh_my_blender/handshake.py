"""Protocol-v2 mutation-bridge application handshake helpers."""

import base64
import os
import re
from typing import Any

PROTOCOL_VERSION = 2
MUTATION_BRIDGE_CAPABILITY = "mutation_bridge_v2"
SCENE_MANIFEST_V3_CAPABILITY = "scene_manifest_v3"
EXPECTED_DAEMON_VERSION = "0.1.0"
_SEMANTIC_VERSION = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
_UUID4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
_NONCE = re.compile(r"^[A-Za-z0-9_-]{22}$")


class HandshakeError(ValueError):
    """A protocol handshake message is malformed."""


def build_hello(project_id: str, addon_version: str, blender_version: str) -> dict[str, Any]:
    nonce = base64.urlsafe_b64encode(os.urandom(16)).decode("ascii").rstrip("=")
    return {
        "type": "hello",
        "protocol": PROTOCOL_VERSION,
        "addon_version": addon_version,
        "blender_version": blender_version,
        "project_id": project_id,
        "client_nonce": nonce,
        "capabilities": [
            MUTATION_BRIDGE_CAPABILITY,
            SCENE_MANIFEST_V3_CAPABILITY,
        ],
    }


def validate_hello_ack(ack: Any) -> dict[str, Any]:
    fields = {"type", "protocol", "daemon_version", "launch_id", "session_id", "server_nonce", "capabilities"}
    if not isinstance(ack, dict) or set(ack) != fields:
        raise HandshakeError("hello_ack must contain exactly the protocol-v2 fields")
    if ack["type"] != "hello_ack" or ack["protocol"] != PROTOCOL_VERSION:
        raise HandshakeError("invalid hello_ack discriminator or protocol")
    daemon_version = ack["daemon_version"]
    if (
        not isinstance(daemon_version, str)
        or _SEMANTIC_VERSION.fullmatch(daemon_version) is None
        or daemon_version != EXPECTED_DAEMON_VERSION
    ):
        raise HandshakeError(
            "incompatible daemon version: expected "
            f"{EXPECTED_DAEMON_VERSION}, received {daemon_version!r}; "
            "install a matching Oh My Blender daemon"
        )
    if not all(
        isinstance(ack[key], str) and ack[key]
        for key in ("launch_id", "session_id", "server_nonce")
    ):
        raise HandshakeError("invalid hello_ack string field")
    if not _UUID4.fullmatch(ack["launch_id"]) or not _UUID4.fullmatch(ack["session_id"]):
        raise HandshakeError("launch_id and session_id must be lowercase UUIDv4")
    if not _NONCE.fullmatch(ack["server_nonce"]):
        raise HandshakeError("server_nonce must be unpadded base64url for 16 bytes")
    if ack["capabilities"] not in (
        [MUTATION_BRIDGE_CAPABILITY],
        [MUTATION_BRIDGE_CAPABILITY, SCENE_MANIFEST_V3_CAPABILITY],
    ):
        raise HandshakeError(
            "capabilities must negotiate mutation_bridge_v2 with optional scene_manifest_v3"
        )
    return ack
