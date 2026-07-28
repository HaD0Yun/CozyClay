# Contributing to CozyClay

CozyClay is alpha software with a deliberately narrow surface. Contributions are welcome; contributions that widen the trust boundary are not.

## The one rule

**You must understand your code.** If you cannot explain what a change does and how it interacts with the transaction protocol, the PR will be closed. Using an agent to write code is fine. Submitting code you have not read is not.

If you use an agent, run it from the repository root so it picks up [AGENTS.md](AGENTS.md), and make it follow that file.

## Where changes belong

CozyClay is an additive fork of [Pi](https://github.com/earendil-works/pi). That shape is load-bearing:

- New CozyClay behavior goes in `packages/blender-*`, `packages/director-*`, `apps/`, or `blender-addon/`.
- `packages/{ai,agent,coding-agent,tui,server,storage}` are upstream Pi. **Do not edit them.** A patch there turns every future upstream sync into a source-level conflict. If you genuinely need a Pi change, open an issue here first, and take the change upstream.

## Invariants that PRs must not break

These are the reasons CozyClay is safe to point at a scene you care about. A PR that weakens one needs an explicit argument in its description.

1. **Schemas stay closed.** Unknown fields fail. Both directions. No permissive fallbacks.
2. **Mutations stay revision-bound.** No tool mutates without an `expected_revision_id` check.
3. **Mutations stay transactional.** Prepare/commit with rollback; no partial writes left behind.
4. **Ownership stays enforced.** The director never mutates entities it does not own.
5. **Evidence stays digest-authorized.** Caller-supplied metadata never authorizes a camera plan.
6. **The tool allowlist stays closed.** Adding a tool to the embedded director session is an API decision, not a convenience.
7. **Cross-language parity holds.** The Python add-on and the TypeScript protocol must produce identical canonical revisions. CI enforces this by exporting the same scene twice and hashing both sides.

## Before opening a PR

```sh
npm run check
python3 -m unittest discover -s blender-addon/tests
npm --prefix packages/blender-protocol test
npm --prefix packages/blender-tools test
npm --prefix packages/director-core test
npm --prefix packages/director-runtime test
npm --prefix apps/cclay-extension test
```

All must pass. If you change protocol shapes, update both the TypeScript schema and the Python validator in the same PR, plus the parity test that pins them together.

## Issues

Short, concrete, reproducible. Include:

- Blender version and OS
- What you asked the director to do
- What it did instead, with the tool name and error code if there is one
- The relevant lines from `.cclay-blender-attach.log` in your project directory

Do not paste an entire agent transcript. Trim it to the failing turn.

## Commits

`{feat,fix,docs}(scope): summary`. Explain why in the body when the why is not obvious. Do not commit `package-lock.json` unless the dependency change is the point of the PR.

## Licensing of contributions

CozyClay is GPL-3.0-or-later, and contributions are accepted under that same license — inbound equals outbound. There is no CLA and no copyright assignment: you keep the copyright on what you write.

That is a deliberate trade. Because nobody signs rights over, CozyClay cannot later be turned into a closed-source product, by us or by anyone else. It is also why an MIT-licensed dependency is fine to add while a proprietary one is not.

Two rules follow from the licenses the repository already carries:

- Do not add a dependency, vendored file, or patch under a license that is incompatible with GPLv3. Apache-2.0, MIT, BSD, and MPL-2.0 are fine; GPLv2-only is not, and neither is anything with a field-of-use or non-commercial restriction.
- If you modify or vendor third-party code, keep its notices and record it in [LICENSES/README.md](LICENSES/README.md). A patch against someone else's sources carries their license, not ours.
