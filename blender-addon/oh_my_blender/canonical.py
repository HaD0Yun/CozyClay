"""Canonical JSON serialization and revision hashing for Scene Snapshot v2.

Contract: docs/SCENE-SNAPSHOT-V2.md section 4. Must stay byte-identical to
packages/blender-director/src/canonical.ts; the shared fixture
packages/blender-director/test/fixtures/canonical-numbers.json guards parity
in both test suites. Pure stdlib so it runs outside Blender.
"""

from __future__ import annotations

import hashlib
import math
import unicodedata
from fractions import Fraction

TEN_POW_9 = 10**9
MAX_MAGNITUDE = 1e15

_ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\t": "\\t",
    "\n": "\\n",
    "\f": "\\f",
    "\r": "\\r",
}


def canonical_number(value: float | int) -> str:
    """Serialize per the spec: decimal rounded half-even to 1e-9.

    Trailing fractional zeros stripped, ``-0`` becomes ``"0"``, no exponent
    notation. The integer rule coincides with this algorithm for integral
    values, so all JSON numbers go through here.
    """
    if isinstance(value, bool):
        raise TypeError("bool is not a canonical number")
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        raise ValueError(f"canonical number must be finite, got {value!r}")
    if abs(value) >= MAX_MAGNITUDE:
        raise ValueError(f"canonical number magnitude must be < 1e15, got {value!r}")
    # Fraction(float) is the exact binary64 value; round() on Fraction is
    # exact round-half-even. Rounding the magnitude matches the TypeScript
    # implementation, which rounds the (positive) mantissa expansion.
    scaled = round(Fraction(abs(value)) * TEN_POW_9)
    if scaled == 0:
        return "0"
    sign = "-" if value < 0 else ""
    integer_part, fraction_digits = divmod(scaled, TEN_POW_9)
    fraction_part = str(fraction_digits).rjust(9, "0").rstrip("0")
    if fraction_part:
        return f"{sign}{integer_part}.{fraction_part}"
    return f"{sign}{integer_part}"


def canonical_string(value: str) -> str:
    """NFC-normalize and serialize with JSON minimal escaping."""
    normalized = unicodedata.normalize("NFC", value)
    out = ['"']
    for character in normalized:
        escape = _ESCAPES.get(character)
        if escape is not None:
            out.append(escape)
        elif ord(character) < 0x20:
            out.append(f"\\u{ord(character):04x}")
        else:
            out.append(character)
    out.append('"')
    return "".join(out)


def canonical_json(value: object) -> str:
    """Serialize a parsed JSON value to canonical text.

    Code-point-sorted NFC keys, no whitespace, numbers per canonical_number.
    Array order is preserved; semantic sorting happens in the schema layer.
    """
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return canonical_number(value)
    if isinstance(value, str):
        return canonical_string(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        entries = sorted(
            ((unicodedata.normalize("NFC", key), nested) for key, nested in value.items()),
            key=lambda entry: entry[0],
        )
        return "{" + ",".join(f"{canonical_string(key)}:{canonical_json(nested)}" for key, nested in entries) + "}"
    raise TypeError(f"value is not canonical JSON serializable: {type(value).__name__}")


def canonical_revision(value: object) -> str:
    """Lowercase-hex SHA-256 of the UTF-8 canonical bytes."""
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()
