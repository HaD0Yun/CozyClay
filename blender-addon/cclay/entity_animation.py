"""Pure (bpy-free) animation-curve summarization for inspect_entity.

The live incident: ``inspect_entity(entity_id, "animation")`` on a retargeted
character rig returned a 2.05 MB tool result because ``_entity_detail`` dumped
every keyframe of every f-curve with no bound. A rig is roughly 65 bones x up
to 10 channels x hundreds of frames, so the raw dump blows the model context
window. This module turns that raw dump into a bounded, deterministic summary
plus an optional narrowed keyframe view, with no Blender dependency so the
math stays unit-testable on plain CPython.

The split between filtering and truncation matters and is deliberate:

- Filtering (``data_path_filter`` / ``frame_start`` / ``frame_end``) is the
  caller's intent. A curve whose keyframes are all filtered out is dropped
  from ``animations`` and is NOT counted in ``curvesOmitted`` -- the caller
  asked for exactly that subset, so nothing was withheld.
- Truncation is the budget's doing. When the selection still exceeds a budget
  after filtering, curves/keyframes are withheld and counted in
  ``curvesOmitted`` / ``keyframesOmitted`` so the caller knows what was lost
  and can re-narrow to recover the exact keys.
"""

from __future__ import annotations

import json
import re
from decimal import Decimal

# Response budgets. The keyframe budget is the hard ceiling that makes the 2 MB
# incident impossible: even a fully-keyed rig collapses to per-curve summaries
# well under these limits. The curve-row and group-row caps bound the summary
# shape so a pathologically wide rig cannot balloon the response either.
MAX_KEYFRAMES = 600
MAX_CURVES = 200
MAX_GROUPS = 256

# Hard serialized-byte ceiling on the animation section. The count caps above
# bound the *shape* of the summary but not its serialized size: 200 curves with
# 1000-character data paths still serialize to ~230 KB (~110k tokens), which
# blows the model context window. MAX_ANIMATION_BYTES is the real byte bound;
# when the built payload exceeds it, trailing curve rows (then trailing group
# rows) are dropped deterministically until it fits.
MAX_ANIMATION_BYTES = 32768

# Section caps for the non-animation scopes of inspect_entity, exposed here so
# the pure (bpy-free) tests can reach them without importing manifest.py (which
# imports bpy). manifest._entity_detail applies them to bound scope "all".
MAX_BONES = 512
MAX_MATERIALS = 64

# Whole-envelope ceiling for one inspect_entity result. The extension bridge
# refuses anything larger, measured over the same {revision, entity_id, scope,
# detail} envelope, so the add-on must guarantee it rather than letting a valid
# response be rejected after the work is done.
MAX_RESULT_BYTES = 65536


class AnimationBudgetError(RuntimeError):
    """A payload could not be reduced under its byte ceiling."""

# Derive the animated bone name from a data path. ``pose.bones["NAME"].location``
# -> ``NAME``; ``pose.bones["NAME"]["custom_prop"]`` -> ``NAME``; any other path
# (object-level ``location``, a malformed path, a driver path) -> the path
# itself. Both quote styles are accepted; the trailing ``.`` or ``[`` after the
# closing quote is optional so a bare property access still groups under the
# bone. A malformed path never raises.
_BONE_NAME = re.compile(r"""^pose\.bones\[(['"])(.*?)\1\](?:[.\[]|$)""")


