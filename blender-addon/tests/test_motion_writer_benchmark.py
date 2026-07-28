"""Pure host coverage for the Release-1 fresh-process benchmark harness."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPOSITORY_ROOT / "scripts/benchmark_motion_writer.py"
SPEC = importlib.util.spec_from_file_location("benchmark_motion_writer", SCRIPT)
benchmark = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(benchmark)


def _terminal(**changes):
    receipt = {
        "schema": "cclay.stage_scene_motion.v2",
        "report_version": 2,
        "qualification_version": "ardy-adaptive-v1",
        "outcome": "SUCCESS",
        "terminal_phase": "SUCCEEDED",
        "error_code": None,
        "mode": "bulk_dense",
        "effective_mode": "bulk_dense",
        "motion_count": 1,
        "completed_motion_count": 1,
        "dense_motion_count": 1,
        "optimized_motion_count": 0,
        "fallback_motion_count": 0,
        "source_points": 23760,
        "rss_delta_bytes": 1024,
        "max_heartbeat_gap_ms": 20.0,
        "longest_uninterruptible_call_ms": 30.0,
        "max_scheduled_step_ms": 40.0,
    }
    receipt.update(changes)
    return receipt


def _fixture_result(**changes):
    result = {name: True for name in benchmark.REQUIRED_RESULT_FLAGS}
    result["denseWriterBenchmarkReceipt"] = {
        "curves": 99,
        "points": 23760,
        "legacyCurves": 99,
        "legacyPoints": 23760,
        "writerOrder": "bulk_first",
        "bulkRunsMs": [2.0],
        "legacyRunsMs": [12.0],
        "elapsedMs": 100.0,
        "bulkMedianMs": 2.0,
        "legacyMedianMs": 12.0,
        "speedup": 6.0,
    }
    result.update(changes)
    return result


def _stdout(result=None, terminal=None):
    result = _fixture_result() if result is None else result
    terminal = _terminal() if terminal is None else terminal
    return "\n".join((
        "Blender 5.2.0",
        "INFO:cclay.motion_keyframes:" + json.dumps(terminal),
        benchmark.RESULT_PREFIX + json.dumps(result),
    ))


def _row(speedup=6.0, latency=20.0, fallback=0):
    return {
        "bulkMedianMs": 2.0,
        "legacyMedianMs": 12.0,
        "speedup": speedup,
        "totalElapsedMs": 1000.0,
        "rssDeltaBytes": 1024.0,
        "maxHeartbeatGapMs": latency,
        "longestUninterruptibleCallMs": latency,
        "maxScheduledStepMs": latency,
        "curves": 99,
        "points": 23760,
        "legacyCurves": 99,
        "legacyPoints": 23760,
        "fixtureGates": {name: True for name in benchmark.REQUIRED_RESULT_FLAGS},
        "terminalReceipt": {"fallbackMotionCount": fallback},
    }


class MotionWriterBenchmarkTests(unittest.TestCase):
    def test_nearest_rank_p95(self):
        self.assertIsNone(benchmark.nearest_rank_p95([]))
        self.assertEqual(benchmark.nearest_rank_p95([9]), 9.0)
        self.assertEqual(benchmark.nearest_rank_p95(range(1, 21)), 19.0)
        self.assertEqual(benchmark.nearest_rank_p95(range(1, 32)), 30.0)

    def test_seeded_order_is_deterministic_and_seed_sensitive(self):
        first = benchmark.deterministic_order(31, 1)
        self.assertEqual(first, benchmark.deterministic_order(31, 1))
        self.assertNotEqual(first, benchmark.deterministic_order(31, 2))
        self.assertEqual(sorted(first), list(range(31)))
        self.assertEqual(
            (sum(token % 2 == 0 for token in first), sum(token % 2 == 1 for token in first)),
            (16, 15),
        )

    def test_defaults_are_release_grade_counts(self):
        parser = benchmark.build_parser()
        args = parser.parse_args(["--blender", "blender", "--output", "evidence.json"])
        self.assertEqual((args.warmups, args.runs, args.seed), (3, 31, 1))

    def test_content_addressed_output_uses_exact_canonical_bytes(self):
        document = {"schema": benchmark.SCHEMA, "z": [3, 2, 1], "a": {"b": True}}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "requested.json"
            digest, sibling = benchmark.write_content_addressed(output, document)
            expected = b'{"a":{"b":true},"schema":"cclay.motion_writer_benchmark.v1","z":[3,2,1]}\n'
            self.assertEqual(output.read_bytes(), expected)
            self.assertEqual(sibling.read_bytes(), expected)
            self.assertEqual(digest, hashlib.sha256(expected).hexdigest())
            self.assertEqual(sibling.name, f"{digest}.json")

    def test_valid_result_is_reduced_to_structured_fields(self):
        row = benchmark.parse_process_output(_stdout(), 0, 1234.0)
        self.assertEqual(row["blenderVersion"], "5.2.0")
        self.assertEqual((row["curves"], row["points"]), (99, 23760))
        self.assertEqual(row["rssDeltaBytes"], 1024.0)
        self.assertEqual(row["writerOrder"], "bulk_first")
        self.assertNotIn("stdout", row)

    def test_missing_duplicate_and_invalid_results_are_rejected(self):
        with self.assertRaisesRegex(benchmark.BenchmarkError, "exactly one"):
            benchmark.parse_process_output("Blender 5.2.0", 0, 1.0)
        duplicate = _stdout() + "\n" + benchmark.RESULT_PREFIX + json.dumps(_fixture_result())
        with self.assertRaisesRegex(benchmark.BenchmarkError, "exactly one"):
            benchmark.parse_process_output(duplicate, 0, 1.0)
        invalid = _fixture_result(denseWriterBezierKeyParity=False)
        with self.assertRaisesRegex(benchmark.BenchmarkError, "fixture gates failed"):
            benchmark.parse_process_output(_stdout(result=invalid), 0, 1.0)
        with self.assertRaisesRegex(benchmark.BenchmarkError, "terminal instrumentation"):
            benchmark.parse_process_output(_stdout(terminal=_terminal(fallback_motion_count=1)), 0, 1.0)
        with self.assertRaisesRegex(benchmark.BenchmarkError, "return code"):
            benchmark.parse_process_output(_stdout(), 2, 1.0)
        duplicate_terminal = _stdout().replace(
            benchmark.RESULT_PREFIX,
            "INFO:cclay.motion_keyframes:" + json.dumps(_terminal()) + "\n"
            + benchmark.RESULT_PREFIX,
        )
        with self.assertRaisesRegex(benchmark.BenchmarkError, "exactly one successful"):
            benchmark.parse_process_output(duplicate_terminal, 0, 1.0)
        with self.assertRaisesRegex(benchmark.BenchmarkError, "writerOrder"):
            benchmark.parse_process_output(
                _stdout(),
                0,
                1.0,
                expected_writer_order="legacy_first",
            )
        invalid_samples = _fixture_result()
        invalid_samples["denseWriterBenchmarkReceipt"]["bulkRunsMs"] = [2.0, 2.0]
        with self.assertRaisesRegex(benchmark.BenchmarkError, "exactly one sample"):
            benchmark.parse_process_output(_stdout(result=invalid_samples), 0, 1.0)
        mismatched_median = _fixture_result()
        mismatched_median["denseWriterBenchmarkReceipt"]["bulkMedianMs"] = 2.1
        with self.assertRaisesRegex(benchmark.BenchmarkError, "medians must equal"):
            benchmark.parse_process_output(_stdout(result=mismatched_median), 0, 1.0)
        mismatched_speedup = _fixture_result()
        mismatched_speedup["denseWriterBenchmarkReceipt"]["speedup"] = 5.0
        with self.assertRaisesRegex(benchmark.BenchmarkError, "speedup must equal"):
            benchmark.parse_process_output(_stdout(result=mismatched_speedup), 0, 1.0)

    def test_gate_calculation_covers_speed_parity_fallback_and_latency(self):
        passing = [_row(speedup=value) for value in (5.0, 6.0, 7.0)]
        gates = benchmark.calculate_gates(passing)
        self.assertTrue(gates["passed"])
        self.assertFalse(benchmark.calculate_gates([_row(4.99)])["medianSpeedupAtLeast5x"])
        self.assertFalse(benchmark.calculate_gates([_row(fallback=1)])["noFallback"])
        self.assertFalse(benchmark.calculate_gates([_row(latency=250.0)])["reportedLatencyBelow250Ms"])
        missing_latency = _row()
        missing_latency["maxHeartbeatGapMs"] = None
        missing_latency_gates = benchmark.calculate_gates([missing_latency])
        self.assertFalse(missing_latency_gates["reportedLatencyBelow250Ms"])
        over_rss = _row()
        over_rss["rssDeltaBytes"] = benchmark.RSS_LIMIT_BYTES + 1
        over_rss_gates = benchmark.calculate_gates([over_rss])
        self.assertFalse(over_rss_gates["rssDeltaAtMost512MiB"])
        self.assertFalse(over_rss_gates["passed"])
        unequal = _row()
        unequal["legacyPoints"] = 23759
        self.assertFalse(benchmark.calculate_gates([unequal])["equalWorkAndParity"])

    def test_aggregates_use_nearest_rank_p95(self):
        rows = [_row(speedup=float(value)) for value in range(1, 32)]
        aggregate = benchmark.aggregate_rows(rows)["speedup"]
        self.assertEqual(aggregate, {"count": 31, "median": 16.0, "p95": 30.0, "max": 31.0})


if __name__ == "__main__":
    unittest.main()
