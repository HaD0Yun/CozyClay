"""The ARDY generator draws once per run, and never saves a diverged clip.

These are the two claims best-of-N removal actually makes, and they are checked
here BEHAVIOURALLY: `main()` runs against a counting fake sampler and the
outcome is the observation. Everything downstream of the fake `to_numpy` --
`find_non_finite`, the `measure_*` functions, `save_motion_npz` -- is the real
code operating on real numpy arrays.

This exists because the equivalent source-level contract in
test_ardy_constraint_spec.py cannot close. Eight review rounds each named one
more SPELLING of "invoke the sampler twice": inside a helper, the helper's
decorator, main's decorator, main's entrypoint, module-level hooks, aliases of
the model object, and bound methods of it. The invariant is semantic -- how many
times a callable object is invoked -- so counting invocations ends the chain that
enumerating syntax could not. The AST contract is kept for what syntax really
does express: payload identity, guard placement, and the removed flags.

Runs under Blender's Python because that interpreter ships numpy and the dev
machine's system python3 does not.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/ardy_generate_once_fixture.py"


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class ArdyGenerateOnceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        completed = subprocess.run(
            [str(BLENDER), "--background", "--factory-startup", "--python", str(SCRIPT)],
            cwd=REPOSITORY_ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=900,
        )
        payload = None
        for line in completed.stdout.splitlines():
            if line.startswith("CCLAY_ONCE="):
                payload = json.loads(line[len("CCLAY_ONCE="):])
        if payload is None:
            raise AssertionError(
                "fixture printed no CCLAY_ONCE payload\n"
                f"exit={completed.returncode}\n{completed.stdout[-4000:]}\n{completed.stderr[-4000:]}"
            )
        cls.clean = payload["clean"]
        cls.poisoned = payload["poisoned"]
        cls.post_draw_failure = payload["postDrawFailure"]

    def test_the_sampler_is_invoked_exactly_once(self):
        """One GPU draw per run, counted rather than inferred from syntax.

        A syntactic contract can pin where the call sits but not how many times
        the object is invoked, which is why every alias and wrapper spelling
        defeated the AST version in turn. Here the fake sampler counts its own
        invocations, so any spelling that draws twice reports two.
        """
        self.assertIsNone(self.clean["error"], "the clean run must succeed")
        self.assertEqual(
            self.clean["modelCalls"],
            1,
            "best-of-N removal means exactly one sampling pass per run",
        )

    def test_a_successful_run_saves_the_clip(self):
        """Non-vacuity: the guard test below only means something if a good clip
        does reach the npz.
        """
        self.assertTrue(self.clean["npzWritten"])
        saved = self.clean["saved"]
        self.assertEqual(
            saved["members"],
            [
                "foot_contacts", "fps", "global_rot_mats", "local_rot_mats",
                "posed_joints", "root_positions", "text",
            ],
        )
        self.assertTrue(saved["posedFinite"])

    def test_a_diverged_clip_is_rejected_before_it_reaches_disk(self):
        """A NaN in the sampler's output must abort the run with no npz.

        The AST contract proves the guard is CALLED before the save. This proves
        it WORKS: the file does not exist afterwards.
        """
        self.assertIsNotNone(self.poisoned["error"], "a diverged clip must raise")
        self.assertIn("generated motion diverged", self.poisoned["error"])
        self.assertIn("posed_joints", self.poisoned["error"])
        self.assertFalse(
            self.poisoned["npzWritten"],
            "a diverged clip must not be written; the guard runs before the save",
        )

    def test_the_divergence_report_names_the_exact_location(self):
        """The fixture poisons one known cell, so the message is checkable."""
        # Frame 7 is the last of the fixture's 8, index (1, 2) is joint 1's Z.
        self.assertIn("frame 7", self.poisoned["error"])
        self.assertIn("index (1, 2)", self.poisoned["error"])

    def test_divergence_costs_exactly_one_draw_not_a_retry(self):
        """Rejecting a clip must not trigger a second generation."""
        self.assertEqual(self.poisoned["modelCalls"], 1)

    def test_a_post_draw_failure_costs_exactly_one_draw(self):
        """Exactly-once is a FAILURE-path invariant, not only a happy-path one.

        A retry wrapper is likeliest to appear around a step that can fail, and
        the previous scenarios only exercised success plus the guard's own
        ValueError. This scenario makes `motion_rep.inverse` raise RuntimeError
        once, immediately after a completed draw. A retry around draw+inverse
        would silently draw a second time in the same process, and nothing in the
        source contract or the wrapper test could see it.
        """
        self.assertEqual(
            self.post_draw_failure["modelCalls"],
            1,
            "a post-draw failure must not be retried into a second GPU draw",
        )
        self.assertIsNotNone(self.post_draw_failure["error"])
        self.assertIn("simulated post-draw failure", self.post_draw_failure["error"])

    def test_a_post_draw_failure_writes_nothing(self):
        """The failure must escape, not be swallowed into a partial output."""
        self.assertFalse(self.post_draw_failure["npzWritten"])


if __name__ == "__main__":
    unittest.main()