def _js_number(value):
    """Render a number the way ``JSON.stringify`` would in JavaScript.

    The byte ceiling is enforced twice: here, so the add-on never sends a
    payload the extension will refuse, and again in the extension bridge, which
    measures ``JSON.stringify(result)``. Those two measurements have to agree on
    every byte, and Python and JavaScript disagree on how they spell some
    numbers: Python writes ``1e-06`` and ``1e+16`` where JavaScript writes
    ``0.000001`` and ``10000000000000000``, and Python writes ``3.0`` where
    JavaScript writes ``3``. Blender hands us small float coordinates all the
    time, so this is not a theoretical difference -- getting it wrong lets a
    legitimate response be refused after the work is done.

    Both languages already print the shortest round-tripping digits, so only the
    exponent/positional decision and the integral suffix need translating.
    """
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return repr(value)
    if value != value or value in (float("inf"), float("-inf")):
        # JSON.stringify emits null for NaN/Infinity; json.dumps would emit
        # NaN/Infinity. Neither should reach the wire, but stay conservative.
        return "null"
    if value == int(value) and abs(value) < 1e21:
        return repr(int(value))
    text = repr(value)
    if "e" not in text and "E" not in text:
        return text
    exponent = Decimal(text).adjusted()
    if -7 < exponent < 21:
        return format(Decimal(text), "f")
    mantissa, _, exp = text.partition("e")
    exp_value = int(exp)
    mantissa = mantissa.rstrip("0").rstrip(".") if "." in mantissa else mantissa
    return f"{mantissa}e{'+' if exp_value >= 0 else '-'}{abs(exp_value)}"


def _js_json_size(value) -> int:
    """UTF-8 byte length of ``value`` serialized exactly as JSON.stringify would.

    Only the JSON types the add-on actually emits are supported; anything else
    is a programming error and raises rather than guessing a size.
    """
    parts = []

    def encode(node):
        if node is None:
            parts.append("null")
        elif isinstance(node, str):
            parts.append(json.dumps(node, ensure_ascii=False))
        elif isinstance(node, (bool, int, float)):
            parts.append(_js_number(node))
        elif isinstance(node, dict):
            parts.append("{")
            first = True
            for key, item in node.items():
                if not first:
                    parts.append(",")
                first = False
                parts.append(json.dumps(str(key), ensure_ascii=False))
                parts.append(":")
                encode(item)
            parts.append("}")
        elif isinstance(node, (list, tuple)):
            parts.append("[")
            for index, item in enumerate(node):
                if index:
                    parts.append(",")
                encode(item)
            parts.append("]")
        else:
            raise TypeError(f"cannot size {type(node).__name__} for the JSON wire")

    encode(value)
    return len("".join(parts).encode("utf-8"))


def _group_name(data_path: str) -> str:
    """Return the bone name for a pose-bone data path, else the path itself."""
    try:
        match = _BONE_NAME.match(data_path)
    except TypeError:
        # data_path is not a string (malformed upstream); fall through.
        match = None
    if match is None:
        return data_path
    name = match.group(2)
    return name if name else data_path


def _filter_keyframes(keyframes, frame_start, frame_end):
    """Keep only keyframes within the inclusive frame range."""
    out = []
    for kp in keyframes:
        frame = kp["frame"]
        if frame_start is not None and frame < frame_start:
            continue
        if frame_end is not None and frame > frame_end:
            continue
        out.append(kp)
    return out


def _curve_summary(curve):
    """Compute per-curve summary fields (counts, bounds, interpolations).

    Bounds come from min/max rather than the first and last element: f-curve
    keyframe order is Blender's, not ours, and a frame-range filter can leave
    any subset. An empty curve reports null bounds instead of raising, even
    though the caller drops empty curves before summarizing.
    """
    keyframes = curve["keyframes"]
    frames = [kp["frame"] for kp in keyframes]
    values = [kp["value"] for kp in keyframes]
    interpolations = sorted({kp["interpolation"] for kp in keyframes})
    return {
        "keyframeCount": len(keyframes),
        "frameStart": min(frames) if frames else None,
        "frameEnd": max(frames) if frames else None,
        "valueMin": min(values) if values else None,
        "valueMax": max(values) if values else None,
        "interpolations": interpolations,
    }


