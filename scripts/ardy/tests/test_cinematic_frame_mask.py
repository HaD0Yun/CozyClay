import math

from scripts.interactive_demo.cinematic_frame_mask import compute_frame_mask_layout, make_frame_mask_image


def test_wide_viewport_masks_left_and_right() -> None:
    layout = compute_frame_mask_layout(
        canvas_aspect=2.0,
        output_aspect=16 / 9,
        vertical_fov_radians=math.radians(60.0),
        distance=0.02,
    )

    assert len(layout.bars) == 2
    assert layout.bars[0].center_x < 0.0 < layout.bars[1].center_x
    assert layout.bars[0].center_y == layout.bars[1].center_y == 0.0
    assert layout.bars[0].height == layout.viewport_height


def test_tall_viewport_masks_top_and_bottom() -> None:
    layout = compute_frame_mask_layout(
        canvas_aspect=1.0,
        output_aspect=16 / 9,
        vertical_fov_radians=math.radians(60.0),
        distance=0.02,
    )

    assert len(layout.bars) == 2
    assert layout.bars[0].center_y < 0.0 < layout.bars[1].center_y
    assert layout.bars[0].center_x == layout.bars[1].center_x == 0.0
    assert layout.bars[0].width == layout.viewport_width


def test_matching_aspect_needs_no_mask() -> None:
    layout = compute_frame_mask_layout(
        canvas_aspect=16 / 9,
        output_aspect=16 / 9,
        vertical_fov_radians=math.radians(60.0),
        distance=0.02,
    )

    assert layout.bars == ()


def test_single_mask_image_keeps_center_transparent() -> None:
    image = make_frame_mask_image(canvas_aspect=2.0, output_aspect=16 / 9)

    assert image[256, 0, 3] == 255
    assert image[256, 256, 3] == 0
    assert image[256, -1, 3] == 255
