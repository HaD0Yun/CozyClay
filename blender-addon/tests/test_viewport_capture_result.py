"""Wire-shape tests for the capture_viewport bridge result.

A view that reaches the model without a mime type or image data is not a
cosmetic defect: the TypeScript tool turns every view into an image content
block, and `data:undefined;base64,undefined` makes the model API reject every
later request in that session. The conversation cannot recover, so the add-on
must fail the call instead of returning such a view.
"""

import pathlib
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))

from cclay import viewport_capture as viewport_capture_module
from cclay.connection import Connection, ConnectionError

REVISION = "a" * 64
# Sentinel so a test can pass params=None deliberately: the bridge always sends
# an object, and a missing params value is protocol skew the add-on refuses.
_UNSET = object()


def _view(name="viewport", **overrides):
    view = {
        "name": name,
        "mime_type": "image/jpeg",
        "data_base64": "/9j/4AAQSkZJRg==",
        "width": 1024,
        "height": 576,
        "method": "offscreen",
    }
    view.update(overrides)
    return view


def _capture(revision=REVISION, params=_UNSET, views=None, capture=None):
    if capture is None:
        captured = {"views": list(views if views is not None else [_view()])}

        def capture(subject=None, views=None, project_id=None):
            return captured

    request = {} if params is _UNSET else params
    with mock.patch.object(viewport_capture_module, "capture_viewport", capture):
        return Connection._capture_viewport_result(None, revision, request)


class CaptureViewportResultTests(unittest.TestCase):
    def test_result_has_exactly_revision_and_views(self):
        result = _capture()
        self.assertEqual(set(result), {"revision", "views"})
        self.assertEqual(result["revision"], REVISION)
        self.assertEqual(len(result["views"]), 1)

    def test_every_view_carries_the_six_contract_keys(self):
        result = _capture(views=[_view("three_quarter"), _view("side")])
        for view in result["views"]:
            self.assertEqual(set(view), set(viewport_capture_module.VIEWPORT_VIEW_KEYS))
            self.assertTrue(view["mime_type"])
            self.assertTrue(view["data_base64"])

    def test_view_missing_a_contract_key_is_refused(self):
        broken = _view()
        del broken["mime_type"]
        with self.assertRaises(ConnectionError) as raised:
            _capture(views=[broken])
        self.assertIn("INVALID_CAPTURE_VIEWPORT_RESULT", str(raised.exception))

    def test_view_with_an_extra_key_is_refused(self):
        with self.assertRaises(ConnectionError) as raised:
            _capture(views=[_view(subject="e1")])
        self.assertIn("INVALID_CAPTURE_VIEWPORT_RESULT", str(raised.exception))

    def test_view_without_image_data_is_refused(self):
        for field in ("mime_type", "data_base64"):
            with self.subTest(field=field):
                with self.assertRaises(ConnectionError) as raised:
                    _capture(views=[_view(**{field: ""})])
                self.assertIn("carries no image data", str(raised.exception))

    def test_none_params_are_accepted_and_forwarded(self):
        seen = {}

        def capture(subject=None, views=None, project_id=None):
            seen.update(subject=subject, views=views, project_id=project_id)
            return {"views": [_view()]}

        _capture(
            params={"subject": None, "views": None, "project_id": None},
            capture=capture,
        )
        self.assertEqual(seen, {"subject": None, "views": None, "project_id": None})

    def test_params_are_forwarded_verbatim(self):
        seen = {}

        def capture(subject=None, views=None, project_id=None):
            seen.update(subject=subject, views=views, project_id=project_id)
            return {"views": [_view("three_quarter"), _view("side")]}

        result = _capture(
            params={
                "subject": "8bd1a3a4-1c0f-4a5e-9c2e-3b6f7c9d0e1f",
                "views": ["three_quarter", "side"],
                "project_id": "project-1",
            },
            capture=capture,
        )
        self.assertEqual(seen["subject"], "8bd1a3a4-1c0f-4a5e-9c2e-3b6f7c9d0e1f")
        self.assertEqual(seen["views"], ["three_quarter", "side"])
        self.assertEqual(seen["project_id"], "project-1")
        self.assertEqual([view["name"] for view in result["views"]], ["three_quarter", "side"])

    def test_non_dict_params_are_refused_rather_than_coerced(self):
        # Coercing a malformed frame to an empty request would turn protocol
        # skew into a default-shaped success.
        for params in ("subject", 7, ["views"], None):
            with self.subTest(params=params):
                with self.assertRaises(ConnectionError) as raised:
                    _capture(params=params)
                self.assertIn("params must be an object", str(raised.exception))

    def test_non_string_subject_is_refused(self):
        with self.assertRaises(ConnectionError) as raised:
            _capture(params={"subject": 7})
        self.assertIn("INVALID_CAPTURE_VIEWPORT_PARAMS", str(raised.exception))

    def test_non_list_views_is_refused(self):
        with self.assertRaises(ConnectionError) as raised:
            _capture(params={"views": "three_quarter"})
        self.assertIn("INVALID_CAPTURE_VIEWPORT_PARAMS", str(raised.exception))

    def test_non_string_view_name_is_refused(self):
        with self.assertRaises(ConnectionError) as raised:
            _capture(params={"views": ["side", 3]})
        self.assertIn("every view name must be a string", str(raised.exception))

    def test_unknown_param_is_refused(self):
        with self.assertRaises(ConnectionError) as raised:
            _capture(params={"subject": None, "views": None, "project_id": None, "quality": 90})
        self.assertIn("unknown params ['quality']", str(raised.exception))

    def test_views_without_a_subject_are_refused(self):
        # The no-subject capture is the human's live viewport: it cannot honour
        # named views, and silently ignoring them returns the wrong image.
        with self.assertRaises(ConnectionError) as raised:
            _capture(params={"subject": None, "views": ["side"], "project_id": None})
        self.assertIn("named views require a subject", str(raised.exception))

    def test_non_string_project_id_is_refused(self):
        with self.assertRaises(ConnectionError) as raised:
            _capture(params={"project_id": 12})
        self.assertIn("project_id must be a string", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
