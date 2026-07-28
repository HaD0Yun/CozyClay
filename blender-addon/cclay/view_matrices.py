"""Pure, bpy-free view-matrix synthesis for multi-angle viewport capture.

The director's visual QA needs several purposeful angles of a named subject in
one call, without moving the camera, the viewport, or any object. Blender's
``GPUOffScreen.draw_view3d`` accepts the view and window matrices as explicit
arguments, so synthesizing them yields any angle with no scene mutation. This
module holds the geometry that picks those angles and builds the matrices, kept
bpy-free so it is unit-testable with plain CPython; ``viewport_capture`` is the
single Blender-facing consumer.

Matrices are returned as 4x4 row-major tuples, which ``mathutils.Matrix``
accepts directly (``Matrix(rows)``). The view matrix is the world-to-view
transform (the inverse of the camera world transform); the window matrix is a
standard OpenGL perspective projection.
"""

from __future__ import annotations

import math

# Named views the capture surface serves. Each entry maps a view name to a
# builder that, given the subject's world AABB and a framing margin, returns
# (eye, target, up, fov_y_radians). The eye and target are world-space points;
# the distance is derived from the bounds so a 0.02 m prop and a 1.8 m character
# both frame with the same margin and no hardcoded distance.
DEFAULT_VIEWS = ("three_quarter", "side", "contact_low")
ALL_VIEW_NAMES = ("three_quarter", "front", "side", "top", "contact_low")
# Cap the number of views per call. Five named views cover every relation the
# visual-qa skill requires (establishing, depth, contact gap, top, front); more
# than that is redundant at the ~0.6 MP capture budget and burns vision tokens
# for no new evidence. Each image costs roughly w*h/750 tokens (~786 at the
# 1024x576-equivalent budget), so eight views is ~6.3k tokens per call, a
# deliberate ceiling for a fast iterative QA path.
MAX_VIEWS = 8
# Capture aspect is chosen per view but the pixel budget stays the old
# 1024x576 area, so a portrait or square view costs the same as a wide one.
MIN_VIEW_ASPECT = 9.0 / 16.0
MAX_VIEW_ASPECT = 16.0 / 9.0
DEFAULT_VIEW_ASPECT = MAX_VIEW_ASPECT
# Vertical field of view for the synthesized perspective. Matches the default
# Blender viewport lens (50 mm on a 36 mm sensor ~ 39.6 degrees); wide enough to
# frame a subject at a short distance without a fisheye look.
DEFAULT_FOV_Y = math.radians(39.6)
# Small framing margin so the subject never kisses the image edge.
FRAMING_MARGIN = 0.15
# contact_low lifts the eye just above the support plane so the grazing line of
# sight reveals the contact/support gap without clipping into the ground.
CONTACT_LOW_EYE_HEIGHT = 0.02


class ViewMatrixError(ValueError):
    """A multi-angle view request cannot be satisfied."""


def _normalize(vector: tuple[float, float, float]) -> tuple[float, float, float]:
    x, y, z = vector
    length = math.sqrt(x * x + y * y + z * z)
    if length < 1e-12:
        raise ViewMatrixError(f"cannot normalize a zero-length direction: {vector}")
    return (x / length, y / length, z / length)


def _cross(a: tuple[float, float, float], b: tuple[float, float, float]) -> tuple[float, float, float]:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def _subtract(a: tuple[float, float, float], b: tuple[float, float, float]) -> tuple[float, float, float]:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _add(a: tuple[float, float, float], b: tuple[float, float, float]) -> tuple[float, float, float]:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def _scale(a: tuple[float, float, float], s: float) -> tuple[float, float, float]:
    return (a[0] * s, a[1] * s, a[2] * s)


def aabb_center(minimum: tuple[float, float, float], maximum: tuple[float, float, float]) -> tuple[float, float, float]:
    return (
        (minimum[0] + maximum[0]) / 2.0,
        (minimum[1] + maximum[1]) / 2.0,
        (minimum[2] + maximum[2]) / 2.0,
    )


