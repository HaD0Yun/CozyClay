# Guest-first experiment (P2-7)

**Status: plan, not shipped.** The research audit (20260825-221744) found every
competitor (Spline, Womp, Rive, LTX) gates the editor behind account creation,
and community complaints name mandatory signup as a first-session abandonment
trigger. CozyClay already has no login — this document is the experiment plan
to turn that into a measured advantage instead of an accident.

## Hypothesis

A visitor who can play a sample and edit it before any account exists reaches
`activation:completed` at a materially higher rate than a flow that asks for
identity first.

## Design

1. Guest session is the default and already works (no code gate to remove).
2. Identity is requested lazily, at the first moment that needs it:
   - export/share a project file (needs a name to save under),
   - sync a scene across devices,
   - AI generation queue (if a hosted queue ever bills per user).
3. Instrumentation (already in the product code, `src/analytics.js` and `src/App.jsx`): `install:first_launch`,
   `sample:played` (removed in #914), `craft:first_action`, `scene:created` (including the
   startup scene), `export:video_succeeded`, `export:blocking_frame_succeeded`,
   `activation:completed`. When a lazy-identity prompt lands, add
   `identity:prompted` / `identity:completed` / `identity:dismissed`.
4. Measure: guest cohort's session→craft and craft→export rates vs. any future
   identity-first variant. Decision rule: ship the variant with the higher
   completion, not the higher signup count.

## Non-goals

- No account system in this milestone. No server identity, no auth provider,
  no share links (backend, abuse and privacy scope that the audit explicitly
  deferred to P2/conditional).
- Do not gate export behind identity to juice signups — the audit's community
  evidence (Rive's export paywall complaint) says that converts the trial into
  a dead end.
