"""The add-on suite must skip, never raise, when Blender is unavailable.

CI runs `python3 -m unittest discover -s blender-addon/tests` on a hermetic
Python runner with no Blender binary. A module that raises from setUp/setUpClass
because `BLENDER.is_file()` is false turns "this machine has no Blender" into a
red build, which is what the convention `@unittest.skipUnless(BLENDER.is_file(),
...)` exists to prevent.

Scope: this is a targeted regression detector for the guarded-raise shape that
actually broke CI, not a general proof that the convention cannot be evaded. It
reports a module-level `BLENDER` constant plus a `setUp`/`setUpClass` that, on
the Blender-ABSENT branch only, raises AssertionError, RuntimeError, or
SystemExit, or calls `self.fail`/`cls.fail`. Recognised absence tests are
`not BLENDER.is_file()`, `not shutil.which("blender")`,
`BLENDER.is_file() is False`, and `shutil.which("blender") is None`. Shapes
outside that grammar — an unconditional raise, a module-level guard, a raise
behind an aliased predicate — are deliberately out of scope and would need the
grammar and its negative samples extended first.

Only the absence branch body is inspected. A raise in the `else` of such a
branch fires when Blender is PRESENT and is a legitimate failure, so flagging it
would be a false positive.
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

TESTS_DIRECTORY = Path(__file__).resolve().parent
SEEDED_VIOLATION = TESTS_DIRECTORY / "fixtures" / "blender_gating_violation_sample.py"
GUARDED_METHODS = {"setUp", "setUpClass"}
PROHIBITED_EXCEPTIONS = {"AssertionError", "RuntimeError", "SystemExit"}


def _declares_blender_constant(module: ast.Module) -> bool:
    for node in module.body:
        targets = node.targets if isinstance(node, ast.Assign) else []
        if isinstance(node, ast.AnnAssign):
            targets = [node.target]
        for target in targets:
            if isinstance(target, ast.Name) and target.id == "BLENDER":
                return True
    return False


def _is_blender_probe(node: ast.expr) -> bool:
    """True for `BLENDER.is_file()` and `shutil.which("blender")`."""
    if not isinstance(node, ast.Call):
        return False
    function = node.func
    if not isinstance(function, ast.Attribute):
        return False
    if function.attr == "is_file":
        return isinstance(function.value, ast.Name) and function.value.id == "BLENDER"
    if function.attr == "which":
        # Qualify the receiver: only `shutil.which`, not any object exposing a
        # `.which()` method, matches the grammar this detector documents.
        if not (isinstance(function.value, ast.Name) and function.value.id == "shutil"):
            return False
        return any(
            isinstance(argument, ast.Constant) and argument.value == "blender"
            for argument in node.args
        )
    return False


def _is_blender_absence_test(node: ast.expr) -> bool:
    """True for the four recognised absence tests listed in the module docstring."""
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
        return _is_blender_probe(node.operand)
    if isinstance(node, ast.Compare) and len(node.ops) == 1 and len(node.comparators) == 1:
        if not isinstance(node.ops[0], ast.Is):
            return False
        comparator = node.comparators[0]
        if not isinstance(comparator, ast.Constant) or comparator.value not in (False, None):
            return False
        return _is_blender_probe(node.left)
    return False


def _raised_name(node: ast.Raise) -> str | None:
    exception = node.exc
    if isinstance(exception, ast.Call):
        exception = exception.func
    if isinstance(exception, ast.Name):
        return exception.id
    if isinstance(exception, ast.Attribute):
        return exception.attr
    return None


def _failure_calls_and_raises(body: list[ast.stmt]) -> list[tuple[int, str]]:
    """Prohibited hard failures anywhere inside the given branch body."""
    found: list[tuple[int, str]] = []
    for statement in body:
        for node in ast.walk(statement):
            if isinstance(node, ast.Raise):
                raised = _raised_name(node)
                if raised in PROHIBITED_EXCEPTIONS:
                    found.append((node.lineno, f"raises {raised}"))
            elif isinstance(node, ast.Call):
                function = node.func
                if (
                    isinstance(function, ast.Attribute)
                    and function.attr == "fail"
                    and isinstance(function.value, ast.Name)
                    and function.value.id in {"self", "cls"}
                ):
                    found.append((node.lineno, f"calls {function.value.id}.fail()"))
    return found


def _violations_in_source(source: str, label: str) -> list[str]:
    module = ast.parse(source, filename=label)
    if not _declares_blender_constant(module):
        return []
    found: list[str] = []
    for classdef in ast.walk(module):
        if not isinstance(classdef, ast.ClassDef):
            continue
        for method in classdef.body:
            if not isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            if method.name not in GUARDED_METHODS:
                continue
            for branch in ast.walk(method):
                if not isinstance(branch, ast.If) or not _is_blender_absence_test(branch.test):
                    continue
                # Only branch.body: a raise in `orelse` fires when Blender IS present.
                for lineno, what in _failure_calls_and_raises(branch.body):
                    found.append(
                        f"{label}:{lineno} "
                        f"{classdef.name}.{method.name} {what} "
                        "when Blender is absent; use "
                        '@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")'
                    )
    return found


class BlenderGatingConventionTests(unittest.TestCase):
    def test_the_detector_fires_on_the_seeded_violation(self) -> None:
        self.assertTrue(SEEDED_VIOLATION.is_file(), f"missing seeded sample at {SEEDED_VIOLATION}")
        violations = _violations_in_source(
            SEEDED_VIOLATION.read_text(encoding="utf-8"), SEEDED_VIOLATION.name
        )
        self.assertEqual(len(violations), 1, violations)
        self.assertIn("SeededGatingViolationTests.setUpClass", violations[0])
        self.assertIn("AssertionError", violations[0])

    def _detect(self, guard: str, failure: str) -> list[str]:
        detected = _violations_in_source(
            "\n".join(
                [
                    "import shutil",
                    "import unittest",
                    "from pathlib import Path",
                    'BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")',
                    "class T(unittest.TestCase):",
                    "    @classmethod",
                    "    def setUpClass(cls):",
                    f"        if {guard}:",
                    f"            {failure}",
                ]
            ),
            "sample.py",
        )
        return detected

    def test_the_detector_covers_every_documented_guard_and_failure_shape(self) -> None:
        guards = [
            "not BLENDER.is_file()",
            'not shutil.which("blender")',
            "BLENDER.is_file() is False",
            'shutil.which("blender") is None',
        ]
        failures = [
            'raise AssertionError("x")',
            'raise RuntimeError("x")',
            "raise SystemExit(1)",
            'cls.fail("x")',
        ]
        for guard in guards:
            for failure in failures:
                with self.subTest(guard=guard, failure=failure):
                    self.assertEqual(len(self._detect(guard, failure)), 1)

    def test_the_detector_does_not_flag_non_prohibited_failures(self) -> None:
        self.assertEqual(self._detect("not BLENDER.is_file()", 'raise ValueError("x")'), [])
        self.assertEqual(self._detect("not BLENDER.is_file()", "pass"), [])

    def test_the_detector_does_not_flag_an_unrelated_guard(self) -> None:
        self.assertEqual(
            self._detect('not shutil.which("ffmpeg")', 'raise AssertionError("x")'), []
        )
        # The grammar names `shutil.which`; any other receiver is out of scope.
        self.assertEqual(
            self._detect('not registry.which("blender")', 'raise AssertionError("x")'), []
        )
        self.assertEqual(
            self._detect("not OTHER.is_file()", 'raise AssertionError("x")'), []
        )

    def test_a_raise_in_the_blender_present_branch_is_not_a_violation(self) -> None:
        source = "\n".join(
            [
                "import shutil",
                "import unittest",
                "from pathlib import Path",
                'BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")',
                "class T(unittest.TestCase):",
                "    @classmethod",
                "    def setUpClass(cls):",
                "        if not BLENDER.is_file():",
                '            raise unittest.SkipTest("Blender is unavailable")',
                "        else:",
                '            raise AssertionError("headless Blender failed")',
            ]
        )
        self.assertEqual(_violations_in_source(source, "sample.py"), [])

    def test_no_add_on_test_module_raises_when_blender_is_unavailable(self) -> None:
        modules = sorted(TESTS_DIRECTORY.glob("test_*.py"))
        self.assertGreater(len(modules), 50, "add-on test discovery looks broken")
        violations: list[str] = []
        for module_path in modules:
            violations.extend(
                _violations_in_source(module_path.read_text(encoding="utf-8"), module_path.name)
            )
        self.assertEqual(violations, [], "\n".join(violations))


if __name__ == "__main__":
    unittest.main()
