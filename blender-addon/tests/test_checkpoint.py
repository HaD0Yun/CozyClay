"""Tests for scoped value checkpoints."""

import copy
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))

from cclay.checkpoint import create_checkpoint, restore, verify


class CheckpointTests(unittest.TestCase):
    def test_scoped_value_snapshot_round_trip(self):
        """§15.3 lines 484-487: scoped values restore without global undo."""
        scene = {
            "object:cube": {"location": (1.0, 2.0, 3.0), "visible": True},
            "material:red": {"roughness": 0.25},
        }
        checkpoint = create_checkpoint(scene)
        scene["object:cube"]["location"] = (9.0, 9.0, 9.0)

        restore(checkpoint, lambda key, values: scene.__setitem__(key, copy.deepcopy(values)))

        self.assertTrue(verify(checkpoint, lambda key: scene[key]))
        self.assertEqual(scene["object:cube"]["location"], (1.0, 2.0, 3.0))

    def test_scoped_value_snapshot_verification_detects_and_repairs_mutation(self):
        """§4 line 117: verification fails until checkpoint restoration succeeds."""
        scene = {"object:cube": {"scale": (1.0, 1.0, 1.0)}}
        checkpoint = create_checkpoint(scene)
        scene["object:cube"]["scale"] = (2.0, 2.0, 2.0)

        self.assertFalse(verify(checkpoint, lambda key: scene[key]))
        restore(checkpoint, lambda key, values: scene.__setitem__(key, copy.deepcopy(values)))
        self.assertTrue(verify(checkpoint, lambda key: scene[key]))

    def test_scoped_value_snapshot_restore_is_idempotent(self):
        """§15.3 lines 484-487: rewriting snapshot values is idempotent."""
        scene = {"object:cube": {"energy": 10.0}}
        checkpoint = create_checkpoint(scene)
        scene["object:cube"]["energy"] = 20.0
        apply = lambda key, values: scene.__setitem__(key, copy.deepcopy(values))

        restore(checkpoint, apply)
        once = copy.deepcopy(scene)
        restore(checkpoint, apply)

        self.assertEqual(scene, once)
        self.assertTrue(verify(checkpoint, lambda key: scene[key]))

    def test_scoped_value_snapshot_hash_is_deterministic_across_insertion_order(self):
        """§15.3 lines 484-487: equivalent scoped values have one stable hash."""
        first = {"object:b": {"z": 2, "a": 1}, "object:a": {"name": "Cube"}}
        second = {"object:a": {"name": "Cube"}, "object:b": {"a": 1, "z": 2}}

        self.assertEqual(create_checkpoint(first).state_hash, create_checkpoint(second).state_hash)

    def test_snapshot_is_defensively_copied_at_input_and_on_every_access(self):
        original = {"object:cube": {"location": [1.0, 2.0, 3.0]}}
        checkpoint = create_checkpoint(original)
        original["object:cube"]["location"][0] = 9.0
        exposed = checkpoint.entities
        exposed["object:cube"]["location"][1] = 8.0

        restored = {}
        restore(checkpoint, lambda key, values: restored.__setitem__(key, values))

        self.assertEqual(restored, {"object:cube": {"location": [1.0, 2.0, 3.0]}})
        self.assertTrue(verify(checkpoint, lambda key: restored[key]))
        self.assertEqual(
            checkpoint.entities,
            {"object:cube": {"location": [1.0, 2.0, 3.0]}},
        )


if __name__ == "__main__":
    unittest.main()
