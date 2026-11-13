# Third-Party Notices

CozyClay is an independent project. The names and licenses below apply only to their respective third-party projects and do not imply sponsorship, affiliation, or endorsement.

## Three.js

CozyClay's browser-based 3D studio uses [Three.js](https://threejs.org/) through `three`, `@react-three/fiber`, and `@react-three/drei`.

- Copyright (c) 2010-2026 three.js authors
- License: MIT
- Source: https://github.com/mrdoob/three.js
- License text: https://github.com/mrdoob/three.js/blob/dev/LICENSE

## Mediabunny

CozyClay uses [Mediabunny](https://mediabunny.dev/) to mux recorded WebCodecs
video frames into MP4 files in the browser.

- Copyright (c) 2024-2026 Vanilagy
- License: MPL-2.0
- Source: https://github.com/Vanilagy/mediabunny
- License text: https://github.com/Vanilagy/mediabunny/blob/main/LICENSE

## NVIDIA ARDY

CozyClay provides an optional bridge and data-conversion workflow for externally installed [ARDY](https://github.com/nv-tlabs/ardy), an interactive human-motion generation project from NVIDIA Research.

ARDY is not bundled with CozyClay. Users must obtain, install, and operate ARDY separately under NVIDIA's terms.

- Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES
- ARDY source license: Apache License 2.0
- Source: https://github.com/nv-tlabs/ardy
- Source license: https://github.com/nv-tlabs/ardy/blob/main/LICENSE

ARDY model checkpoints and other model assets may be governed by separate terms, including the NVIDIA Open Model License identified by the ARDY project. Users are responsible for reviewing and complying with those terms before downloading or using the models.

## Meta Llama 3

ARDY's text encoder is based on Meta Llama 3 (`Meta-Llama-3-8B-Instruct`).
CozyClay does not bundle or redistribute the model weights; the optional
`tools/ardy/setup-text-encoder.py` script downloads them directly from a
public repository to the user's own machine for local use, together with the
model's LICENSE and USE_POLICY files.

Built with Meta Llama 3.

- Copyright © Meta Platforms, Inc. All Rights Reserved.
- License: Meta Llama 3 Community License
- License text: https://www.llama.com/llama3/license/
- Acceptable Use Policy: https://www.llama.com/llama3/use-policy/

Meta Llama 3 is licensed under the Meta Llama 3 Community License,
Copyright © Meta Platforms, Inc. All Rights Reserved.

## LLM2Vec

ARDY's text encoder applies the LLM2Vec adapters from McGill NLP
(`LLM2Vec-Meta-Llama-3-8B-Instruct-mntp` and `-mntp-supervised`). Like the
base weights, they are downloaded by the setup script for local use, not
bundled.

- Copyright (c) 2024 McGill NLP
- License: MIT (the adapters are derived from Meta Llama 3; the Meta Llama 3
  Community License applies to that underlying model)
- Source: https://github.com/McGill-NLP/llm2vec
- License text: https://github.com/McGill-NLP/llm2vec/blob/main/LICENSE

## Fonts

CozyClay bundles subsets of two typefaces. Both are licensed under the SIL Open
Font License 1.1, which allows them to be redistributed with software as long as
the copyright notice and the licence travel with the files. The licence texts are
in `public/fonts/` next to the fonts themselves.

The text object's solid letters use one more typeface, bundled as glyph outlines
in `src/text/fonts/`, under its own permissive licence (text in the same folder).

### Inter

- Copyright (c) 2016 The Inter Project Authors
- License: SIL Open Font License 1.1
- Source: https://github.com/rsms/inter
- License text: `public/fonts/Inter-OFL.txt`

### Instrument Serif

- Copyright 2022 The Instrument Serif Project Authors
- License: SIL Open Font License 1.1
- Source: https://github.com/Instrument/instrument-serif
- License text: `public/fonts/InstrumentSerif-OFL.txt`

### Helvetiker Bold

- Copyright (c) 2004 Magenta Ltd.
- License: MgOpen font license (redistribution permitted with the notice)
- Source: the three.js examples font set (`examples/fonts/helvetiker_bold.typeface.json`)
- License text: `src/text/fonts/helvetiker-LICENSE.txt`

## Character models

The rigs in `public/models/` are Mixamo characters from Adobe. Adobe permits
their use in projects but not the distribution of the raw character files, which
is what shipping them in this repository, the npm package and the hosted site
amounts to. They are also outside the scope of this repository's AGPL-3.0 grant:
nothing here relicenses them, and a fork does not acquire the right to
redistribute them.

They are being replaced with a CC0 rig. Until that lands, treat these two files
as third-party content that this licence does not cover.

- `x-bot-tpose.fbx`, `y-bot-tpose.fbx` — Adobe Mixamo
- Terms: https://www.adobe.com/legal/terms.html

## posthog-js

The hosted site at cozyclay.org uses [posthog-js](https://posthog.com/docs/libraries/js) for anonymous usage analytics.

The disclosed wire events include session start/end (bucketed duration and
actions), one-per-session feature usage, project save/open buckets, and the
hosted composer/login/ticket/result funnel. Events carry only the registered
`origin_kind`, coarse `os`, and npm `install_kind`; prompts, filenames, paths,
project names, and timestamps are excluded. Source checkouts keep telemetry
disabled. See the Analytics & privacy section in `README.md` for the complete
event table and opt-out controls.

- Copyright PostHog Inc.
- License: Apache-2.0 AND MIT
- Source: https://github.com/PostHog/posthog-js

## pi agent packages

The optional agent sidecar loads `@earendil-works/pi-ai`,
`@earendil-works/pi-agent-core` and `@earendil-works/pi-codemode` at runtime (they are declared dependencies,
loaded lazily by the sidecar; the launcher itself does not import them).

- Copyright (c) Earendil Works
- License: MIT
- Source: https://github.com/earendil-works/pi (packages/ai → @earendil-works/pi-ai, packages/agent → @earendil-works/pi-agent-core, packages/codemode → @earendil-works/pi-codemode)

Their transitive runtime dependencies, which the agent sidecar also loads, are:

- `@anthropic-ai/sdk` — License: MIT — https://github.com/anthropics/anthropic-sdk-typescript
- `openai` — License: Apache-2.0 — https://github.com/openai/openai-node
- `@google/genai` — License: Apache-2.0 — https://github.com/googleapis/js-genai
- `@aws-sdk/client-bedrock-runtime` — License: Apache-2.0 — https://github.com/aws/aws-sdk-js-v3
- `@smithy/node-http-handler` — License: Apache-2.0 — https://github.com/smithy-lang/smithy-typescript
- `http-proxy-agent` — License: MIT — https://github.com/TooTallNate/proxy-agents
- `https-proxy-agent` — License: MIT — https://github.com/TooTallNate/proxy-agents
- `partial-json` — License: MIT — https://github.com/promplate/partial-json-parser-js
- `typebox` — License: MIT — https://github.com/sinclairzx81/typebox
- `@earendil-works/pi-telemetry` — License: MIT — https://github.com/earendil-works/pi
- `quickjs-wasi` — License: MIT — https://github.com/vercel-labs/quickjs-wasi

## jpeg-js

The MCP runtime decodes JPEG reference images for `compare_sculpt` with `jpeg-js`, on the local machine.

- Copyright (c) 2014, Eugene Ware and Adobe
- License: BSD-3-Clause
- Source: https://github.com/jpeg-js/jpeg-js

## ONNX Runtime

The Auto Pose tool (`src/poser/`) runs its pose network in the browser with `onnxruntime-web` (WASM); its Node tests use the same package. The Auto Pose network file ships in the npm package (`dist/models/`), not in the git repository or on the hosted site; it is CozyClay's own model and is loaded from the local server on first use.

- Copyright (c) Microsoft Corporation
- License: MIT
- Source: https://github.com/microsoft/onnxruntime
- License text: https://github.com/microsoft/onnxruntime/blob/main/LICENSE

## CozyClay license scope

The CozyClay combined work in this repository is distributed under AGPL-3.0-or-later, subject to the transition details in `LICENSING.md`. That license does not replace or relicense Three.js, ARDY, ARDY model checkpoints, the bundled fonts, the character rigs, or any other third-party component.
