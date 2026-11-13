# Real-model Studio Agent scenarios

Run against the full local dev stack (Studio on `:5180`, live hub on `:5184`):

```sh
QA_URL=http://127.0.0.1:5180/app/ \
QA_AGENT_MODEL=cliproxy/claude-opus-5-5 \
QA_OUT=/tmp/cozyclay-agent-scenarios \
node tools/qa-browser.mjs -- node test/qa-agent-scenarios-browser.mjs
```

`QA_AGENT_MODEL` defaults to `cliproxy/claude-opus-5-5`. The script selects it before testing, exercises sight, object removal, shot creation, motion generation, and motion persistence, then writes per-scenario status and evidence to `$QA_OUT/agent-scenarios.json` (default `/tmp/cozyclay-agent-scenarios/agent-scenarios.json`). It exits nonzero if any scenario fails. The suite uses a real model and live scene; it is excluded from the default Node verification run.
