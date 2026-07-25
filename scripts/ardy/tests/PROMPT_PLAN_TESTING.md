# Prompt plan tests

Run the prompt-plan suite from the repository root so the interactive demo modules resolve exactly as they do in `run_demo.py`:

```bash
PYTHONPATH=scripts .venv/bin/python -m pytest \
  tests/test_prompt_timeline.py \
  tests/test_prompt_plan.py \
  tests/test_prompt_plan_execution.py
```

The execution test covers a complete six-cue plan: six contiguous 40-frame spans, totaling 240 frames.
