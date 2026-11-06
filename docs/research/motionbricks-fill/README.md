# MotionBricks fill: progress log

Status: **work in progress**. Layers 1 and 2 pass. Layer 3 needs human picks. Layer 4 is blocked.

This folder records the work on the native MotionBricks fill (`COZYCLAY_MB_MODE=native`, `src/motion3/bricks/fill-native*.js`,
`mcp/motionbricks/service.mjs`). It holds the measurements and the bench, so the work can continue from here.

## Goal and how it is measured

| Layer | Bar | Status |
|---|---|---|
| L1 no regression | the installed take is not worse than main's in any QA class, key miss, sync or jerk spikes | **OK**: 13/13 (bench 7 + real agent takes 6), `results/r22-set.json`, `results/r22-real.json` |
| L2 naturalness | motion-life metrics (`src/motion3/qa/motion-life.js`) better on some specs, worse on none | **OK**: door2 QA 518 -> 62, key miss 69.3 -> 4.5 cm, sync 1 -> 0.67; sit sync 1 -> 0 |
| L3 human preference | 70% or more pick the MotionBricks clip in a blind A/B | **OPEN**: 4 blind clips made, no picks yet |
| L4 real agent runs | completion and QA at or above main, 0 disconnects | **BLOCKED**: see below |

```
agent spec -> POST /agent/motion-fill -> fill worker -> generate gaps -> local / global / install checks -> motion.compile install
                                          (worker thread: hub ping stays free)        (each check: no class worse than the compiler's take)
```

## What changed (code)

| Change | Why (measured) |
|---|---|
| Fill keys only on channels the author keyed at both gap ends (`fill.js` `boundToGap`) | t2A2 QA 103 -> 39: a hand drifted 80 cm on a channel nobody keyed |
| 6-frame seam blend with the compiler's curve; foot-lock release over 4 frames; foot angle smoothing (`fill-native-core.js`) | gait acceleration seams 12 -> 9; t2B3 clean gaps 2 -> 4 |
| Gaps generated independently from the base compile; subset search (<= 6 gaps) or greedy removal | lets any subset of gaps stay |
| Local, global and install checks (`fill-native.js` `worseKinds`, `globalWorse`, install check through repair) | without them: door2 overlap 0 -> 151, rules2 overlap 0 -> 312 |
| Install check against the agent's own keys; with no fill key kept, the keys go back as sent | pass-through keys alone made real take t2A3 QA 20 -> 33 |
| Fill on a worker thread (`mcp/motionbricks/fill-worker.mjs`) | 53 s fill: main-thread stall 8.0 s -> 24 ms; agent run disconnects 6/6 before, 0 in every run after (F3-F14) |
| One deadline (45 s, from the request's arrival); heavy specs (one compile > 2 s) keep the compiler's take | the Studio waits 90 s (`src/commands/motion3-fill.js` `FILL_TIMEOUT_MS`) |
| Native fills install without thinning | door2 sync 1 -> 0.67 kept after install |
| The fill answer says how many gaps were kept and why the others were dropped; agent guidance: skills for walking and contact, the fill for free whole-body moves, one fill per change of the keys | the agent read "filled 3 gaps" with 0 kept and refilled 6 more times |

## Why layer 4 is blocked

1. In the layer-4 agent runs (box carry, 4 runs per side), MotionBricks was **never called**. Every fill hit the 2 s early exit.
   The agent's real specs take 1.2-17 s per compile on a Mac and 2.2-48 s on the A/B box. Source: the fill answers in the run sessions.
2. 79% of a heavy compile is `planWalks` (`src/motion3/walk-plan.js`). Its cache key holds all of `spec.keys`, so every fill key
   re-plans the walk (up to 22 trial compiles). Freezing the plans cuts walking takes 3-7x (17.0 -> 2.5 s). Takes without a walk do not get faster.
3. One install check (repair, 2 rounds) takes 9.5-32 s, so two checks already exceed the 45 s deadline.
4. With **no time limit**, the real takes keep gaps on 1 of 6 (t2F11, QA 106 -> 98); every other gap is dropped as local-worse
   or as a hold. One fill takes 56-391 s (`results/r20-real.json`). A box carry is almost all walking and hand contact,
   so it leaves MotionBricks almost nothing to fill. Speed alone does not make layer 4 pass on this task.

Layer 4 by side, 4 runs each (`results/agent-runs.json`): disconnects 0 / 0; box on shelf + shot main 3/4, MotionBricks 2/4;
QA group median 18.5 / 16, while the spread inside one side (0-34) is larger than the difference; MotionBricks keys in the final take 0/4.

## Next steps

- Layer 4 on a task with free whole-body moves (door open, kick, throw: bench `door2` gains the most), 4+ runs per side.
- Layer 3: blind picks on the 4 clips.
- If heavy specs must be filled: freeze walk plans inside the fill, and move the fill out of the 90 s wait (async) or make the compiler faster.

## Bench

```
MAIN=<repo> SET=bench/set      NATIVE_NOTHIN=1 CANDG='{"timing":"exact","gate":false}' node bench/bench.mjs out.json base,candG 1
MAIN=<repo> SET=bench/set-real NATIVE_NOTHIN=1 CANDG='{"timing":"exact","gate":false}' node bench/bench.mjs out.json base,candG 1
```

- `bench/set`: 7 specs (door2, gait, sit, rules2, t2A1, t2A2, t2B3). `bench/set-real`: the final takes of 6 real agent runs.
- Each row: raw and installed (repair 2 rounds, as `motion.compile` installs) metrics, fill time, kept gaps and drop reasons.
- `bench/runqa.mjs <dir>`: recompile each run's final take (doc.json) the same way for every arm. `bench/cref.mjs`, `bench/ctake.mjs`: compile and install-check timings.
- `results/loop.json`: every step of the loop with its measured effect. `results/r0-base.json`: the baseline before any change.
- Set `COZYCLAY_MB_DEADLINE_MS` and `COZYCLAY_MB_MAX_COMPILE_MS` high to measure the fill without its time limits.
