import importlib.util
import pathlib
import tempfile
import unittest


SCRIPT = pathlib.Path(__file__).parents[1] / "cclay_interval_inbetween.py"
SPEC = importlib.util.spec_from_file_location("cclay_interval_inbetween", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class IntervalInbetweenContractTests(unittest.TestCase):
    def test_pose_intervals_require_both_clip_endpoints_and_are_sorted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            sources = []
            for index in range(3):
                source = root / f"pose-{index}.npz"
                source.write_bytes(b"placeholder")
                sources.append(source)
            parsed = MODULE.parse_poses(
                [
                    (str(sources[2]), "0", "99"),
                    (str(sources[0]), "0", "0"),
                    (str(sources[1]), "0", "44"),
                ],
                100,
            )
        self.assertEqual([entry[0] for entry in parsed], [0, 44, 99])

    def test_pose_intervals_reject_missing_final_endpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            left = root / "left.npz"
            right = root / "right.npz"
            left.write_bytes(b"placeholder")
            right.write_bytes(b"placeholder")
            with self.assertRaisesRegex(ValueError, "clip endpoints 0 and 99"):
                MODULE.parse_poses(
                    [(str(left), "0", "0"), (str(right), "0", "80")],
                    100,
                )

    def test_pose_intervals_reject_duplicate_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            left = root / "left.npz"
            right = root / "right.npz"
            left.write_bytes(b"placeholder")
            right.write_bytes(b"placeholder")
            with self.assertRaisesRegex(ValueError, "duplicate captured pose"):
                MODULE.parse_poses(
                    [(str(left), "0", "0"), (str(right), "0", "0")],
                    100,
                )


if __name__ == "__main__":
    unittest.main()
