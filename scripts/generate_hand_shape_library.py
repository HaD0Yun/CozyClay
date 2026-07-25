#!/usr/bin/env python3
"""Validate calibration data and regenerate the pure hand-shape library."""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = REPOSITORY_ROOT / "blender-addon/calibration/hand-shapes-v1.json"
DEFAULT_OUTPUT = REPOSITORY_ROOT / "blender-addon/cclay/hand_shapes.py"
FINGERS = ("Thumb", "Index", "Middle", "Ring", "Pinky")
ROLES = tuple(f"{finger}{segment}" for finger in FINGERS for segment in range(1, 5))
SIDES = ("left", "right")
RELAXED_NON_THUMB = (
    (4, 10, 16, 17),
    (3, 18, 15, 22),
    (2, 18, 26, 16),
    (4, 20, 8, 19),
)
_HEADER_START = "LIBRARY_VERSION = "
_HEADER_END = "_FINGERS = "
_CHANNEL_START = "# Calibrated local flexion angles in degrees. The calibration JSON is the numeric authority.\n"
_CHANNEL_END = "PRESET_LIBRARY = "


class CalibrationError(ValueError):
    pass


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise CalibrationError(message)


def validate(data: Any) -> dict[str, Any]:
    _require(isinstance(data, dict), "calibration root must be an object")
    _require(
        set(data) == {
            "schema_version",
            "library_version",
            "rotation_model",
            "canonical_fingers",
            "canonical_roles",
            "characters",
            "approval",
            "presets",
        },
        "calibration root contains missing or unknown fields",
    )
    _require(data.get("schema_version") == 1, "schema_version must be 1")
    version = data.get("library_version")
    _require(isinstance(version, str) and re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version) is not None, "library_version must be semantic numeric version")
    _require(data.get("canonical_fingers") == list(FINGERS), "canonical_fingers must use frozen order")
    _require(data.get("canonical_roles") == list(ROLES), "canonical_roles must use frozen order")
    rotation = data.get("rotation_model")
    _require(isinstance(rotation, dict), "rotation_model must be an object")
    _require(
        set(rotation) == {"channel", "adapter", "quaternion_order", "composition"},
        "rotation_model contains missing or unknown fields",
    )
    _require(rotation.get("channel") == "local_flexion_degrees", "unsupported rotation channel")
    _require(
        rotation.get("adapter") == "per-character/side/role unit axis",
        "unsupported rotation adapter",
    )
    _require(rotation.get("quaternion_order") == "wxyz", "quaternion order must be wxyz")
    _require(rotation.get("composition") == "authored_base @ delta", "composition order must be authored_base @ delta")
    characters = data.get("characters")
    _require(isinstance(characters, dict) and set(characters) == {"Y_BOT", "X_BOT"}, "characters must be exactly Y_BOT and X_BOT")
    reference_adapters = None
    for character, value in characters.items():
        _require(
            isinstance(value, dict) and set(value) == {"bone_prefix", "role_adapters"},
            f"invalid {character} rig adapter fields",
        )
        _require(value.get("bone_prefix") == "mixamorig:", f"invalid {character} bone convention")
        adapters = value.get("role_adapters")
        _require(
            isinstance(adapters, dict) and list(adapters) == list(SIDES),
            f"invalid {character} role adapter sides",
        )
        for side in SIDES:
            side_adapters = adapters[side]
            _require(
                isinstance(side_adapters, dict) and list(side_adapters) == list(ROLES),
                f"{character}/{side} adapters must cover every ordered canonical role",
            )
            for role, axis in side_adapters.items():
                _require(
                    isinstance(axis, list)
                    and len(axis) == 3
                    and all(
                        isinstance(component, (int, float))
                        and not isinstance(component, bool)
                        and math.isfinite(component)
                        for component in axis
                    ),
                    f"{character}/{side}/{role} axis must have three finite components",
                )
                magnitude = math.sqrt(sum(float(component) ** 2 for component in axis))
                _require(
                    abs(magnitude - 1.0) <= 1.0e-6,
                    f"{character}/{side}/{role} axis must be unit length",
                )
        if reference_adapters is None:
            reference_adapters = adapters
        else:
            _require(
                adapters == reference_adapters,
                "generated library requires matching adapters across bundled rigs",
            )
    approval = data.get("approval")
    _require(isinstance(approval, dict), "approval must be an object")
    _require(set(approval) == {"status", "closed", "approved_library_version", "provenance"}, "approval contains missing or unknown fields")
    _require(approval.get("status") == "approved" and approval.get("closed") is True, "calibration approval must be closed and approved")
    _require(approval.get("approved_library_version") == version, "approval version must match library version")
    provenance = approval.get("provenance")
    _require(isinstance(provenance, list), "approval provenance must be a list")
    _require({item.get("character_type") for item in provenance if isinstance(item, dict)} == {"Y_BOT", "X_BOT"}, "provenance must cover both bundled characters")
    for item in provenance:
        _require(isinstance(item, dict), "each provenance record must be an object")
        _require(set(item) == {"character_type", "source", "method"}, "provenance record contains missing or unknown fields")
        _require(isinstance(item.get("source"), str) and item["source"].endswith(".fbx"), "each provenance source must identify an FBX")
        _require(isinstance(item.get("method"), str) and item["method"], "each provenance record must state its method")

    presets = data.get("presets")
    _require(isinstance(presets, dict) and 10 <= len(presets) <= 20, "presets must contain 10 through 20 entries")
    _require("relaxed" in presets and "open" in presets, "relaxed and open presets are mandatory")
    signatures: set[tuple[float, ...]] = set()
    for name, preset in presets.items():
        _require(isinstance(name, str) and re.fullmatch(r"[a-z][a-z0-9]*(?:_[a-z0-9]+)*", name) is not None, f"invalid public preset name: {name!r}")
        _require(isinstance(preset, dict) and set(preset) == set(SIDES), f"preset {name} must define both sides")
        flattened: list[float] = []
        for side in SIDES:
            channels = preset[side]
            _require(isinstance(channels, dict) and list(channels) == list(FINGERS), f"preset {name}/{side} must use complete ordered finger inventory")
            for finger in FINGERS:
                values = channels[finger]
                _require(isinstance(values, list) and len(values) == 4, f"preset {name}/{side}/{finger} must have four segments")
                _require(all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) for value in values), f"preset {name}/{side}/{finger} must contain finite numbers")
                _require(values[3] == 0 if finger == "Thumb" else True, f"preset {name}/{side} Thumb4 must remain identity")
                flattened.extend(float(value) for value in values)
        signature = tuple(flattened)
        _require(signature not in signatures, f"preset {name} is not numerically distinct")
        signatures.add(signature)
    for side in SIDES:
        _require(all(value == 0 for finger in FINGERS for value in presets["open"][side][finger]), f"open/{side} must be identity")
        observed = tuple(tuple(presets["relaxed"][side][finger]) for finger in FINGERS[1:])
        _require(observed == RELAXED_NON_THUMB, f"relaxed/{side} legacy non-thumb flexion changed")
    return data


