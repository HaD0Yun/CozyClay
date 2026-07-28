#!/usr/bin/env python3
"""Run the Release-1 motion-writer benchmark in fresh Blender processes."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import re
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Iterable

SCHEMA = "cclay.motion_writer_benchmark.v1"
RESULT_PREFIX = "CCLAY_STAGE_CHARACTER_RESULTS="
WRITER_ORDER_ENV = "CCLAY_BENCHMARK_WRITER_ORDER"
TERMINAL_SCHEMA = "cclay.stage_scene_motion.v2"
DEFAULT_WARMUPS = 3
DEFAULT_RUNS = 31
LATENCY_LIMIT_MS = 250.0
RSS_LIMIT_BYTES = 512 * 1024 * 1024
SPEEDUP_GATE = 5.0

REQUIRED_RESULT_FLAGS = (
    "denseWriterExactInventory",
    "denseWriterLayeredTopology",
    "denseWriterBezierKeyParity",
    "denseWriterBezierEvaluationParity",
    "denseWriterCompleteCurveParity",
    "denseWriterPerformanceImproved",
    "denseWriterTemporaryActionsRemoved",
)
HASHED_INPUTS = (
    "blender-addon/cclay/stage_scene.py",
    "blender-addon/cclay/motion_retarget.py",
    "blender-addon/tests/fixtures/stage_scene_character_fixture.py",
    "blender-addon/cclay/assets/characters/y-bot-tpose.fbx",
    "blender-addon/cclay/assets/characters/x-bot-tpose.fbx",
)
METRICS = (
    "bulkMedianMs",
    "legacyMedianMs",
    "speedup",
    "totalElapsedMs",
    "rssDeltaBytes",
    "maxHeartbeatGapMs",
    "longestUninterruptibleCallMs",
    "maxScheduledStepMs",
)


class BenchmarkError(ValueError):
    """A benchmark input or child-process receipt is invalid."""


def nearest_rank_p95(values: Iterable[float]) -> float | None:
    ordered = sorted(float(value) for value in values)
    if not ordered:
        return None
    return ordered[math.ceil(0.95 * len(ordered)) - 1]


def deterministic_order(count: int, seed: int) -> list[int]:
    order = list(range(count))
    random.Random(seed).shuffle(order)
    return order


def canonical_bytes(document: dict[str, Any]) -> bytes:
    return (json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n").encode()


def write_content_addressed(output: Path, document: dict[str, Any]) -> tuple[str, Path]:
    payload = canonical_bytes(document)
    digest = hashlib.sha256(payload).hexdigest()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(payload)
    sibling = output.with_name(f"{digest}.json")
    sibling.write_bytes(payload)
    return digest, sibling


def _finite_number(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise BenchmarkError(f"{name} must be numeric")
    result = float(value)
    if not math.isfinite(result) or result < 0:
        raise BenchmarkError(f"{name} must be finite and non-negative")
    return result


def _json_objects(stdout: str) -> list[dict[str, Any]]:
    objects = []
    decoder = json.JSONDecoder()
    for line in stdout.splitlines():
        for start, character in enumerate(line):
            if character != "{":
                continue
            try:
                value, _end = decoder.raw_decode(line[start:])
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                objects.append(value)
                break
    return objects


def parse_process_output(
    stdout: str,
    return_code: int,
    elapsed_ms: float,
    expected_writer_order: str | None = None,
) -> dict[str, Any]:
    result_lines = [
        line[len(RESULT_PREFIX):]
        for line in stdout.splitlines()
        if line.startswith(RESULT_PREFIX)
    ]
    if len(result_lines) != 1:
        raise BenchmarkError(f"expected exactly one {RESULT_PREFIX} line, got {len(result_lines)}")
    try:
        result = json.loads(result_lines[0])
    except json.JSONDecodeError as error:
        raise BenchmarkError("fixture result is not valid JSON") from error
    if not isinstance(result, dict):
        raise BenchmarkError("fixture result must be a JSON object")
    if return_code != 0:
        raise BenchmarkError(f"Blender exited with return code {return_code}")
    missing = [name for name in REQUIRED_RESULT_FLAGS if result.get(name) is not True]
    if missing:
        raise BenchmarkError("fixture gates failed: " + ", ".join(missing))

    receipt = result.get("denseWriterBenchmarkReceipt")
    if not isinstance(receipt, dict):
        raise BenchmarkError("denseWriterBenchmarkReceipt is missing")
    expected_counts = {"curves": 99, "points": 23760, "legacyCurves": 99, "legacyPoints": 23760}
    for name, expected in expected_counts.items():
        if receipt.get(name) != expected:
            raise BenchmarkError(f"benchmark {name} must equal {expected}")
    bulk = _finite_number(receipt.get("bulkMedianMs"), "bulkMedianMs")
    legacy = _finite_number(receipt.get("legacyMedianMs"), "legacyMedianMs")
    speedup = _finite_number(receipt.get("speedup"), "speedup")
    if bulk <= 0 or legacy <= 0:
        raise BenchmarkError("writer medians must be positive")
    bulk_runs = receipt.get("bulkRunsMs")
    legacy_runs = receipt.get("legacyRunsMs")
    if not isinstance(bulk_runs, list) or len(bulk_runs) != 1:
        raise BenchmarkError("benchmark bulkRunsMs must contain exactly one sample")
    if not isinstance(legacy_runs, list) or len(legacy_runs) != 1:
        raise BenchmarkError("benchmark legacyRunsMs must contain exactly one sample")
    bulk_sample = _finite_number(bulk_runs[0], "bulkRunsMs[0]")
    legacy_sample = _finite_number(legacy_runs[0], "legacyRunsMs[0]")
    if bulk_sample <= 0 or legacy_sample <= 0:
        raise BenchmarkError("writer samples must be positive")
    if bulk != bulk_sample or legacy != legacy_sample:
        raise BenchmarkError("writer medians must equal their single samples")
    calculated_speedup = legacy / bulk
    if not math.isclose(speedup, calculated_speedup, rel_tol=1e-12, abs_tol=0.0):
        raise BenchmarkError("benchmark speedup must equal legacyMedianMs / bulkMedianMs")
    writer_order = receipt.get("writerOrder")
    if writer_order not in ("bulk_first", "legacy_first"):
        raise BenchmarkError("benchmark writerOrder must be bulk_first or legacy_first")
    if expected_writer_order is not None and writer_order != expected_writer_order:
        raise BenchmarkError(
            f"benchmark writerOrder {writer_order!r} does not match requested {expected_writer_order!r}"
        )

    successful = [
        item for item in _json_objects(stdout)
        if item.get("schema") == TERMINAL_SCHEMA
        and item.get("outcome") == "SUCCESS"
        and item.get("terminal_phase") == "SUCCEEDED"
        and item.get("error_code") is None
        and item.get("mode") == "bulk_dense"
        and item.get("effective_mode") == "bulk_dense"
        and item.get("motion_count") == 1
        and item.get("completed_motion_count") == 1
        and item.get("dense_motion_count") == 1
        and item.get("optimized_motion_count") == 0
        and item.get("fallback_motion_count") == 0
        and item.get("source_points") == 23760
    ]
    if len(successful) != 1:
        raise BenchmarkError(
            f"expected exactly one successful bulk-dense terminal instrumentation receipt, "
            f"got {len(successful)}"
        )
    terminal = successful[0]

    version_match = re.search(r"(?m)^Blender\s+([^\s]+)", stdout)
    if not version_match:
        raise BenchmarkError("Blender version banner is missing")
    row: dict[str, Any] = {
        "returnCode": return_code,
        "blenderVersion": version_match.group(1),
        "bulkMedianMs": bulk,
        "legacyMedianMs": legacy,
        "speedup": speedup,
        "totalElapsedMs": float(elapsed_ms),
        "denseElapsedMs": _finite_number(receipt.get("elapsedMs"), "elapsedMs"),
        "curves": 99,
        "points": 23760,
        "legacyCurves": 99,
        "legacyPoints": 23760,
        "writerOrder": writer_order,
        "fixtureGates": {name: True for name in REQUIRED_RESULT_FLAGS},
        "terminalReceipt": {
            "schema": TERMINAL_SCHEMA,
            "reportVersion": terminal.get("report_version"),
            "qualificationVersion": terminal.get("qualification_version"),
            "outcome": terminal.get("outcome"),
            "terminalPhase": terminal.get("terminal_phase"),
            "mode": terminal.get("mode"),
            "effectiveMode": terminal.get("effective_mode"),
            "motionCount": terminal.get("motion_count"),
            "completedMotionCount": terminal.get("completed_motion_count"),
            "denseMotionCount": terminal.get("dense_motion_count"),
            "optimizedMotionCount": terminal.get("optimized_motion_count"),
            "fallbackMotionCount": terminal.get("fallback_motion_count"),
            "sourcePoints": terminal.get("source_points"),
        },
    }
    aliases = {
        "rssDeltaBytes": "rss_delta_bytes",
        "maxHeartbeatGapMs": "max_heartbeat_gap_ms",
        "longestUninterruptibleCallMs": "longest_uninterruptible_call_ms",
        "maxScheduledStepMs": "max_scheduled_step_ms",
    }
    for output_name, receipt_name in aliases.items():
        value = terminal.get(receipt_name)
        row[output_name] = None if value is None else _finite_number(value, receipt_name)
    return row


def calculate_gates(rows: list[dict[str, Any]]) -> dict[str, Any]:
    if not rows:
        raise BenchmarkError("at least one measured row is required")
    parity = all(
        row.get("curves") == row.get("legacyCurves") == 99
        and row.get("points") == row.get("legacyPoints") == 23760
        and all(row.get("fixtureGates", {}).values())
        for row in rows
    )
    no_fallback = all(row.get("terminalReceipt", {}).get("fallbackMotionCount") == 0 for row in rows)
    latency_names = (
        "maxHeartbeatGapMs",
        "longestUninterruptibleCallMs",
        "maxScheduledStepMs",
    )
    latency = all(
        all(
            isinstance(row.get(name), (int, float))
            and not isinstance(row.get(name), bool)
            and math.isfinite(float(row[name]))
            and float(row[name]) < LATENCY_LIMIT_MS
            for name in latency_names
        )
        for row in rows
    )
    rss = all(
        isinstance(row.get("rssDeltaBytes"), (int, float))
        and not isinstance(row.get("rssDeltaBytes"), bool)
        and math.isfinite(float(row["rssDeltaBytes"]))
        and 0 <= float(row["rssDeltaBytes"]) <= RSS_LIMIT_BYTES
        for row in rows
    )
    median_speedup = statistics.median(float(row["speedup"]) for row in rows)
    gates = {
        "medianSpeedupAtLeast5x": median_speedup >= SPEEDUP_GATE,
        "equalWorkAndParity": parity,
        "noFallback": no_fallback,
        "reportedLatencyBelow250Ms": latency,
        "rssDeltaAtMost512MiB": rss,
    }
    gates["passed"] = all(gates.values())
    return gates


def aggregate_rows(rows: list[dict[str, Any]]) -> dict[str, Any]:
    aggregates: dict[str, Any] = {}
    for name in METRICS:
        values = [float(row[name]) for row in rows if row.get(name) is not None]
        aggregates[name] = {
            "count": len(values),
            "median": statistics.median(values) if values else None,
            "p95": nearest_rank_p95(values),
            "max": max(values) if values else None,
        }
    return aggregates


def _hash_file(path: Path) -> dict[str, Any]:
    return {"contentAddressed": True, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def _hash_executable(path: Path) -> dict[str, Any]:
    try:
        return _hash_file(path)
    except OSError:
        stat = path.stat()
        identity = {"size": stat.st_size, "mtimeNs": stat.st_mtime_ns, "inode": stat.st_ino}
        return {
            "contentAddressed": False,
            "statIdentity": identity,
            "statIdentitySha256": hashlib.sha256(canonical_bytes(identity)).hexdigest(),
        }


def _approved_plan(repository: Path) -> Path:
    candidates = sorted(
        path for path in (repository / ".gjc").glob("**/plans/ralplan/*/pending-approval.md")
        if "Release 1" in path.read_text(errors="replace") and "23,760" in path.read_text(errors="replace")
    )
    if not candidates:
        raise BenchmarkError("approved Release-1 plan was not found below .gjc")
    return candidates[-1]


def collect_hashes(repository: Path, blender: Path) -> dict[str, Any]:
    hashes = {name: _hash_file(repository / name) for name in HASHED_INPUTS}
    plan = _approved_plan(repository)
    hashes[plan.relative_to(repository).as_posix()] = _hash_file(plan)
    hashes["blenderExecutable"] = _hash_executable(blender)
    return hashes


def _resolve_inputs(args: argparse.Namespace) -> tuple[Path, Path, Path]:
    repository = Path(args.repository).expanduser().resolve()
    if not repository.is_dir():
        raise BenchmarkError("--repository must be a directory")
    blender_name = shutil.which(args.blender) or args.blender
    blender = Path(blender_name).expanduser().resolve()
    if not blender.is_file() or not os.access(blender, os.X_OK):
        raise BenchmarkError("--blender must be an executable file")
    if args.warmups < 0:
        raise BenchmarkError("--warmups must be non-negative")
    if args.runs <= 0:
        raise BenchmarkError("--runs must be positive")
    fixture = repository / "blender-addon/tests/fixtures/stage_scene_character_fixture.py"
    for path in (fixture, *(repository / name for name in HASHED_INPUTS)):
        if not path.is_file():
            raise BenchmarkError(f"required repository input is missing: {path.name}")
    output = Path(args.output).expanduser().resolve()
    if output.exists() and not output.is_file():
        raise BenchmarkError("--output must be a file path")
    if not output.parent.is_dir():
        raise BenchmarkError("--output parent directory must exist")
    return repository, blender, output


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--blender", required=True)
    parser.add_argument("--repository", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--warmups", type=int, default=DEFAULT_WARMUPS)
    parser.add_argument("--runs", type=int, default=DEFAULT_RUNS)
    parser.add_argument("--output", required=True)
    parser.add_argument("--expected-blender-prefix")
    parser.add_argument("--seed", type=int, default=1)
    return parser


def run(args: argparse.Namespace) -> tuple[str, Path]:
    repository, blender, output = _resolve_inputs(args)
    fixture_relative = "blender-addon/tests/fixtures/stage_scene_character_fixture.py"
    command = [str(blender), "--background", "--factory-startup", "--python", fixture_relative]
    process_order = deterministic_order(args.runs, args.seed)
    measured: list[dict[str, Any]] = []
    if WRITER_ORDER_ENV not in (repository / fixture_relative).read_text():
        raise BenchmarkError(f"fixture does not implement {WRITER_ORDER_ENV}")
    for invocation in range(args.warmups + args.runs):
        env = os.environ.copy()
        env.pop(WRITER_ORDER_ENV, None)
        measured_index = invocation - args.warmups
        expected_writer_order = None
        if measured_index >= 0:
            expected_writer_order = (
                "bulk_first" if process_order[measured_index] % 2 == 0 else "legacy_first"
            )
            env[WRITER_ORDER_ENV] = expected_writer_order
        started = time.perf_counter()
        completed = subprocess.run(
            command, cwd=repository, env=env, capture_output=True, text=True, timeout=900, check=False
        )
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        row = parse_process_output(
            completed.stdout + "\n" + completed.stderr,
            completed.returncode,
            elapsed_ms,
            expected_writer_order,
        )
        if args.expected_blender_prefix and not row["blenderVersion"].startswith(args.expected_blender_prefix):
            raise BenchmarkError(
                f"Blender version {row['blenderVersion']!r} does not start with {args.expected_blender_prefix!r}"
            )
        if measured_index >= 0:
            row["measuredIndex"] = measured_index
            row["processOrderToken"] = process_order[measured_index]
            measured.append(row)

    gates = calculate_gates(measured)
    document = {
        "schema": SCHEMA,
        "command": {
            "executable": blender.name,
            "arguments": ["--background", "--factory-startup", "--python", fixture_relative],
        },
        "config": {
            "repository": ".",
            "warmups": args.warmups,
            "runs": args.runs,
            "seed": args.seed,
            "expectedBlenderPrefix": args.expected_blender_prefix,
            "freshProcessPerInvocation": True,
            "writerOrdering": {
                "source": "fixtureOrderEnvironment",
                "environment": WRITER_ORDER_ENV,
            },
        },
        "hashes": collect_hashes(repository, blender),
        "rows": measured,
        "aggregates": aggregate_rows(measured),
        "gates": gates,
    }
    digest, sibling = write_content_addressed(output, document)
    if not gates["passed"]:
        raise BenchmarkError(f"benchmark gates failed; evidence sha256={digest}")
    return digest, sibling


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        digest, sibling = run(args)
    except (BenchmarkError, OSError, subprocess.SubprocessError) as error:
        print(f"benchmark_motion_writer: {error}", file=sys.stderr)
        return 1
    print(json.dumps({"sha256": digest, "contentAddressedOutput": sibling.name}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
