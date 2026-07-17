"""Protocol-v1 application handshake helpers."""

import base64
import os
import re
from typing import Any

PROTOCOL_VERSION = 1
_UUID4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
_NONCE = re.compile(r"^[A-Za-z0-9_-]{22}$")


class HandshakeError(ValueError):
    """A protocol handshake message is malformed."""


def build_hello(project_id: str, addon_version: str, blender_version: str) -> dict[str, Any]:
    nonce = base64.urlsafe_b64encode(os.urandom(16)).decode("ascii").rstrip("=")
    return {"type": "hello", "protocol": PROTOCOL_VERSION, "addon_version": addon_version,
            "blender_version": blender_version, "project_id": project_id, "client_nonce": nonce}


def validate_hello_ack(ack: Any) -> dict[str, Any]:
    fields = {"type", "protocol", "daemon_version", "launch_id", "session_id", "server_nonce", "capabilities"}
    if not isinstance(ack, dict) or set(ack) != fields:
        raise HandshakeError("hello_ack must contain exactly the protocol-v1 fields")
    if ack["type"] != "hello_ack" or ack["protocol"] != PROTOCOL_VERSION:
        raise HandshakeError("invalid hello_ack discriminator or protocol")
    if not all(isinstance(ack[key], str) and ack[key] for key in ("daemon_version", "launch_id", "session_id", "server_nonce")):
        raise HandshakeError("invalid hello_ack string field")
    if not _UUID4.fullmatch(ack["launch_id"]) or not _UUID4.fullmatch(ack["session_id"]):
        raise HandshakeError("launch_id and session_id must be lowercase UUIDv4")
    if not _NONCE.fullmatch(ack["server_nonce"]):
        raise HandshakeError("server_nonce must be unpadded base64url for 16 bytes")
    if not isinstance(ack["capabilities"], list) or not all(isinstance(x, str) for x in ack["capabilities"]):
        raise HandshakeError("capabilities must be a string array")
    return ack
