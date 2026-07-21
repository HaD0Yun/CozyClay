from __future__ import annotations

import json
import pathlib
import re
import sys

import bpy

REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

from oh_my_blender.manifest import extract_scene_manifest_v2
from oh_my_blender.stage_scene import (
    StageSceneError,
    _derived_child_entity_id,
    apply_stage_scene_transaction,
)

PROJECT_ID = "00000000-0000-4000-8000-00000000000a"
YBOT_ID = "11111111-1111-4111-8111-111111111111"
XBOT_ID = "22222222-2222-4222-8222-222222222222"
DUPE_ID = "33333333-3333-4333-8333-333333333333"
UUID4 = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)


class FakeConnection:
    def __init__(self):
        self.active_checkpoint = None
        self.recovery = None

    def hold_checkpoint(self, checkpoint, recovery_fn=None):
        if self.active_checkpoint is not None:
            raise RuntimeError("checkpoint already held")
        self.active_checkpoint = checkpoint
        self.recovery = recovery_fn

    def release_checkpoint(self):
        value = self.active_checkpoint
        self.active_checkpoint = None
        self.recovery = None
        return value

    def ensure_mutation_connection(self, _phase):
        return None

    def require_recovery(self):
        raise AssertionError("fixture rollback must not require recovery")


def character(entity_id, character_type, name, location):
    return {
        "op": "add_character",
        "entity_id": entity_id,
        "character_type": character_type,
        "name": name,
        "location": list(location),
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
    }


def main():
    for scene_object in list(bpy.data.objects):
        bpy.data.objects.remove(scene_object, do_unlink=True)
    bpy.context.scene["omb.project_id"] = PROJECT_ID
    connection = FakeConnection()
    base = extract_scene_manifest_v2()
    committed = []
    result = apply_stage_scene_transaction(
        {
            "schema_version": 1,
            "expected_revision_id": base["revisionId"],
            "operations": [
                character(YBOT_ID, "Y_BOT", "Fighter One", (1, 0, 0)),
                character(XBOT_ID, "X_BOT", "Fighter Two", (-1, 0, 0)),
            ],
        },
        base["sceneHash"],
        connection,
        committed.append,
    )

    ybot = next(o for o in bpy.data.objects if o.get("omb.entity_id") == YBOT_ID)
    xbot = next(o for o in bpy.data.objects if o.get("omb.entity_id") == XBOT_ID)
    ybot_children = [o for o in bpy.data.objects if o.parent is ybot]
    manifest = result["manifest"]
    manifest_types = {o["entityId"]: o["type"] for o in manifest["objects"]}

    results = {
        "rootsAreArmatures": ybot.type == "ARMATURE" and xbot.type == "ARMATURE",
        "rootNames": [ybot.name, xbot.name] == ["Fighter One", "Fighter Two"],
        "rootLocation": tuple(round(v, 6) for v in ybot.location) == (1.0, 0.0, 0.0),
        "importScalePreserved": all(abs(s - 0.01) < 1e-6 for s in ybot.scale),
        "characterTypeTagged": ybot["omb.character_type"] == "Y_BOT"
        and xbot["omb.character_type"] == "X_BOT",
        "childrenExist": len(ybot_children) >= 2,
        "childrenOwned": all(
            o.get("omb.owned_project_id") == PROJECT_ID
            and isinstance(o.get("omb.entity_id"), str)
            and UUID4.fullmatch(o["omb.entity_id"]) is not None
            for o in ybot_children
        ),
        "childIdsDeterministic": all(
            o["omb.entity_id"]
            == _derived_child_entity_id(YBOT_ID, o.name.removeprefix("Fighter One "))
            for o in ybot_children
        ),
        "manifestHasArmatures": manifest_types.get(YBOT_ID) == "ARMATURE"
        and manifest_types.get(XBOT_ID) == "ARMATURE",
        "manifestBonesPopulated": len(manifest.get("bones", [])) > 0,
        "committed": len(committed) == 1,
        "identityCoversCharacters": [
            identity["entity_id"] for identity in result["entity_identities"]
        ] == [YBOT_ID, XBOT_ID],
        "checkpointReleased": connection.active_checkpoint is None,
    }

    object_count = len(bpy.data.objects)
    dupe_code = None
    try:
        apply_stage_scene_transaction(
            {
                "schema_version": 1,
                "expected_revision_id": result["manifest"]["revisionId"],
                "operations": [
                    character(DUPE_ID, "Y_BOT", "Fighter One", (0, 0, 0)),
                ],
            },
            result["scene_hash"],
            connection,
            committed.append,
        )
    except StageSceneError as error:
        dupe_code = getattr(error, "code", None)
    results["dupeNameCode"] = dupe_code
    results["dupeRollback"] = len(bpy.data.objects) == object_count
    results["dupeCheckpointReleased"] = connection.active_checkpoint is None

    print("OMB_STAGE_CHARACTER_RESULTS=" + json.dumps(results))


main()