def _tuple_text(values: list[Any]) -> str:
    return "(" + ", ".join(repr(value) for value in values) + ")"


def _render_header(data: dict[str, Any]) -> str:
    names = list(data["presets"])
    role_rows = [ROLES[index:index + 4] for index in range(0, len(ROLES), 4)]
    name_rows = (names[:6], names[6:13], names[13:])
    adapters = data["characters"]["Y_BOT"]["role_adapters"]
    quote = json.dumps
    lines = [f'LIBRARY_VERSION = {quote(data["library_version"])}', "CANONICAL_ROLES = ("]
    lines.extend("    " + ", ".join(quote(value) for value in row) + "," for row in role_rows)
    lines.extend([")", "CANONICAL_ROLE_ORDER = CANONICAL_ROLES", "PRESET_NAMES = ("])
    lines.extend("    " + ", ".join(quote(value) for value in row) + "," for row in name_rows if row)
    lines.extend([
        ")",
        '_FINGERS = ("Thumb", "Index", "Middle", "Ring", "Pinky")',
        '_SIDES = ("left", "right")',
        "_FLEXION_ADAPTERS = {",
        *[
            f'    {quote(side)}: {{'
            + ", ".join(
                f'{quote(role)}: {_tuple_text(adapters[side][role])}'
                for role in ROLES
            )
            + "},"
            for side in SIDES
        ],
        "}",
        "_IDENTITY = (1.0, 0.0, 0.0, 0.0)",
        "",
    ])
    return "\n".join(lines) + "\n"


def _render_channels(data: dict[str, Any]) -> str:
    lines = [_CHANNEL_START.rstrip("\n"), "_CHANNELS = {"]
    for name, preset in data["presets"].items():
        sides = []
        for side in SIDES:
            fingers = ", ".join(_tuple_text(preset[side][finger]) for finger in FINGERS)
            sides.append(f'{json.dumps(side)}: ({fingers})')
        lines.append(f"    {json.dumps(name)}: {{{', '.join(sides)}}},")
    lines.extend(["}", ""])
    return "\n".join(lines)


def render(existing: str, data: dict[str, Any]) -> str:
    header_start = existing.find(_HEADER_START)
    header_end = existing.find(_HEADER_END, header_start)
    channel_start = existing.find(_CHANNEL_START, header_end)
    channel_end = existing.find(_CHANNEL_END, channel_start)
    _require(min(header_start, header_end, channel_start, channel_end) >= 0, "generated module markers are missing")
    header_tail = existing.find("\n", header_end)
    identity_tail = existing.find("\n\n", header_tail)
    _require(identity_tail >= 0, "generated module header is malformed")
    return (
        existing[:header_start]
        + _render_header(data)
        + existing[identity_tail + 2:channel_start]
        + _render_channels(data)
        + existing[channel_end:]
    )


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--check", action="store_true")
    return parser.parse_args()


def main() -> int:
    arguments = _arguments()
    try:
        data = validate(json.loads(arguments.source.read_text(encoding="utf-8")))
        existing = arguments.output.read_text(encoding="utf-8")
        generated = render(existing, data)
    except (OSError, json.JSONDecodeError, CalibrationError) as exc:
        print(f"hand-shape generation failed: {exc}", file=sys.stderr)
        return 2
    if arguments.check:
        if existing != generated:
            print(f"generated hand-shape library is stale: {arguments.output}", file=sys.stderr)
            return 1
        return 0
    arguments.output.write_text(generated, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