def aabb_half_extent(minimum: tuple[float, float, float], maximum: tuple[float, float, float]) -> tuple[float, float, float]:
    return (
        (maximum[0] - minimum[0]) / 2.0,
        (maximum[1] - minimum[1]) / 2.0,
        (maximum[2] - minimum[2]) / 2.0,
    )


def bounding_radius(minimum: tuple[float, float, float], maximum: tuple[float, float, float]) -> float:
    """Half the AABB diagonal: the smallest sphere enclosing the subject."""
    half = aabb_half_extent(minimum, maximum)
    return math.sqrt(half[0] ** 2 + half[1] ** 2 + half[2] ** 2)


def clamp_view_aspect(aspect: float) -> float:
    """Keep a capture aspect inside the useful portrait-to-wide band."""
    if not math.isfinite(aspect) or aspect <= 0.0:
        return DEFAULT_VIEW_ASPECT
    return min(MAX_VIEW_ASPECT, max(MIN_VIEW_ASPECT, aspect))


def suggested_view_aspect(
    name: str,
    minimum: tuple[float, float, float],
    maximum: tuple[float, float, float],
) -> float:
    """Pick the aspect that wastes the fewest pixels for one named view.

    The capture budget is a fixed area, so choosing an aspect is free: a tall
    character reads better in 9:16, a top view reads better matching its XY
    footprint, and contact_low stays wide because a support gap is a horizontal
    feature. Anything degenerate falls back to the old 16:9.
    """
    half = aabb_half_extent(minimum, maximum)
    if name == "top":
        if half[1] <= 1e-9:
            return DEFAULT_VIEW_ASPECT
        return clamp_view_aspect(half[0] / half[1])
    if name == "contact_low":
        return DEFAULT_VIEW_ASPECT
    horizontal = math.sqrt(half[0] ** 2 + half[1] ** 2)
    if half[2] > max(horizontal * 1.15, 1e-9):
        return MIN_VIEW_ASPECT
    return DEFAULT_VIEW_ASPECT


def framing_distance(bounds_radius: float, fov_y: float, margin: float = FRAMING_MARGIN) -> float:
    """Eye-to-target distance that frames a bounding sphere with a margin.

    Derived from the vertical field of view, not a hardcoded constant, so a
    0.02 m prop and a 1.8 m character both fit with the same margin. The sphere
    fits when ``tan(fov_y/2) >= radius / distance``; the margin pushes the eye
    back so the subject never touches the frame edge.
    """
    if bounds_radius <= 0.0:
        raise ViewMatrixError(f"subject bounding radius must be positive, got {bounds_radius}")
    if not (0.0 < fov_y < math.pi):
        raise ViewMatrixError(f"fov_y must be in (0, pi), got {fov_y}")
    return (bounds_radius / math.tan(fov_y / 2.0)) * (1.0 + margin)


def look_at_view_matrix(
    eye: tuple[float, float, float],
    target: tuple[float, float, float],
    up: tuple[float, float, float],
) -> tuple[tuple[float, float, float, float], ...]:
    """Build a world-to-view (``region_3d.view_matrix``) 4x4 from a look-at.

    Blender's view space looks down -Z with +Y up, matching ``region_3d``. The
    returned matrix is the inverse of the camera world transform, i.e. the
    matrix that maps world points into view space.
    """
    forward = _normalize(_subtract(target, eye))
    right = _normalize(_cross(forward, up))
    true_up = _normalize(_cross(right, forward))
    # Camera local axes in world: +X -> right, +Y -> true_up, +Z -> -forward
    # (camera looks down -Z). The view matrix is the inverse of that world
    # transform: rotation transposed, translation negated and rotated back, so
    # each row is one camera axis followed by minus its dot with the eye.
    rx, ry, rz = right
    ux, uy, uz = true_up
    bx, by, bz = (-forward[0], -forward[1], -forward[2])
    ex, ey, ez = eye
    return (
        (rx, ry, rz, -(rx * ex + ry * ey + rz * ez)),
        (ux, uy, uz, -(ux * ex + uy * ey + uz * ez)),
        (bx, by, bz, -(bx * ex + by * ey + bz * ez)),
        (0.0, 0.0, 0.0, 1.0),
    )