def summarize_animation_curves(
    curves,
    *,
    data_path_filter=None,
    frame_start=None,
    frame_end=None,
):
    """Summarize raw animation curves into a bounded response.

    ``curves`` is a list of ``{"source", "dataPath", "arrayIndex", "keyframes":
    [{"frame", "value", "interpolation"}, ...]}`` entries, as produced by
    ``manifest._entity_detail``.

    Returns ``{"animations": [...], "summary": {...}}``. Each animation entry
    carries ``source``, ``dataPath``, ``arrayIndex``, ``keyframeCount``,
    ``frameStart``, ``frameEnd``, ``valueMin``, ``valueMax``, ``interpolations``,
    and ``keyframes`` -- present only when the whole selection fits every
    budget. ``summary`` carries ``curveCount``, ``keyframeCount``,
    ``frameStart``, ``frameEnd``, ``groupCount``, ``groups``, and ``truncated``
    (null or a ``{"reason", "curvesOmitted", "groupsOmitted",
    "keyframesOmitted", "hint"}`` object). When the serialized animation
    section exceeds ``MAX_ANIMATION_BYTES``, trailing curve rows then trailing
    group rows are dropped deterministically until it fits, and the byte-budget
    reason is appended to ``truncated.reason``.

    Curves are sorted by ``(source, dataPath, arrayIndex)``; groups by name.
    """
    # 1. Apply the caller's narrowing filters. The drop rule for an empty curve
    #    depends on whether the caller supplied a narrowing filter:
    #    - With a filter (data_path_filter / frame_start / frame_end), a curve
    #      whose keyframes are all filtered out is dropped from ``animations``
    #      and is NOT counted in ``curvesOmitted`` -- the caller asked for exactly
    #      that subset, so nothing was withheld.
    #    - Without any filter, a curve that legitimately has zero keyframes is
    #      preserved: it appears with ``keyframeCount: 0`` and null bounds rather
    #      than silently vanishing, because its absence is not caller intent.
    has_filter = (
        data_path_filter is not None
        or frame_start is not None
        or frame_end is not None
    )
    filtered = []
    for curve in curves:
        data_path = curve["dataPath"]
        if data_path_filter is not None and data_path_filter not in data_path:
            continue
        keyframes = _filter_keyframes(curve["keyframes"], frame_start, frame_end)
        if not keyframes and has_filter:
            continue
        filtered.append(
            {
                "source": curve["source"],
                "dataPath": data_path,
                "arrayIndex": curve["arrayIndex"],
                "keyframes": keyframes,
            }
        )

    # Deterministic ordering: source, dataPath, arrayIndex.
    filtered.sort(key=lambda c: (c["source"], c["dataPath"], c["arrayIndex"]))

    curve_count = len(filtered)
    total_keyframes = sum(len(c["keyframes"]) for c in filtered)

    # 2. Aggregate groups (per animated bone / data-path root).
    group_index = {}
    for curve in filtered:
        name = _group_name(curve["dataPath"])
        entry = group_index.get(name)
        if entry is None:
            entry = {"name": name, "curveCount": 0, "keyframeCount": 0}
            group_index[name] = entry
        entry["curveCount"] += 1
        entry["keyframeCount"] += len(curve["keyframes"])
    groups = sorted(group_index.values(), key=lambda g: g["name"])
    group_count = len(groups)

    # 3. Overall frame bounds across the selection (None when empty, which
    #    includes a selection of only zero-keyframe curves).
    if filtered:
        all_frames = [kp["frame"] for c in filtered for kp in c["keyframes"]]
        selection_frame_start = min(all_frames) if all_frames else None
        selection_frame_end = max(all_frames) if all_frames else None
    else:
        selection_frame_start = None
        selection_frame_end = None

    # 4. Count-budget check. keyframes are emitted only when the whole selection
    #    fits every count budget; otherwise every keyframes list is dropped and
    #    the per-curve summaries remain.
    fits_keyframes = total_keyframes <= MAX_KEYFRAMES
    fits_curves = curve_count <= MAX_CURVES
    fits_groups = group_count <= MAX_GROUPS
    fits_all = fits_keyframes and fits_curves and fits_groups

    reasons = []
    if not fits_keyframes:
        reasons.append(
            f"keyframe budget exceeded ({total_keyframes} > {MAX_KEYFRAMES})"
        )
    if not fits_curves:
        reasons.append(f"curve budget exceeded ({curve_count} > {MAX_CURVES})")
    if not fits_groups:
        reasons.append(f"group budget exceeded ({group_count} > {MAX_GROUPS})")

    # curves/groups withheld by the count caps (truthful base before the byte
    # budget runs).
    cap_curves_omitted = max(0, curve_count - MAX_CURVES)
    cap_groups_omitted = max(0, group_count - MAX_GROUPS)
    # When the selection does not fit, every keyframes list is withheld, so the
    # full selection's keyframes are omitted from the response.
    cap_keyframes_omitted = 0 if fits_all else total_keyframes

    # 5. Build the animation rows. Cap at MAX_CURVES (sorted); drop keyframes
    #    lists unless the whole selection fits.
    rows = []
    for curve in filtered[:MAX_CURVES]:
        summary = _curve_summary(curve)
        entry = {
            "source": curve["source"],
            "dataPath": curve["dataPath"],
            "arrayIndex": curve["arrayIndex"],
            "keyframeCount": summary["keyframeCount"],
            "frameStart": summary["frameStart"],
            "frameEnd": summary["frameEnd"],
            "valueMin": summary["valueMin"],
            "valueMax": summary["valueMax"],
            "interpolations": summary["interpolations"],
        }
        if fits_all:
            entry["keyframes"] = curve["keyframes"]
        rows.append(entry)

    groups_list = groups[:MAX_GROUPS]

    summary = {
        "curveCount": curve_count,
        "keyframeCount": total_keyframes,
        "frameStart": selection_frame_start,
        "frameEnd": selection_frame_end,
        "groupCount": group_count,
        "groups": groups_list,
        "truncated": None,  # filled in after the byte budget below
    }

    # 6. Serialized-byte ceiling. The count caps bound the shape, not the size:
    #    200 curves with 1000-character data paths still serialize past 32 KB.
    #    Measure the *complete* payload -- including the final ``truncated``
    #    object, whose reason text carries the drop counts -- and, while it
    #    exceeds the ceiling, deterministically drop trailing curve rows (then
    #    trailing group rows) until it fits. Reduction is by row removal only --
    #    no field value is mangled -- and every dropped row is counted so the
    #    caller can re-narrow. Iterating against the final payload (not a
    #    truncated-less stub) is what keeps the result under the ceiling instead
    #    of off-by-the-truncated-object-size.
    byte_curves_dropped = 0
    byte_keyframes_dropped = 0
    byte_groups_dropped = 0

    def _build_truncated():
        curves_omitted = cap_curves_omitted + byte_curves_dropped
        groups_omitted = cap_groups_omitted + byte_groups_dropped
        keyframes_omitted = cap_keyframes_omitted + byte_keyframes_dropped
        these_reasons = list(reasons)
        if byte_curves_dropped > 0 or byte_groups_dropped > 0:
            these_reasons.append(
                f"animation byte budget exceeded ({MAX_ANIMATION_BYTES} bytes); "
                f"dropped {byte_curves_dropped} curve rows and "
                f"{byte_groups_dropped} group rows"
            )
        if not these_reasons:
            return None, curves_omitted, groups_omitted, keyframes_omitted
        return (
            {
                "reason": "; ".join(these_reasons),
                "curvesOmitted": curves_omitted,
                "groupsOmitted": groups_omitted,
                "keyframesOmitted": keyframes_omitted,
                "hint": (
                    "Narrow with data_path_filter, frame_start, or frame_end "
                    "to get exact keyframes."
                ),
            },
            curves_omitted,
            groups_omitted,
            keyframes_omitted,
        )

    def _full_size():
        # Measure the projection the caller actually returns
        # (manifest._entity_detail publishes the summary under
        # "animationSummary", nine characters longer than "summary"), encoded as
        # UTF-8 bytes -- a name with non-ASCII characters costs more bytes than
        # it does characters, and the ceiling is a byte ceiling.
        truncated, _, _, _ = _build_truncated()
        summary["truncated"] = truncated
        return _js_json_size({"animations": rows, "animationSummary": summary})

    # Drop trailing curve rows first, then trailing group rows, re-measuring
    # against the full payload each iteration so the truncated object's own
    # bytes are accounted for.
    while rows and _full_size() > MAX_ANIMATION_BYTES:
        dropped = rows.pop()
        byte_curves_dropped += 1
        if "keyframes" in dropped:
            byte_keyframes_dropped += dropped["keyframeCount"]
    while groups_list and _full_size() > MAX_ANIMATION_BYTES:
        groups_list.pop()
        byte_groups_dropped += 1

    truncated, curves_omitted, groups_omitted, keyframes_omitted = _build_truncated()
    summary["truncated"] = truncated

    # Postcondition: with both lists exhausted the payload is a fixed-size
    # metadata object, so this cannot loop or return something unbounded. Assert
    # it rather than trusting the loops, because the whole point of this module
    # is that an oversized response destroys the model conversation.
    final_size = _js_json_size({"animations": rows, "animationSummary": summary})
    if final_size > MAX_ANIMATION_BYTES:
        raise AnimationBudgetError(
            f"animation payload is {final_size} bytes after full reduction, "
            f"over the {MAX_ANIMATION_BYTES} byte ceiling"
        )

    return {"animations": rows, "summary": summary}


