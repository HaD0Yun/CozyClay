import base64
import hashlib
import json
import socket
import struct
import threading
import unittest
from unittest import mock

from cclay.ws_client import MessageTooLarge, WebSocketClient

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class Server:
    def __init__(self):
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0)); self.sock.listen(1)
        self.port = self.sock.getsockname()[1]
        self.headers = {}; self.masked = False; self.payload = None
        self.thread = threading.Thread(target=self.run, daemon=True); self.thread.start()

    def recv_exact(self, conn, n):
        out = b""
        while len(out) < n: out += conn.recv(n - len(out))
        return out

    def frame(self, opcode, payload, fin=True):
        first = (0x80 if fin else 0) | opcode
        n = len(payload)
        size = bytes([n]) if n < 126 else b"\x7e" + struct.pack("!H", n)
        return bytes([first]) + size + payload

    def run(self):
        conn, _ = self.sock.accept()
        with conn:
            data = b""
            while b"\r\n\r\n" not in data: data += conn.recv(4096)
            lines = data.decode().split("\r\n")
            self.headers = dict(line.split(": ", 1) for line in lines[1:] if ": " in line)
            accept = base64.b64encode(hashlib.sha1((self.headers["Sec-WebSocket-Key"] + GUID).encode()).digest()).decode()
            conn.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n").encode())
            h = self.recv_exact(conn, 2); n = h[1] & 127; self.masked = bool(h[1] & 128)
            if n == 126: n = struct.unpack("!H", self.recv_exact(conn, 2))[0]
            elif n == 127: n = struct.unpack("!Q", self.recv_exact(conn, 8))[0]
            mask = self.recv_exact(conn, 4); raw = self.recv_exact(conn, n)
            self.payload = bytes(v ^ mask[i % 4] for i, v in enumerate(raw))
            opcode = h[0] & 15
            if opcode == 1:
                midpoint = len(self.payload) // 2
                conn.sendall(self.frame(1, self.payload[:midpoint], False) + self.frame(0, self.payload[midpoint:]))
            elif opcode == 8:
                conn.sendall(self.frame(8, self.payload))
        self.sock.close()


class WebSocketTests(unittest.TestCase):
    def test_rfc6455_upgrade_mask_echo_fragmentation_clause_4(self):
        server = Server(); client = WebSocketClient.connect(server.port, "secret", timeout=1)
        client.send_json({"hello": "world"})
        self.assertEqual(client.recv_json(), {"hello": "world"}); client.close()
        server.thread.join(1)
        self.assertEqual(server.headers["Host"], f"127.0.0.1:{server.port}")
        self.assertEqual(server.headers["Authorization"], "Bearer secret")
        self.assertTrue(server.masked); self.assertEqual(json.loads(server.payload), {"hello": "world"})

    def test_rfc6455_close_code_round_trip_clause_4(self):
        server = Server(); client = WebSocketClient.connect(server.port, "secret", timeout=1)
        client.close(1000); server.thread.join(1)
        self.assertEqual(struct.unpack("!H", server.payload[:2])[0], 1000)

    def test_protocol_v1_one_mib_message_limit_clause_4(self):
        server = Server(); client = WebSocketClient.connect(server.port, "secret", timeout=1)
        with self.assertRaises(MessageTooLarge): client.send_text("x" * (1024 * 1024 + 1))
        client.close(); server.thread.join(1)

    def test_outbound_oversize_keeps_the_link_open_for_the_error_report(self):
        """An oversized send is our own bug; severing the link loses the only
        channel able to report it, which is how a QA render batch turned into a
        bare BRIDGE_DISCONNECTED."""
        server = Server(); client = WebSocketClient.connect(server.port, "secret", timeout=1)
        with self.assertRaises(MessageTooLarge): client.send_text("x" * (1024 * 1024 + 1))

        self.assertFalse(client.closed)
        client.send_json({"reported": "over the live link"})
        self.assertEqual(client.recv_json(), {"reported": "over the live link"})
        client.close(); server.thread.join(1)

    def test_inbound_oversize_still_drops_the_untrusted_transport(self):
        header = b"\x81\x7f" + struct.pack("!Q", 1024 * 1024 + 1)
        sock = mock.Mock()
        sock.recv.side_effect = [header[:2], header[2:]]
        client = WebSocketClient(sock)

        with self.assertRaises(MessageTooLarge):
            client.recv_json()

        self.assertTrue(client.closed)
        sock.close.assert_called_once_with()

    def test_close_marks_transport_closed_when_close_frame_send_fails(self):
        sock = mock.Mock()
        sock.sendall.side_effect = OSError("severed")
        client = WebSocketClient(sock)

        client.close()

        self.assertTrue(client.closed)
        sock.close.assert_called_once_with()


if __name__ == "__main__": unittest.main()