def perspective_window_matrix(
    fov_y: float,
    aspect: float,
    near: float,
    far: float,
) -> tuple[tuple[float, float, float, float], ...]:
    """Build a perspective ``region_3d.window_matrix`` (OpenGL convention)."""
    if not (0.0 < fov_y < math.pi):
        raise ViewMatrixError(f"fov_y must be in (0, pi), got {fov_y}")
    if aspect <= 0.0:
        raise ViewMatrixError(f"aspect must be positive, got {aspect}")
    if not (0.0 < near < far):
        raise ViewMatrixError(f"requires 0 < near < far, got near={near} far={far}")
    f = 1.0 / math.tan(fov_y / 2.0)
    return (
        (f / aspect, 0.0, 0.0, 0.0),
        (0.0, f, 0.0, 0.0),
        (0.0, 0.0, (far + near) / (near - far), (2.0 * far * near) / (near - far)),
        (0.0, 0.0, -1.0, 0.0),
    )


def _three_quarter(minimum, maximum, margin):
    center = aabb_center(minimum, maximum)
    radius = bounding_radius(minimum, maximum)
    distance = framing_distance(radius, DEFAULT_FOV_Y, margin)
    # Front-right-above establishing view: reveals three faces and depth.
    direction = _normalize((1.0, -1.0, 0.55))
    eye = _add(center, _scale(direction, distance))
    return eye, center, (0.0, 0.0, 1.0), DEFAULT_FOV_Y


def _front(minimum, maximum, margin):
    center = aabb_center(minimum, maximum)
    radius = bounding_radius(minimum, maximum)
    distance = framing_distance(radius, DEFAULT_FOV_Y, margin)
    eye = _add(center, (0.0, -distance, 0.0))
    return eye, center, (0.0, 0.0, 1.0), DEFAULT_FOV_Y


def _side(minimum, maximum, margin):
    center = aabb_center(minimum, maximum)
    radius = bounding_radius(minimum, maximum)
    distance = framing_distance(radius, DEFAULT_FOV_Y, margin)
    eye = _add(center, (distance, 0.0, 0.0))
    return eye, center, (0.0, 0.0, 1.0), DEFAULT_FOV_Y


def _top(minimum, maximum, margin):
    center = aabb_center(minimum, maximum)
    radius = bounding_radius(minimum, maximum)
    distance = framing_distance(radius, DEFAULT_FOV_Y, margin)
    eye = _add(center, (0.0, 0.0, distance))
    # Looking straight down: world +Y is screen-up so front faces the viewer.
    return eye, center, (0.0, 1.0, 0.0), DEFAULT_FOV_Y


def _contact_low(minimum, maximum, margin):
    # The reason this view exists: a near-ground grazing line of sight aimed at
    # the subject's BASE is the only angle where a support gap or penetration
    # reads. Target the base centre, not the AABB centre, so the eye stays level
    # with the contact plane instead of tilting up toward the body centre.
    base_center = (
        (minimum[0] + maximum[0]) / 2.0,
        (minimum[1] + maximum[1]) / 2.0,
        minimum[2],
    )
    half = aabb_half_extent(minimum, maximum)
    # Frame the footprint, not the full height: the gap is a horizontal feature,
    # so use the horizontal half-extent (plus a little vertical headroom for the
    # near-ground eye) to set the distance.
    footprint_radius = math.sqrt(half[0] ** 2 + half[1] ** 2)
    frame_radius = max(footprint_radius, half[2] * 0.5)
    if frame_radius <= 0.0:
        raise ViewMatrixError("contact_low requires a non-degenerate subject footprint")
    distance = framing_distance(frame_radius, DEFAULT_FOV_Y, margin)
    # Eye hovers just above the support plane, offset along -Y so the gaze is
    # horizontal toward the base. A grazing angle, not a worm's-eye tilt.
    eye = (base_center[0], base_center[1] - distance, base_center[2] + CONTACT_LOW_EYE_HEIGHT)
    return eye, base_center, (0.0, 0.0, 1.0), DEFAULT_FOV_Y