def fit_result_to_budget(result, *, budget=MAX_RESULT_BYTES):
    """Trim one inspect_entity result envelope under a serialized-byte budget.

    The per-section caps bound each section's shape, but ``scope="all"`` returns
    bones plus materials plus animation, and only animation has narrowing
    params. The extension bridge refuses an oversized result outright, so the
    add-on must guarantee the size itself -- otherwise a legitimate response is
    thrown away after the work is done and the model has no way to inspect that
    entity at all.

    The budget covers the WHOLE envelope (``revision``, ``entity_id``,
    ``scope``, ``detail``), because that is exactly what the bridge measures;
    budgeting only ``detail`` leaves a few hundred bytes of envelope that can
    push an accepted payload over the bridge's identical ceiling.

    Trimming is deterministic and runs from the trailing end of the least
    navigable sections first (bones, then materials, then animation rows, which
    the caller can still recover with ``data_path_filter``), recording the
    omission counts each section already publishes.
    """
    detail = result.get("detail")
    if not isinstance(detail, dict):
        return result
    order = (("bones", "bonesOmitted"), ("materials", "materialsOmitted"))

    def size():
        return _js_json_size(result)

    for key, omitted_key in order:
        rows = detail.get(key)
        while isinstance(rows, list) and rows and size() > budget:
            rows.pop()
            detail[omitted_key] = detail.get(omitted_key, 0) + 1
    animations = detail.get("animations")
    summary = detail.get("animationSummary")
    while isinstance(animations, list) and animations and size() > budget:
        dropped = animations.pop()
        if isinstance(summary, dict):
            truncated = summary.get("truncated")
            if truncated is None:
                truncated = {
                    "reason": "",
                    "curvesOmitted": 0,
                    "groupsOmitted": 0,
                    "keyframesOmitted": 0,
                    "hint": (
                        "Narrow with data_path_filter, frame_start, or frame_end "
                        "to get exact keyframes."
                    ),
                }
                summary["truncated"] = truncated
            truncated["curvesOmitted"] += 1
            truncated["keyframesOmitted"] += dropped.get("keyframeCount", 0) if "keyframes" in dropped else 0
            reason = f"entity detail byte budget exceeded ({budget} bytes)"
            if reason not in truncated["reason"]:
                truncated["reason"] = (
                    f"{truncated['reason']}; {reason}" if truncated["reason"] else reason
                )
    final = size()
    if final > budget:
        # Every trimmable row is gone and the envelope is still oversized. The
        # remaining payload is a fixed set of scalar object metadata, so this is
        # unreachable for a real entity; fail loudly rather than hand the bridge
        # a result it will refuse.
        raise AnimationBudgetError(
            f"inspect_entity result is {final} bytes after full reduction, "
            f"over the {budget} byte ceiling"
        )
    return result
