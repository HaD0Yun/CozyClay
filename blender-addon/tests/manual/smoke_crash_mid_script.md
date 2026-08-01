# execute_blender_python crash-mid-script real-Blender smoke

This procedure intentionally kills a real Blender process. Use only a disposable copy of a `.blend` and project directory. It verifies the conservative crash behavior, not rollback of arbitrary side effects.

## Prerequisites

- Start Blender with the CozyClay add-on enabled and save a disposable file under a disposable project directory, referred to below as `$PROJECT`.
- Confirm `$PROJECT/.cclay/project.json` and `$PROJECT/.cclay/bridge-endpoint.json` exist.
- Run this from the repository root. Keep a second terminal open for the kill command.

```sh
export PROJECT="/absolute/path/to/disposable/project"
export CCLAY_PROJECT_DIR="$PROJECT"
python3 -m json.tool "$PROJECT/.cclay/project.json"
python3 -m json.tool "$PROJECT/.cclay/bridge-endpoint.json"
```

Record the original `current_revision_id` as `BASE_REVISION` and the endpoint PID as `BLENDER_PID`.

## Start a deliberately long execution

In terminal A, run this request driver from the repository root. It sends a real bridge request that first changes scene state, then remains inside non-preemptible Python long enough to kill Blender.

```sh
node --import tsx --input-type=module <<'EOF'
import { BlenderBridge } from "./apps/cclay-extension/src/bridge.ts";
const project = process.env.CCLAY_PROJECT_DIR;
if (!project) throw new Error("CCLAY_PROJECT_DIR is required");
const bridge = new BlenderBridge(project);
await bridge.start();
await bridge.waitForAttach(AbortSignal.timeout(30_000));
const base = (await bridge.inspectProject()).revision;
console.log(JSON.stringify({ base_revision: base }));
console.log(await bridge.executeBlenderPython({
  script: 'import bpy, time\nbpy.context.scene["cclay.crash_mid_script"] = "written before kill"\ntime.sleep(60)',
  deadline_ms: 30_000,
  capture_stdout: true,
  expected_revision_id: base,
}));
EOF
```

Wait until the journal file exists and says `started` (do not wait for the 60-second script to complete):

```sh
find "$PROJECT/.cclay/execution-journal" -name '*.json' -maxdepth 1 -print
python3 -m json.tool "$PROJECT/.cclay/execution-journal"/*.json
```

## Kill Blender while Python is running

In terminal B, use the PID from the endpoint file. `SIGKILL` is intentional: it prevents normal recovery/finalization.

```sh
BLENDER_PID="$(python3 -c 'import json,os; print(json.load(open(os.environ["CCLAY_PROJECT_DIR"]+"/.cclay/bridge-endpoint.json"))["pid"])')"
kill -KILL "$BLENDER_PID"
wait
```

Expected immediately after the kill:

- Terminal A resolves or reports an `outcome_unknown`/disconnect result; it must not report a fabricated success or `failed_recovered`.
- The request journal remains `status: "started"` (not `finalized` or `recovered`).
- New mutation attempts are frozen/rejected with execution-recovery-required behavior until a human verifies the project state.
- The scene property written before the kill is **outcome unknown**. Do not infer rollback from the journal.

Capture evidence before restarting:

```sh
mkdir -p "$PROJECT/.cclay/manual-crash-evidence"
cp "$PROJECT/.cclay/execution-journal"/*.json "$PROJECT/.cclay/manual-crash-evidence/"
cp "$PROJECT/.cclay/project.json" "$PROJECT/.cclay/manual-crash-evidence/project-before-restart.json"
```

## Restart and inspect

1. Start Blender manually on the same disposable canonical `.blend`; do not submit another mutation first.
2. Inspect `$PROJECT/.cclay/execution-journal/*.json`, `$PROJECT/.cclay/project.json`, and Blender's visible scene state.
3. Record whether the process had saved the canonical file before death and whether `cclay.crash_mid_script` is present. This is inspection evidence only; it does not convert the original execution outcome to success.
4. Retain the journal as the authoritative crash record. Clear any mutation freeze only after a human has inspected the recovered/loaded scene and explicitly accepts its state.

## Required evidence and signoff

- Project path: ______________________________
- Base revision: ______________________________
- Request/journal ID: ______________________________
- Blender PID killed: ______________________________
- Journal before restart (`started`) captured: [ ]
- Driver result was `outcome_unknown`/disconnect, not success: [ ]
- Mutation freeze observed: [ ]
- Restart inspection recorded: [ ]
- `cclay.crash_mid_script` present after restart: [ ] yes [ ] no [ ] indeterminate
- Reviewer / date: ______________________________
- Overall: [ ] PASS  [ ] FAIL
- [x] This session's signed walkthrough is live acceptance S12; retain `s12/crash-evidence.json` and `s12/execution-journal-started.json` with the run artifacts.

Python execution is non-preemptible: a kill cannot safely interrupt or roll back Python at an arbitrary instruction. External side effects such as files, network calls, and spawned processes are not rolled back, even when normal exception recovery reloads the `.blend`.
