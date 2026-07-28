# Pinned Pi model-data fixture

This is a point-in-time snapshot of `packages/ai/src/providers/data/*.json`
(including `.manifest.json`), the model catalog Pi's `generate-models`
script fetches live from provider APIs at build time.

That directory is gitignored (`packages/ai/src/providers/data/`) and never
committed as real source, because CozyClay's CI is intentionally hermetic —
see the "Check" step comment in `.github/workflows/ci.yml`. It never runs
`npm run build`, so it never hits a live network endpoint.

Pi 0.82.0's `packages/ai/src/model-catalog.ts` introduced
`flattenModelCatalog<TProvider, TGroups extends ModelGroups>`, which requires
a real, structurally-typed JSON literal for each provider's data file. Pi's
own fallback ambient declaration for a *missing* file
(`packages/ai/src/providers/data-json.d.ts`, `const value: unknown`) cannot
satisfy that generic bound, so `tsgo --noEmit` fails everywhere a
`*.models.ts` file is reachable whenever the data directory does not exist —
independent of anything CozyClay's own packages do.

The CI "Check" step copies this fixture into
`packages/ai/src/providers/data/` before typechecking, so `tsgo` sees real
JSON literals without any network access. Do not edit the JSON files here by
hand; regenerate the whole snapshot with:

```sh
npm --prefix packages/ai run hydrate-model-data
rm -rf fixtures/pi-model-data
cp -r packages/ai/src/providers/data fixtures/pi-model-data
```

CozyClay edits no source file under `packages/ai` (see
`docs/UPSTREAM-SYNC.md`); this fixture lives here, outside that tree, for
exactly that reason. Refresh it opportunistically (e.g. during an upstream
sync) — a stale snapshot only affects local typecheck fidelity for
newly-added/removed model IDs, never runtime behavior.