_VIEW_BUILDERS = {
    "three_quarter": _three_quarter,
    "front": _front,
    "side": _side,
    "top": _top,
    "contact_low": _contact_low,
}


def resolve_views(requested: list[str] | None, subject_given: bool) -> list[str]:
    """Validate and resolve the view-name list, applying the default set."""
    if not subject_given:
        # No subject: the caller wants the human's viewport, not named views.
        return []
    if requested is None:
        # Default set when a subject is given but views are omitted: an
        # establishing three-quarter, a side that reveals depth, and contact_low.
        # The visual-qa skill requires at least two views including one that
        # reveals the contact/support gap before approving a support/contact/
        # seat/lean/grasp relation; this trio satisfies that with no redundant
        # angles. Adding front/top is available on request but not the default,
        # because they rarely show a contact gap that contact_low does not.
        return list(DEFAULT_VIEWS)
    if not isinstance(requested, list):
        raise ViewMatrixError(f"views must be a list of strings, got {type(requested).__name__}")
    # Bound the cost before validating names: a too-long list is rejected on the
    # cap regardless of whether it also repeats names. Each image costs ~786
    # vision tokens at the fixed 1024x576-equivalent area, so MAX_VIEWS is the
    # per-call budget ceiling.
    if len(requested) > MAX_VIEWS:
        raise ViewMatrixError(
            f"requested {len(requested)} views but the cap is {MAX_VIEWS}; "
            "each image costs ~786 vision tokens at the 1024x576-equivalent budget"
        )
    resolved: list[str] = []
    seen: set[str] = set()
    for entry in requested:
        if not isinstance(entry, str) or not entry:
            raise ViewMatrixError(f"each view name must be a non-empty string, got {entry!r}")
        if entry not in _VIEW_BUILDERS:
            raise ViewMatrixError(
                f"unknown view name {entry!r}; expected one of {sorted(_VIEW_BUILDERS)}"
            )
        if entry in seen:
            raise ViewMatrixError(f"duplicate view name {entry!r}; each view must be distinct")
        seen.add(entry)
        resolved.append(entry)
    return resolved


def build_view(
    name: str,
    minimum: tuple[float, float, float],
    maximum: tuple[float, float, float],
    aspect: float,
    margin: float = FRAMING_MARGIN,
) -> dict:
    """Build one named view: eye, target, view matrix, and window matrix."""
    if name not in _VIEW_BUILDERS:
        raise ViewMatrixError(
            f"unknown view name {name!r}; expected one of {sorted(_VIEW_BUILDERS)}"
        )
    eye, target, up, fov_y = _VIEW_BUILDERS[name](minimum, maximum, margin)
    view_matrix = look_at_view_matrix(eye, target, up)
    # Near/far derived from the subject bounds so the subject always lies in the
    # frustum regardless of its size; far gives the ground/context room behind.
    radius = bounding_radius(minimum, maximum)
    near = max(0.01, radius * 0.05)
    far = max(near * 2.0, radius * 12.0 + 10.0)
    window_matrix = perspective_window_matrix(fov_y, aspect, near, far)
    return {
        "name": name,
        "eye": eye,
        "target": target,
        "up": up,
        "fov_y": fov_y,
        "view_matrix": view_matrix,
        "window_matrix": window_matrix,
    }


def build_views(
    names: list[str],
    minimum: tuple[float, float, float],
    maximum: tuple[float, float, float],
    aspect: float,
    margin: float = FRAMING_MARGIN,
) -> list[dict]:
    """Build every named view for a subject AABB, preserving request order."""
    return [build_view(name, minimum, maximum, aspect, margin) for name in names]
