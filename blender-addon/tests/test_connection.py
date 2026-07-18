"""Tests for add-on connection lifecycle orchestration."""

import pathlib
import subprocess
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))

from oh_my_blender.connection import (
    Connection,
    ConnectionError,
    _test_only_inject_disconnect_fault,
    verify_reconnect_hash,
)


class FakeProcess:
    def __init__(self, times_out=False):
        self.times_out = times_out
        self.wait_calls = []

    def wait(self, timeout=None):
        self.wait_calls.append(timeout)
        if self.times_out:
            raise subprocess.TimeoutExpired("daemon", timeout)
        return 0


class FakeChild:
    def __init__(self, process):
        self.process = process
        self.killed = False
        self.streams_closed = False

    def kill(self):
        self.killed = True

    def close_streams(self):
        self.streams_closed = True


class FakeSocket:
    def __init__(self, replies=()):
        self.closed = False
        self.replies = iter(replies)
        self.sent = []

    def send_json(self, message):
        self.sent.append(message)

    def recv_json(self):
        return next(self.replies)

    def close(self):
        self.closed = True


class ConnectionTests(unittest.TestCase):
    def test_reconnect_gate_accepts_equal_hashes(self):
        """§4 line 119: reconnect requires the canonical live scene hash."""
        verify_reconnect_hash("ab12", "ab12")

    def test_reconnect_gate_rejects_mismatched_hashes(self):
        """§4 line 119: reconnect refuses a non-canonical live scene."""
        with self.assertRaises(ConnectionError):
            verify_reconnect_hash("ab12", "cd34")

    def test_only_disconnect_fault_injector_mutates_target_value(self):
        """§12 line 411: the test fault changes one harmless property."""
        entities = {"object:cube": {"visible": True, "name": "Cube"}}

        _test_only_inject_disconnect_fault(entities, "object:cube", "visible", False)

        self.assertFalse(entities["object:cube"]["visible"])
        self.assertEqual(entities["object:cube"]["name"], "Cube")

    def test_disconnect_sends_shutdown_and_waits_for_ack_and_child(self):
        """§4 lines 103/118: normal unload drains before child exit."""
        process = FakeProcess()
        child = FakeChild(process)
        socket = FakeSocket([{"type": "shutdown_ack"}])
        connection = Connection(child, socket)

        connection.disconnect("addon_unload", timeout=0.1)

        self.assertEqual(socket.sent, [{"type": "shutdown", "reason": "addon_unload"}])
        self.assertTrue(socket.closed)
        self.assertFalse(child.killed)
        self.assertTrue(child.streams_closed)
        self.assertEqual(len(process.wait_calls), 1)

    def test_disconnect_force_kills_only_after_child_wait_timeout(self):
        """§4 line 118: force-kill follows, never precedes, the drain bound."""
        process = FakeProcess(times_out=True)
        child = FakeChild(process)
        socket = FakeSocket([{"type": "shutdown_ack"}])

        Connection(child, socket).disconnect("addon_unload", timeout=0.1)

        self.assertTrue(child.killed)
        self.assertEqual(len(process.wait_calls), 1)


if __name__ == "__main__":
    unittest.main()
