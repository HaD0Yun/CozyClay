from __future__ import annotations

import importlib
import json
import pathlib
import sys
import types
import unittest

ROOT = pathlib.Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))
import cclay
_inserted = []
for name, module in (("bpy", types.ModuleType("bpy")), ("mathutils", types.ModuleType("mathutils"))):
    if name not in sys.modules:
        if name == "mathutils":
            module.Quaternion = object
        sys.modules[name] = module
        _inserted.append(name)
try:
    manifest = importlib.import_module("cclay.manifest")
finally:
    for name in _inserted:
        sys.modules.pop(name, None)


class ExtensionsManifestTests(unittest.TestCase):
    def test_utf8_byte_ceiling_fixture_matches_typescript_boundary(self):
        fixture = json.loads((ROOT / "../packages/director-core/test/fixtures/extensions-byte-ceiling.json").read_text(encoding="utf-8"))
        extensions = fixture["extensions"]
        self.assertEqual(len(manifest.canonical_json(extensions).encode("utf-8")), 65536)
        manifest.validate_extensions(extensions)
        extensions["x-aa"] += "漢"
        with self.assertRaises(ValueError):
            manifest.validate_extensions(extensions)

    def test_opaque_namespaces_are_allowed_but_invalid_values_are_rejected(self):
        manifest.validate_extensions({"x-future-addon": {"unknown": [True, "value"]}})
        with self.assertRaises(ValueError):
            manifest.validate_extensions({"x-future-addon": "x" * 4097})
    def test_unpaired_surrogates_are_rejected_but_astral_extension_strings_are_accepted(self):
        with self.assertRaises(UnicodeEncodeError):
            manifest.validate_extensions({"x-newer-addon": {"value": "\ud800"}})
        with self.assertRaises(UnicodeEncodeError):
            manifest.validate_extensions({"x-newer-addon": {"value": "\udc00"}})

        astral = {"x-newer-addon": {"value": "😀"}}
        manifest.validate_extensions(astral)
        self.assertEqual(
            len(manifest.canonical_json(astral).encode("utf-8")),
            34,
        )

    def test_scene_root_property_round_trips_the_canonical_payload(self):
        scene = {}
        manifest.bpy.context = types.SimpleNamespace(scene=scene)
        extensions = {"x-future-addon": {"opaque": "漢"}}
        manifest.write_extensions(extensions)
        reopened_scene = {"cclay.extensions_json": scene["cclay.extensions_json"]}
        self.assertEqual(manifest._read_extensions(reopened_scene), extensions)

if __name__ == "__main__":
    unittest.main()
