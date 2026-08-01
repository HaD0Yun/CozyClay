# execute_blender_python real-Blender acceptance

## Prerequisites

- Run from the repository root on a workstation with a GUI-capable Blender executable.
- The checkout is built/installed as the add-on used by the live driver.
- No Blender instance is using `/tmp/cclay-e2e-artifacts`.
- `CCLAY_LIVE_ACCEPTANCE=1` is deliberate: the scenarios execute arbitrary Python in Blender.

## Run

```sh
rm -rf /tmp/cclay-e2e-artifacts
cd apps/cclay-extension
CCLAY_LIVE_ACCEPTANCE=1 node --import tsx --test test/live-acceptance.test.ts
```

## Happy-path checklist (S10)

Expected command result: subtest `S10 execute_blender_python commits one revision and exposes Unicode stdout` passes.

Inspect the generated evidence:

```sh
python3 -m json.tool /tmp/cclay-e2e-artifacts/results.json
python3 -m json.tool /tmp/cclay-e2e-artifacts/s10/execution-journal.json
python3 -m json.tool /tmp/cclay-e2e-artifacts/project-*/.cclay/project.json
```

Pass criteria:

- `results.json.S10.status` is `passed` and its `stdout` contains `S10 Unicode: ✓ 雪`.
- S10 reports distinct `base_revision` and `new_revision` values.
- `s10/execution-journal.json` has `status: "finalized"`, its base equals `base_revision`, and its new revision equals `new_revision`.
- The durable `.cclay/project.json.current_revision_id` equals S10's `new_revision`.
- `transcript.log` includes `S10 observe standalone execution mutation`; the assertion proves the in-Blender sidecar read `cclay.e2e_execute_happy = "mutated"`.

## Exception/reload checklist (S11)

Expected command result: subtest `S11 execute_blender_python exception reloads the backup and reconnects a fresh generation` passes.

Inspect the generated evidence:

```sh
python3 -m json.tool /tmp/cclay-e2e-artifacts/s11/execution-journal.json
python3 -m json.tool /tmp/cclay-e2e-artifacts/s11/endpoints.json
python3 -m json.tool /tmp/cclay-e2e-artifacts/results.json
```

Pass criteria:

- S11 reports `journal_status: "recovered"` and the exact `base_revision` is retained; no child revision is reported.
- `s11/execution-journal.json` has `status: "recovered"` and its base revision equals S11's base.
- `s11/endpoints.json.after.token_generation` is strictly greater than `before.token_generation`.
- `transcript.log` contains `get_execution_outcome S11`, `S11 confirm backup reload removed mutation`, and `S11 read after recovery`.
- `.cclay/project.json.current_revision_id` equals S11's base revision. The sidecar assertion proves `cclay.e2e_execute_failure` is absent after the backup reload.

## Warning, default, and opt-out checklist

1. Open the add-on panel in the same scratch project. Confirm the execute-Python warning is visible verbatim: `This lets the AI director run arbitrary Python in your live Blender session with no sandbox. Locked objects are not protected. External file, network, and process effects cannot be rolled back. Exceptions trigger full-.blend reload recovery.`
2. For a newly initialized project, confirm the Execute Blender Python control is enabled (default ON). Confirm `.cclay/project.json` has no `allowExecuteBlenderPython: false` opt-out.
3. Turn off the panel's Execute Blender Python control and save. Confirm `.cclay/project.json` contains `"allowExecuteBlenderPython": false`.
4. Attempt an execute-Python request. It must return `precondition_failed` with code `AUTH_INVALID`; it must not create a new execution journal or mutate the scene.
5. Turn the control back on, save, and confirm an execute request is again permitted.

## Signoff

- Run directory: ______________________________
- Blender version / add-on version: ______________________________
- S10 pass: [ ]  S11 pass: [ ]  warning/default/opt-out pass: [ ]
- Evidence reviewed by: ______________________________
- Date: ______________________________
- Overall: [ ] PASS  [ ] FAIL
