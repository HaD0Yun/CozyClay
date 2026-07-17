"""Small RFC 6455 WebSocket client for the loopback daemon."""

import base64
import hashlib
import json
import os
import socket
import struct
from typing import Any

_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_MESSAGE_SIZE = 1024 * 1024


class WebSocketError(RuntimeError):
    pass


class MessageTooLarge(WebSocketError):
    pass


class ProtocolError(WebSocketError):
    pass


class WebSocketClient:
    def __init__(self, sock: socket.socket):
        self.socket = sock
        self.closed = False

    @classmethod
    def connect(cls, port: int, token: str, timeout: float = 10.0) -> "WebSocketClient":
        sock = socket.create_connection(("127.0.0.1", port), timeout=timeout)
        sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (f"GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\n"
                   f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
                   f"Authorization: Bearer {token}\r\n\r\n")
        try:
            sock.sendall(request.encode("ascii"))
            raw = bytearray()
            while b"\r\n\r\n" not in raw:
                chunk = sock.recv(4096)
                if not chunk or len(raw) + len(chunk) > 16384:
                    raise ProtocolError("invalid HTTP upgrade response")
                raw.extend(chunk)
            header, remainder = bytes(raw).split(b"\r\n\r\n", 1)
            if remainder:
                raise ProtocolError("unexpected bytes after HTTP upgrade")
            lines = header.decode("ascii").split("\r\n")
            if lines[0] != "HTTP/1.1 101 Switching Protocols":
                raise ProtocolError("WebSocket upgrade rejected")
            headers = {}
            for line in lines[1:]:
                name, sep, value = line.partition(":")
                if not sep: raise ProtocolError("malformed upgrade header")
                headers[name.lower()] = value.strip()
            expected = base64.b64encode(hashlib.sha1((key + _GUID).encode("ascii")).digest()).decode("ascii")
            if headers.get("sec-websocket-accept") != expected:
                raise ProtocolError("invalid Sec-WebSocket-Accept")
            connection_tokens = {part.strip().lower() for part in headers.get("connection", "").split(",")}
            if headers.get("upgrade", "").lower() != "websocket" or "upgrade" not in connection_tokens:
                raise ProtocolError("invalid upgrade headers")
            return cls(sock)
        except Exception:
            sock.close()
            raise

    def _too_large(self) -> "None":
        self.closed = True
        self.socket.close()
        raise MessageTooLarge("message exceeds 1 MiB")

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        if len(payload) > MAX_MESSAGE_SIZE and opcode in (0, 1, 2):
            self._too_large()
        mask = os.urandom(4)
        length = len(payload)
        if length < 126: header = bytes((0x80 | opcode, 0x80 | length))
        elif length <= 65535: header = bytes((0x80 | opcode, 0x80 | 126)) + struct.pack("!H", length)
        else: header = bytes((0x80 | opcode, 0x80 | 127)) + struct.pack("!Q", length)
        masked = bytes(value ^ mask[i % 4] for i, value in enumerate(payload))
        self.socket.sendall(header + mask + masked)

    def send_text(self, text: str) -> None:
        payload = text.encode("utf-8")
        if len(payload) > MAX_MESSAGE_SIZE:
            self._too_large()
        self._send_frame(1, payload)

    def send_json(self, value: Any) -> None:
        self.send_text(json.dumps(value, separators=(",", ":"), ensure_ascii=False))

    def _exact(self, size: int) -> bytes:
        chunks = bytearray()
        while len(chunks) < size:
            chunk = self.socket.recv(size - len(chunks))
            if not chunk: raise WebSocketError("socket closed")
            chunks.extend(chunk)
        return bytes(chunks)

    def _recv_frame(self) -> tuple[bool, int, bytes]:
        first, second = self._exact(2)
        if first & 0x70: raise ProtocolError("RSV bits are unsupported")
        if second & 0x80: raise ProtocolError("server frames must not be masked")
        length = second & 127
        if length == 126: length = struct.unpack("!H", self._exact(2))[0]
        elif length == 127: length = struct.unpack("!Q", self._exact(8))[0]
        opcode = first & 15
        if opcode >= 8 and (not first & 0x80 or length > 125): raise ProtocolError("invalid control frame")
        if length > MAX_MESSAGE_SIZE:
            self._too_large()
        return bool(first & 0x80), opcode, self._exact(length)

    def recv_text(self) -> str:
        parts = bytearray(); started = False
        while True:
            fin, opcode, payload = self._recv_frame()
            if opcode == 8:
                self.closed = True
                raise WebSocketError("peer closed socket")
            if opcode == 9:
                self._send_frame(10, payload); continue
            if opcode == 10: continue
            if opcode == 1 and not started: started = True
            elif opcode == 0 and started: pass
            else: raise ProtocolError("invalid text fragmentation")
            if len(parts) + len(payload) > MAX_MESSAGE_SIZE:
                self._too_large()
            parts.extend(payload)
            if fin:
                try: return parts.decode("utf-8")
                except UnicodeDecodeError as exc: raise ProtocolError("text frame is not UTF-8") from exc

    def recv_json(self) -> Any:
        try: return json.loads(self.recv_text())
        except json.JSONDecodeError as exc: raise ProtocolError("text message is not JSON") from exc

    def close(self, code: int = 1000) -> int | None:
        if self.closed: return None
        if not (1000 <= code <= 4999): raise ValueError("invalid close code")
        self._send_frame(8, struct.pack("!H", code))
        received = None
        try:
            fin, opcode, payload = self._recv_frame()
            if fin and opcode == 8 and len(payload) >= 2: received = struct.unpack("!H", payload[:2])[0]
        except (OSError, WebSocketError):
            pass
        self.closed = True; self.socket.close()
        return received
